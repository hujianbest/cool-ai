import type { UnitOfWork } from "@/src/application/unit-of-work";
import type {
  CreateMissionCommand,
  MissionCommandCapability,
} from "@/src/modules/mission-work";
import type { ReviewDeliveryCommandCapability } from "@/src/modules/review-delivery";
import type { Mission } from "@/src/shared/project-context-contracts";

export type CreateMissionWorkflow = {
  execute(command: CreateMissionCommand): Mission;
};

export function createMissionWorkflow(dependencies: {
  missionCommands: MissionCommandCapability;
  reviewDeliveryCommands: ReviewDeliveryCommandCapability;
  unitOfWork: UnitOfWork;
}): CreateMissionWorkflow {
  return {
    execute(command) {
      return dependencies.unitOfWork.run((transaction) => {
        const created = dependencies.missionCommands.createMission(transaction, command);
        dependencies.reviewDeliveryCommands.initializeForMission(transaction, {
          missionId: created.missionId,
          occurredAt: created.occurredAt,
          projectId: created.projectId,
          stepId: `mission-review-initialized:${created.missionId}:v1`,
        });
        return created.mission;
      });
    },
  };
}
