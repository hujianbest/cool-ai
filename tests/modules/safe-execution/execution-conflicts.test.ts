import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  compareCanonicalPathStates,
  normalizeCanonicalRelativePath,
  reserveExecutionStagedPaths,
  staleExecutionForCanonicalPathChanges,
} from "@/src/adapters/outbound/sqlite/safe-execution/execution-conflicts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

type State = {
  exists: boolean;
  identity: string | null;
  path: string;
  sha256: string | null;
};

const file = (path: string, value: string, identity = `id:${path}`): State => ({
  exists: true,
  identity,
  path,
  sha256: hash(value),
});

const absent = (path: string): State => ({
  exists: false,
  identity: null,
  path,
  sha256: null,
});

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function conflictDatabase(): { database: DatabaseSync; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "cool-ai-conflicts-"));
  directories.push(directory);
  const path = join(directory, "conflicts.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE executions(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reason_code TEXT,
      next_event_sequence INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE execution_staged_results(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      execution_id TEXT NOT NULL
    );
    CREATE TABLE execution_staged_files(
      id TEXT PRIMARY KEY,
      staged_result_id TEXT NOT NULL,
      path TEXT NOT NULL,
      path_key TEXT NOT NULL
    );
    CREATE TABLE execution_events(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      attempt_no INTEGER NOT NULL,
      type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE immutable_previews(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE immutable_usage(id TEXT PRIMARY KEY, tokens INTEGER NOT NULL);
    CREATE TABLE task_state(id TEXT PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO executions(id,project_id,status) VALUES
      ('alpha','project','running'),('beta','project','staged'),('gamma','project','staged');
    INSERT INTO execution_staged_results(id,project_id,execution_id) VALUES
      ('stage-beta','project','beta'),('stage-gamma','project','gamma');
    INSERT INTO execution_staged_files(id,staged_result_id,path,path_key) VALUES
      ('file-beta','stage-beta','src/value.txt','src/value.txt'),
      ('file-gamma','stage-gamma','src/other.txt','src/other.txt');
    INSERT INTO immutable_previews VALUES ('preview','unchanged');
    INSERT INTO immutable_usage VALUES ('usage',17);
    INSERT INTO task_state VALUES ('task','in_progress');
  `);
  return { database, path };
}

describe("execution canonical path conflicts", () => {
  it("detects owner/program edits by identity and hash without overwriting current state", () => {
    const frozen = [
      file("src/read.txt", "read"),
      file("src/modified.txt", "old"),
      absent("src/added.txt"),
    ];
    const current = [
      file("src/read.txt", "owner edit", "owner-replacement"),
      file("src/modified.txt", "old", "program-recreated"),
      file("src/added.txt", "raced add", "external-add"),
    ];

    const result = compareCanonicalPathStates({
      current,
      frozen,
      relevantPaths: ["src/read.txt", "src/modified.txt", "src/added.txt"],
    });

    expect(result.disposition).toBe("stale");
    expect(result.mismatches.map(({ kind, path }) => [path, kind])).toEqual([
      ["src/added.txt", "added_path_now_exists"],
      ["src/modified.txt", "identity_changed"],
      ["src/read.txt", "identity_changed"],
    ]);
    expect(current).toEqual([
      file("src/read.txt", "owner edit", "owner-replacement"),
      file("src/modified.txt", "old", "program-recreated"),
      file("src/added.txt", "raced add", "external-add"),
    ]);
  });

  it("treats delete/recreate with identical bytes as stale and ignores unrelated paths", () => {
    const frozen = [file("src/a.txt", "same", "original"), file("src/b.txt", "before", "b")];
    const current = [
      file("src/a.txt", "same", "recreated"),
      file("src/b.txt", "after", "external"),
    ];

    expect(compareCanonicalPathStates({
      current,
      frozen,
      relevantPaths: ["src/a.txt"],
    })).toMatchObject({
      disposition: "stale",
      mismatches: [{ kind: "identity_changed", path: "src/a.txt" }],
    });
    expect(compareCanonicalPathStates({
      current,
      frozen,
      relevantPaths: [],
    }).disposition).toBe("current");
  });

  it("atomically marks external path changes stale without mutating previews, usage, or task state", () => {
    const { database } = conflictDatabase();
    try {
      const result = staleExecutionForCanonicalPathChanges(database, {
        attemptNo: 1,
        current: [file("src/read.txt", "external", "replacement")],
        executionId: "alpha",
        frozen: [file("src/read.txt", "original", "original")],
        platform: "win32",
        projectId: "project",
        relevantPaths: ["SRC\\READ.txt"],
      });

      expect(result.disposition).toBe("stale");
      expect(database.prepare(
        "SELECT status,reason_code AS reasonCode,version FROM executions WHERE id='alpha'",
      ).get()).toEqual({ reasonCode: "STALE_EXECUTION", status: "stale", version: 2 });
      expect(database.prepare(
        "SELECT sequence,type,payload_json AS payload FROM execution_events WHERE execution_id='alpha'",
      ).get()).toEqual({
        payload: JSON.stringify({ categories: ["external_workspace"], pathCount: 1 }),
        sequence: 1,
        type: "stale_detected",
      });
      expect(database.prepare("SELECT * FROM immutable_previews").all())
        .toEqual([{ body: "unchanged", id: "preview" }]);
      expect(database.prepare("SELECT * FROM immutable_usage").all())
        .toEqual([{ id: "usage", tokens: 17 }]);
      expect(database.prepare("SELECT * FROM task_state").all())
        .toEqual([{ id: "task", status: "in_progress" }]);
    } finally {
      database.close();
    }
  });

  it("normalizes Unicode, separators, dot segments, and platform casing deterministically", () => {
    expect(normalizeCanonicalRelativePath("src\\nested\\..\\CAFÉ.txt", "win32"))
      .toBe("src/café.txt");
    expect(normalizeCanonicalRelativePath("src/Cafe\u0301.txt", "win32"))
      .toBe("src/café.txt");
    expect(normalizeCanonicalRelativePath("src/Case.txt", "linux"))
      .toBe("src/Case.txt");
    expect(() => normalizeCanonicalRelativePath("../escape.txt", "linux")).toThrow(/relative path/iu);
    expect(() => normalizeCanonicalRelativePath("C:\\absolute.txt", "win32")).toThrow(/relative path/iu);
  });

  it("conflicts both executions on the same normalized path even for identical output", () => {
    const { database } = conflictDatabase();
    try {
      const result = reserveExecutionStagedPaths(database, {
        attemptNo: 1,
        executionId: "alpha",
        paths: ["src\\VALUE.txt", "src/value.txt"],
        platform: "win32",
        projectId: "project",
      });

      expect(result).toEqual({
        conflictingExecutionIds: ["beta"],
        disposition: "conflicted",
        pathKeys: ["src/value.txt"],
      });
      expect(database.prepare(
        "SELECT id,status,reason_code AS reasonCode FROM executions WHERE id IN ('alpha','beta') ORDER BY id",
      ).all()).toEqual([
        { id: "alpha", reasonCode: "PATH_CONFLICT", status: "conflicted" },
        { id: "beta", reasonCode: "PATH_CONFLICT", status: "conflicted" },
      ]);
      expect(database.prepare(`
        SELECT execution_id AS executionId,sequence,type,payload_json AS payload
        FROM execution_events ORDER BY execution_id
      `).all().map((row) => ({
        ...(row as Record<string, unknown>),
        payload: JSON.parse((row as { payload: string }).payload),
      }))).toEqual([
        {
          executionId: "alpha",
          payload: { otherExecutionIds: ["beta"], pathCount: 1 },
          sequence: 1,
          type: "conflict_detected",
        },
        {
          executionId: "beta",
          payload: { otherExecutionIds: ["alpha"], pathCount: 1 },
          sequence: 1,
          type: "conflict_detected",
        },
      ]);
      expect(database.prepare("SELECT * FROM immutable_previews").all())
        .toEqual([{ body: "unchanged", id: "preview" }]);
      expect(database.prepare("SELECT * FROM immutable_usage").all())
        .toEqual([{ id: "usage", tokens: 17 }]);
      expect(database.prepare("SELECT * FROM task_state").all())
        .toEqual([{ id: "task", status: "in_progress" }]);
    } finally {
      database.close();
    }
  });

  it("allows non-overlapping executions to stage and merge independently", () => {
    const { database } = conflictDatabase();
    try {
      expect(reserveExecutionStagedPaths(database, {
        attemptNo: 1,
        executionId: "alpha",
        paths: ["src/new.txt"],
        platform: "win32",
        projectId: "project",
      })).toEqual({
        conflictingExecutionIds: [],
        disposition: "reserved",
        pathKeys: ["src/new.txt"],
      });
      expect(database.prepare("SELECT status FROM executions WHERE id='alpha'").get())
        .toEqual({ status: "running" });

      const frozen = [file("src/other.txt", "other"), file("src/new.txt", "before")];
      const afterFirstMerge = [file("src/other.txt", "other"), file("src/new.txt", "merged")];
      expect(compareCanonicalPathStates({
        current: afterFirstMerge,
        frozen,
        relevantPaths: ["src/other.txt"],
      }).disposition).toBe("current");
    } finally {
      database.close();
    }
  });

  it("serializes parallel reservations so same-path races cannot both succeed", async () => {
    const { database, path } = conflictDatabase();
    database.exec(`
      DELETE FROM execution_staged_files;
      DELETE FROM execution_staged_results;
      UPDATE executions SET status='running',reason_code=NULL;
    `);
    const second = new DatabaseSync(path);
    second.exec("PRAGMA busy_timeout=5000");
    try {
      const firstResult = reserveExecutionStagedPaths(database, {
        attemptNo: 1,
        executionId: "alpha",
        paths: ["src/race.txt"],
        platform: "win32",
        projectId: "project",
        persistReservation(current, pathKeys) {
          current.exec(`
            INSERT INTO execution_staged_results VALUES ('stage-alpha','project','alpha');
            INSERT INTO execution_staged_files VALUES
              ('race-alpha','stage-alpha','src/race.txt','${pathKeys[0]}');
          `);
        },
      });
      const secondResult = reserveExecutionStagedPaths(second, {
        attemptNo: 1,
        executionId: "beta",
        paths: ["SRC\\RACE.txt"],
        platform: "win32",
        projectId: "project",
        persistReservation(current, pathKeys) {
          current.exec(`
            INSERT INTO execution_staged_results VALUES ('stage-beta-race','project','beta');
            INSERT INTO execution_staged_files VALUES
              ('race-beta','stage-beta-race','SRC\\RACE.txt','${pathKeys[0]}');
          `);
        },
      });

      expect(firstResult.disposition).toBe("reserved");
      expect(secondResult).toMatchObject({
        conflictingExecutionIds: ["alpha"],
        disposition: "conflicted",
      });
      expect(database.prepare("SELECT id,status FROM executions WHERE id IN ('alpha','beta') ORDER BY id").all())
        .toEqual([
          { id: "alpha", status: "conflicted" },
          { id: "beta", status: "conflicted" },
        ]);
    } finally {
      second.close();
      database.close();
    }
  });
});
