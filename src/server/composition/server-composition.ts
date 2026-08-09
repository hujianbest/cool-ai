import {
  createMissionWorkflow,
  type CreateMissionWorkflow,
} from "@/src/server/application/create-mission-workflow";
import type { UnitOfWork } from "@/src/application/unit-of-work";
import type { MissionCommandCapability } from "@/src/modules/mission-work";
import { SqliteMissionCommandCapability } from "@/src/adapters/outbound/sqlite/mission-work/sqlite-mission-command-capability";
import type { ReviewDeliveryCommandCapability } from "@/src/server/review/public";
import { SqliteReviewDeliveryCommandCapability } from "@/src/server/review/sqlite-review-delivery-command-capability";
import { SqliteUnitOfWork } from "@/src/adapters/outbound/sqlite/sqlite-unit-of-work";

export type ServerComposition = {
  createMissionWorkflow: CreateMissionWorkflow;
  missionCommands: MissionCommandCapability;
  reviewDeliveryCommands: ReviewDeliveryCommandCapability;
  unitOfWork: UnitOfWork;
};

export function createServerComposition(
  databasePath: string,
  overrides: {
    missionCommands?: MissionCommandCapability;
    reviewDeliveryCommands?: ReviewDeliveryCommandCapability;
  } = {},
): ServerComposition {
  const unitOfWork = new SqliteUnitOfWork(databasePath);
  const missionCommands =
    overrides.missionCommands ?? new SqliteMissionCommandCapability();
  const reviewDeliveryCommands =
    overrides.reviewDeliveryCommands
    ?? new SqliteReviewDeliveryCommandCapability();

  return {
    createMissionWorkflow: createMissionWorkflow({
      missionCommands,
      reviewDeliveryCommands,
      unitOfWork,
    }),
    missionCommands,
    reviewDeliveryCommands,
    unitOfWork,
  };
}
