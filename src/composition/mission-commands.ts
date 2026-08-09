import { canonicalRequestHash } from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import { missionInput } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import type { CreateMissionInput } from "@/src/modules/mission-work";
import type { Mission } from "@/src/shared/project-context-contracts";

import { createServerComposition } from "./server-composition";

export function createMission(
  databasePath: string,
  projectId: string,
  input: CreateMissionInput,
): Mission {
  const parsed = missionInput(input);
  const command = {
    expectedVersion: parsed.expectedVersion,
    goal: parsed.goal,
    operationId: parsed.operationId,
    projectId,
    title: parsed.title,
  };
  const { createMissionWorkflow } = createServerComposition(databasePath);
  return createMissionWorkflow.execute({
    ...command,
    requestHash: canonicalRequestHash(command),
  });
}
