import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-11T08:00:00.000Z";
const DELETED_AT = "2026-08-11T09:00:00.000Z";

let databasePath: string;
let operationCounter = 0;

function nextOperationId(): string {
  operationCounter += 1;
  return `00000000-0000-4000-8000-${String(operationCounter).padStart(12, "0")}`;
}

function seedProject(
  projectId: string,
  agentIds: [string, string, ...string[]],
): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
         VALUES (?,?,?,NULL,NULL,1)`,
      )
      .run(projectId, projectId, NOW);
    const providerId = `provider-${projectId}`;
    database
      .prepare(
        `INSERT INTO providers(
           id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
           credential_version,credential_generation,key_id,api_key_mask,verified_at,
           version,created_at,updated_at
         ) VALUES (?,'Provider','http://localhost/v1','model','cipher','iv','tag',
           1,1,'key','***',?,1,?,?)`,
      )
      .run(providerId, NOW, NOW, NOW);
    const insertAgent = database.prepare(
      `INSERT INTO agents(
         id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
         can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
         updated_at,review_capable
       ) VALUES (?,?,'Peer','Prompt',?,'model','A','sage',
         1,1,0,1000,3,1,?,?,0)`,
    );
    const insertMember = database.prepare(
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
    );
    for (const agentId of agentIds) {
      insertAgent.run(agentId, `Agent ${agentId}`, providerId, NOW, NOW);
      insertMember.run(projectId, agentId, NOW);
    }
  } finally {
    database.close();
  }
}

function createSeededThread(projectId: string, title: string): string {
  return createThread(databasePath, projectId, {
    memberAgentIds: [`agent-${projectId}-a`, `agent-${projectId}-b`],
    operationId: nextOperationId(),
    title,
  }).body.thread.id;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  operationCounter = 0;
  seedProject("project-a", ["agent-project-a-a", "agent-project-a-b"]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("thread recycle bin schema seam", () => {
  it("bootstraps identity 19 with deleted_at, the recycle-bin partial index and thread_purge_markers", () => {
    const raw = new DatabaseSync(databasePath);
    try {
      expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 19 });
      const objects = raw
        .prepare(
          `SELECT type,name FROM sqlite_master
           WHERE name IN ('collaboration_threads_recycle_bin','thread_purge_markers')
           ORDER BY name`,
        )
        .all();
      expect(objects).toEqual([
        { name: "collaboration_threads_recycle_bin", type: "index" },
        { name: "thread_purge_markers", type: "table" },
      ]);
      const columns = (
        raw.prepare("PRAGMA table_info(collaboration_threads)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);
      expect(columns).toContain("deleted_at");
      const index = raw
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE name='collaboration_threads_recycle_bin'`,
        )
        .get() as { sql: string };
      expect(index.sql).toContain("WHERE deleted_at IS NOT NULL");
    } finally {
      raw.close();
    }
  });

  it("accepts NULL and ISO deleted_at values and rejects malformed ones", () => {
    const threadId = createSeededThread("project-a", "Thread A");
    const raw = new DatabaseSync(databasePath);
    try {
      raw
        .prepare("UPDATE collaboration_threads SET deleted_at=? WHERE id=?")
        .run(DELETED_AT, threadId);
      expect(
        raw
          .prepare("SELECT deleted_at FROM collaboration_threads WHERE id=?")
          .get(threadId),
      ).toEqual({ deleted_at: DELETED_AT });
      raw
        .prepare("UPDATE collaboration_threads SET deleted_at=NULL WHERE id=?")
        .run(threadId);
      expect(
        raw
          .prepare("SELECT deleted_at FROM collaboration_threads WHERE id=?")
          .get(threadId),
      ).toEqual({ deleted_at: null });
      expect(() =>
        raw
          .prepare(
            "UPDATE collaboration_threads SET deleted_at='not-a-timestamp' WHERE id=?",
          )
          .run(threadId),
      ).toThrow(/CHECK/u);
      expect(() =>
        raw
          .prepare(
            "UPDATE collaboration_threads SET deleted_at='2026-08-11' WHERE id=?",
          )
          .run(threadId),
      ).toThrow(/CHECK/u);
    } finally {
      raw.close();
    }
  });

  it("enforces the purge-marker primary key, projects cascade and no threads foreign key", () => {
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec("PRAGMA foreign_keys=ON");
      // No FK to collaboration_threads: a marker names a thread tuple that is
      // about to disappear inside the purge transaction.
      raw
        .prepare(
          `INSERT INTO thread_purge_markers(project_id,thread_id,created_at)
           VALUES ('project-a','missing-thread',?)`,
        )
        .run(NOW);
      expect(() =>
        raw
          .prepare(
            `INSERT INTO thread_purge_markers(project_id,thread_id,created_at)
             VALUES ('project-a','missing-thread',?)`,
          )
          .run(NOW),
      ).toThrow(/UNIQUE constraint failed: thread_purge_markers/u);
      expect(() =>
        raw
          .prepare(
            `INSERT INTO thread_purge_markers(project_id,thread_id,created_at)
             VALUES ('missing-project','thread',?)`,
          )
          .run(NOW),
      ).toThrow(/FOREIGN KEY/u);
      expect(() =>
        raw
          .prepare(
            `INSERT INTO thread_purge_markers(project_id,thread_id,created_at)
             VALUES ('project-a','other-thread','not-a-timestamp')`,
          )
          .run(),
      ).toThrow(/CHECK/u);
      raw.prepare("DELETE FROM projects WHERE id='project-a'").run();
      expect(
        raw.prepare("SELECT count(*) AS count FROM thread_purge_markers").get(),
      ).toEqual({ count: 0 });
    } finally {
      raw.close();
    }
  });

  it("extends the three thread no_delete triggers with the purge-marker exemption", () => {
    const threadA = createSeededThread("project-a", "Thread A");
    const threadB = createSeededThread("project-a", "Thread B");
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec("PRAGMA foreign_keys=OFF");
      const deleteFact = raw.prepare(
        "DELETE FROM collaboration_thread_facts WHERE project_id=? AND thread_id=?",
      );
      const deleteMember = raw.prepare(
        "DELETE FROM collaboration_thread_policy_members WHERE project_id=? AND thread_id=?",
      );
      const deleteRevision = raw.prepare(
        "DELETE FROM collaboration_thread_policy_revisions WHERE project_id=? AND thread_id=?",
      );
      expect(() => deleteFact.run("project-a", threadA)).toThrow(/IMMUTABLE_THREAD_FACT/u);
      expect(() => deleteMember.run("project-a", threadA)).toThrow(
        /IMMUTABLE_THREAD_POLICY_MEMBER/u,
      );
      expect(() => deleteRevision.run("project-a", threadA)).toThrow(
        /IMMUTABLE_THREAD_POLICY_REVISION/u,
      );

      raw
        .prepare(
          `INSERT INTO thread_purge_markers(project_id,thread_id,created_at)
           VALUES (?,?,?)`,
        )
        .run("project-a", threadA, NOW);
      // The exemption is scoped to the marked tuple only.
      expect(() => deleteFact.run("project-a", threadB)).toThrow(/IMMUTABLE_THREAD_FACT/u);
      expect(() => deleteMember.run("project-a", threadB)).toThrow(
        /IMMUTABLE_THREAD_POLICY_MEMBER/u,
      );
      expect(() => deleteRevision.run("project-a", threadB)).toThrow(
        /IMMUTABLE_THREAD_POLICY_REVISION/u,
      );

      expect(deleteFact.run("project-a", threadA).changes).toBeGreaterThan(0);
      expect(deleteMember.run("project-a", threadA).changes).toBeGreaterThan(0);
      expect(deleteRevision.run("project-a", threadA).changes).toBeGreaterThan(0);
    } finally {
      raw.close();
    }
  });

  it("fails reopen validation when a purge marker survives its transaction", () => {
    const raw = new DatabaseSync(databasePath);
    try {
      raw
        .prepare(
          `INSERT INTO thread_purge_markers(project_id,thread_id,created_at)
           VALUES ('project-a','thread-x',?)`,
        )
        .run(NOW);
    } finally {
      raw.close();
    }
    expect(() => openDatabase(databasePath)).toThrowError(
      expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }) as Error,
    );
  });

  it("reopens an exact identity-19 database idempotently with a soft-deleted thread", () => {
    const threadId = createSeededThread("project-a", "Thread A");
    const raw = new DatabaseSync(databasePath);
    try {
      raw
        .prepare(
          "UPDATE collaboration_threads SET deleted_at=? WHERE project_id=? AND id=?",
        )
        .run(DELETED_AT, "project-a", threadId);
    } finally {
      raw.close();
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const database = openDatabase(databasePath);
      try {
        expect(database.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 19,
        });
        expect(
          database
            .prepare("SELECT deleted_at FROM collaboration_threads WHERE id=?")
            .get(threadId),
        ).toEqual({ deleted_at: DELETED_AT });
      } finally {
        database.close();
      }
    }
  });
});
