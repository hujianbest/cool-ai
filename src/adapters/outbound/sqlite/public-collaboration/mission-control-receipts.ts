import type { DatabaseSync } from "node:sqlite";

import type {
  ControlOperationPrior,
  TransitionReceipt,
} from "@/src/modules/public-collaboration";

export function insertTransitionReceipt(
  database: DatabaseSync,
  input: {
    operationId: string;
    projectId: string;
    requestHash: string;
    receipt: TransitionReceipt;
  },
): void {
  const timestamp = new Date().toISOString();
  const status = input.receipt.ok ? 200 : input.receipt.error.status;
  database.prepare(`
    INSERT INTO collaboration_operations(
      id,project_id,thread_id,run_id,kind,request_hash,status,http_status,response_json,
      created_at,updated_at
    ) VALUES (
      ?, ?,
      (SELECT id FROM collaboration_threads
       WHERE project_id=? ORDER BY created_at,id LIMIT 1),
      NULL, 'control', ?, 'completed', ?, ?, ?, ?
    )
  `).run(
    input.operationId,
    input.projectId,
    input.projectId,
    input.requestHash,
    status,
    JSON.stringify(input.receipt),
    timestamp,
    timestamp,
  );
}

export function readControlOperationPrior(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
): ControlOperationPrior | undefined {
  return database.prepare(`
    SELECT kind,request_hash AS requestHash,status,response_json AS responseJson
    FROM collaboration_operations WHERE project_id=? AND id=?
  `).get(projectId, operationId) as ControlOperationPrior | undefined;
}
