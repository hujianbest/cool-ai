import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollaborationError } from "@/src/modules/public-collaboration";
import {
  createThread,
  updateThreadPolicy,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

const NOW = "2026-08-08T08:00:00.000Z";
const CREATE_OPERATION = "00000000-0000-4000-8000-000000000701";
const UPDATE_OPERATION = "00000000-0000-4000-8000-000000000801";
const OTHER_OPERATION = "00000000-0000-4000-8000-000000000802";
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
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?, ?, ?)",
    );
    agentIds.forEach((agentId, position) => {
      insertAgent.run(agentId, `Agent ${agentId}`, providerId, NOW, NOW);
      insertMember.run(projectId, agentId, `2026-08-08T08:00:0${position}.000Z`);
    });
  } finally {
    database.close();
  }
}

function createTestThread(projectId = "project-a"): ReturnType<typeof createThread> {
  return createThread(databasePath, projectId, {
    memberAgentIds:
      projectId === "project-a" ? ["agent-a", "agent-b"] : ["agent-x", "agent-y"],
    operationId: CREATE_OPERATION,
    title: "Policy thread",
  });
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

function policyCounts(threadId: string): Record<string, number> {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT
           (SELECT count(*) FROM collaboration_thread_policy_revisions
             WHERE project_id='project-a' AND thread_id=?) AS revisions,
           (SELECT count(*) FROM collaboration_thread_policy_members
             WHERE project_id='project-a' AND thread_id=?) AS members,
           (SELECT count(*) FROM collaboration_thread_facts
             WHERE project_id='project-a' AND thread_id=?) AS facts,
           (SELECT count(*) FROM collaboration_operations
             WHERE project_id='project-a' AND thread_id=?) AS operations`,
      )
      .get(threadId, threadId, threadId, threadId) as Record<string, number>;
  } finally {
    database.close();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  directory = mkdtempSync(join(tmpdir(), "thread-policy-"));
  databasePath = join(directory, "cockpit.sqlite");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { force: true, recursive: true });
});

describe("thread member policy updates", () => {
  it("atomically appends an immutable ordered revision, fact, heads, and receipt", () => {
    seedProject("project-a", ["agent-a", "agent-b", "agent-c"]);
    const created = createTestThread();
    const threadId = created.body.thread.id;

    const result = updateThreadPolicy(databasePath, "project-a", threadId, {
      expectedVersion: 1,
      memberAgentIds: ["agent-c", "agent-a"],
      operationId: UPDATE_OPERATION,
    });

    expect(result.status).toBe(200);
    expect(result.body.thread).toMatchObject({
      id: threadId,
      lastActivitySequence: 3,
      policyVersion: 2,
      projectId: "project-a",
      version: 2,
    });
    expect(result.body.policy).toEqual(result.body.thread.policy);
    expect(result.body.policy.members).toEqual([
      {
        agentId: "agent-c",
        displayNameSnapshot: "Agent agent-c",
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
      activitySequence: 3,
      payload: { policyVersion: 2 },
      policyRevisionId: result.body.policy.revisionId,
      sequence: 3,
      type: "policy_changed",
    });

    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT active_policy_revision_id AS revisionId,policy_version AS policyVersion,
                    next_fact_sequence AS nextFactSequence,last_activity_sequence AS activity,
                    version
             FROM collaboration_threads WHERE project_id=? AND id=?`,
          )
          .get("project-a", threadId),
      ).toEqual({
        activity: 3,
        nextFactSequence: 4,
        policyVersion: 2,
        revisionId: result.body.policy.revisionId,
        version: 2,
      });
      expect(
        database
          .prepare(
            `SELECT thread_id AS threadId,kind,status,http_status AS httpStatus,
                    response_schema_version AS schemaVersion
             FROM collaboration_operations WHERE project_id=? AND id=?`,
          )
          .get("project-a", UPDATE_OPERATION),
      ).toEqual({
        httpStatus: 200,
        kind: "policy_update",
        schemaVersion: 7,
        status: "completed",
        threadId,
      });
    } finally {
      database.close();
    }
  });

  it("replays the same operation/hash and conflicts on a different hash", () => {
    seedProject("project-a", ["agent-a", "agent-b", "agent-c"]);
    const threadId = createTestThread().body.thread.id;
    const input = {
      expectedVersion: 1,
      memberAgentIds: ["agent-b", "agent-c"],
      operationId: UPDATE_OPERATION,
    };
    const first = updateThreadPolicy(databasePath, "project-a", threadId, input);
    const replay = updateThreadPolicy(databasePath, "project-a", threadId, input);

    expect(replay).toEqual(first);
    expectCode(
      () =>
        updateThreadPolicy(databasePath, "project-a", threadId, {
          ...input,
          memberAgentIds: ["agent-a", "agent-c"],
        }),
      "OPERATION_CONFLICT",
    );
    expect(policyCounts(threadId)).toEqual({
      facts: 3,
      members: 4,
      operations: 2,
      revisions: 2,
    });
  });

  it("returns sanitized stale-version conflict with currentVersion and writes nothing", () => {
    seedProject("project-a", ["agent-a", "agent-b", "agent-c"]);
    const threadId = createTestThread().body.thread.id;
    updateThreadPolicy(databasePath, "project-a", threadId, {
      expectedVersion: 1,
      memberAgentIds: ["agent-a", "agent-c"],
      operationId: UPDATE_OPERATION,
    });
    const before = policyCounts(threadId);

    const error = expectCode(
      () =>
        updateThreadPolicy(databasePath, "project-a", threadId, {
          expectedVersion: 1,
          memberAgentIds: ["agent-b", "agent-c"],
          operationId: OTHER_OPERATION,
        }),
      "VERSION_CONFLICT",
    );

    expect(error.httpStatus).toBe(409);
    expect(error.message).toBe("Thread version has changed.");
    expect(error.details).toEqual({ currentVersion: 2 });
    expect(policyCounts(threadId)).toEqual(before);
  });

  it("rejects empty, duplicate, removed, unavailable, and other-project members", () => {
    seedProject("project-a", ["agent-a", "agent-b", "agent-c"]);
    seedProject("project-b", ["agent-x", "agent-y"]);
    const threadId = createTestThread().body.thread.id;
    const database = openDatabase(databasePath);
    try {
      database
        .prepare("DELETE FROM project_memberships WHERE project_id=? AND agent_id=?")
        .run("project-a", "agent-c");
    } finally {
      database.close();
    }
    const before = policyCounts(threadId);
    const invalidLists = [
      [],
      ["agent-a", "agent-a"],
      ["agent-a", "agent-c"],
      ["agent-a", "missing-agent"],
      ["agent-a", "agent-x"],
    ];

    invalidLists.forEach((memberAgentIds, index) => {
      const operationId = `00000000-0000-4000-8000-${String(900 + index).padStart(12, "0")}`;
      const expectedCode = index < 2 ? "INVALID_INPUT" : "AGENT_NOT_MEMBER";
      expectCode(
        () =>
          updateThreadPolicy(databasePath, "project-a", threadId, {
            expectedVersion: 1,
            memberAgentIds,
            operationId,
          }),
        expectedCode,
      );
      expect(policyCounts(threadId)).toEqual(before);
    });
  });

  it("validates the project/thread tuple without changing either project", () => {
    seedProject("project-a", ["agent-a", "agent-b"]);
    seedProject("project-b", ["agent-x", "agent-y"]);
    const threadId = createTestThread("project-a").body.thread.id;
    const before = policyCounts(threadId);

    const error = expectCode(
      () =>
        updateThreadPolicy(databasePath, "project-b", threadId, {
          expectedVersion: 1,
          memberAgentIds: ["agent-x", "agent-y"],
          operationId: UPDATE_OPERATION,
        }),
      "RESOURCE_NOT_FOUND",
    );
    expect(error.message).toBe("Thread was not found.");
    expect(policyCounts(threadId)).toEqual(before);
  });

  it("enforces revision/member immutability and deferred active-head foreign keys", () => {
    seedProject("project-a", ["agent-a", "agent-b", "agent-c"]);
    const threadId = createTestThread().body.thread.id;
    const updated = updateThreadPolicy(databasePath, "project-a", threadId, {
      expectedVersion: 1,
      memberAgentIds: ["agent-b", "agent-c"],
      operationId: UPDATE_OPERATION,
    });
    const revisionId = updated.body.policy.revisionId;
    const database = openDatabase(databasePath);
    try {
      expect(() =>
        database
          .prepare("UPDATE collaboration_thread_policy_revisions SET version=3 WHERE id=?")
          .run(revisionId),
      ).toThrow(/IMMUTABLE_THREAD_POLICY_REVISION/u);
      expect(() =>
        database
          .prepare("DELETE FROM collaboration_thread_policy_revisions WHERE id=?")
          .run(revisionId),
      ).toThrow(/IMMUTABLE_THREAD_POLICY_REVISION/u);
      expect(() =>
        database
          .prepare(
            `UPDATE collaboration_thread_policy_members SET position=9
             WHERE project_id=? AND thread_id=? AND revision_id=? AND agent_id=?`,
          )
          .run("project-a", threadId, revisionId, "agent-b"),
      ).toThrow(/IMMUTABLE_THREAD_POLICY_MEMBER/u);
      expect(() =>
        database
          .prepare(
            `DELETE FROM collaboration_thread_policy_members
             WHERE project_id=? AND thread_id=? AND revision_id=? AND agent_id=?`,
          )
          .run("project-a", threadId, revisionId, "agent-b"),
      ).toThrow(/IMMUTABLE_THREAD_POLICY_MEMBER/u);

      database.exec("BEGIN IMMEDIATE");
      database.exec("PRAGMA defer_foreign_keys=ON");
      database
        .prepare(
          `UPDATE collaboration_threads
           SET active_policy_revision_id=?,policy_version=3,version=3
           WHERE project_id=? AND id=?`,
        )
        .run("future-revision", "project-a", threadId);
      expect(() => database.exec("COMMIT")).toThrow(/FOREIGN KEY constraint failed/u);
      if (database.isTransaction) database.exec("ROLLBACK");
    } finally {
      database.close();
    }
    expect(policyCounts(threadId)).toEqual({
      facts: 3,
      members: 4,
      operations: 2,
      revisions: 2,
    });
  });
});
