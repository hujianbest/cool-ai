import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMission } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

type ContextRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const routeModules =
  import.meta.glob<ContextRoute>("../app/api/projects/[projectId]/context/route.ts");

let directory: string;
let databasePath: string;

async function route(): Promise<ContextRoute> {
  const load =
    routeModules["../app/api/projects/[projectId]/context/route.ts"];
  expect(load, "the deterministic context route must exist").toBeTypeOf("function");
  return load();
}

function seedAgents(projectId: string, includeSecondMember = true): void {
  const database = openDatabase(databasePath);
  database.exec(`
    INSERT INTO providers (
      id, name, base_url, default_model, api_key_cipher, api_key_iv, api_key_tag,
      credential_version, credential_generation, key_id, api_key_mask, verified_at,
      version, created_at, updated_at
    ) VALUES (
      'provider-api-context', 'Provider', 'https://never-expose.invalid', 'model',
      'cipher-secret', 'iv-secret', 'tag-secret', 1, 1, 'key-secret',
      'Authorization secret', 'now', 1, 'now', 'now'
    );
    INSERT INTO agents (
      id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
      can_read, can_write, can_execute, max_tokens, max_handoffs, version, created_at, updated_at
    ) VALUES
      (
        'agent-one', 'One', 'Plans', 'One prompt', 'provider-api-context', 'model', '1', 'sage',
        1, 0, 0, 1000, 1, 1, 'now', 'now'
      ),
      (
        'agent-two', 'Two', 'Builds', 'Two prompt', 'provider-api-context', 'model', '2', 'gold',
        1, 1, 1, 1000, 1, 1, 'now', 'now'
      ),
      (
        'agent-outside', 'Outside', 'Waits', 'Outside prompt', 'provider-api-context', 'model', 'O', 'slate',
        1, 0, 0, 1000, 1, 1, 'now', 'now'
      );
  `);
  database
    .prepare(
      `INSERT INTO project_memberships (project_id, agent_id, joined_at)
       VALUES (?, 'agent-one', 'a')`,
    )
    .run(projectId);
  if (includeSecondMember) {
    database
      .prepare(
        `INSERT INTO project_memberships (project_id, agent_id, joined_at)
         VALUES (?, 'agent-two', 'b')`,
      )
      .run(projectId);
  }
  database.close();
}

function bindWorkspace(projectId: string): void {
  const database = openDatabase(databasePath);
  database
    .prepare(
      "UPDATE projects SET workspace_path = ?, workspace_key = ? WHERE id = ?",
    )
    .run(directory, directory.toLowerCase(), projectId);
  database.close();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-context-api-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("project context API", () => {
  it("returns the same deterministic snapshot on repeated GET", async () => {
    const contextRoute = await route();
    const project = createProject("Context API", databasePath);
    seedAgents(project.id);
    bindWorkspace(project.id);
    createMission(databasePath, project.id, {
      expectedVersion: 0,
      goal: "Goal",
      operationId: "16000000-0000-4000-8000-000000000108",
      title: "Mission",
    });
    const context = { params: Promise.resolve({ projectId: project.id }) };
    const url = `http://localhost/api/projects/${project.id}/context?agentId=agent-one`;

    const first = await contextRoute.GET(new Request(url), context);
    const second = await contextRoute.GET(new Request(url), context);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
  });

  it("returns stable readiness, nonmember, missing-agent, and query errors", async () => {
    const contextRoute = await route();
    const project = createProject("Context errors", databasePath);
    seedAgents(project.id, false);
    const context = { params: Promise.resolve({ projectId: project.id }) };
    const base = `http://localhost/api/projects/${project.id}/context`;

    const missingQuery = await contextRoute.GET(new Request(base), context);
    expect(missingQuery.status).toBe(400);
    await expect(missingQuery.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [{ code: "required", field: "agentId" }],
        message: "Context request is invalid.",
      },
    });

    const notReady = await contextRoute.GET(
      new Request(`${base}?agentId=agent-one`),
      context,
    );
    expect(notReady.status).toBe(409);
    await expect(notReady.json()).resolves.toEqual({
      error: {
        code: "CONTEXT_NOT_READY",
        message: "Project context is not ready.",
        missing: ["workspace", "members", "mission"],
      },
    });

    const nonmember = await contextRoute.GET(
      new Request(`${base}?agentId=agent-outside`),
      context,
    );
    expect(nonmember.status).toBe(409);
    await expect(nonmember.json()).resolves.toEqual({
      error: {
        code: "AGENT_NOT_MEMBER",
        message: "Selected agent is not a project member.",
      },
    });

    const missingAgent = await contextRoute.GET(
      new Request(`${base}?agentId=missing`),
      context,
    );
    expect(missingAgent.status).toBe(404);
    await expect(missingAgent.json()).resolves.toEqual({
      error: {
        code: "AGENT_NOT_FOUND",
        message: "Agent was not found.",
      },
    });
  });
});
