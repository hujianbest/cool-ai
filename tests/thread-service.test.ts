import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollaborationError } from "@/src/server/collaboration/collaboration-errors";
import { createThread, listThreads } from "@/src/server/collaboration/thread-service";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

const NOW = "2026-08-08T08:00:00.000Z";
const OPERATION_1 = "00000000-0000-4000-8000-000000000701";
const OPERATION_2 = "00000000-0000-4000-8000-000000000702";
let directory: string;
let databasePath: string;

function seedProject(projectId: string, agentIds: [string, string, ...string[]]): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
         VALUES (?, ?, ?, NULL, NULL, 1)`,
      )
      .run(projectId, projectId, NOW);
    const providerId = `provider-${projectId}`;
    database
      .prepare(
        `INSERT INTO providers(
           id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
           credential_version,credential_generation,key_id,api_key_mask,verified_at,
           version,created_at,updated_at
         ) VALUES (?, 'Provider', 'http://localhost/v1', 'model', 'cipher', 'iv', 'tag',
           1, 1, 'key', '***', ?, 1, ?, ?)`,
      )
      .run(providerId, NOW, NOW, NOW);
    const insertAgent = database.prepare(
      `INSERT INTO agents(
         id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
         can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
         updated_at,review_capable
       ) VALUES (?, ?, 'Peer', 'Prompt', ?, 'model', 'A', 'sage',
         1, 1, 0, 1000, 3, 1, ?, ?, 0)`,
    );
    const insertMember = database.prepare(
      `INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?, ?, ?)`,
    );
    agentIds.forEach((agentId, position) => {
      insertAgent.run(agentId, `Agent ${agentId}`, providerId, NOW, NOW);
      insertMember.run(projectId, agentId, `2026-08-08T08:00:0${position}.000Z`);
    });
  } finally {
    database.close();
  }
}

function expectCode(operation: () => unknown, code: string): CollaborationError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
    return error as CollaborationError;
  }
  throw new Error(`Expected ${code}`);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "thread-service-"));
  databasePath = join(directory, "cockpit.sqlite");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { force: true, recursive: true });
});

describe("project thread service", () => {
  it("creates one atomic thread, revision, ordered members, facts, and receipt", () => {
    seedProject("project-a", ["agent-a", "agent-b", "agent-c"]);

    const result = createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-b", "agent-a"],
      operationId: OPERATION_1,
      title: "  Planning 👩🏽‍💻  ",
    });

    expect(result.status).toBe(201);
    expect(result.body.created).toBe(true);
    expect(result.body.thread).toMatchObject({
      availability: "ready",
      policyVersion: 1,
      projectId: "project-a",
      title: "Planning 👩🏽‍💻",
      version: 1,
    });
    expect(result.body.thread.policy.members).toEqual([
      {
        agentId: "agent-b",
        displayNameSnapshot: "Agent agent-b",
        live: "current",
        position: 0,
      },
      {
        agentId: "agent-a",
        displayNameSnapshot: "Agent agent-a",
        live: "current",
        position: 1,
      },
    ]);
    expect(result.body.fact).toMatchObject({
      activitySequence: 1,
      payload: { title: "Planning 👩🏽‍💻" },
      sequence: 1,
      type: "thread_created",
    });
    expect(result.body.thread.lastActivitySequence).toBe(2);

    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT type,sequence,activity_sequence AS activitySequence,
                    policy_revision_id AS policyRevisionId
             FROM collaboration_thread_facts
             WHERE project_id=? AND thread_id=? ORDER BY sequence`,
          )
          .all("project-a", result.body.thread.id),
      ).toEqual([
        {
          activitySequence: 1,
          policyRevisionId: null,
          sequence: 1,
          type: "thread_created",
        },
        {
          activitySequence: 2,
          policyRevisionId: result.body.thread.policy.revisionId,
          sequence: 2,
          type: "policy_changed",
        },
      ]);
      expect(
        database
          .prepare(
            `SELECT active_policy_revision_id AS revisionId,policy_version AS policyVersion,
                    next_fact_sequence AS nextFactSequence,last_activity_sequence AS activity,
                    version
             FROM collaboration_threads WHERE project_id=? AND id=?`,
          )
          .get("project-a", result.body.thread.id),
      ).toEqual({
        activity: 2,
        nextFactSequence: 3,
        policyVersion: 1,
        revisionId: result.body.thread.policy.revisionId,
        version: 1,
      });
      expect(
        database
          .prepare(
            `SELECT thread_id AS threadId,kind,status,http_status AS httpStatus,
                    response_schema_version AS schemaVersion
             FROM collaboration_operations WHERE project_id=? AND id=?`,
          )
          .get("project-a", OPERATION_1),
      ).toEqual({
        httpStatus: 201,
        kind: "thread_create",
        schemaVersion: 7,
        status: "completed",
        threadId: result.body.thread.id,
      });
    } finally {
      database.close();
    }
  });

  it("accepts one to eighty trimmed graphemes and rejects malformed input without writes", () => {
    seedProject("project-a", ["agent-a", "agent-b"]);
    const eighty = "👩🏽‍💻".repeat(80);
    const accepted = createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: OPERATION_1,
      title: ` ${eighty} `,
    });
    expect(accepted.body.thread.title).toBe(eighty);

    const invalidInputs = [
      {
        memberAgentIds: ["agent-a", "agent-b"],
        operationId: OPERATION_2,
        title: "👩🏽‍💻".repeat(81),
      },
      { memberAgentIds: ["agent-a"], operationId: OPERATION_2, title: "Too few" },
      {
        memberAgentIds: ["agent-a", "agent-a"],
        operationId: OPERATION_2,
        title: "Duplicate",
      },
      {
        extra: true,
        memberAgentIds: ["agent-a", "agent-b"],
        operationId: OPERATION_2,
        title: "Extra",
      },
    ];
    for (const input of invalidInputs) {
      const error = expectCode(
        () => createThread(databasePath, "project-a", input),
        "INVALID_INPUT",
      );
      expect(error.message).toBe("Thread input is invalid.");
    }
    expect(listThreads(databasePath, "project-a", {}).body.threads).toHaveLength(1);
  });

  it("allows same-title threads, replays an operation exactly, and conflicts on another hash", () => {
    seedProject("project-a", ["agent-a", "agent-b"]);
    const input = {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: OPERATION_1,
      title: "Same title",
    };
    const first = createThread(databasePath, "project-a", input);
    const replay = createThread(databasePath, "project-a", input);
    const second = createThread(databasePath, "project-a", {
      ...input,
      operationId: OPERATION_2,
    });

    expect(replay).toEqual(first);
    expect(second.body.thread.id).not.toBe(first.body.thread.id);
    const conflict = expectCode(
      () => createThread(databasePath, "project-a", { ...input, title: "Changed" }),
      "OPERATION_CONFLICT",
    );
    expect(conflict.message).toBe("Operation id was already used for different input.");
    expect(listThreads(databasePath, "project-a", {}).body.threads).toHaveLength(2);
  });

  it("requires a deduplicated set of current members from the same project", () => {
    seedProject("project-a", ["agent-a", "agent-b"]);
    seedProject("project-b", ["agent-c", "agent-d"]);

    const error = expectCode(
      () =>
        createThread(databasePath, "project-a", {
          memberAgentIds: ["agent-a", "agent-c"],
          operationId: OPERATION_1,
          title: "Cross project",
        }),
      "AGENT_NOT_MEMBER",
    );

    expect(error.message).toBe("Selected Agent is not a current project member.");
    expect(listThreads(databasePath, "project-a", {}).body.threads).toEqual([]);
    expect(listThreads(databasePath, "project-b", {}).body.threads).toEqual([]);
  });

  it("orders same-time creation deterministically and pages with strict opaque cursors", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    seedProject("project-a", ["agent-a", "agent-b"]);
    const first = createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: OPERATION_1,
      title: "First",
    });
    const second = createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: OPERATION_2,
      title: "Second",
    });

    const firstPage = listThreads(databasePath, "project-a", { limit: 1 }).body;
    expect(firstPage.threads.map(({ id }) => id)).toEqual([second.body.thread.id]);
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const secondPage = listThreads(databasePath, "project-a", {
      cursor: firstPage.nextCursor!,
      limit: 1,
    }).body;
    expect(secondPage.threads.map(({ id }) => id)).toEqual([first.body.thread.id]);
    expect(secondPage.nextCursor).toBeNull();
    expect(listThreads(databasePath, "project-a", { limit: 100 }).body.threads).toEqual(
      listThreads(databasePath, "project-a", { limit: 100 }).body.threads,
    );

    const invalidQueries = [
      { cursor: "not+base64" },
      { cursor: Buffer.from('{"v":1,"a":2,"id":"x","extra":true}').toString("base64url") },
      { cursor: Buffer.from('{"a":2,"v":1,"id":"x"}').toString("base64url") },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: 1, unknown: true },
    ];
    for (const query of invalidQueries) {
      const error = expectCode(
        () => listThreads(databasePath, "project-a", query),
        "INVALID_INPUT",
      );
      expect(error.message).toBe("Thread list input is invalid.");
    }
  });

  it("isolates project lists and permits the same operation UUID in another project", () => {
    seedProject("project-a", ["agent-a", "agent-b"]);
    seedProject("project-b", ["agent-c", "agent-d"]);
    createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: OPERATION_1,
      title: "A only",
    });
    createThread(databasePath, "project-b", {
      memberAgentIds: ["agent-c", "agent-d"],
      operationId: OPERATION_1,
      title: "B only",
    });

    expect(
      listThreads(databasePath, "project-a", {}).body.threads.map(({ title }) => title),
    ).toEqual(["A only"]);
    expect(
      listThreads(databasePath, "project-b", {}).body.threads.map(({ title }) => title),
    ).toEqual(["B only"]);
    const missing = expectCode(
      () => listThreads(databasePath, "missing-project", {}),
      "PROJECT_NOT_FOUND",
    );
    expect(missing.message).toBe("Project was not found.");
  });
});
