import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createMission, createWorkItem } from "@/src/server/mission-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";

type ProjectMember = {
  agentId: string;
  joinedAt: string;
  name: string;
  role: string;
  model: string;
  avatarText: string;
  accentToken: string;
  skillNames: string[];
  permissions: {
    readFiles: boolean;
    writeFiles: boolean;
    runCommands: boolean;
  };
};

type MembershipState = {
  members: ProjectMember[];
  projectVersion: number;
};

type MembershipServiceModule = {
  getMembers(databasePath: string, projectId: string): MembershipState;
  replaceMembers(
    databasePath: string,
    projectId: string,
    input: { agentIds: string[]; expectedProjectVersion: number },
  ): MembershipState;
};

const serviceModules =
  import.meta.glob<MembershipServiceModule>("../src/adapters/outbound/sqlite/project-workspace/membership-service.ts");

let directory: string;
let databasePath: string;

async function loadService(): Promise<MembershipServiceModule> {
  const load = serviceModules["../src/adapters/outbound/sqlite/project-workspace/membership-service.ts"];
  expect(load, "the membership domain service must exist").toBeTypeOf("function");
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
      'provider-1', 'Provider', 'https://example.invalid', 'model-a',
      'cipher', 'iv', 'tag', 1, 1, 'key', '****', 'now', 1, 'now', 'now'
    );
    INSERT INTO skills (id, name, description, instructions, version, created_at, updated_at)
      VALUES
        ('skill-plan', 'Plan', '', 'Plan work', 1, 'now', 'now'),
        ('skill-review', 'Review', '', 'Review work', 1, 'now', 'now');
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
      ),
      (
        'agent-gamma', 'Gamma', 'Reviews', 'private gamma', 'provider-1', 'model-a', 'G', 'slate',
        1, 0, 1, 1000, 1, 1, '2026-07-29T00:00:02.000Z', '2026-07-29T00:00:02.000Z'
      );
    INSERT INTO agent_skills (agent_id, skill_id, position)
      VALUES
        ('agent-alpha', 'skill-review', 1),
        ('agent-alpha', 'skill-plan', 0),
        ('agent-beta', 'skill-review', 0);
  `);
  database.close();
}

function expectServiceError(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-members-service-"));
  databasePath = join(directory, "cockpit.sqlite");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { force: true, recursive: true });
});

describe("project membership service", () => {
  it("fully replaces an equal roster, retains joinedAt, and reads latest public profiles", async () => {
    const service = await loadService();
    const project = createProject("Membership", databasePath);
    seedAgents();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T10:00:00.000Z"));

    const first = service.replaceMembers(databasePath, project.id, {
      agentIds: ["agent-beta", "agent-alpha"],
      expectedProjectVersion: 1,
    });

    expect(first.projectVersion).toBe(2);
    expect(first.members.map(({ agentId }) => agentId)).toEqual([
      "agent-alpha",
      "agent-beta",
    ]);
    expect(first.members[0]).toMatchObject({
      agentId: "agent-alpha",
      name: "Alpha",
      role: "Plans",
      model: "model-a",
      avatarText: "A",
      accentToken: "sage",
      skillNames: ["Plan", "Review"],
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
      },
    });
    expect(Object.keys(first.members[0])).not.toContain("leader");
    expect(Object.keys(first.members[0])).not.toContain("rank");
    expect(Object.keys(first.members[0])).not.toContain("systemPrompt");

    const alphaJoinedAt = first.members[0].joinedAt;
    const database = openDatabase(databasePath);
    database.exec(`
      UPDATE agents
      SET name = 'Alpha updated', role = 'Coordinates', model = 'model-new',
          can_write = 1, updated_at = 'later'
      WHERE id = 'agent-alpha';
    `);
    database.close();
    vi.setSystemTime(new Date("2026-07-29T11:00:00.000Z"));

    const replaced = service.replaceMembers(databasePath, project.id, {
      agentIds: ["agent-gamma", "agent-alpha"],
      expectedProjectVersion: 2,
    });

    expect(replaced.members.map(({ agentId }) => agentId)).toEqual([
      "agent-alpha",
      "agent-gamma",
    ]);
    expect(replaced.members[0]).toMatchObject({
      joinedAt: alphaJoinedAt,
      name: "Alpha updated",
      role: "Coordinates",
      model: "model-new",
      permissions: expect.objectContaining({ writeFiles: true }),
    });
    expect(replaced.members[1].joinedAt).toBe("2026-07-29T11:00:00.000Z");
    expect(service.getMembers(databasePath, project.id)).toEqual(replaced);
  });

  it("rejects too few, duplicate, missing agents and stale versions without changing the roster", async () => {
    const service = await loadService();
    const project = createProject("Validation", databasePath);
    seedAgents();

    for (const agentIds of [["agent-alpha"], ["agent-alpha", "agent-alpha"]]) {
      expectServiceError(
        () =>
          service.replaceMembers(databasePath, project.id, {
            agentIds,
            expectedProjectVersion: 1,
          }),
        "INVALID_INPUT",
      );
    }
    expectServiceError(
      () =>
        service.replaceMembers(databasePath, project.id, {
          agentIds: ["agent-alpha", "missing-agent"],
          expectedProjectVersion: 1,
        }),
      "AGENT_NOT_FOUND",
    );

    const current = service.replaceMembers(databasePath, project.id, {
      agentIds: ["agent-alpha", "agent-beta"],
      expectedProjectVersion: 1,
    });
    expectServiceError(
      () =>
        service.replaceMembers(databasePath, project.id, {
          agentIds: ["agent-alpha", "agent-gamma"],
          expectedProjectVersion: 1,
        }),
      "RESOURCE_CONFLICT",
    );
    expect(service.getMembers(databasePath, project.id)).toEqual(current);
  });

  it("prevents removing a member assigned to a project work item", async () => {
    const service = await loadService();
    const project = createProject("Assignments", databasePath);
    seedAgents();
    service.replaceMembers(databasePath, project.id, {
      agentIds: ["agent-alpha", "agent-beta"],
      expectedProjectVersion: 1,
    });

    const mission = createMission(databasePath, project.id, {
      expectedVersion: 0,
      goal: "Goal",
      operationId: "16000000-0000-4000-8000-000000000116",
      title: "Mission",
    });
    createWorkItem(databasePath, mission.id, {
      assigneeAgentId: "agent-beta",
      dependencyIds: [],
      description: "",
      title: "Assigned",
    });

    expect(() =>
      service.replaceMembers(databasePath, project.id, {
        agentIds: ["agent-alpha", "agent-gamma"],
        expectedProjectVersion: 2,
      }),
    ).toThrowError(
      expect.objectContaining({
        agentIds: ["agent-beta"],
        code: "MEMBER_HAS_ASSIGNMENTS",
      }),
    );
    expect(service.getMembers(databasePath, project.id).members.map(({ agentId }) => agentId)).toEqual([
      "agent-alpha",
      "agent-beta",
    ]);
  });
});
