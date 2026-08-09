import type { DatabaseSync } from "node:sqlite";

export function seedMissionInitialization(
  database: DatabaseSync,
  input: {
    missionId: string;
    occurredAt: string;
    projectId: string;
  },
): void {
  database.prepare(
    `INSERT INTO mission_delivery_heads(
       mission_id,project_id,context_version,state,current_delivery_id,
       current_operation_id,generation_lease_token,generation_lease_expires_at,
       last_error_code,next_event_sequence,version,updated_at
     ) VALUES (?, ?, 1, 'ongoing', NULL, NULL, NULL, NULL, NULL, 2, 1, ?)`,
  ).run(input.missionId, input.projectId, input.occurredAt);
  database.prepare(
    `INSERT INTO review_events(
       id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,
       created_at
     ) VALUES (?, ?, ?, 1, 'mission_review_initialized', 'system', NULL, ?, ?)`,
  ).run(
    `mission-review-initialized:${input.missionId}:v1`,
    input.projectId,
    input.missionId,
    JSON.stringify({
      contextVersion: 1,
      headVersion: 1,
      missionId: input.missionId,
    }),
    input.occurredAt,
  );
}

export function seedMissionInitializationForMission(
  database: DatabaseSync,
  mission: { id: string; projectId: string; updatedAt: string },
): void {
  seedMissionInitialization(database, {
    missionId: mission.id,
    occurredAt: mission.updatedAt,
    projectId: mission.projectId,
  });
}
