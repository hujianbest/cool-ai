import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemory } from "@/src/server/memory-service";
import {
  createMission,
  createWorkItem,
} from "@/src/server/mission-service";
import { createProject } from "@/src/server/projects";
import { openDatabase } from "@/src/server/db";

type ContextSnapshot = {
  schemaVersion: 1;
  shared: {
    project: { id: string; name: string; workspacePath: string };
    roster: Array<{ agentId: string; joinedAt: string; skillNames: string[] }>;
    mission: { id: string };
    workItems: Array<{ id: string; dependencyIds: string[] }>;
    memories: Array<{ id: string; active: boolean }>;
  };
  currentAgent: {
    id: string;
    name: string;
    role: string;
    systemPrompt: string;
    skills: Array<{ id: string; name: string; instructions: string }>;
    permissions: {
      readFiles: boolean;
      writeFiles: boolean;
      runCommands: boolean;
    };
  };
};

type ContextServiceModule = {
  createContextSnapshot(
    databasePath: string,
    projectId: string,
    agentId: string,
  ): ContextSnapshot;
};

const serviceModules =
  import.meta.glob<ContextServiceModule>("../src/server/context-snapshot-service.ts");

const FORBIDDEN_KEYS = new Set([
  "apikey",
  "cipher",
  "iv",
  "tag",
  "keyid",
  "validationtoken",
  "masterkey",
  "authorization",
  "headers",
  "baseurl",
  "generatedat",
  "timestamp",
]);
const SECRET_VALUES = [
  "https://secret-provider.example/v1",
  "known-cipher",
  "known-iv",
  "known-tag",
  "known-key-id",
  "known-validation-token",
  "known-master-key",
  "Bearer known-authorization",
];

let directory: string;
let databasePath: string;

async function service(): Promise<ContextServiceModule> {
  const load = serviceModules["../src/server/context-snapshot-service.ts"];
  expect(load, "the deterministic context snapshot service must exist").toBeTypeOf(
    "function",
  );
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
      'provider-context', 'Secret Provider', 'https://secret-provider.example/v1', 'model-context',
      'known-cipher', 'known-iv', 'known-tag', 1, 1, 'known-key-id',
      'Bearer known-authorization', 'known-validation-token', 1, 'now', 'now'
    );
    INSERT INTO skills (id, name, description, instructions, version, created_at, updated_at)
      VALUES
        ('skill-plan', 'Plan', '', 'Plan safely', 1, 'now', 'now'),
        ('skill-review', 'Review', '', 'Review carefully', 1, 'now', 'now');
    INSERT INTO agents (
      id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
      can_read, can_write, can_execute, max_tokens, max_handoffs, version, created_at, updated_at
    ) VALUES
      (
        'agent-alpha', 'Alpha', 'Plans', 'Alpha private prompt', 'provider-context',
        'model-context', 'A', 'sage', 1, 0, 0, 1000, 1, 1, 'now', 'now'
      ),
      (
        'agent-beta', 'Beta', 'Builds', 'Beta private prompt', 'provider-context',
        'model-context', 'B', 'gold', 1, 1, 1, 1000, 1, 1, 'now', 'now'
      ),
      (
        'agent-outsider', 'Outsider', 'Waits', 'Outside prompt', 'provider-context',
        'model-context', 'O', 'slate', 1, 0, 0, 1000, 1, 1, 'now', 'now'
      );
    INSERT INTO agent_skills (agent_id, skill_id, position)
      VALUES
        ('agent-alpha', 'skill-review', 1),
        ('agent-alpha', 'skill-plan', 0),
        ('agent-beta', 'skill-review', 0);
  `);
  database.close();
}

function addMember(projectId: string, agentId: string, joinedAt: string): void {
  const database = openDatabase(databasePath);
  database
    .prepare(
      `INSERT INTO project_memberships (project_id, agent_id, joined_at)
       VALUES (?, ?, ?)`,
    )
    .run(projectId, agentId, joinedAt);
  database.close();
}

function bindWorkspace(projectId: string): void {
  const database = openDatabase(databasePath);
  database
    .prepare(
      `UPDATE projects
       SET workspace_path = ?, workspace_key = ?, version = version + 1
       WHERE id = ?`,
    )
    .run(directory, directory.toLowerCase(), projectId);
  database.close();
}

function collectKeysAndStrings(
  value: unknown,
  keys: string[] = [],
  strings: string[] = [],
): { keys: string[]; strings: string[] } {
  if (typeof value === "string") strings.push(value);
  else if (Array.isArray(value)) {
    value.forEach((item) => collectKeysAndStrings(item, keys, strings));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key.toLowerCase());
      collectKeysAndStrings(child, keys, strings);
    }
  }
  return { keys, strings };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-context-snapshot-"));
  databasePath = join(directory, "cockpit.sqlite");
});

afterEach(() => {
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("deterministic project context snapshot", () => {
  it("reports readiness in workspace, members, mission order and requires selected membership", async () => {
    const contexts = await service();
    const project = createProject("Readiness", databasePath);
    seedAgents();
    addMember(project.id, "agent-alpha", "2026-07-29T00:00:00.000Z");

    expect(() =>
      contexts.createContextSnapshot(databasePath, project.id, "agent-alpha"),
    ).toThrowError(
      expect.objectContaining({
        code: "CONTEXT_NOT_READY",
        missing: ["workspace", "members", "mission"],
      }),
    );

    bindWorkspace(project.id);
    expect(() =>
      contexts.createContextSnapshot(databasePath, project.id, "agent-alpha"),
    ).toThrowError(
      expect.objectContaining({
        code: "CONTEXT_NOT_READY",
        missing: ["members", "mission"],
      }),
    );

    addMember(project.id, "agent-beta", "2026-07-29T00:00:01.000Z");
    expect(() =>
      contexts.createContextSnapshot(databasePath, project.id, "agent-alpha"),
    ).toThrowError(
      expect.objectContaining({ code: "CONTEXT_NOT_READY", missing: ["mission"] }),
    );

    createMission(databasePath, project.id, { title: "Ready", goal: "Ready" });
    expect(() =>
      contexts.createContextSnapshot(databasePath, project.id, "agent-outsider"),
    ).toThrowError(expect.objectContaining({ code: "AGENT_NOT_MEMBER" }));
    expect(() =>
      contexts.createContextSnapshot(databasePath, project.id, "missing-agent"),
    ).toThrowError(expect.objectContaining({ code: "AGENT_NOT_FOUND" }));
  });

  it("repeats deeply equal snapshots with exact ordering and member-identical shared data", async () => {
    const contexts = await service();
    const project = createProject("Stable snapshot", databasePath);
    seedAgents();
    bindWorkspace(project.id);
    addMember(project.id, "agent-beta", "2026-07-29T00:00:01.000Z");
    addMember(project.id, "agent-alpha", "2026-07-29T00:00:00.000Z");
    const mission = createMission(databasePath, project.id, {
      title: "Ship context",
      goal: "Produce stable context",
    });
    const firstTask = createWorkItem(databasePath, mission.id, {
      title: "First",
      description: "",
      assigneeAgentId: "agent-alpha",
      dependencyIds: [],
    });
    const secondTask = createWorkItem(databasePath, mission.id, {
      title: "Second",
      description: "",
      assigneeAgentId: "agent-beta",
      dependencyIds: [firstTask.id],
    });
    const thirdTask = createWorkItem(databasePath, mission.id, {
      title: "Third",
      description: "",
      assigneeAgentId: null,
      dependencyIds: [secondTask.id, firstTask.id],
    });
    const database = openDatabase(databasePath);
    database
      .prepare("UPDATE work_items SET created_at = ? WHERE id = ?")
      .run("2026-07-29T01:00:00.000Z", firstTask.id);
    database
      .prepare("UPDATE work_items SET created_at = ? WHERE id = ?")
      .run("2026-07-29T01:00:01.000Z", secondTask.id);
    database
      .prepare("UPDATE work_items SET created_at = ? WHERE id = ?")
      .run("2026-07-29T01:00:02.000Z", thirdTask.id);
    database.close();

    const oldMemory = createMemory(databasePath, project.id, {
      type: "goal",
      content: "Old goal",
      sourceType: "owner_input",
      sourceRef: "Owner",
    });
    const activeMemory = createMemory(databasePath, project.id, {
      type: "goal",
      content: "Current goal",
      sourceType: "owner_input",
      sourceRef: "Owner",
      supersedesId: oldMemory.id,
    });
    const factMemory = createMemory(databasePath, project.id, {
      type: "fact",
      content: "Stable fact",
      sourceType: "work_item",
      sourceRef: firstTask.id,
    });

    process.env.COCKPIT_MASTER_KEY = "known-master-key";
    const alphaFirst = contexts.createContextSnapshot(
      databasePath,
      project.id,
      "agent-alpha",
    );
    const alphaSecond = contexts.createContextSnapshot(
      databasePath,
      project.id,
      "agent-alpha",
    );
    const beta = contexts.createContextSnapshot(
      databasePath,
      project.id,
      "agent-beta",
    );

    expect(alphaSecond).toEqual(alphaFirst);
    expect(beta.shared).toEqual(alphaFirst.shared);
    expect(alphaFirst.schemaVersion).toBe(1);
    expect(alphaFirst.shared.roster.map(({ agentId }) => agentId)).toEqual([
      "agent-alpha",
      "agent-beta",
    ]);
    expect(alphaFirst.shared.roster[0].skillNames).toEqual(["Plan", "Review"]);
    expect(alphaFirst.shared.workItems.map(({ id }) => id)).toEqual([
      firstTask.id,
      secondTask.id,
      thirdTask.id,
    ]);
    expect(alphaFirst.shared.workItems[1].dependencyIds).toEqual([firstTask.id]);
    expect(alphaFirst.shared.workItems[2].dependencyIds).toEqual([
      firstTask.id,
      secondTask.id,
    ]);
    expect(alphaFirst.shared.memories.map(({ id }) => id)).toEqual([
      activeMemory.id,
      factMemory.id,
    ]);
    expect(alphaFirst.currentAgent).toEqual({
      id: "agent-alpha",
      name: "Alpha",
      role: "Plans",
      systemPrompt: "Alpha private prompt",
      skills: [
        { id: "skill-plan", name: "Plan", instructions: "Plan safely" },
        {
          id: "skill-review",
          name: "Review",
          instructions: "Review carefully",
        },
      ],
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
      },
    });
    expect(beta.currentAgent.systemPrompt).toBe("Beta private prompt");
  });

  it("contains no provider/vault deny keys or known secret values", async () => {
    const contexts = await service();
    const project = createProject("Secure snapshot", databasePath);
    seedAgents();
    bindWorkspace(project.id);
    addMember(project.id, "agent-alpha", "a");
    addMember(project.id, "agent-beta", "b");
    createMission(databasePath, project.id, { title: "Secure", goal: "Secure" });
    process.env.COCKPIT_MASTER_KEY = "known-master-key";

    const snapshot = contexts.createContextSnapshot(
      databasePath,
      project.id,
      "agent-alpha",
    );
    const scanned = collectKeysAndStrings(snapshot);
    expect(scanned.keys.filter((key) => FORBIDDEN_KEYS.has(key))).toEqual([]);
    const serialized = JSON.stringify(snapshot);
    for (const secret of SECRET_VALUES) {
      expect(serialized).not.toContain(secret);
    }
  });
});
