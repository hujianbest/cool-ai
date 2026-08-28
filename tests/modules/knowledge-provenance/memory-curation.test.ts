import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createWorkItem } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import {
  createMemory,
  listMemories,
  searchMemories,
} from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { createMission } from "@/src/composition/mission-commands";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type MemoryType = "goal" | "decision" | "fact" | "artifact" | "experience";
type SourceType =
  | "owner_input"
  | "work_item"
  | "artifact_path"
  | "task"
  | "result"
  | "review"
  | "validation"
  | "artifact";
type CurationSource = {
  id: string;
  type: SourceType;
  version?: string | null;
};
type CurationCandidate = {
  agentId: string;
  content: string;
  createdAt: string;
  id: string;
  projectId: string;
  sources: Array<{
    href: string | null;
    id: string;
    type: SourceType;
    version: string | null;
  }>;
  status: "pending" | "published" | "rejected" | "replaced";
  supersedesId: string | null;
  type: MemoryType;
};
type CurationCandidateListItem = CurationCandidate & {
  agentName: string;
  diff: Array<{
    kind: "added" | "removed" | "unchanged";
    text: string;
  }>;
};
type PublishedMemory = {
  actor: {
    confirmer: { decisionId: string; reviewAttemptId: string } | null;
    proposerAgent: {
      accentToken: string;
      avatarText: string;
      name: string;
    } | null;
    proposerType: "owner" | "agent";
  };
  chainId: string;
  content: string;
  id: string;
  source: {
    href: string | null;
    id: string;
    type: SourceType;
    version: string | null;
  };
};
type CurationModule = {
  decideCuration(
    databasePath: string,
    projectId: string,
    candidateId: string,
    input: {
      action: "publish" | "reject";
      operationId: string;
    },
  ): {
    candidate: CurationCandidateListItem;
    memory: PublishedMemory | null;
  };
  listCurationCandidates(
    databasePath: string,
    projectId: string,
  ): CurationCandidateListItem[];
  proposeCuration(
    databasePath: string,
    projectId: string,
    input: {
      agentId: string;
      content: string;
      operationId: string;
      sources: CurationSource[];
      supersedesId?: string;
      type: MemoryType;
    },
  ): CurationCandidate;
};

const curationModules = import.meta.glob<CurationModule>(
  "../../../src/adapters/outbound/sqlite/knowledge-provenance/memory-curation.ts",
);

async function curation(): Promise<CurationModule> {
  const load = curationModules[
    "../../../src/adapters/outbound/sqlite/knowledge-provenance/memory-curation.ts"
  ];
  expect(load, "the memory curation command must exist").toBeTypeOf("function");
  return load();
}

function seedAgents(databasePath: string): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv, api_key_tag,
        credential_version, credential_generation, key_id, api_key_mask, verified_at,
        version, created_at, updated_at
      ) VALUES (
        'provider-curation', 'Provider', 'https://example.invalid', 'model-curation',
        'cipher', 'iv', 'tag', 1, 1, 'key', '****', 'now', 1, 'now', 'now'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
        can_read, can_write, can_execute, max_tokens, max_handoffs, version,
        created_at, updated_at
      ) VALUES
        (
          'agent-member', 'Member', 'Plans', 'private', 'provider-curation',
          'model-curation', 'M', 'sage', 1, 1, 0, 1000, 1, 1, 'now', 'now'
        ),
        (
          'agent-outsider', 'Outsider', 'Builds', 'private', 'provider-curation',
          'model-curation', 'O', 'gold', 1, 1, 1, 1000, 1, 1, 'now', 'now'
        );
    `);
  } finally {
    database.close();
  }
}

function addMember(databasePath: string, projectId: string, agentId: string): void {
  const database = openDatabase(databasePath);
  try {
    database.prepare(`
      INSERT INTO project_memberships(project_id,agent_id,joined_at)
      VALUES (?,?,'2026-08-27T00:00:00.000Z')
    `).run(projectId, agentId);
  } finally {
    database.close();
  }
}

function candidateCount(databasePath: string): number {
  const database = openDatabase(databasePath);
  try {
    const row = database.prepare(
      "SELECT COUNT(*) AS count FROM memory_curation_candidates",
    ).get() as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

function createProjectWorkItem(
  databasePath: string,
  projectId: string,
  operationId: string,
): { id: string } {
  const mission = createMission(databasePath, projectId, {
    expectedVersion: 0,
    goal: "Validate memory curation sources",
    operationId,
    title: "Curation source mission",
  });
  return createWorkItem(databasePath, mission.id, {
    assigneeAgentId: null,
    dependencyIds: [],
    description: "",
    title: "Curation source work item",
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("agent-signed memory curation", () => {
  it("creates a sourced pending candidate without publishing a memory", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation proposal", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const service = await curation();

    const before = listMemories(databasePath, project.id, true);
    const candidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "  Preserve the exact source tuple.  ",
      operationId: "63000000-0000-4000-8000-000000000001",
      sources: [{ id: "  Owner brief  ", type: "owner_input", version: null }],
      type: "decision",
    });

    expect(candidate).toMatchObject({
      agentId: "agent-member",
      content: "Preserve the exact source tuple.",
      projectId: project.id,
      sources: [{ id: "Owner brief", type: "owner_input", version: null }],
      status: "pending",
      supersedesId: null,
      type: "decision",
    });
    expect(candidate.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(candidate.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(listMemories(databasePath, project.id, true)).toEqual(before);
    expect(candidateCount(databasePath)).toBe(1);
  });

  it("replays the same project operation without inserting another candidate", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation replay", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const service = await curation();
    const input = {
      agentId: "agent-member",
      content: "Replay this proposal",
      operationId: "63000000-0000-4000-8000-000000000002",
      sources: [{ id: "Owner note", type: "owner_input" as const }],
      type: "fact" as const,
    };

    const first = service.proposeCuration(databasePath, project.id, input);
    const replay = service.proposeCuration(databasePath, project.id, input);

    expect(replay).toEqual(first);
    expect(candidateCount(databasePath)).toBe(1);
  });

  it("rejects an Agent outside the project without leaving candidate rows", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation membership", databasePath);
    const other = createProject("Other membership", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, other.id, "agent-outsider");
    const service = await curation();

    expect(() => service.proposeCuration(databasePath, project.id, {
      agentId: "agent-outsider",
      content: "Must not cross the project boundary",
      operationId: "63000000-0000-4000-8000-000000000003",
      sources: [{ id: "Owner note", type: "owner_input" }],
      type: "fact",
    })).toThrowError(expect.objectContaining({ code: "AGENT_NOT_MEMBER" }));
    expect(candidateCount(databasePath)).toBe(0);
  });

  it("rejects empty and cross-project sources without leaving candidate rows", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation sources", databasePath);
    const other = createProject("Other sources", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const foreignWorkItem = createProjectWorkItem(
      databasePath,
      other.id,
      "63000000-0000-4000-8000-000000000004",
    );
    const service = await curation();

    expect(() => service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Missing source",
      operationId: "63000000-0000-4000-8000-000000000005",
      sources: [],
      type: "fact",
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Foreign source",
      operationId: "63000000-0000-4000-8000-000000000006",
      sources: [{ id: foreignWorkItem.id, type: "work_item" }],
      type: "fact",
    })).toThrowError(expect.objectContaining({ code: "INVALID_SOURCE" }));
    expect(() => service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Too many sources",
      operationId: "63000000-0000-4000-8000-000000000025",
      sources: Array.from({ length: 9 }, (_, index) => ({
        id: `Owner source ${index}`,
        type: "owner_input" as const,
      })),
      type: "fact",
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(candidateCount(databasePath)).toBe(0);
  });

  it("lists only project candidates newest-first", async () => {
    vi.useFakeTimers();
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation list", databasePath);
    const other = createProject("Other curation list", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    addMember(databasePath, other.id, "agent-member");
    const service = await curation();

    vi.setSystemTime(new Date("2026-08-27T01:00:00.000Z"));
    const older = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Older project candidate",
      operationId: "63000000-0000-4000-8000-000000000007",
      sources: [{ id: "Owner note A", type: "owner_input" }],
      type: "fact",
    });
    vi.setSystemTime(new Date("2026-08-27T01:01:00.000Z"));
    const foreign = service.proposeCuration(databasePath, other.id, {
      agentId: "agent-member",
      content: "Other project candidate",
      operationId: "63000000-0000-4000-8000-000000000008",
      sources: [{ id: "Owner note B", type: "owner_input" }],
      type: "fact",
    });
    vi.setSystemTime(new Date("2026-08-27T01:02:00.000Z"));
    const newer = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Newer project candidate",
      operationId: "63000000-0000-4000-8000-000000000009",
      sources: [{ id: "Owner note C", type: "owner_input" }],
      type: "decision",
    });

    expect(service.listCurationCandidates(databasePath, project.id).map(({ id }) => id))
      .toEqual([newer.id, older.id]);
    expect(service.listCurationCandidates(databasePath, other.id).map(({ id }) => id))
      .toEqual([foreign.id]);
  });

  it("lists Agent attribution, ordered sources, and an all-added multiline diff", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation added diff", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const service = await curation();
    const candidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "alpha\n\nomega",
      operationId: "63000000-0000-4000-8000-000000000010",
      sources: [
        { id: "First source", type: "owner_input" },
        { id: "Second source", type: "owner_input" },
      ],
      type: "decision",
    });

    expect(service.listCurationCandidates(databasePath, project.id)).toEqual([{
      ...candidate,
      agentName: "Member",
      diff: [
        { kind: "added", text: "alpha" },
        { kind: "added", text: "" },
        { kind: "added", text: "omega" },
      ],
    }]);
  });

  it("rejects fabricated legacy source versions without leaving candidate rows", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation source versions", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const workItem = createProjectWorkItem(
      databasePath,
      project.id,
      "63000000-0000-4000-8000-000000000032",
    );
    const service = await curation();

    expect(() => service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Fabricated owner version",
      operationId: "63000000-0000-4000-8000-000000000033",
      sources: [{ id: "Owner source", type: "owner_input", version: "v2" }],
      type: "fact",
    })).toThrowError(expect.objectContaining({ code: "INVALID_SOURCE" }));
    expect(() => service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Fabricated work item version",
      operationId: "63000000-0000-4000-8000-000000000034",
      sources: [{ id: workItem.id, type: "work_item", version: "fake-v2" }],
      type: "fact",
    })).toThrowError(expect.objectContaining({ code: "INVALID_SOURCE" }));
    expect(candidateCount(databasePath)).toBe(0);
  });

  it("freezes Agent attribution when the candidate is proposed", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation attribution snapshot", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const service = await curation();
    service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Keep the proposal-time attribution",
      operationId: "63000000-0000-4000-8000-000000000023",
      sources: [{ id: "Owner snapshot source", type: "owner_input" }],
      type: "fact",
    });

    const database = openDatabase(databasePath);
    try {
      database.prepare("UPDATE agents SET name='Renamed Agent' WHERE id='agent-member'").run();
    } finally {
      database.close();
    }

    expect(service.listCurationCandidates(databasePath, project.id)[0]?.agentName)
      .toBe("Member");
  });

  it("publishes with the proposal-time Agent attribution after a pre-publish rename", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation frozen publish attribution", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const database = openDatabase(databasePath);
    try {
      database.prepare(`
        UPDATE agents
        SET name='Curator Lin',avatar_text='CL',accent_token='gold'
        WHERE id='agent-member'
      `).run();
    } finally {
      database.close();
    }
    const service = await curation();
    const candidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Keep frozen attribution before publish",
      operationId: "63000000-0000-4000-8000-000000000028",
      sources: [{ id: "Owner frozen source", type: "owner_input" }],
      type: "fact",
    });
    const renamedDatabase = openDatabase(databasePath);
    try {
      renamedDatabase.prepare(`
        UPDATE agents
        SET name='Renamed Agent',avatar_text='R',accent_token='sage'
        WHERE id='agent-member'
      `).run();
    } finally {
      renamedDatabase.close();
    }

    const published = service.decideCuration(databasePath, project.id, candidate.id, {
      action: "publish",
      operationId: "63000000-0000-4000-8000-000000000029",
    });
    const frozenAttribution = {
      accentToken: "gold",
      avatarText: "CL",
      id: "agent-member",
      name: "Curator Lin",
    };
    expect(published.memory?.actor.proposerAgent).toEqual(frozenAttribution);
    expect(listMemories(databasePath, project.id)[0]?.actor.proposerAgent)
      .toEqual(frozenAttribution);
  });

  it("keeps published Agent attribution frozen after a later rename", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation post-publish attribution", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const database = openDatabase(databasePath);
    try {
      database.prepare(`
        UPDATE agents
        SET name='Curator Lin',avatar_text='CL',accent_token='gold'
        WHERE id='agent-member'
      `).run();
    } finally {
      database.close();
    }
    const service = await curation();
    const candidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Keep frozen attribution after publish",
      operationId: "63000000-0000-4000-8000-000000000030",
      sources: [{ id: "Owner frozen source", type: "owner_input" }],
      type: "fact",
    });
    service.decideCuration(databasePath, project.id, candidate.id, {
      action: "publish",
      operationId: "63000000-0000-4000-8000-000000000031",
    });
    const renamedDatabase = openDatabase(databasePath);
    try {
      renamedDatabase.prepare(`
        UPDATE agents
        SET name='Renamed Agent',avatar_text='R',accent_token='sage'
        WHERE id='agent-member'
      `).run();
    } finally {
      renamedDatabase.close();
    }

    const frozenAttribution = {
      accentToken: "gold",
      avatarText: "CL",
      id: "agent-member",
      name: "Curator Lin",
    };
    expect(listMemories(databasePath, project.id)[0]?.actor.proposerAgent)
      .toEqual(frozenAttribution);
    expect(searchMemories(databasePath, project.id, {
      q: "frozen attribution",
    })[0]?.memory.actor.proposerAgent).toEqual(frozenAttribution);
  });

  it("lists a deterministic line diff against the superseded memory text", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation replacement diff", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const target = createMemory(databasePath, project.id, {
      content: "alpha\nshared",
      sourceRef: "Owner decision",
      sourceType: "owner_input",
      type: "decision",
    });
    const service = await curation();
    const candidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "beta\nshared",
      operationId: "63000000-0000-4000-8000-000000000011",
      sources: [{ id: "Owner follow-up", type: "owner_input" }],
      supersedesId: target.id,
      type: "decision",
    });

    expect(service.listCurationCandidates(databasePath, project.id)).toEqual([{
      ...candidate,
      agentName: "Member",
      diff: [
        { kind: "removed", text: "alpha" },
        { kind: "added", text: "beta" },
        { kind: "unchanged", text: "shared" },
      ],
    }]);
  });

  it("rejects listing candidates for an unknown project", async () => {
    const databasePath = memoryDatabasePath();
    const service = await curation();

    expect(() => service.listCurationCandidates(databasePath, "missing-project"))
      .toThrowError(expect.objectContaining({ code: "PROJECT_NOT_FOUND", httpStatus: 404 }));
  });

  it("publishes an Agent memory once and returns it through list and search", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation publish", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const service = await curation();
    const candidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Published Agent insight",
      operationId: "63000000-0000-4000-8000-000000000012",
      sources: [{ id: "Owner approval source", type: "owner_input" }],
      type: "fact",
    });

    const published = service.decideCuration(databasePath, project.id, candidate.id, {
      action: "publish",
      operationId: "63000000-0000-4000-8000-000000000013",
    });
    expect(published.candidate.status).toBe("published");
    expect(published.memory).toMatchObject({
      actor: {
        confirmer: null,
        proposerAgent: { name: "Member" },
        proposerType: "agent",
      },
      content: "Published Agent insight",
      source: {
        href: null,
        id: "Owner approval source",
        type: "owner_input",
        version: null,
      },
    });
    if (published.memory === null) throw new Error("Expected a published memory.");
    expect(listMemories(databasePath, project.id)).toContainEqual(published.memory);
    expect(searchMemories(databasePath, project.id, {
      q: "Agent insight",
    }).map(({ memory }) => memory.id)).toContain(published.memory.id);

    const replay = service.decideCuration(databasePath, project.id, candidate.id, {
      action: "publish",
      operationId: "63000000-0000-4000-8000-000000000013",
    });
    expect(replay).toEqual(published);
    expect(service.decideCuration(databasePath, project.id, candidate.id, {
      action: "publish",
      operationId: "63000000-0000-4000-8000-000000000026",
    })).toEqual(published);
    const otherCandidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Another publish candidate",
      operationId: "63000000-0000-4000-8000-000000000024",
      sources: [{ id: "Other owner source", type: "owner_input" }],
      type: "fact",
    });
    expect(() => service.decideCuration(databasePath, project.id, otherCandidate.id, {
      action: "publish",
      operationId: "63000000-0000-4000-8000-000000000013",
    })).toThrowError(expect.objectContaining({
      code: "OPERATION_CONFLICT",
      httpStatus: 409,
    }));
    expect(
      service.listCurationCandidates(databasePath, project.id)
        .find(({ id }) => id === otherCandidate.id)?.status,
    ).toBe("pending");
    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM memory_entries WHERE chain_id=?",
      ).get(published.memory.chainId)).toEqual({ count: 1 });
      expect(database.prepare(`
        SELECT decision_operation_id AS operationId,
               decision_request_hash AS requestHash
        FROM memory_curation_candidates
        WHERE project_id=? AND id=?
      `).get(project.id, candidate.id)).toEqual({
        operationId: "63000000-0000-4000-8000-000000000013",
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    } finally {
      database.close();
    }
  });

  it("rejects without writing memory and conflicts across terminal actions", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation reject", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const service = await curation();
    const before = listMemories(databasePath, project.id, true);
    expect(() => service.decideCuration(databasePath, project.id, "missing-candidate", {
      action: "reject",
      operationId: "63000000-0000-4000-8000-000000000022",
    })).toThrowError(expect.objectContaining({ code: "CURATION_NOT_FOUND", httpStatus: 404 }));
    const rejectedCandidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Reject this insight",
      operationId: "63000000-0000-4000-8000-000000000014",
      sources: [{ id: "Owner source", type: "owner_input" }],
      type: "fact",
    });

    const rejected = service.decideCuration(databasePath, project.id, rejectedCandidate.id, {
      action: "reject",
      operationId: "63000000-0000-4000-8000-000000000015",
    });
    expect(rejected).toMatchObject({ candidate: { status: "rejected" }, memory: null });
    expect(service.decideCuration(databasePath, project.id, rejectedCandidate.id, {
      action: "reject",
      operationId: "63000000-0000-4000-8000-000000000027",
    })).toMatchObject({ candidate: { status: "rejected" }, memory: null });
    expect(() => service.decideCuration(databasePath, project.id, rejectedCandidate.id, {
      action: "publish",
      operationId: "63000000-0000-4000-8000-000000000016",
    })).toThrowError(expect.objectContaining({ code: "ACTION_CONFLICT" }));
    expect(listMemories(databasePath, project.id, true)).toEqual(before);

    const publishedCandidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Publish this insight",
      operationId: "63000000-0000-4000-8000-000000000017",
      sources: [{ id: "Owner source", type: "owner_input" }],
      type: "fact",
    });
    service.decideCuration(databasePath, project.id, publishedCandidate.id, {
      action: "publish",
      operationId: "63000000-0000-4000-8000-000000000018",
    });
    expect(() => service.decideCuration(databasePath, project.id, publishedCandidate.id, {
      action: "reject",
      operationId: "63000000-0000-4000-8000-000000000019",
    })).toThrowError(expect.objectContaining({ code: "ACTION_CONFLICT" }));
  });

  it("marks a candidate replaced when its supersedes target is no longer active", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation replaced", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const target = createMemory(databasePath, project.id, {
      content: "Original decision",
      sourceRef: "Owner decision",
      sourceType: "owner_input",
      type: "decision",
    });
    const service = await curation();
    const candidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Candidate replacement",
      operationId: "63000000-0000-4000-8000-000000000020",
      sources: [{ id: "Owner follow-up", type: "owner_input" }],
      supersedesId: target.id,
      type: "decision",
    });
    createMemory(databasePath, project.id, {
      content: "Owner replacement wins",
      sourceRef: "Owner decision",
      sourceType: "owner_input",
      supersedesId: target.id,
      type: "decision",
    });

    expect(() => service.decideCuration(databasePath, project.id, candidate.id, {
      action: "publish",
      operationId: "63000000-0000-4000-8000-000000000021",
    })).toThrowError(expect.objectContaining({ code: "MEMORY_NOT_ACTIVE" }));
    expect(service.listCurationCandidates(databasePath, project.id)[0]?.status).toBe("replaced");
    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM memory_entries
        WHERE proposer_actor_type='agent'
      `).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("marks a stale superseding candidate replaced when rejecting it", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation stale reject", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const target = createMemory(databasePath, project.id, {
      content: "Original goal",
      sourceRef: "Owner goal",
      sourceType: "owner_input",
      type: "goal",
    });
    const service = await curation();
    const candidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Candidate stale goal",
      operationId: "63000000-0000-4000-8000-000000000035",
      sources: [{ id: "Owner follow-up", type: "owner_input" }],
      supersedesId: target.id,
      type: "goal",
    });
    createMemory(databasePath, project.id, {
      content: "Owner replacement wins",
      sourceRef: "Owner goal",
      sourceType: "owner_input",
      supersedesId: target.id,
      type: "goal",
    });
    const beforeDecision = listMemories(databasePath, project.id, true).length;

    expect(() => service.decideCuration(databasePath, project.id, candidate.id, {
      action: "reject",
      operationId: "63000000-0000-4000-8000-000000000036",
    })).toThrowError(expect.objectContaining({ code: "MEMORY_NOT_ACTIVE" }));
    expect(service.listCurationCandidates(databasePath, project.id)[0]?.status).toBe("replaced");
    expect(listMemories(databasePath, project.id, true)).toHaveLength(beforeDecision);
  });

  it("keeps curation snapshots immutable while lifecycle decisions remain writable", async () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Curation immutable snapshot", databasePath);
    seedAgents(databasePath);
    addMember(databasePath, project.id, "agent-member");
    const service = await curation();
    const publishCandidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Immutable publish candidate",
      operationId: "63000000-0000-4000-8000-000000000037",
      sources: [{ id: "Owner immutable source", type: "owner_input" }],
      type: "fact",
    });
    const rejectCandidate = service.proposeCuration(databasePath, project.id, {
      agentId: "agent-member",
      content: "Immutable reject candidate",
      operationId: "63000000-0000-4000-8000-000000000038",
      sources: [{ id: "Owner immutable source", type: "owner_input" }],
      type: "fact",
    });

    const database = openDatabase(databasePath);
    try {
      const frozenColumns = [
        "id",
        "project_id",
        "agent_id",
        "agent_name",
        "agent_avatar_text",
        "agent_accent_token",
        "type",
        "content",
        "supersedes_id",
        "operation_id",
        "request_hash",
        "created_at",
      ] as const;
      for (const column of frozenColumns) {
        expect(
          () => database.prepare(`
            UPDATE memory_curation_candidates
            SET ${column}=${column}
            WHERE id=?
          `).run(publishCandidate.id),
          `frozen curation column ${column}`,
        ).toThrowError(/IMMUTABLE_CURATION_SNAPSHOT/u);
      }
      expect(() => database.prepare(`
        UPDATE memory_curation_sources SET source_id=source_id WHERE candidate_id=?
      `).run(publishCandidate.id)).toThrowError(/IMMUTABLE_CURATION_SOURCE/u);
      expect(() => database.prepare(`
        DELETE FROM memory_curation_sources WHERE candidate_id=?
      `).run(publishCandidate.id)).toThrowError(/IMMUTABLE_CURATION_SOURCE/u);
      expect(() => database.prepare(`
        DELETE FROM memory_curation_candidates WHERE id=?
      `).run(publishCandidate.id)).toThrowError(/IMMUTABLE_CURATION_CANDIDATE/u);
    } finally {
      database.close();
    }

    expect(service.decideCuration(databasePath, project.id, publishCandidate.id, {
      action: "publish",
      operationId: "63000000-0000-4000-8000-000000000039",
    }).candidate.status).toBe("published");
    expect(service.decideCuration(databasePath, project.id, rejectCandidate.id, {
      action: "reject",
      operationId: "63000000-0000-4000-8000-000000000040",
    }).candidate.status).toBe("rejected");
  });

  it("keeps createMemory on the owner-only proposer path", () => {
    const databasePath = memoryDatabasePath();
    const project = createProject("Owner memory path", databasePath);

    expect(createMemory(databasePath, project.id, {
      content: "Owner-created memory",
      sourceRef: "Owner source",
      sourceType: "owner_input",
      type: "goal",
    }).actor).toEqual({
      confirmer: null,
      persistedBy: "platform",
      proposerAgent: null,
      proposerType: "owner",
    });
  });
});
