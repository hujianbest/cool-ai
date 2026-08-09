import { describe, expect, it } from "vitest";

import { createTransactionContext } from "@/src/application/transaction-context";
import { createMissionWorkflow } from "@/src/server/application/create-mission-workflow";
import type { UnitOfWork } from "@/src/application/unit-of-work";
import type {
  MissionCommandCapability,
  MissionCreated,
} from "@/src/modules/mission-work";
import type { ReviewDeliveryCommandCapability } from "@/src/modules/review-delivery";

describe("create mission application workflow", () => {
  it("passes one opaque transaction through both capabilities in strict order", () => {
    const calls: Array<{ command: unknown; transaction: unknown; type: string }> = [];
    const transaction = createTransactionContext();
    const unitOfWork: UnitOfWork = {
      run(work) {
        calls.push({ command: null, transaction, type: "begin" });
        const result = work(transaction);
        calls.push({ command: null, transaction, type: "commit" });
        return result;
      },
    };
    const created: MissionCreated = {
      mission: {
        createdAt: "2026-08-09T01:02:03.000Z",
        goal: "Keep owner writes isolated",
        id: "mission-1",
        projectId: "project-1",
        title: "Canonical workflow",
        updatedAt: "2026-08-09T01:02:03.000Z",
        version: 1,
      },
      missionId: "mission-1",
      occurredAt: "2026-08-09T01:02:03.000Z",
      projectId: "project-1",
    };
    const missionCommands: MissionCommandCapability = {
      createMission(receivedTransaction, command) {
        calls.push({ command, transaction: receivedTransaction, type: "mission" });
        return created;
      },
    };
    const reviewDeliveryCommands: ReviewDeliveryCommandCapability = {
      initializeForMission(receivedTransaction, command) {
        calls.push({ command, transaction: receivedTransaction, type: "review" });
        return {
          deliveryHeadVersion: 1,
          eventSequence: 1,
          stepId: command.stepId,
        };
      },
    };

    const result = createMissionWorkflow({
      missionCommands,
      reviewDeliveryCommands,
      unitOfWork,
    }).execute({
      expectedVersion: 0,
      goal: created.mission.goal,
      operationId: "operation-1",
      projectId: created.projectId,
      requestHash: "a".repeat(64),
      title: created.mission.title,
    });

    expect(result).toEqual(created.mission);
    expect(calls.map(({ type }) => type)).toEqual([
      "begin",
      "mission",
      "review",
      "commit",
    ]);
    expect(calls.map(({ transaction: received }) => received)).toEqual([
      transaction,
      transaction,
      transaction,
      transaction,
    ]);
    expect(calls[2]?.command).toEqual({
      missionId: "mission-1",
      occurredAt: "2026-08-09T01:02:03.000Z",
      projectId: "project-1",
      stepId: "mission-review-initialized:mission-1:v1",
    });
  });

  it.each(["mission", "review"] as const)(
    "leaves rollback to the UnitOfWork when %s creation fails",
    (failurePoint) => {
      const events: string[] = [];
      const transaction = createTransactionContext();
      const failure = new Error(`${failurePoint} failed`);
      const unitOfWork: UnitOfWork = {
        run(work) {
          events.push("begin");
          try {
            const result = work(transaction);
            events.push("commit");
            return result;
          } catch (error) {
            events.push("rollback");
            throw error;
          }
        },
      };
      const missionCommands: MissionCommandCapability = {
        createMission() {
          events.push("mission");
          if (failurePoint === "mission") throw failure;
          return {
            mission: {
              createdAt: "now",
              goal: "Goal",
              id: "mission-rollback",
              projectId: "project-rollback",
              title: "Title",
              updatedAt: "now",
              version: 1,
            },
            missionId: "mission-rollback",
            occurredAt: "now",
            projectId: "project-rollback",
          };
        },
      };
      const reviewDeliveryCommands: ReviewDeliveryCommandCapability = {
        initializeForMission(_receivedTransaction, command) {
          events.push(`review:${command.stepId}`);
          if (failurePoint === "review") throw failure;
          return {
            deliveryHeadVersion: 1,
            eventSequence: 1,
            stepId: command.stepId,
          };
        },
      };
      const workflow = createMissionWorkflow({
        missionCommands,
        reviewDeliveryCommands,
        unitOfWork,
      });

      expect(() =>
        workflow.execute({
          expectedVersion: 0,
          goal: "Goal",
          operationId: "operation-rollback",
          projectId: "project-rollback",
          requestHash: "b".repeat(64),
          title: "Title",
        }),
      ).toThrow(failure);
      expect(events.at(-1)).toBe("rollback");
      expect(events).not.toContain("commit");
      if (failurePoint === "mission") {
        expect(events.some((event) => event.startsWith("review:"))).toBe(false);
      }
    },
  );
});
