import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collaborationErrorResponse } from "@/src/server/collaboration/collaboration-api";
import { CollaborationError } from "@/src/server/collaboration/collaboration-errors";
import { openDatabase } from "@/src/server/db";
import { apiErrorCopy } from "@/src/shared/api-error-copy";

type Route = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<Route>(
  "../app/api/projects/[projectId]/runs/route.ts",
);

let directory: string;
let databasePath: string;

async function route(): Promise<Route> {
  const load = routeModules["../app/api/projects/[projectId]/runs/route.ts"];
  expect(load).toBeTypeOf("function");
  return load();
}

function seedProject(ready = true): void {
  const database = openDatabase(databasePath);
  const timestamp = "2026-07-30T00:00:00.000Z";
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
           'cipher', 'iv', 'tag', 1, 1, 'key-1', '***', ?, 1, ?, ?
         )`,
      )
      .run(timestamp, timestamp, timestamp);
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
    if (ready) {
      database
        .prepare(
          `INSERT INTO missions (
             id, project_id, title, goal, version, created_at, updated_at
           ) VALUES ('mission-1', 'project-1', 'Mission', 'Goal', 1, ?, ?)`,
        )
        .run(timestamp, timestamp);
    }
  } finally {
    database.close();
  }
}

async function post(body: Record<string, unknown>): Promise<Response> {
  return (await route()).POST(
    new Request("http://localhost/api/projects/project-1/runs", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ projectId: "project-1" }) },
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-operations-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
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

  it("returns the stable in-progress envelope for a matching pending receipt", async () => {
    seedProject();
    const input = {
      message: "Pending body",
      operationId: "00000000-0000-4000-8000-000000000303",
    };
    await post(input);
    const database = openDatabase(databasePath);
    try {
      database
        .prepare(
          `UPDATE collaboration_operations
           SET status = 'pending', http_status = NULL, response_json = NULL
           WHERE project_id = 'project-1' AND id = ?`,
        )
        .run(input.operationId);
    } finally {
      database.close();
    }

    const pending = await post(input);

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
      database
        .prepare(
          `INSERT INTO missions (
             id, project_id, title, goal, version, created_at, updated_at
           ) VALUES (
             'mission-late', 'project-1', 'Mission', 'Goal', 1,
             '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
           )`,
        )
        .run();
    } finally {
      database.close();
    }

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
