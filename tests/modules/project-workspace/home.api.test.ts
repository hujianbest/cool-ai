import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type HomeRouteModule = {
  GET(): Promise<Response>;
  POST(request: Request): Promise<Response>;
};

const routeModules = import.meta.glob<HomeRouteModule>(
  "../../../app/api/home/route.ts",
);

let previousDatabasePath: string | undefined;

function seedProvider(): void {
  const databasePath = process.env.COCKPIT_DB_PATH;
  if (!databasePath) throw new Error("Test database path is unavailable.");
  const database = openDatabase(databasePath);
  database.exec(`
    INSERT INTO providers (
      id, name, base_url, default_model, api_key_cipher, api_key_iv, api_key_tag,
      credential_version, credential_generation, key_id, api_key_mask, verified_at,
      version, created_at, updated_at
    ) VALUES (
      'provider-1', 'Provider', 'https://example.invalid', 'model-a',
      'cipher-secret', 'iv-secret', 'tag-secret', 1, 1, 'key-secret', '****', 'now', 1, 'now', 'now'
    );
  `);
  database.close();
}

function seedAgent(): void {
  seedProvider();
  const databasePath = process.env.COCKPIT_DB_PATH;
  if (!databasePath) throw new Error("Test database path is unavailable.");
  const database = openDatabase(databasePath);
  database.exec(`
    INSERT INTO agents (
      id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
      can_read, can_write, can_execute, max_tokens, max_handoffs, version, created_at, updated_at
    ) VALUES (
      'agent-alpha', 'Alpha', 'Plans', 'private system prompt', 'provider-1', 'model-a', 'A', 'sage',
      1, 0, 0, 1000, 1, 1, '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'
    );
  `);
  database.close();
}

async function loadRoute(): Promise<HomeRouteModule> {
  const load = routeModules["../../../app/api/home/route.ts"];
  expect(load, "the home route must exist").toBeTypeOf("function");
  return load();
}

beforeEach(() => {
  previousDatabasePath = process.env.COCKPIT_DB_PATH;
  process.env.COCKPIT_DB_PATH = memoryDatabasePath();
});

afterEach(() => {
  if (previousDatabasePath === undefined) {
    delete process.env.COCKPIT_DB_PATH;
  } else {
    process.env.COCKPIT_DB_PATH = previousDatabasePath;
  }
});

describe("GET /api/home", () => {
  it("returns only the needs-agent discriminator when no agent exists", async () => {
    const route = await loadRoute();

    const response = await route.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "needs_agent" });
  });

  it("does not mint starter agents on a read of an empty roster", async () => {
    const route = await loadRoute();
    seedProvider();

    const response = await route.GET();
    const databasePath = process.env.COCKPIT_DB_PATH;
    if (!databasePath) throw new Error("Test database path is unavailable.");
    const database = openDatabase(databasePath);
    const agentCount = database.prepare("SELECT COUNT(*) AS count FROM agents").get() as {
      count: number;
    };
    database.close();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "needs_agent" });
    expect(agentCount.count).toBe(0);
  });

  it("does not create a personal conversation project on a read", async () => {
    const route = await loadRoute();
    seedAgent();

    const response = await route.GET();
    const databasePath = process.env.COCKPIT_DB_PATH;
    if (!databasePath) throw new Error("Test database path is unavailable.");
    const database = openDatabase(databasePath);
    const projectCount = database.prepare("SELECT COUNT(*) AS count FROM projects").get() as {
      count: number;
    };
    database.close();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "needs_direct_chat" });
    expect(projectCount.count).toBe(0);
  });
});

describe("POST /api/home", () => {
  it("rejects a request body", async () => {
    const route = await loadRoute();

    const response = await route.POST(
      new Request("http://localhost/api/home", {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "Home does not accept a request body.",
      },
    });
  });

  it("returns needs-agent without writing a personal conversation project", async () => {
    const route = await loadRoute();

    const response = await route.POST(new Request("http://localhost/api/home", { method: "POST" }));
    const databasePath = process.env.COCKPIT_DB_PATH;
    if (!databasePath) throw new Error("Test database path is unavailable.");
    const database = openDatabase(databasePath);
    const projectCount = database.prepare("SELECT COUNT(*) AS count FROM projects").get() as {
      count: number;
    };
    database.close();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "needs_agent" });
    expect(projectCount.count).toBe(0);
  });

  it("creates one stable sanitized ready home that later reads reuse", async () => {
    const route = await loadRoute();
    seedAgent();

    const firstResponse = await route.POST(
      new Request("http://localhost/api/home", { method: "POST" }),
    );
    const firstPayload = await firstResponse.json();
    const secondResponse = await route.POST(
      new Request("http://localhost/api/home", { method: "POST" }),
    );
    const secondPayload = await secondResponse.json();
    const readResponse = await route.GET();
    const readPayload = await readResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(firstPayload).toEqual({
      agent: {
        accentToken: "sage",
        avatarText: "A",
        id: "agent-alpha",
        name: "Alpha",
        role: "Plans",
      },
      kind: "ready",
      project: {
        createdAt: expect.any(String),
        id: expect.any(String),
        name: "个人对话",
      },
      threads: [],
    });
    expect(secondResponse.status).toBe(200);
    expect(secondPayload).toEqual(firstPayload);
    expect(readResponse.status).toBe(200);
    expect(readPayload).toEqual(firstPayload);
    expect(JSON.stringify(firstPayload)).not.toContain("private system prompt");
    expect(JSON.stringify(firstPayload)).not.toContain("cipher-secret");
  });
});
