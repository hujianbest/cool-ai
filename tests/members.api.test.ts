import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";

type MembersRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
  PUT(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const routeModules =
  import.meta.glob<MembersRoute>("../app/api/projects/[projectId]/members/route.ts");

let directory: string;
let databasePath: string;

async function loadRoute(): Promise<MembersRoute> {
  const load = routeModules["../app/api/projects/[projectId]/members/route.ts"];
  expect(load, "the project members route must exist").toBeTypeOf("function");
  return load();
}

function seedAgents(): void {
  const database = openDatabase(databasePath);
  database.exec(`
    INSERT INTO providers (
      id, name, base_url, default_model, api_key_cipher, api_key_iv, api_key_tag,
      credential_version, credential_generation, key_id, api_key_mask, verified_at,
      version, created_at, updated_at
    ) VALUES (
      'provider-api', 'Provider', 'https://example.invalid', 'model-api',
      'cipher', 'iv', 'tag', 1, 1, 'key', '****', 'now', 1, 'now', 'now'
    );
    INSERT INTO agents (
      id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
      can_read, can_write, can_execute, max_tokens, max_handoffs, version, created_at, updated_at
    ) VALUES
      (
        'agent-one', 'One', 'Plans', 'private one', 'provider-api', 'model-api', '1', 'sage',
        1, 0, 0, 1000, 1, 1, 'now', 'now'
      ),
      (
        'agent-two', 'Two', 'Builds', 'private two', 'provider-api', 'model-api', '2', 'gold',
        1, 1, 1, 1000, 1, 1, 'now', 'now'
      );
  `);
  database.close();
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-members-api-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("project members API", () => {
  it("gets and fully replaces a public equal roster", async () => {
    const route = await loadRoute();
    const project = createProject("API roster", databasePath);
    seedAgents();
    const context = { params: Promise.resolve({ projectId: project.id }) };

    const emptyResponse = await route.GET(
      new Request(`http://localhost/api/projects/${project.id}/members`),
      context,
    );
    expect(emptyResponse.status).toBe(200);
    await expect(emptyResponse.json()).resolves.toEqual({
      members: [],
      projectVersion: 1,
    });

    const response = await route.PUT(
      jsonRequest(`http://localhost/api/projects/${project.id}/members`, {
        agentIds: ["agent-two", "agent-one"],
        expectedProjectVersion: 1,
      }),
      context,
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.projectVersion).toBe(2);
    expect(payload.members.map(({ agentId }: { agentId: string }) => agentId)).toEqual([
      "agent-one",
      "agent-two",
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/leader|rank|systemPrompt|providerId/i);
  });

  it("returns stable validation, missing-agent, conflict, and JSON errors", async () => {
    const route = await loadRoute();
    const project = createProject("API errors", databasePath);
    seedAgents();
    const context = { params: Promise.resolve({ projectId: project.id }) };
    const url = `http://localhost/api/projects/${project.id}/members`;

    const invalidJson = await route.PUT(
      new Request(url, {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "PUT",
      }),
      context,
    );
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toEqual({
      error: {
        code: "INVALID_JSON",
        message: "Request body must be valid JSON.",
      },
    });

    const tooFew = await route.PUT(
      jsonRequest(url, {
        agentIds: ["agent-one"],
        expectedProjectVersion: 1,
      }),
      context,
    );
    expect(tooFew.status).toBe(400);
    await expect(tooFew.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [{ code: "too_small", field: "agentIds" }],
        message: "Project members input is invalid.",
      },
    });

    const missing = await route.PUT(
      jsonRequest(url, {
        agentIds: ["agent-one", "missing-agent"],
        expectedProjectVersion: 1,
      }),
      context,
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "AGENT_NOT_FOUND",
        message: "One or more agents were not found.",
      },
    });

    const created = await route.PUT(
      jsonRequest(url, {
        agentIds: ["agent-one", "agent-two"],
        expectedProjectVersion: 1,
      }),
      context,
    );
    expect(created.status).toBe(200);

    const stale = await route.PUT(
      jsonRequest(url, {
        agentIds: ["agent-one", "agent-two"],
        expectedProjectVersion: 1,
      }),
      context,
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: {
        code: "RESOURCE_CONFLICT",
        currentVersion: 2,
        message: "Project version is stale.",
      },
    });
  });
});
