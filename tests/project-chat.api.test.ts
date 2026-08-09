import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createMission } from "@/src/composition/mission-commands";

type Route = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<Route>([
  "../app/api/projects/[projectId]/threads/[threadId]/messages/route.ts",
  "../app/api/projects/[projectId]/threads/[threadId]/runs/route.ts",
]);

let directory: string;
let databasePath: string;
let threadId: string;
const MASTER_KEY = Buffer.alloc(32, 38).toString("base64url");

async function route(path: "messages" | "runs"): Promise<Route> {
  const key =
    `../app/api/projects/[projectId]/threads/[threadId]/${path}/route.ts`;
  const load = routeModules[key];
  expect(load, `${path} route must exist`).toBeTypeOf("function");
  return load();
}

function seedReadyProject(): void {
  const database = openDatabase(databasePath);
  const credential = createCredentialVault().encrypt("provider-1", "fixture-key");
  try {
    database.exec(`
      INSERT INTO projects (
        id, name, created_at, workspace_path, workspace_key, version
      ) VALUES (
        'project-1', 'Project', '2026-07-30T00:00:00.000Z',
        'D:\\workspace', 'd:/workspace', 1
      );
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv,
        api_key_tag, credential_version, credential_generation, key_id,
        api_key_mask, verified_at, version, created_at, updated_at
      ) VALUES (
        'provider-1', 'Local', 'http://127.0.0.1:4000/v1', 'model',
        '${credential.apiKeyCipher}', '${credential.apiKeyIv}',
        '${credential.apiKeyTag}', ${credential.credentialVersion}, 1,
        '${credential.keyId}', '${credential.apiKeyMask}',
        '2026-07-30T00:00:00.000Z', 1,
        '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text,
        accent_token, can_read, can_write, can_execute, max_tokens,
        max_handoffs, version, created_at, updated_at
      ) VALUES
        (
          'agent-a', 'Alpha', 'Peer', 'Prompt', 'provider-1', 'model', 'A',
          'sage', 1, 0, 0, 1000, 5, 1,
          '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
        ),
        (
          'agent-b', 'Beta', 'Peer', 'Prompt', 'provider-1', 'model', 'B',
          'sage', 1, 0, 0, 1000, 5, 1,
          '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
        );
      INSERT INTO project_memberships (project_id, agent_id, joined_at)
      VALUES ('project-1', 'agent-a', 'a'), ('project-1', 'agent-b', 'b');
    `);
  } finally {
    database.close();
  }
  createMission(databasePath, "project-1", {
    expectedVersion: 0,
    goal: "Goal",
    operationId: "16000000-0000-4000-8000-000000000110",
    title: "Mission",
  });
  threadId = createThread(databasePath, "project-1", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000000309",
    title: "Project chat",
  }).body.thread.id;
}

async function post(
  path: "messages" | "runs",
  body: Record<string, unknown>,
): Promise<Response> {
  return (await route(path)).POST(
    new Request(
      `http://localhost/api/projects/project-1/threads/${threadId}/${path}`,
      {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
      },
    ),
    { params: Promise.resolve({ projectId: "project-1", threadId }) },
  );
}

async function start(
  operationId = "00000000-0000-4000-8000-000000000310",
): Promise<Record<string, any>> {
  const response = await post("runs", { message: "Start", operationId });
  expect(response.status).toBe(201);
  return response.json();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "project-chat-api-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("project chat API terminal semantics", () => {
  it("stores a project message with no active run without creating one", async () => {
    seedReadyProject();

    const response = await post("messages", {
      content: "A note before collaboration",
      operationId: "00000000-0000-4000-8000-000000000311",
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      message: { content: "A note before collaboration", runId: null, sequence: 1 },
    });
    const database = openDatabase(databasePath);
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM collaboration_runs").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it("appends a project message to the active run and deduplicates it", async () => {
    seedReadyProject();
    const started = await start();
    const input = {
      content: "Owner interjection",
      mentionAgentId: "agent-b",
      operationId: "00000000-0000-4000-8000-000000000312",
    };

    const first = await post("messages", input);
    const firstBody = await first.json();
    const replay = await post("messages", input);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(first.status);
    expect(await replay.json()).toEqual(firstBody);
    expect(firstBody).toMatchObject({
      message: { mentionAgentId: "agent-b", runId: null, sequence: 2 },
    });
    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(
        "SELECT status FROM collaboration_runs WHERE id=?",
      ).get(started.run.id)).toEqual({ status: "running" });
    } finally {
      database.close();
    }
  });

  it("rejects a reused project-message operation id with different content", async () => {
    seedReadyProject();
    const operationId = "00000000-0000-4000-8000-000000000313";
    await post("messages", { content: "First", operationId });

    const conflict = await post("messages", { content: "Second", operationId });

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: {
        code: "OPERATION_CONFLICT",
        message: "Operation id was already used for different input.",
      },
    });
  });

  it.each(["planned", "stopped"] as const)(
    "does not revive a %s run when posting a project message",
    async (status) => {
      seedReadyProject();
      const started = await start();
      const database = openDatabase(databasePath);
      try {
        database
          .prepare("UPDATE collaboration_runs SET status = ? WHERE id = ?")
          .run(status, started.run.id);
      } finally {
        database.close();
      }

      const response = await post("messages", {
        content: `After ${status}`,
        operationId:
          status === "planned"
            ? "00000000-0000-4000-8000-000000000314"
            : "00000000-0000-4000-8000-000000000315",
      });

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        message: { runId: null },
      });
      const check = openDatabase(databasePath);
      try {
        expect(
          check.prepare("SELECT status FROM collaboration_runs WHERE id = ?").get(started.run.id),
        ).toEqual({ status });
      } finally {
        check.close();
      }
    },
  );

  it("starts an explicit new run after a terminal run", async () => {
    seedReadyProject();
    const first = await start();
    const database = openDatabase(databasePath);
    try {
      database
        .prepare("UPDATE collaboration_runs SET status = 'stopped' WHERE id = ?")
        .run(first.run.id);
    } finally {
      database.close();
    }

    const response = await post("runs", {
      message: "Explicitly start again",
      operationId: "00000000-0000-4000-8000-000000000316",
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      created: true,
      message: { runId: expect.any(String), sequence: 2 },
      run: { status: "running" },
    });
    expect(body.run.id).not.toBe(first.run.id);
  });
});
