import type { DatabaseSync } from "node:sqlite";

import { captureExecutionFrozenInput } from "@/src/server/execution/execution-frozen-input";

export function refreshExecutionFrozenFixture(
  database: DatabaseSync,
  executionId: string,
): string {
  const row = database.prepare(`
    SELECT e.agent_id AS agentId,e.mission_id AS missionId,e.project_id AS projectId,
           e.source_collaboration_run_id AS sourceRunId,e.work_item_id AS workItemId,
           a.id AS attemptId,a.baseline_manifest_hash AS baselineHash
    FROM executions e
    JOIN execution_attempts a
      ON a.project_id=e.project_id AND a.execution_id=e.id
     AND a.attempt_no=e.current_attempt_no
    WHERE e.id=?
  `).get(executionId) as {
    agentId: string;
    attemptId: string;
    baselineHash: string | null;
    missionId: string;
    projectId: string;
    sourceRunId: string;
    workItemId: string;
  };
  const frozen = captureExecutionFrozenInput(database, {
    agentId: row.agentId,
    baselineManifestHash: row.baselineHash,
    missionId: row.missionId,
    projectId: row.projectId,
    sourceCollaborationRunId: row.sourceRunId,
    workItemId: row.workItemId,
  });
  database.prepare(`
    UPDATE execution_attempts
    SET frozen_public_json=?,frozen_private_json=?,frozen_context_hash=?
    WHERE id=?
  `).run(
    JSON.stringify(frozen.publicEnvelope),
    JSON.stringify(frozen.privateEnvelope),
    frozen.contextHash,
    row.attemptId,
  );
  database.prepare(`
    UPDATE execution_staged_results SET context_hash=? WHERE attempt_id=?
  `).run(frozen.contextHash, row.attemptId);
  return frozen.contextHash;
}
