import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";
import { createMission } from "@/src/server/mission-service";
import { createProject } from "@/src/server/projects";
import { validateV7 } from "@/src/server/migrations-v7";


const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-v6-mission-"));
  directories.push(directory);
  return join(directory, "cockpit.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("fresh v6 mission initialization", () => {
  it("atomically creates the mission, delivery context head and sequence-one event", () => {
    const path = databasePath();
    const project = createProject("Fresh mission", path);
    const mission = createMission(path, project.id, { title: "Mission", goal: "Goal" });
    const database = openDatabase(path);

    expect(database.prepare(
      `SELECT mission_id AS missionId,project_id AS projectId,context_version AS contextVersion,
              state,current_delivery_id AS currentDeliveryId,next_event_sequence AS nextSequence,version
       FROM mission_delivery_heads WHERE mission_id=?`,
    ).get(mission.id)).toEqual({
      contextVersion: 1,
      currentDeliveryId: null,
      missionId: mission.id,
      nextSequence: 2,
      projectId: project.id,
      state: "ongoing",
      version: 1,
    });
    expect(database.prepare(
      `SELECT project_id AS projectId,mission_id AS missionId,sequence,type,actor_type AS actorType,
              actor_id AS actorId,payload_json AS payload
       FROM review_events WHERE mission_id=?`,
    ).get(mission.id)).toEqual({
      actorId: null,
      actorType: "system",
      missionId: mission.id,
      payload: JSON.stringify({ contextVersion: 1, headVersion: 1, missionId: mission.id }),
      projectId: project.id,
      sequence: 1,
      type: "mission_review_initialized",
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(validateV7(database)).toBeNull();
    database.close();
  });

  it("rolls back the mission when head or event initialization faults", () => {
    const path = databasePath();
    const project = createProject("Rollback", path);
    const database = openDatabase(path);
    database.exec(`
      CREATE TRIGGER inject_review_event_fault
      BEFORE INSERT ON review_events
      BEGIN SELECT RAISE(ABORT,'injected event fault'); END
    `);
    database.close();

    expect(() => createMission(path, project.id, { title: "Mission", goal: "Goal" }))
      .toThrow();
    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare("SELECT COUNT(*) AS count FROM missions").get()).toEqual({ count: 0 });
    expect(unchanged.prepare("SELECT COUNT(*) AS count FROM mission_delivery_heads").get())
      .toEqual({ count: 0 });
    expect(unchanged.prepare("SELECT COUNT(*) AS count FROM review_events").get())
      .toEqual({ count: 0 });
    unchanged.close();
  });

  it("has one concurrent create winner and leaves no orphan mission, head or event", async () => {
    const path = databasePath();
    const project = createProject("Concurrent", path);
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() =>
        createMission(path, project.id, { title: "Winner A", goal: "Goal" })),
      Promise.resolve().then(() =>
        createMission(path, project.id, { title: "Winner B", goal: "Goal" })),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const database = openDatabase(path);
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM missions) AS missions,
        (SELECT COUNT(*) FROM mission_delivery_heads) AS heads,
        (SELECT COUNT(*) FROM review_events) AS events
    `).get()).toEqual({ events: 1, heads: 1, missions: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(validateV7(database)).toBeNull();
    database.close();
  });

  it("fails closed when a mission initialization fact is orphaned or version-drifted", () => {
    const orphanPath = databasePath();
    const orphanProject = createProject("Orphan", orphanPath);
    createMission(orphanPath, orphanProject.id, { title: "Mission", goal: "Goal" });
    const orphan = new DatabaseSync(orphanPath);
    orphan.exec("PRAGMA foreign_keys=OFF");
    orphan.exec("DELETE FROM mission_delivery_heads");
    orphan.close();
    expect(() => openDatabase(orphanPath))
      .toThrowError(expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }));

    const driftPath = databasePath();
    const driftProject = createProject("Version drift", driftPath);
    createMission(driftPath, driftProject.id, { title: "Mission", goal: "Goal" });
    const drift = new DatabaseSync(driftPath);
    drift.exec("DROP TRIGGER review_event_no_update");
    drift.exec("UPDATE review_events SET sequence=2");
    drift.exec(`
      CREATE TRIGGER review_event_no_update BEFORE UPDATE ON review_events
      BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW_EVENT'); END
    `);
    drift.close();
    expect(() => openDatabase(driftPath))
      .toThrowError(expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }));
  });
});
