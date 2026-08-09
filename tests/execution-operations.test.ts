import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { openDatabase } from "@/src/server/db";
import { execV7Fixture } from "@/tests/fixtures/execution/current-graph";

const PROJECT_ID = "operation-project";
const EXECUTION_ID = "operation-execution";
const ATTEMPT_ID = "operation-attempt";
const NOW = "2026-07-30T03:30:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const responseSchema = z.object({
  executionId: z.string(),
  outcome: z.enum(["ready", "recovered"]),
}).strict();

type ActionKind =
  | "sandbox_build"
  | "model"
  | "file_list"
  | "file_read"
  | "file_write"
  | "command"
  | "stage_compute"
  | "merge_apply"
  | "merge_recover"
  | "manual_resolution";

type OperationModule = {
  acquireOperationAction: (database: DatabaseSync, input: {
    actionIndex: number;
    leaseExpiresAt: string;
    leaseToken: string;
    operationId: string;
    projectId: string;
    startedAt: string;
  }) => { actionIndex: number; status: "running" };
  appendOperationAction: (database: DatabaseSync, input: {
    actionId: string;
    attemptId: string;
    executionId: string;
    kind: ActionKind;
    operationId: string;
    overallDeadlineAt: string;
    projectId: string;
    requestHash: string;
    timestamp: string;
  }) => { actionIndex: number; status: "pending" };
  beginExternalOperation: (database: DatabaseSync, input: {
    action: {
      actionId: string;
      attemptId: string;
      kind: ActionKind;
      overallDeadlineAt: string;
      requestHash: string;
    };
    executionId: string;
    kind: "start" | "recover";
    operationId: string;
    projectId: string;
    requestHash: string;
    responseSchema: { parse(value: unknown): unknown };
    timestamp: string;
  }) =>
    | { actionIndex: number; status: "pending" }
    | { body: unknown; status: number };
  finalizeOperationAction: <T>(database: DatabaseSync, input: {
    actionIndex: number;
    body: T;
    httpStatus: number;
    leaseToken: string;
    operationId: string;
    projectId: string;
    responseSchema: z.ZodType<T>;
    result: unknown;
    status: "succeeded" | "failed" | "interrupted" | "discarded";
    timestamp: string;
  }) => { body: T; status: number };
  finishOperationActionAndAppend: (database: DatabaseSync, input: {
    actionIndex: number;
    leaseToken: string;
    nextAction: {
      actionId: string;
      attemptId: string;
      kind: ActionKind;
      overallDeadlineAt: string;
      requestHash: string;
    };
    operationId: string;
    projectId: string;
    result: unknown;
    status: "succeeded" | "failed" | "interrupted" | "discarded";
    timestamp: string;
  }) => { actionIndex: number; status: "pending" };
  readExecutionOperation: <T>(database: DatabaseSync, input: {
    kind: "start" | "recover";
    operationId: string;
    projectId: string;
    requestHash: string;
    responseSchema: z.ZodType<T>;
  }) => { body: T; status: number } | null;
};

let directory: string;
let databasePath: string;
let operations: OperationModule;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-execution-operations-"));
  databasePath = join(directory, "cockpit.sqlite");
  seedExecution();
  const moduleId = "@/src/server/execution/execution-operations";
  try {
    operations = await import(/* @vite-ignore */ moduleId) as OperationModule;
  } catch {
    expect.fail("The execution operation receipt primitive is unavailable.");
  }
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

function seedExecution(): void {
  const database = openDatabase(databasePath);
  try {
    execV7Fixture(databasePath, database, `
      INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
      VALUES ('${PROJECT_ID}','Operations','${NOW}','D:\\workspace','d:/workspace',1);
      INSERT INTO providers (
        id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
        credential_version,credential_generation,key_id,api_key_mask,verified_at,
        version,created_at,updated_at
      ) VALUES (
        'provider','Provider','http://127.0.0.1:4000/v1','model','c','i','t',
        1,1,'k','***','${NOW}',1,'${NOW}','${NOW}'
      );
      INSERT INTO agents (
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
      ) VALUES (
        'agent','Agent','Builder','private','provider','model','A','sage',
        1,1,1,1000,5,1,'${NOW}','${NOW}'
      );
      INSERT INTO project_memberships (project_id,agent_id,joined_at)
      VALUES ('${PROJECT_ID}','agent','${NOW}');
      INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
      VALUES ('mission','${PROJECT_ID}','Mission','Goal',1,'${NOW}','${NOW}');
      INSERT INTO work_items (
        id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
      ) VALUES ('work','mission','Work','','in_progress','agent',1,'${NOW}','${NOW}');
      INSERT INTO collaboration_runs (
        id,project_id,status,current_agent_id,round_count,next_event_sequence,
        version,execution_epoch,pause_reason,pause_category,created_at,updated_at
      ) VALUES ('run','${PROJECT_ID}','planned','agent',1,1,1,1,NULL,NULL,'${NOW}','${NOW}');
      INSERT INTO project_validation_policy_revisions (
        id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
        classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
      ) VALUES (
        'policy','${PROJECT_ID}',NULL,'system',1,
        '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        1,0,2,0,'${NOW}'
      );
      INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
      VALUES ('${PROJECT_ID}','policy',1,'${NOW}');
      INSERT INTO executions (
        id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
        current_policy_revision_id,status,resume_target,reason_code,
        manual_recovery_required,recovery_resolution,current_attempt_no,
        business_round_count,tool_call_count,next_event_sequence,version,created_at,
        business_deadline_at,first_running_at,updated_at,merged_at
      ) VALUES (
        '${EXECUTION_ID}','${PROJECT_ID}','run','mission','work','agent','policy',
        'queued',NULL,NULL,0,NULL,1,0,0,1,1,'${NOW}',NULL,NULL,'${NOW}',NULL
      );
      INSERT INTO execution_attempts (
        id,project_id,execution_id,attempt_no,status,sandbox_root,
        baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
        frozen_public_json,frozen_private_json,frozen_context_hash,
        frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
        started_at,finished_at
      ) VALUES (
        '${ATTEMPT_ID}','${PROJECT_ID}','${EXECUTION_ID}',1,'preparing','D:\\sandbox',
        NULL,NULL,NULL,'{}','{}','${"c".repeat(64)}','policy',1,
        '${"d".repeat(64)}','${NOW}',NULL
      );
    `);
  } finally {
    database.close();
  }
}

function operationId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function deadline(seconds: number): string {
  return new Date(Date.parse(NOW) + seconds * 1000).toISOString();
}

function begin(database: DatabaseSync, id: string, kind: "start" | "recover" = "start") {
  return operations.beginExternalOperation(database, {
    action: {
      actionId: `action-${id}-0`,
      attemptId: ATTEMPT_ID,
      kind: kind === "start" ? "sandbox_build" : "merge_recover",
      overallDeadlineAt: deadline(900),
      requestHash: HASH_A,
    },
    executionId: EXECUTION_ID,
    kind,
    operationId: id,
    projectId: PROJECT_ID,
    requestHash: HASH_A,
    responseSchema,
    timestamp: NOW,
  });
}

function acquire(database: DatabaseSync, id: string, actionIndex: number, token: string) {
  return operations.acquireOperationAction(database, {
    actionIndex,
    leaseExpiresAt: deadline(120),
    leaseToken: token,
    operationId: id,
    projectId: PROJECT_ID,
    startedAt: NOW,
  });
}

describe("execution parent operations and ordered child receipts", () => {
  it("keeps the receipt pending across contiguous children and completes only on the final public outcome", () => {
    const database = openDatabase(databasePath);
    const id = operationId(1);
    try {
      expect(begin(database, id)).toEqual({ actionIndex: 0, status: "pending" });
      expect(() => begin(database, id)).toThrowError(
        expect.objectContaining({ code: "OPERATION_IN_PROGRESS" }),
      );
      expect(acquire(database, id, 0, "lease-0")).toEqual({
        actionIndex: 0,
        status: "running",
      });
      expect(operations.finishOperationActionAndAppend(database, {
        actionIndex: 0,
        leaseToken: "lease-0",
        nextAction: {
          actionId: `action-${id}-1`,
          attemptId: ATTEMPT_ID,
          kind: "file_read",
          overallDeadlineAt: deadline(900),
          requestHash: HASH_B,
        },
        operationId: id,
        projectId: PROJECT_ID,
        result: { code: "SANDBOX_READY" },
        status: "succeeded",
        timestamp: NOW,
      })).toEqual({ actionIndex: 1, status: "pending" });

      const pending = database.prepare(
        `SELECT action_count AS actionCount,final_action_index AS finalActionIndex,
                status,http_status AS httpStatus,response_json AS responseJson
         FROM execution_operations WHERE project_id=? AND id=?`,
      ).get(PROJECT_ID, id);
      expect(pending).toEqual({
        actionCount: 2,
        finalActionIndex: null,
        httpStatus: null,
        responseJson: null,
        status: "pending",
      });
      expect(database.prepare(
        `SELECT action_index AS actionIndex,status FROM execution_actions
         WHERE project_id=? AND operation_id=? ORDER BY action_index`,
      ).all(PROJECT_ID, id)).toEqual([
        { actionIndex: 0, status: "succeeded" },
        { actionIndex: 1, status: "pending" },
      ]);

      acquire(database, id, 1, "lease-1");
      const outcome = { executionId: EXECUTION_ID, outcome: "ready" as const };
      expect(operations.finalizeOperationAction(database, {
        actionIndex: 1,
        body: outcome,
        httpStatus: 201,
        leaseToken: "lease-1",
        operationId: id,
        projectId: PROJECT_ID,
        responseSchema,
        result: { code: "READ_COMPLETE" },
        status: "succeeded",
        timestamp: NOW,
      })).toEqual({ body: outcome, status: 201 });
      expect(database.prepare(
        `SELECT action_count AS actionCount,final_action_index AS finalActionIndex,status
         FROM execution_operations WHERE project_id=? AND id=?`,
      ).get(PROJECT_ID, id)).toEqual({
        actionCount: 2,
        finalActionIndex: 1,
        status: "completed",
      });
    } finally {
      database.close();
    }
  });

  it("replays exact status/body and conflicts on either kind or canonical request hash", () => {
    const database = openDatabase(databasePath);
    const id = operationId(2);
    const body = { executionId: EXECUTION_ID, outcome: "recovered" as const };
    try {
      begin(database, id, "recover");
      acquire(database, id, 0, "recover-lease");
      operations.finalizeOperationAction(database, {
        actionIndex: 0,
        body,
        httpStatus: 200,
        leaseToken: "recover-lease",
        operationId: id,
        projectId: PROJECT_ID,
        responseSchema,
        result: { direction: "rollback" },
        status: "succeeded",
        timestamp: NOW,
      });

      expect(operations.readExecutionOperation(database, {
        kind: "recover",
        operationId: id,
        projectId: PROJECT_ID,
        requestHash: HASH_A,
        responseSchema,
      })).toEqual({ body, status: 200 });
      expect(() => operations.readExecutionOperation(database, {
        kind: "start",
        operationId: id,
        projectId: PROJECT_ID,
        requestHash: HASH_A,
        responseSchema,
      })).toThrowError(expect.objectContaining({ code: "OPERATION_CONFLICT" }));
      expect(() => operations.readExecutionOperation(database, {
        kind: "recover",
        operationId: id,
        projectId: PROJECT_ID,
        requestHash: HASH_B,
        responseSchema,
      })).toThrowError(expect.objectContaining({ code: "OPERATION_CONFLICT" }));
      expect(begin(database, id, "recover")).toEqual({ body, status: 200 });
    } finally {
      database.close();
    }
  });

  it("allows at most one running child for an operation and its execution", () => {
    const database = openDatabase(databasePath);
    const first = operationId(3);
    const second = operationId(4);
    try {
      begin(database, first);
      begin(database, second, "recover");
      acquire(database, first, 0, "first-lease");
      expect(() => acquire(database, second, 0, "second-lease")).toThrowError(
        expect.objectContaining({ code: "OPERATION_IN_PROGRESS" }),
      );
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM execution_actions
         WHERE execution_id=? AND status='running'`,
      ).get(EXECUTION_ID)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("uses CAS so final completion occurs exactly once and duplicate finalizers replay deterministically", () => {
    const database = openDatabase(databasePath);
    const id = operationId(5);
    const body = { executionId: EXECUTION_ID, outcome: "ready" as const };
    const finalization = {
      actionIndex: 0,
      body,
      httpStatus: 201,
      leaseToken: "lease-final",
      operationId: id,
      projectId: PROJECT_ID,
      responseSchema,
      result: { code: "READY" },
      status: "succeeded" as const,
      timestamp: NOW,
    };
    try {
      begin(database, id);
      acquire(database, id, 0, finalization.leaseToken);
      expect(() => operations.finalizeOperationAction(database, {
        ...finalization,
        body: { ...body, privateDetail: "must-not-persist" } as typeof body,
      })).toThrow();
      expect(database.prepare(
        `SELECT status,response_json AS responseJson FROM execution_operations
         WHERE project_id=? AND id=?`,
      ).get(PROJECT_ID, id)).toEqual({ responseJson: null, status: "pending" });
      expect(operations.finalizeOperationAction(database, finalization)).toEqual({
        body,
        status: 201,
      });
      expect(operations.finalizeOperationAction(database, finalization)).toEqual({
        body,
        status: 201,
      });
      expect(begin(database, id)).toEqual({ body, status: 201 });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM execution_operations
         WHERE project_id=? AND id=? AND status='completed'`,
      ).get(PROJECT_ID, id)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("rejects gaps, stale action_count, and appending behind a nonterminal child", () => {
    const database = openDatabase(databasePath);
    const id = operationId(6);
    try {
      begin(database, id);
      expect(() => operations.appendOperationAction(database, {
        actionId: `action-${id}-gap`,
        attemptId: ATTEMPT_ID,
        executionId: EXECUTION_ID,
        kind: "model",
        operationId: id,
        overallDeadlineAt: deadline(900),
        projectId: PROJECT_ID,
        requestHash: HASH_B,
        timestamp: NOW,
      })).toThrowError(expect.objectContaining({ code: "EXECUTION_STATE_CONFLICT" }));
      expect(database.prepare(
        `SELECT action_count AS actionCount,
                (SELECT COUNT(*) FROM execution_actions a
                 WHERE a.project_id=o.project_id AND a.operation_id=o.id) AS childCount
         FROM execution_operations o WHERE project_id=? AND id=?`,
      ).get(PROJECT_ID, id)).toEqual({ actionCount: 1, childCount: 1 });
    } finally {
      database.close();
    }
  });
});
