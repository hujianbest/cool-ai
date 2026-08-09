import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { createServerComposition } from "@/src/server/composition/server-composition";
import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createMission } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { openEmptyCurrentDatabase } from "@/tests/fixtures/sqlite/current-database";

const directories: string[] = [];

function currentPath(): string {
  const fixture = openEmptyCurrentDatabase();
  fixture.database.close();
  directories.push(fixture.directory);
  return fixture.databasePath;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 25,
    });
  }
});

describe("current Mission initialization", () => {
  it("atomically creates Mission and Review-owned initialization facts", () => {
    const databasePath = currentPath();
    const project = createProject("Current mission", databasePath);
    const mission = createMission(databasePath, project.id, {
      expectedVersion: 0,
      goal: "Preserve delivery behavior",
      operationId: "16000000-0000-4000-8000-000000000109",
      title: "Mission",
    });
    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT context_version AS contextVersion,
                    next_event_sequence AS nextSequence, version
             FROM mission_delivery_heads WHERE mission_id=?`,
          )
          .get(mission.id),
      ).toEqual({ contextVersion: 1, nextSequence: 2, version: 1 });
      expect(
        database
          .prepare(
            `SELECT id,sequence,type FROM review_events WHERE mission_id=?`,
          )
          .get(mission.id),
      ).toEqual({
        id: `mission-review-initialized:${mission.id}:v1`,
        sequence: 1,
        type: "mission_review_initialized",
      });
    } finally {
      database.close();
    }
  });

  it("rolls back all owner facts when initialization fails", () => {
    const databasePath = currentPath();
    const project = createProject("Current rollback", databasePath);
    const failure = new Error("review initialization failed");
    const composition = createServerComposition(databasePath, {
      reviewDeliveryCommands: {
        initializeForMission() {
          throw failure;
        },
      },
    });

    const command = {
      expectedVersion: 0,
        goal: "Rollback",
      operationId: "00000000-0000-4000-8000-000000000163",
        projectId: project.id,
        title: "Mission",
    };
    expect(() =>
      composition.createMissionWorkflow.execute({
        ...command,
        requestHash: canonicalRequestHash(command),
      }),
    ).toThrow(failure);

    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT
               (SELECT count(*) FROM missions) AS missions,
               (SELECT count(*) FROM mission_delivery_heads) AS heads,
               (SELECT count(*) FROM review_events) AS events`,
          )
          .get(),
      ).toEqual({ events: 0, heads: 0, missions: 0 });
    } finally {
      database.close();
    }
  });
});
