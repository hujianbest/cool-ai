import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  ExecutionError,
  executionDtoFromDatabase,
} from "@/src/server/execution/execution-service";
import {
  executeMergeCommit,
  executeMergePrepare,
  type MergeFaultPoint,
} from "@/src/server/execution/merge-journal-service";
import type { MergeVerifiedAdapter } from "@/src/server/execution/merge-verified-adapter";
import type {
  MergeExecutionInput,
  MergeExecutionResponse,
} from "@/src/shared/execution-contracts";

type MergeHooks = {
  point(input: { path: string | null; point: MergeFaultPoint }): void | Promise<void>;
};

type OperationRow = {
  httpStatus: number | null;
  kind: string;
  requestHash: string;
  responseJson: string | null;
  status: string;
};

type ExecutionOwnerRow = {
  projectId: string;
  sandboxRoot: string;
  workspaceRoot: string;
};

export type MergeExecutionResult = {
  body: MergeExecutionResponse | { error: { code: string; message: string } };
  status: number;
};

let testHooks: MergeHooks | undefined;
let testAdapter: MergeVerifiedAdapter | undefined;

export function setMergeExecutionHooksForTests(hooks: MergeHooks | undefined): void {
  testHooks = hooks;
}

export function setMergeExecutionAdapterForTests(
  adapter: MergeVerifiedAdapter | undefined,
): void {
  testAdapter = adapter;
}

function requestHash(executionId: string, input: MergeExecutionInput): string {
  return createHash("sha256").update(JSON.stringify({
    executionId,
    expectedVersion: input.expectedVersion,
    kind: "merge",
    stagedHash: input.stagedHash,
  })).digest("hex");
}

function operationRow(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
): OperationRow | undefined {
  return database.prepare(`
    SELECT kind,request_hash AS requestHash,status,http_status AS httpStatus,
           response_json AS responseJson
    FROM execution_operations WHERE project_id=? AND id=?
  `).get(projectId, operationId) as OperationRow | undefined;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the stable merge error.
    }
    throw error;
  }
}

function normalizedReceipt(
  database: DatabaseSync,
  executionId: string,
  operationId: string,
  row: OperationRow,
): MergeExecutionResult {
  if (row.status !== "completed" || row.httpStatus === null || row.responseJson === null) {
    throw new ExecutionError("OPERATION_IN_PROGRESS", 409, "Merge operation is already pending.");
  }
  const stored = JSON.parse(row.responseJson) as MergeExecutionResult["body"];
  if (row.httpStatus !== 200 || !("result" in stored)) {
    return { body: stored, status: row.httpStatus };
  }
  const body: MergeExecutionResponse = {
    execution: executionDtoFromDatabase(database, executionId),
    result: stored.result,
  };
  const responseJson = JSON.stringify(body);
  if (responseJson !== row.responseJson) {
    database.prepare(`
      UPDATE execution_operations
      SET response_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status='completed' AND http_status=200
    `).run(responseJson, operationId);
  }
  return { body, status: 200 };
}

function replayOrConflict(
  database: DatabaseSync,
  projectId: string,
  executionId: string,
  operationId: string,
  hash: string,
): MergeExecutionResult | null {
  const row = operationRow(database, projectId, operationId);
  if (!row) return null;
  if (row.kind !== "merge" || row.requestHash !== hash) {
    throw new ExecutionError("OPERATION_CONFLICT", 409, "Operation id has different input.");
  }
  return normalizedReceipt(database, executionId, operationId, row);
}

function rejectionBody(error: unknown): {
  body: { error: { code: string; message: string } };
  status: number;
} {
  if (error instanceof ExecutionError) {
    return {
      body: { error: { code: error.code, message: "The merge request was rejected." } },
      status: error.httpStatus,
    };
  }
  return {
    body: { error: { code: "INTERNAL_ERROR", message: "The merge service is unavailable." } },
    status: 500,
  };
}

function persistPreAcquireRejection(
  database: DatabaseSync,
  owner: ExecutionOwnerRow,
  executionId: string,
  input: MergeExecutionInput,
  hash: string,
  error: unknown,
): MergeExecutionResult {
  const rejected = rejectionBody(error);
  try {
    transaction(database, () => {
      const replay = operationRow(database, owner.projectId, input.operationId);
      if (replay) return;
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO execution_operations (
          id,project_id,execution_id,kind,request_hash,has_external_actions,
          action_count,final_action_index,status,http_status,response_json,created_at,updated_at
        ) VALUES (?, ?, ?, 'merge', ?, 0, 0, NULL, 'completed', ?, ?, ?, ?)
      `).run(
        input.operationId,
        owner.projectId,
        executionId,
        hash,
        rejected.status,
        JSON.stringify(rejected.body),
        now,
        now,
      );
    });
  } catch {
    // A concurrent same-operation request may have committed the receipt first.
  }
  const winner = replayOrConflict(
    database,
    owner.projectId,
    executionId,
    input.operationId,
    hash,
  );
  if (!winner) {
    throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Merge rejection was not durable.");
  }
  return winner;
}

export async function mergeExecution(
  databasePath: string,
  executionId: string,
  input: MergeExecutionInput,
  options: { hooks?: MergeHooks } = {},
): Promise<MergeExecutionResult> {
  const database = openDatabase(databasePath);
  try {
    const owner = database.prepare(`
      SELECT e.project_id AS projectId,p.workspace_path AS workspaceRoot,
             a.sandbox_root AS sandboxRoot
      FROM executions e
      JOIN projects p ON p.id=e.project_id
      JOIN execution_attempts a
        ON a.project_id=e.project_id AND a.execution_id=e.id
       AND a.attempt_no=e.current_attempt_no
      WHERE e.id=?
    `).get(executionId) as ExecutionOwnerRow | undefined;
    if (!owner) {
      throw new ExecutionError("EXECUTION_NOT_FOUND", 404, "Execution does not exist.");
    }
    const hash = requestHash(executionId, input);
    const replay = replayOrConflict(
      database,
      owner.projectId,
      executionId,
      input.operationId,
      hash,
    );
    if (replay) return replay;

    const hooks = options.hooks ?? testHooks;
    try {
      const prepared = await executeMergePrepare({
        database,
        executionId,
        expectedVersion: input.expectedVersion,
        fs: testAdapter,
        hooks,
        journalBaseRoot: join(dirname(owner.sandboxRoot), "merge"),
        operationId: input.operationId,
        projectId: owner.projectId,
        stagedHash: input.stagedHash,
        workspaceRoot: owner.workspaceRoot,
      });
      await executeMergeCommit({
        database,
        fs: testAdapter,
        hooks,
        journalId: prepared.journalId,
      });
      const completed = operationRow(database, owner.projectId, input.operationId);
      if (!completed) {
        throw new ExecutionError("MERGE_INVARIANT_FAILED", 500, "Merge receipt is missing.");
      }
      return normalizedReceipt(database, executionId, input.operationId, completed);
    } catch (error) {
      const durable = operationRow(database, owner.projectId, input.operationId);
      if (durable) {
        if (durable.kind !== "merge" || durable.requestHash !== hash) {
          throw new ExecutionError("OPERATION_CONFLICT", 409, "Operation id has different input.");
        }
        if (durable.status === "completed") {
          return normalizedReceipt(database, executionId, input.operationId, durable);
        }
        throw error;
      }
      return persistPreAcquireRejection(database, owner, executionId, input, hash, error);
    }
  } finally {
    database.close();
  }
}
