import { describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { setDirectChatAgent } from "@/src/adapters/outbound/sqlite/project-workspace/membership-service";
import {
  createProject,
  ensureDirectProject,
} from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

function seedAgents(databasePath: string): void {
  const database = openDatabase(databasePath);
  database.exec(`
    INSERT INTO providers (
      id, name, base_url, default_model, api_key_cipher, api_key_iv, api_key_tag,
      credential_version, credential_generation, key_id, api_key_mask, verified_at,
      version, created_at, updated_at
    ) VALUES (
      'provider-1', 'Provider', 'https://example.invalid', 'model-a',
      'cipher', 'iv', 'tag', 1, 1, 'key', '****', 'now', 1, 'now', 'now'
    );
    INSERT INTO agents (
      id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
      can_read, can_write, can_execute, max_tokens, max_handoffs, version, created_at, updated_at
    ) VALUES
      (
        'agent-alpha', 'Alpha', 'Plans', 'private alpha', 'provider-1', 'model-a', 'A', 'sage',
        1, 0, 0, 1000, 1, 1, '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'
      ),
      (
        'agent-beta', 'Beta', 'Builds', 'private beta', 'provider-1', 'model-a', 'B', 'gold',
        1, 1, 1, 1000, 1, 1, '2026-07-29T00:00:01.000Z', '2026-07-29T00:00:01.000Z'
      );
  `);
  database.close();
}

describe("direct home project commands", () => {
  it("ensures one stable unbound personal conversation project", () => {
    const databasePath = memoryDatabasePath();

    const first = ensureDirectProject(databasePath);
    const second = ensureDirectProject(databasePath);

    expect(first).toEqual(second);
    expect(first.name).toBe("个人对话");
  });

  it("sets and replaces the only agent for an unbound project", () => {
    const databasePath = memoryDatabasePath();
    const project = ensureDirectProject(databasePath);
    seedAgents(databasePath);

    const first = setDirectChatAgent(
      databasePath,
      project.id,
      "agent-alpha",
      1,
    );
    const second = setDirectChatAgent(
      databasePath,
      project.id,
      "agent-beta",
      first.projectVersion,
    );

    expect(first.members.map(({ agentId }) => agentId)).toEqual(["agent-alpha"]);
    expect(second.members.map(({ agentId }) => agentId)).toEqual(["agent-beta"]);
    expect(second.projectVersion).toBe(3);
  });

  it("keeps one-member rosters invalid for workspace-bound projects", () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Folder project", databasePath);
    seedAgents(databasePath);
    const database = openDatabase(databasePath);
    database
      .prepare(
        `UPDATE projects
         SET workspace_path = 'D:\\workspace', workspace_key = 'd:\\workspace'
         WHERE id = ?`,
      )
      .run(project.id);
    database.close();

    expect(() =>
      setDirectChatAgent(databasePath, project.id, "agent-alpha", 1),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        fields: [{ code: "workspace_bound", field: "agentIds" }],
      }),
    );
  });

  it("fails closed for missing agents and stale project versions", () => {
    const databasePath = memoryDatabasePath();
    const project = ensureDirectProject(databasePath);
    seedAgents(databasePath);

    expect(() =>
      setDirectChatAgent(databasePath, project.id, "missing-agent", 1),
    ).toThrowError(expect.objectContaining({ code: "AGENT_NOT_FOUND" }));

    setDirectChatAgent(databasePath, project.id, "agent-alpha", 1);
    expect(() =>
      setDirectChatAgent(databasePath, project.id, "agent-beta", 1),
    ).toThrowError(expect.objectContaining({ code: "RESOURCE_CONFLICT" }));
  });

  it("creates a direct thread with the sole project Agent", () => {
    const databasePath = memoryDatabasePath();
    const project = ensureDirectProject(databasePath);
    seedAgents(databasePath);
    setDirectChatAgent(databasePath, project.id, "agent-alpha", 1);

    const created = createThread(databasePath, project.id, {
      memberAgentIds: ["agent-alpha"],
      operationId: "40000000-0000-4000-8000-000000000001",
      title: "First conversation",
    });

    expect(created.status).toBe(201);
    expect(created.body.thread.policy.members.map(({ agentId }) => agentId)).toEqual([
      "agent-alpha",
    ]);
  });
});
