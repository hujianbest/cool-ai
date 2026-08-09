import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { createServerComposition } from "@/src/server/composition/server-composition";
import { canonicalRequestHash } from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createMission } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import type { ReviewDeliveryCommandCapability } from "@/src/modules/review-delivery";
import { openEmptyCurrentDatabase } from "@/tests/fixtures/sqlite/current-database";

const directories: string[] = [];

function emptyCurrentPath(): string {
  const fixture = openEmptyCurrentDatabase();
  fixture.database.close();
  directories.push(fixture.directory);
  return fixture.databasePath;
}

function factCounts(databasePath: string) {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM missions) AS missions,
           (SELECT COUNT(*) FROM mission_delivery_heads) AS heads,
           (SELECT COUNT(*) FROM review_events) AS events`,
      )
      .get();
  } finally {
    database.close();
  }
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

describe("mission transaction composition", () => {
  it("routes the existing Mission entry point through both owner capabilities", () => {
    const databasePath = emptyCurrentPath();
    const project = createProject("Composed mission", databasePath);

    const mission = createMission(databasePath, project.id, {
      expectedVersion: 0,
      goal: "Keep all owner facts atomic",
      operationId: "16000000-0000-4000-8000-000000000118",
      title: "Composition",
    });

    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT id, project_id AS projectId, mission_id AS missionId,
                    sequence, created_at AS createdAt
             FROM review_events
             WHERE mission_id = ?`,
          )
          .get(mission.id),
      ).toEqual({
        createdAt: mission.createdAt,
        id: `mission-review-initialized:${mission.id}:v1`,
        missionId: mission.id,
        projectId: project.id,
        sequence: 1,
      });
      expect(factCounts(databasePath)).toEqual({
        events: 1,
        heads: 1,
        missions: 1,
      });
    } finally {
      database.close();
    }

    const composition = createServerComposition(databasePath);
    const command = {
      missionId: mission.id,
      occurredAt: mission.createdAt,
      projectId: project.id,
      stepId: `mission-review-initialized:${mission.id}:v1`,
    };
    expect(
      composition.unitOfWork.run((transaction) =>
        composition.reviewDeliveryCommands.initializeForMission(
          transaction,
          command,
        )),
    ).toEqual({
      deliveryHeadVersion: 1,
      eventSequence: 1,
      stepId: command.stepId,
    });
    expect(() =>
      composition.unitOfWork.run((transaction) =>
        composition.reviewDeliveryCommands.initializeForMission(transaction, {
          ...command,
          stepId: `${command.stepId}:different`,
        })),
    ).toThrowError(
      expect.objectContaining({ code: "MISSION_INITIALIZATION_CONFLICT" }),
    );
    expect(factCounts(databasePath)).toEqual({
      events: 1,
      heads: 1,
      missions: 1,
    });
  });

  it("rolls back the Mission fact when Review initialization fails", () => {
    const databasePath = emptyCurrentPath();
    const project = createProject("Injected failure", databasePath);
    const failure = new Error("injected review failure");
    const failingReview: ReviewDeliveryCommandCapability = {
      initializeForMission() {
        throw failure;
      },
    };
    const composition = createServerComposition(databasePath, {
      reviewDeliveryCommands: failingReview,
    });

    expect(() =>
          composition.createMissionWorkflow.execute({
            expectedVersion: 0,
        goal: "Must roll back",
            operationId: "00000000-0000-4000-8000-000000000161",
        projectId: project.id,
            requestHash: canonicalRequestHash({
              expectedVersion: 0,
              goal: "Must roll back",
              operationId: "00000000-0000-4000-8000-000000000161",
              projectId: project.id,
              title: "Failure",
            }),
        title: "Failure",
      }),
    ).toThrow(failure);
    expect(factCounts(databasePath)).toEqual({
      events: 0,
      heads: 0,
      missions: 0,
    });
  });

  it("keeps both capabilities inside the caller-owned transaction", () => {
    const databasePath = emptyCurrentPath();
    const project = createProject("Outer rollback", databasePath);
    const composition = createServerComposition(databasePath);
    const rollback = new Error("rollback after both owner writes");

    expect(() =>
      composition.unitOfWork.run((transaction) => {
            const command = {
              expectedVersion: 0,
          goal: "Caller controls commit",
              operationId: "00000000-0000-4000-8000-000000000162",
          projectId: project.id,
          title: "Outer rollback",
            };
            const created = composition.missionCommands.createMission(transaction, {
              ...command,
              requestHash: canonicalRequestHash(command),
            });
        composition.reviewDeliveryCommands.initializeForMission(transaction, {
          missionId: created.missionId,
          occurredAt: created.occurredAt,
          projectId: created.projectId,
          stepId: `mission-review-initialized:${created.missionId}:v1`,
        });
        throw rollback;
      }),
    ).toThrow(rollback);
    expect(factCounts(databasePath)).toEqual({
      events: 0,
      heads: 0,
      missions: 0,
    });
  });

  it("replays the same create operation and rejects a changed request hash", () => {
    const databasePath = emptyCurrentPath();
    const project = createProject("Mission operation", databasePath);
    const composition = createServerComposition(databasePath);
    const operationId = "00000000-0000-4000-8000-000000000160";
    const intent = {
      expectedVersion: 0 as const,
      goal: "Stable mission create",
      operationId,
      projectId: project.id,
      title: "Replay",
    };
    const command = {
      ...intent,
      requestHash: canonicalRequestHash(intent),
    };

    const first = composition.createMissionWorkflow.execute(command);
    const replay = composition.createMissionWorkflow.execute(command);

    expect(replay).toEqual(first);
    expect(factCounts(databasePath)).toEqual({
      events: 1,
      heads: 1,
      missions: 1,
    });
    expect(() =>
      composition.createMissionWorkflow.execute({
        ...command,
        goal: "Changed",
      })).toThrowError(
      expect.objectContaining({ code: "OPERATION_CONFLICT" }),
    );
    const staleCreate = { ...intent, expectedVersion: 1 };
    expect(() =>
      composition.createMissionWorkflow.execute({
        ...staleCreate,
        requestHash: canonicalRequestHash(staleCreate),
      })).toThrowError(
      expect.objectContaining({ code: "VERSION_CONFLICT", currentVersion: 0 }),
    );
  });
});
