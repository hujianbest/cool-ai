import type { TransactionContext } from "@/src/application/transaction-context";
import {
  MissionInitializationError,
  type InitializeMissionDeliveryCommand,
  type MissionDeliveryInitialized,
  type ReviewDeliveryCommandCapability,
} from "@/src/server/review/public";
import { sqliteDatabaseForTransaction } from "@/src/adapters/outbound/sqlite/sqlite-unit-of-work";

type DeliveryHeadRow = {
  contextVersion: number;
  nextEventSequence: number;
  projectId: string;
  state: string;
  updatedAt: string;
  version: number;
};

type ReviewEventRow = {
  actorId: string | null;
  actorType: string;
  createdAt: string;
  id: string;
  payload: string;
  projectId: string;
  sequence: number;
  type: string;
};

const initializedResult = (
  command: InitializeMissionDeliveryCommand,
): MissionDeliveryInitialized => ({
  deliveryHeadVersion: 1,
  eventSequence: 1,
  stepId: command.stepId,
});

function initializationMatches(
  head: DeliveryHeadRow | undefined,
  event: ReviewEventRow | undefined,
  command: InitializeMissionDeliveryCommand,
  payload: string,
): boolean {
  return head?.projectId === command.projectId
    && head.contextVersion === 1
    && head.state === "ongoing"
    && head.nextEventSequence === 2
    && head.version === 1
    && head.updatedAt === command.occurredAt
    && event?.id === command.stepId
    && event.projectId === command.projectId
    && event.sequence === 1
    && event.type === "mission_review_initialized"
    && event.actorType === "system"
    && event.actorId === null
    && event.payload === payload
    && event.createdAt === command.occurredAt;
}

export class SqliteReviewDeliveryCommandCapability
implements ReviewDeliveryCommandCapability {
  initializeForMission(
    transaction: TransactionContext,
    command: InitializeMissionDeliveryCommand,
  ): MissionDeliveryInitialized {
    const database = sqliteDatabaseForTransaction(transaction);
    const payload = JSON.stringify({
      contextVersion: 1,
      headVersion: 1,
      missionId: command.missionId,
    });
    const head = database
      .prepare(
        `SELECT project_id AS projectId, context_version AS contextVersion,
                state, next_event_sequence AS nextEventSequence,
                version, updated_at AS updatedAt
         FROM mission_delivery_heads
         WHERE mission_id = ?`,
      )
      .get(command.missionId) as DeliveryHeadRow | undefined;
    const event = database
      .prepare(
        `SELECT id, project_id AS projectId, sequence, type,
                actor_type AS actorType, actor_id AS actorId,
                payload_json AS payload, created_at AS createdAt
         FROM review_events
         WHERE mission_id = ? AND sequence = 1`,
      )
      .get(command.missionId) as ReviewEventRow | undefined;
    const stepAlreadyUsed = database
      .prepare("SELECT mission_id AS missionId FROM review_events WHERE id = ?")
      .get(command.stepId) as { missionId: string } | undefined;

    if (head || event || stepAlreadyUsed) {
      if (
        stepAlreadyUsed?.missionId === command.missionId
        && initializationMatches(head, event, command, payload)
      ) {
        return initializedResult(command);
      }
      throw new MissionInitializationError();
    }

    try {
      database
        .prepare(
          `INSERT INTO mission_delivery_heads(
             mission_id, project_id, context_version, state,
             current_delivery_id, current_operation_id,
             generation_lease_token, generation_lease_expires_at, last_error_code,
             next_event_sequence, version, updated_at
           ) VALUES (?, ?, 1, 'ongoing', NULL, NULL, NULL, NULL, NULL, 2, 1, ?)`,
        )
        .run(command.missionId, command.projectId, command.occurredAt);
      database
        .prepare(
          `INSERT INTO review_events(
             id, project_id, mission_id, sequence, type,
             actor_type, actor_id, payload_json, created_at
           ) VALUES (?, ?, ?, 1, 'mission_review_initialized',
                     'system', NULL, ?, ?)`,
        )
        .run(
          command.stepId,
          command.projectId,
          command.missionId,
          payload,
          command.occurredAt,
        );
    } catch {
      throw new MissionInitializationError();
    }

    return initializedResult(command);
  }
}
