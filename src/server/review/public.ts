import type { TransactionContext } from "@/src/application/transaction-context";

export type InitializeMissionDeliveryCommand = {
  missionId: string;
  occurredAt: string;
  projectId: string;
  stepId: string;
};

export type MissionDeliveryInitialized = {
  deliveryHeadVersion: number;
  eventSequence: number;
  stepId: string;
};

export class MissionInitializationError extends Error {
  readonly code = "MISSION_INITIALIZATION_CONFLICT";

  constructor() {
    super("Mission delivery initialization conflicts with current state.");
    this.name = "MissionInitializationError";
  }
}

export interface ReviewDeliveryCommandCapability {
  initializeForMission(
    transaction: TransactionContext,
    command: InitializeMissionDeliveryCommand,
  ): MissionDeliveryInitialized;
}
