import { describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { initializeMissingMissionHeads } from "@/tests/fixtures/execution/current-graph";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-21T06:00:00.000Z";

type ContributionInsightDto = {
  disclaimer: "not_ranking";
  project: { detail: string | null; projectId: string | null };
  roles: Array<{
    agentId: string;
    evidence: Array<{ id: string; kind: "review" | "work_item"; title: string }>;
    name: string;
    reviews: { failed: number; passed: number };
    role: string;
    workItems: { blocked: number; completed: number; inProgress: number };
  }>;
};

type ContributionModule = {
  getContributionInsight(databasePath: string, projectId?: string): ContributionInsightDto;
};

const contributionModules = import.meta.glob<ContributionModule>(
  "../../../src/adapters/outbound/sqlite/operations-projection/contribution-insight.ts",
);

async function contributionService(): Promise<ContributionModule> {
  const load = contributionModules[
    "../../../src/adapters/outbound/sqlite/operations-projection/contribution-insight.ts"
  ];
  expect(load, "the contribution insight query must exist").toBeTypeOf("function");
  return load();
}

function seedMember(
  databasePath: string,
  input: {
    agentId: string;
    name: string;
    projectId: string;
    providerId: string;
    role: string;
  },
): void {
  const database = openDatabase(databasePath);
  try {
    const provider = database.prepare("SELECT 1 AS found FROM providers WHERE id=?").get(
      input.providerId,
    );
    if (provider === undefined) {
      database.exec(`
        INSERT INTO providers (
          id, name, base_url, default_model, api_key_cipher, api_key_iv,
          api_key_tag, credential_version, credential_generation, key_id,
          api_key_mask, verified_at, version, created_at, updated_at
        ) VALUES (
          '${input.providerId}', 'Local', 'http://127.0.0.1:4000/v1', 'model',
          'c', 'i', 't', 1, 1, 'k', '***', '${NOW}', 1, '${NOW}', '${NOW}'
        );
      `);
    }
    database.exec(`
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
        can_read, can_write, can_execute, max_tokens, max_handoffs, version, created_at, updated_at
      ) VALUES (
        '${input.agentId}', '${input.name}', '${input.role}', 'private',
        '${input.providerId}', 'model', 'A', 'sage', 1, 1, 0, 1000, 5, 1, '${NOW}', '${NOW}'
      );
      INSERT INTO project_memberships (project_id, agent_id, joined_at)
      VALUES ('${input.projectId}', '${input.agentId}', '${NOW}');
    `);
  } finally {
    database.close();
  }
}

describe("contribution insight", () => {
  it("keeps contribution unknown without a project and is not a ranking", async () => {
    const databasePath = memoryDatabasePath();
    const service = await contributionService();
    expect(service.getContributionInsight(databasePath)).toEqual({
      disclaimer: "not_ranking",
      project: { detail: "需要打开项目", projectId: null },
      roles: [],
    });
  });

  it("groups work-item results by member role and isolates projects", async () => {
    const service = await contributionService();
    const databasePath = memoryDatabasePath();
    const projectA = createProject("Contribution A", databasePath);
    const projectB = createProject("Contribution B", databasePath);
    seedMember(databasePath, {
      agentId: "planner-a",
      name: "Alpha",
      projectId: projectA.id,
      providerId: "provider-contrib",
      role: "规划",
    });
    seedMember(databasePath, {
      agentId: "planner-b",
      name: "Other",
      projectId: projectB.id,
      providerId: "provider-contrib",
      role: "规划",
    });
    const database = openDatabase(databasePath);
    try {
      database.exec(`
        INSERT INTO missions (id, project_id, title, goal, version, created_at, updated_at)
        VALUES
          ('mission-a', '${projectA.id}', 'A', 'Goal', 1, '${NOW}', '${NOW}'),
          ('mission-b', '${projectB.id}', 'B', 'Goal', 1, '${NOW}', '${NOW}');
        INSERT INTO work_items (
          id, mission_id, title, description, status, assignee_agent_id, version,
          created_at, updated_at, lease_token, lease_expires_at, last_heartbeat_at
        ) VALUES
          ('work-a', 'mission-a', 'Blocked A', '', 'blocked', 'planner-a', 1,
           '${NOW}', '${NOW}', NULL, NULL, NULL),
          ('work-b', 'mission-b', 'Blocked B', '', 'blocked', 'planner-b', 1,
           '${NOW}', '${NOW}', NULL, NULL, NULL);
      `);
      initializeMissingMissionHeads(database);
    } finally {
      database.close();
    }

    const usage = service.getContributionInsight(databasePath, projectA.id);
    expect(usage.disclaimer).toBe("not_ranking");
    expect(usage.project).toEqual({ detail: null, projectId: projectA.id });
    expect(usage.roles).toEqual([
      {
        agentId: "planner-a",
        evidence: [{ id: "work-a", kind: "work_item", title: "Blocked A" }],
        name: "Alpha",
        reviews: { failed: 0, passed: 0 },
        role: "规划",
        workItems: { blocked: 1, completed: 0, inProgress: 0 },
      },
    ]);
    expect(service.getContributionInsight(databasePath, projectB.id).roles).toEqual([
      {
        agentId: "planner-b",
        evidence: [{ id: "work-b", kind: "work_item", title: "Blocked B" }],
        name: "Other",
        reviews: { failed: 0, passed: 0 },
        role: "规划",
        workItems: { blocked: 1, completed: 0, inProgress: 0 },
      },
    ]);
    expect(() => service.getContributionInsight(databasePath, "missing-project")).toThrowError(
      /Project was not found/u,
    );
  });

  it("lists at most five work-item evidence titles per role", async () => {
    const service = await contributionService();
    const databasePath = memoryDatabasePath();
    const project = createProject("Contribution Evidence", databasePath);
    seedMember(databasePath, {
      agentId: "planner-a",
      name: "Alpha",
      projectId: project.id,
      providerId: "provider-evidence",
      role: "规划",
    });
    const rows = Array.from({ length: 6 }, (_, index) => {
      const n = index + 1;
      const stamp = `2026-08-21T06:0${n}:00.000Z`;
      return `('work-${n}', 'mission-e', 'Evidence ${n}', '', 'blocked', 'planner-a', 1, '${stamp}', '${stamp}', NULL, NULL, NULL)`;
    }).join(",\n          ");
    const database = openDatabase(databasePath);
    try {
      database.exec(`
        INSERT INTO missions (id, project_id, title, goal, version, created_at, updated_at)
        VALUES ('mission-e', '${project.id}', 'E', 'Goal', 1, '${NOW}', '${NOW}');
        INSERT INTO work_items (
          id, mission_id, title, description, status, assignee_agent_id, version,
          created_at, updated_at, lease_token, lease_expires_at, last_heartbeat_at
        ) VALUES
          ${rows};
      `);
      initializeMissingMissionHeads(database);
    } finally {
      database.close();
    }

    expect(service.getContributionInsight(databasePath, project.id).roles[0]?.evidence).toEqual([
      { id: "work-6", kind: "work_item", title: "Evidence 6" },
      { id: "work-5", kind: "work_item", title: "Evidence 5" },
      { id: "work-4", kind: "work_item", title: "Evidence 4" },
      { id: "work-3", kind: "work_item", title: "Evidence 3" },
      { id: "work-2", kind: "work_item", title: "Evidence 2" },
    ]);
  });
});
