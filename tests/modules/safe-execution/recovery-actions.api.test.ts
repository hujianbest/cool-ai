import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as postExecute } from "@/app/api/executions/[executionId]/recovery-actions/[actionId]/execute/route";
import { POST as postUndo } from "@/app/api/executions/[executionId]/recovery-actions/[actionId]/undo/route";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

import { seedStaleExecution } from "./recovery-actions.test";

const EXECUTION_ID = "recovery-execution";
const OPERATION_ID = "00000000-0000-4000-8000-000000000050";

function request(body: unknown): Request {
  return new Request("http://localhost/api/executions/recovery-execution/recovery-actions/resume_queued/execute", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("recovery action API", () => {
  it("executes resume_queued and rejects unknown or irreversible undo paths", async () => {
    const databasePath = memoryDatabasePath();
    const database = openDatabase(databasePath);
    const version = seedStaleExecution(database);
    database.close();
    vi.stubEnv("COCKPIT_DB_PATH", databasePath);
    try {
      const executed = await postExecute(request({
        confirmation: "执行救援",
        expectedVersion: version,
        operationId: OPERATION_ID,
      }), {
        params: Promise.resolve({
          actionId: "resume_queued",
          executionId: EXECUTION_ID,
        }),
      });
      expect(executed.status).toBe(200);
      expect(executed.headers.get("cache-control")).toBe("no-store");
      expect(await executed.json()).toEqual({
        actionId: "resume_queued",
        executionId: EXECUTION_ID,
        fromStatus: "stale",
        toStatus: "queued",
        version: version + 1,
        writesFiles: false,
      });

      const unknown = await postExecute(request({
        confirmation: "执行救援",
        expectedVersion: version + 1,
        operationId: "00000000-0000-4000-8000-000000000051",
      }), {
        params: Promise.resolve({
          actionId: "rm_rf",
          executionId: EXECUTION_ID,
        }),
      });
      expect(unknown.status).toBe(400);

      const undo = await postUndo(request({
        confirmation: "撤销救援",
        expectedVersion: version + 1,
        operationId: "00000000-0000-4000-8000-000000000052",
      }), {
        params: Promise.resolve({
          actionId: "resume_queued",
          executionId: EXECUTION_ID,
        }),
      });
      expect(undo.status).toBe(400);
      expect(await undo.json()).toEqual({
        error: { code: "INVALID_INPUT", message: "The request is invalid." },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
