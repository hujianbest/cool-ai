import type { TransactionContext } from "@/src/application/transaction-context";
import type { Mission } from "@/src/shared/project-context-contracts";

type FieldError = { field: string; code: string };

export class MissionError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly fields?: FieldError[],
    public readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "MissionError";
  }
}

export type CreateMissionCommand = {
  expectedVersion: number;
  goal: string;
  operationId: string;
  projectId: string;
  requestHash: string;
  title: string;
};

export type MissionCreated = {
  mission: Mission;
  missionId: string;
  occurredAt: string;
  projectId: string;
};

export interface MissionCommandCapability {
  createMission(
    transaction: TransactionContext,
    command: CreateMissionCommand,
  ): MissionCreated;
}
