import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { executionDtoFromDatabase } from "@/src/adapters/outbound/sqlite/safe-execution/execution-service";
import { ExecutionError } from "@/src/modules/safe-execution";
import type {
  SandboxExecutionInput,
  SandboxExecutionOutcome,
  SandboxExecutor,
} from "@/src/modules/safe-execution";
import { startExecutionResponseSchema } from "@/src/shared/execution-contracts";

type ProductionSandboxExecutorDependencies = {
  createAdapter?: () => Promise<unknown>;
  onPhase?: (
    phase:
      | "parents-verified"
      | "before-source-open"
      | "source-opened"
      | "source-read"
      | "source-reverified"
      | "destination-synced"
      | "sandbox-renamed"
      | "after-snapshot"
      | "after-manifest"
      | "after-action"
      | "after-attempt"
      | "after-commit",
  ) => void | Promise<void>;
};

let testExecutor: SandboxExecutor | null = null;

export function setSandboxExecutorForTests(executor: SandboxExecutor | null): void {
  testExecutor = executor;
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
      // Preserve the stable execution error.
    }
    throw error;
  }
}

async function writeBaselineManifest(
  sandboxRoot: string,
  manifest: {
    entries: Array<{
      identity: string;
      modeTag: string;
      path: string;
      sha256: string;
      size: number;
    }>;
    hash: string;
  },
): Promise<string> {
  const path = join(dirname(sandboxRoot), "baseline-manifest.json");
  const temporary = `${path}.tmp-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, JSON.stringify(manifest), { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  return path;
}

async function writeSandboxManifest(
  sandboxRoot: string,
  manifest: {
    entries: Array<{
      identity: string;
      modeTag: string;
      path: string;
      sha256: string;
      size: number;
    }>;
    hash: string;
  },
): Promise<string> {
  const path = join(dirname(sandboxRoot), `sandbox-manifest-${randomUUID()}.json`);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
  return path;
}

type SandboxFailure = {
  actionStatus: "failed" | "interrupted";
  attemptStatus: "failed" | "interrupted";
  code: string;
  executionStatus: "failed" | "paused";
  httpStatus: number;
};

function sandboxFailure(error: unknown): SandboxFailure {
  const code: string =
    typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
    : "INTERNAL_ERROR";
  if (code === "SPECIAL_FILE_REJECTED") {
    return {
      actionStatus: "failed",
      attemptStatus: "interrupted",
      code,
      executionStatus: "paused",
      httpStatus: 422,
    };
  }
  if (code === "SANDBOX_LIMIT_EXCEEDED") {
    return {
      actionStatus: "failed",
      attemptStatus: "interrupted",
      code,
      executionStatus: "paused",
      httpStatus: 413,
    };
  }
  if (code === "SANDBOX_BUILD_DEADLINE_EXCEEDED") {
    return {
      actionStatus: "interrupted",
      attemptStatus: "interrupted",
      code,
      executionStatus: "paused",
      httpStatus: 504,
    };
  }
  if (code === "SANDBOX_UNVERIFIABLE" || code === "SANDBOX_ROOT_INTERSECTION") {
    return {
      actionStatus: "failed",
      attemptStatus: "failed",
      code: "SANDBOX_UNVERIFIABLE",
      executionStatus: "failed",
      httpStatus: 422,
    };
  }
  return {
    actionStatus: "failed",
    attemptStatus: "interrupted",
    code: "INTERNAL_ERROR",
    executionStatus: "paused",
    httpStatus: 500,
  };
}

function finalizeSandboxFailure(
  input: SandboxExecutionInput,
  failure: SandboxFailure,
): SandboxExecutionOutcome {
  const database = openDatabase(input.databasePath);
  try {
    transaction(database, () => {
      const action = database.prepare(`
        UPDATE execution_actions
        SET status=?,lease_token=NULL,lease_expires_at=NULL,error_code=?,
            result_json=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND id=? AND execution_id=? AND attempt_id=?
          AND operation_id=? AND kind='sandbox_build' AND status='running'
          AND lease_token=?
      `).run(
        failure.actionStatus,
        failure.code,
        JSON.stringify({ code: failure.code }),
        input.projectId,
        input.actionId,
        input.executionId,
        input.attemptId,
        input.operationId,
        input.leaseToken,
      );
      if (action.changes !== 1) {
        throw new ExecutionError(
          "SANDBOX_ACTION_INTERRUPTED",
          409,
          "Sandbox failure lost its action lease.",
        );
      }
      const attempt = database.prepare(`
        UPDATE execution_attempts
        SET status=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND id=? AND execution_id=? AND status='preparing'
      `).run(
        failure.attemptStatus,
        input.projectId,
        input.attemptId,
        input.executionId,
      );
      const execution = database.prepare(`
        UPDATE executions
        SET status=?,resume_target=?,reason_code=?,version=version+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND id=? AND status='queued'
          AND first_running_at IS NULL AND business_deadline_at IS NULL
      `).run(
        failure.executionStatus,
        failure.executionStatus === "paused" ? "queued" : null,
        failure.code,
        input.projectId,
        input.executionId,
      );
      if (attempt.changes !== 1 || execution.changes !== 1) {
        throw new ExecutionError(
          "MERGE_INVARIANT_FAILED",
          500,
          "Sandbox failure facts could not be finalized.",
        );
      }
      const body = {
        error: {
          code: failure.code,
          message: "Sandbox preparation failed.",
        },
      };
      const receipt = database.prepare(`
        UPDATE execution_operations
        SET status='completed',final_action_index=0,http_status=?,response_json=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND id=? AND execution_id=? AND status='pending'
          AND action_count=1
      `).run(
        failure.httpStatus,
        JSON.stringify(body),
        input.projectId,
        input.operationId,
        input.executionId,
      );
      if (receipt.changes !== 1) {
        throw new ExecutionError(
          "MERGE_INVARIANT_FAILED",
          500,
          "Sandbox failure receipt could not be completed.",
        );
      }
    });
    return { code: failure.code, httpStatus: failure.httpStatus, kind: "failed" };
  } finally {
    database.close();
  }
}

export function createProductionSandboxExecutor(
  dependencies: ProductionSandboxExecutorDependencies = {},
): SandboxExecutor {
  return async (input) => {
    const [preflightModule, snapshotModule] = await Promise.all([
      import("@/src/adapters/outbound/workspace/sandbox-preflight"),
      import("@/src/adapters/outbound/workspace/sandbox-snapshot"),
    ]);
    type Adapter = NonNullable<
      Parameters<typeof preflightModule.preflightSandbox>[0]["platform"]
    >;
    const adapter = await (
      dependencies.createAdapter?.() ?? preflightModule.createDefaultSandboxFsAdapter()
    ) as Adapter;
    let snapshot;
    try {
      const preflight = await preflightModule.preflightSandbox({
        canonicalRoot: input.canonicalRoot,
        managedSandboxRoot: dirname(dirname(dirname(dirname(input.sandboxRoot)))),
        platform: adapter,
      });
      let lastHeartbeat = Date.now();
      snapshot = await snapshotModule.buildSandboxSnapshot({
        hooks: {
          async onPhase(phase) {
            await dependencies.onPhase?.(phase);
            const now = Date.now();
            if (now - lastHeartbeat < 30_000) return;
            const heartbeatDatabase = openDatabase(input.databasePath);
            try {
              const heartbeat = heartbeatDatabase.prepare(`
                UPDATE execution_actions
                SET lease_expires_at=min(
                      strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds'),
                      overall_deadline_at
                    ),
                    last_heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE project_id=? AND id=? AND status='running' AND lease_token=?
                  AND lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
                  AND overall_deadline_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
              `).run(input.projectId, input.actionId, input.leaseToken);
              if (heartbeat.changes !== 1) {
                throw new ExecutionError(
                  "SANDBOX_ACTION_INTERRUPTED",
                  409,
                  "Sandbox action heartbeat lost its lease.",
                );
              }
              lastHeartbeat = now;
            } finally {
              heartbeatDatabase.close();
            }
          },
        },
        platform: adapter,
        preflight,
        sandboxRoot: input.sandboxRoot,
        sourceRoot: input.canonicalRoot,
      });
    } catch (error) {
      return finalizeSandboxFailure(input, sandboxFailure(error));
    }
    await dependencies.onPhase?.("after-snapshot");
    if (Date.now() >= Date.parse(input.overallDeadlineAt)) {
      return finalizeSandboxFailure(input, sandboxFailure({
        code: "SANDBOX_BUILD_DEADLINE_EXCEEDED",
      }));
    }
    const manifestPath = await writeBaselineManifest(input.sandboxRoot, {
      entries: snapshot.files,
      hash: snapshot.manifestHash,
    });
    const sandboxManifestPath = await writeSandboxManifest(input.sandboxRoot, {
      entries: snapshot.sandboxFiles,
      hash: snapshot.manifestHash,
    });
    await dependencies.onPhase?.("after-manifest");

    const database = openDatabase(input.databasePath);
    try {
      transaction(database, () => {
        const action = database.prepare(`
          UPDATE execution_actions
          SET status='succeeded',lease_token=NULL,lease_expires_at=NULL,
              result_json=?,error_code=NULL,
              finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE project_id=? AND id=? AND execution_id=? AND attempt_id=?
            AND operation_id=? AND kind='sandbox_build' AND status='running'
            AND lease_token=? AND lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
            AND overall_deadline_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        `).run(
          JSON.stringify({ manifestHash: snapshot.manifestHash }),
          input.projectId,
          input.actionId,
          input.executionId,
          input.attemptId,
          input.operationId,
          input.leaseToken,
        );
        if (action.changes !== 1) {
          throw new ExecutionError(
            "SANDBOX_ACTION_INTERRUPTED",
            409,
            "Sandbox action lost its lease before finalization.",
          );
        }
        const operation = database.prepare(`
          SELECT kind FROM execution_operations
          WHERE project_id=? AND id=? AND execution_id=? AND status='pending'
            AND kind IN ('start','retry')
        `).get(input.projectId, input.operationId, input.executionId) as
          | { kind: "retry" | "start" }
          | undefined;
        if (!operation) {
          throw new ExecutionError(
            "MERGE_INVARIANT_FAILED",
            500,
            "Sandbox operation is not pending.",
          );
        }
        void dependencies.onPhase?.("after-action");
        const attempt = database.prepare(`
          UPDATE execution_attempts
          SET status='ready',baseline_manifest_path=?,baseline_manifest_hash=?,
              sandbox_manifest_path=?,sandbox_manifest_hash=?
          WHERE project_id=? AND id=? AND execution_id=? AND status='preparing'
        `).run(
          manifestPath,
          snapshot.manifestHash,
          sandboxManifestPath,
          snapshot.manifestHash,
          input.projectId,
          input.attemptId,
          input.executionId,
        );
        if (attempt.changes !== 1) {
          throw new ExecutionError(
            "MERGE_INVARIANT_FAILED",
            500,
            "Sandbox attempt could not become ready.",
          );
        }
        void dependencies.onPhase?.("after-attempt");
        const body = startExecutionResponseSchema.parse({
          execution: executionDtoFromDatabase(database, input.executionId),
        });
        const receipt = database.prepare(`
          UPDATE execution_operations
          SET status='completed',final_action_index=0,http_status=?,response_json=?,
              updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE project_id=? AND id=? AND execution_id=? AND kind=?
            AND status='pending' AND action_count=1
        `).run(
          operation.kind === "start" ? 201 : 200,
          JSON.stringify(body),
          input.projectId,
          input.operationId,
          input.executionId,
          operation.kind,
        );
        if (receipt.changes !== 1) {
          throw new ExecutionError(
            "MERGE_INVARIANT_FAILED",
            500,
            "Sandbox start receipt could not be completed.",
          );
        }
      });
    } finally {
      database.close();
    }
    await dependencies.onPhase?.("after-commit");
    return { kind: "completed" };
  };
}

export function sandboxExecutor(): SandboxExecutor {
  return testExecutor ?? createProductionSandboxExecutor();
}
