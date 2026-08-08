import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase as openProductionDatabase } from "@/src/server/db";
import * as fixtureDb from "@/tests/v6-fixture-db";

type FixtureOptions = {
  missingDeliveryHeadMissionIds: readonly string[];
  missingReviewHeadResultIds: readonly string[];
};

type FixtureHandle = object;

type FixtureModule = {
  createV6FixtureHandle?: (path: string, options: FixtureOptions) => FixtureHandle;
  openV6FixtureDatabase?: (handle: FixtureHandle) => DatabaseSync;
};

const fixture = fixtureDb as FixtureModule;
const NOW = "2026-08-01T12:00:00.000Z";
const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "v6-fixture-contract-"));
  directories.push(directory);
  return join(directory, "cockpit.sqlite");
}

function createMissingMission(path: string, missionId = "mission", projectId = "project"): void {
  const initialized = fixtureDb.openDatabaseAtV6(path);
  initialized.close();
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=OFF");
  database.prepare(`
    INSERT INTO projects(id,name,created_at,version) VALUES (?, ?, ?, 1)
  `).run(projectId, projectId, NOW);
  database.prepare(`
    INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
    VALUES (?, ?, 'Mission', 'Goal', 1, ?, ?)
  `).run(missionId, projectId, NOW, NOW);
  database.close();
}

function createResultGaps(
  path: string,
  options: { partialHead?: boolean; crossProject?: boolean } = {},
): void {
  const initialized = fixtureDb.openDatabaseAtV6(path);
  initialized.close();
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES
      ('result-1','project','mission','work',1,'execution-1','staged-1',
       'journal-1',NULL,'agent','${NOW}'),
      ('result-2','${options.crossProject ? "other-project" : "project"}','mission','work',2,
       'execution-2','staged-2','journal-2','result-1','agent','${NOW}');
  `);
  if (options.partialHead) {
    database.exec(`
      INSERT INTO work_item_review_heads(
        work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
        state,version,updated_at
      ) VALUES ('work','project','mission','result-1',NULL,'pending_review',1,'${NOW}')
    `);
  }
  database.close();
}

function counts(path: string): Record<string, number> {
  const database = new DatabaseSync(path);
  try {
    return database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM missions) AS missions,
        (SELECT COUNT(*) FROM mission_delivery_heads) AS deliveryHeads,
        (SELECT COUNT(*) FROM review_events) AS events
    `).get() as Record<string, number>;
  } finally {
    database.close();
  }
}

function validHandle(path: string, options: FixtureOptions): FixtureHandle {
  expect(fixture.createV6FixtureHandle).toBeTypeOf("function");
  return fixture.createV6FixtureHandle!(path, options);
}

function openFixture(handle: FixtureHandle): DatabaseSync {
  expect(fixture.openV6FixtureDatabase).toBeTypeOf("function");
  return fixture.openV6FixtureDatabase!(handle);
}

function TypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return TypeScriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function expectRejected(open: () => DatabaseSync | undefined): void {
  try {
    const database = open();
    database?.close();
  } catch {
    return;
  }
  throw new Error("fixture open unexpectedly accepted unsafe input");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("v6 fixture-only missing-head repair contract", () => {
  it("requires a module-branded handle and the exact missing mission allowlist", () => {
    const path = databasePath();
    createMissingMission(path);
    const before = counts(path);

    expect(() => expectRejected(
      () => (fixture.openV6FixtureDatabase as ((value: unknown) => DatabaseSync) | undefined)?.(path),
    )).not.toThrow();
    expect(() => expectRejected(() =>
      (fixture.openV6FixtureDatabase as ((value: unknown) => DatabaseSync) | undefined)?.({
      path,
      options: {
        missingDeliveryHeadMissionIds: ["mission"],
        missingReviewHeadResultIds: [],
      },
      }))).not.toThrow();
    expect(counts(path)).toEqual(before);

    for (const ids of [[], ["mission", "extra"], ["mission", "mission"]]) {
      const handle = validHandle(path, {
        missingDeliveryHeadMissionIds: ids,
        missingReviewHeadResultIds: [],
      });
      expect(() => openFixture(handle)).toThrow();
      expect(counts(path)).toEqual(before);
    }

    const database = openFixture(validHandle(path, {
      missingDeliveryHeadMissionIds: ["mission"],
      missingReviewHeadResultIds: [],
    }));
    expect(database.prepare(
      "SELECT mission_id AS missionId,project_id AS projectId FROM mission_delivery_heads",
    ).get()).toEqual({ missionId: "mission", projectId: "project" });
    expect(database.prepare(
      "SELECT mission_id AS missionId,sequence,type FROM review_events",
    ).get()).toEqual({
      missionId: "mission",
      sequence: 1,
      type: "mission_review_initialized",
    });
    database.close();
  });

  it("fails closed and preserves rows for extra schema or data damage", () => {
    for (const damage of ["schema", "data"] as const) {
      const path = databasePath();
      createMissingMission(path);
      const damaged = new DatabaseSync(path);
      if (damage === "schema") {
        damaged.exec("DROP TRIGGER review_event_no_update");
      } else {
        damaged.exec("PRAGMA foreign_keys=OFF");
        damaged.prepare("UPDATE missions SET project_id='wrong' WHERE id='mission'").run();
      }
      damaged.close();
      const before = counts(path);

      expect(() => openFixture(validHandle(path, {
        missingDeliveryHeadMissionIds: ["mission"],
        missingReviewHeadResultIds: [],
      }))).toThrow();
      expect(counts(path)).toEqual(before);
    }
  });

  it("requires the exact current-latest result gap and rejects partial or mismatched rows", () => {
    for (const testCase of [
      { allow: [], options: {} },
      { allow: ["result-1"], options: {} },
      { allow: ["result-2", "result-extra"], options: {} },
      { allow: ["result-2", "result-2"], options: {} },
      { allow: ["result-2"], options: { partialHead: true } },
      { allow: ["result-2"], options: { crossProject: true } },
    ]) {
      const path = databasePath();
      createResultGaps(path, testCase.options);
      const before = new DatabaseSync(path);
      const beforeRows = before.prepare(`
        SELECT
          (SELECT COUNT(*) FROM work_item_result_versions) AS results,
          (SELECT COUNT(*) FROM work_item_review_heads) AS heads
      `).get();
      before.close();

      expect(() => openFixture(validHandle(path, {
        missingDeliveryHeadMissionIds: [],
        missingReviewHeadResultIds: testCase.allow,
      }))).toThrow();

      const after = new DatabaseSync(path);
      expect(after.prepare(`
        SELECT
          (SELECT COUNT(*) FROM work_item_result_versions) AS results,
          (SELECT COUNT(*) FROM work_item_review_heads) AS heads
      `).get()).toEqual(beforeRows);
      after.close();
    }
  });

  it("never lets the helper or production open repair an unbranded damaged database", () => {
    const path = databasePath();
    createMissingMission(path);
    const before = counts(path);

    expect(() => openProductionDatabase(path))
      .toThrowError(expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }));
    expect(() => expectRejected(
      () => (fixtureDb as { openDatabase?: (value: unknown) => DatabaseSync }).openDatabase?.(path),
    )).not.toThrow();
    expect(counts(path)).toEqual(before);
  });

  it("is never imported by production modules", () => {
    for (const path of TypeScriptFiles(join(process.cwd(), "src"))) {
      expect(readFileSync(path, "utf8"), path).not.toContain("tests/v6-fixture-db");
    }
  });
});
