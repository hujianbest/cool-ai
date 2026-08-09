import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collaborationErrorResponse } from "@/src/server/collaboration/collaboration-api";
import { CollaborationError } from "@/src/modules/public-collaboration";
import {
  canonicalRequestHash,
  readOperationReceipt,
} from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createMission } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { apiErrorCopy } from "@/src/shared/api-error-copy";

type Route = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<Route>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/runs/route.ts",
);

let directory: string;
let databasePath: string;
let threadId: string;
const MASTER_KEY = Buffer.alloc(32, 37).toString("base64url");

async function route(): Promise<Route> {
  const load =
    routeModules["../../../app/api/projects/[projectId]/threads/[threadId]/runs/route.ts"];
  expect(load).toBeTypeOf("function");
  return load();
}

function seedProject(ready = true): void {
  const database = openDatabase(databasePath);
  const timestamp = "2026-07-30T00:00:00.000Z";
  const credential = createCredentialVault().encrypt("provider-1", "fixture-key");
  try {
    database
      .prepare(
        `INSERT INTO projects (
           id, name, created_at, workspace_path, workspace_key, version
         ) VALUES ('project-1', 'Project', ?, ?, ?, 1)`,
      )
      .run(
        timestamp,
        ready ? "D:\\workspace" : null,
        ready ? "d:/workspace" : null,
      );
    database
      .prepare(
        `INSERT INTO providers (
           id, name, base_url, default_model, api_key_cipher, api_key_iv,
           api_key_tag, credential_version, credential_generation, key_id,
           api_key_mask, verified_at, version, created_at, updated_at
         ) VALUES (
           'provider-1', 'Local', 'http://127.0.0.1:4000/v1', 'model',
           ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?
         )`,
      )
      .run(
        credential.apiKeyCipher,
        credential.apiKeyIv,
        credential.apiKeyTag,
        credential.credentialVersion,
        credential.keyId,
        credential.apiKeyMask,
        timestamp,
        timestamp,
        timestamp,
      );
    const insertAgent = database.prepare(
      `INSERT INTO agents (
         id, name, role, system_prompt, provider_id, model, avatar_text,
         accent_token, can_read, can_write, can_execute, max_tokens,
         max_handoffs, version, created_at, updated_at
       ) VALUES (?, ?, 'Peer', 'Prompt', 'provider-1', 'model', ?,
         'sage', 1, 0, 0, 1000, 5, 1, ?, ?)`,
    );
    insertAgent.run("agent-a", "Alpha", "A", timestamp, timestamp);
    insertAgent.run("agent-b", "Beta", "B", timestamp, timestamp);
    const insertMember = database.prepare(
      `INSERT INTO project_memberships (project_id, agent_id, joined_at)
       VALUES ('project-1', ?, ?)`,
    );
    insertMember.run("agent-a", "a");
    insertMember.run("agent-b", "b");
  } finally {
    database.close();
  }
  if (ready) {
    createMission(databasePath, "project-1", {
      expectedVersion: 0,
      goal: "Goal",
      operationId: "16000000-0000-4000-8000-000000000102",
      title: "Mission",
    });
  }
  threadId = createThread(databasePath, "project-1", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000000300",
    title: "Operation receipts",
  }).body.thread.id;
}

async function post(body: Record<string, unknown>): Promise<Response> {
  return (await route()).POST(
    new Request(
      `http://localhost/api/projects/project-1/threads/${threadId}/runs`,
      {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
      },
    ),
    { params: Promise.resolve({ projectId: "project-1", threadId }) },
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-operations-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("generalized collaboration operation receipts", () => {
  it("replays the exact successful status and body for the same hash", async () => {
    seedProject();
    const input = {
      message: "Start planning",
      operationId: "00000000-0000-4000-8000-000000000301",
    };

    const first = await post(input);
    const firstBody = await first.json();
    const replay = await post(input);

    expect(replay.status).toBe(first.status);
    await expect(replay.json()).resolves.toEqual(firstBody);
  });

  it("rejects the same operation id with a different request hash", async () => {
    seedProject();
    const operationId = "00000000-0000-4000-8000-000000000302";
    await post({ message: "First body", operationId });

    const conflict = await post({ message: "Different body", operationId });

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: {
        code: "OPERATION_CONFLICT",
        message: "Operation id was already used for different input.",
      },
    });
  });

  it("preserves the stable in-progress envelope for a legacy pending advance", async () => {
    seedProject();
    const input = {
      message: "Pending body",
      operationId: "00000000-0000-4000-8000-000000000303",
    };
    await post(input);
    const database = openDatabase(databasePath);
    let pending!: Response;
    try {
      const original = database.prepare(
        `SELECT http_status AS httpStatus,response_json AS responseJson,
                response_schema_version AS schemaVersion
         FROM collaboration_operations
         WHERE project_id='project-1' AND id=?`,
      ).get(input.operationId) as {
        httpStatus: number;
        responseJson: string;
        schemaVersion: number;
      };
      database
        .prepare(
          `UPDATE collaboration_operations
           SET kind = 'advance', status = 'pending', http_status = NULL, response_json = NULL,
               response_schema_version = NULL
           WHERE project_id = 'project-1' AND id = ?`,
        )
        .run(input.operationId);
      let error: unknown;
      try {
        readOperationReceipt(
          database,
          "project-1",
          input.operationId,
          "advance",
          canonicalRequestHash({ mentionAgentId: null, message: input.message }),
        );
      } catch (caught) {
        error = caught;
      }
      pending = collaborationErrorResponse(error, "operation receipt test");
      database.prepare(
        `UPDATE collaboration_operations
         SET status='completed',http_status=?,response_json=?,
             response_schema_version=?
         WHERE project_id='project-1' AND id=?`,
      ).run(
        original.httpStatus,
        original.responseJson,
        original.schemaVersion,
        input.operationId,
      );
    } finally {
      database.close();
    }

    expect(pending.status).toBe(409);
    await expect(pending.json()).resolves.toEqual({
      error: {
        code: "OPERATION_IN_PROGRESS",
        message: "Operation is still in progress.",
      },
    });
  });

  it("persists and exactly replays mapped domain errors", async () => {
    seedProject(false);
    const input = {
      message: "Cannot start yet",
      operationId: "00000000-0000-4000-8000-000000000304",
    };
    const first = await post(input);
    const firstBody = await first.json();

    const database = openDatabase(databasePath);
    try {
      database
        .prepare(
          `UPDATE projects
           SET workspace_path = 'D:\\workspace', workspace_key = 'd:/workspace'
           WHERE id = 'project-1'`,
        )
        .run();
    } finally {
      database.close();
    }
    createMission(databasePath, "project-1", {
      expectedVersion: 0,
      goal: "Goal",
      operationId: "16000000-0000-4000-8000-000000000103",
      title: "Mission",
    });

    const replay = await post(input);
    expect(first.status).toBe(409);
    expect(replay.status).toBe(first.status);
    await expect(replay.json()).resolves.toEqual(firstBody);
    expect(firstBody).toEqual({
      error: {
        code: "CONTEXT_NOT_READY",
        fields: { mission: "required", workspace: "required" },
        message: "Collaboration context is not ready.",
      },
    });
  });

  it("provides fixed client copy for every T-3 collaboration error", () => {
    expect(apiErrorCopy({ error: { code: "OPERATION_CONFLICT", message: "raw" } })).toBe(
      "该操作标识已用于其他请求，请重新提交。",
    );
    expect(
      apiErrorCopy({ error: { code: "OPERATION_IN_PROGRESS", message: "raw" } }),
    ).toBe("该操作仍在处理中，请稍后重试。");
    expect(apiErrorCopy({ error: { code: "AGENT_NOT_MEMBER", message: "raw" } })).toBe(
      "所选 Agent 不是项目成员。",
    );
  });

  it("maps only allowlisted CollaborationApiError envelope details", async () => {
    const response = collaborationErrorResponse(
      new CollaborationError("ACTION_CONFLICT", 409, "Stable public message.", {
        category: "action_conflict",
        currentVersion: 7,
        fields: { action: "stale" },
      }),
      "POST /test",
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        category: "action_conflict",
        code: "ACTION_CONFLICT",
        currentVersion: 7,
        fields: { action: "stale" },
        message: "Stable public message.",
      },
    });
  });
});
