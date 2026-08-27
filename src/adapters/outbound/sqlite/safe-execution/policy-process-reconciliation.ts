import { randomUUID } from "node:crypto";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { appendExecutionAuditOutboxRow } from "@/src/adapters/outbound/sqlite/safe-execution/audit-event-outbox";

const reconciledDatabasePaths = new Set<string>();

export function ensurePolicyProcessesReconciled(databasePath: string): void {
  if (reconciledDatabasePaths.has(databasePath)) return;
  reconcilePolicyProcesses(databasePath);
  reconciledDatabasePaths.add(databasePath);
}

export function reconcilePolicyProcesses(databasePath: string): number {
  const database = openDatabase(databasePath);
  database.exec("BEGIN IMMEDIATE");
  try {
    const active = database.prepare(`
      SELECT process.id,process.execution_id AS executionId,
             execution.project_id AS projectId,
             execution.current_attempt_no AS attemptNo,
             execution.next_event_sequence AS sequence
      FROM execution_policy_processes process
      JOIN executions execution ON execution.id=process.execution_id
      WHERE process.status IN ('starting','running','ready','stopping')
      ORDER BY process.created_at,process.id
    `).all() as Array<{
      attemptNo: number;
      executionId: string;
      id: string;
      projectId: string;
      sequence: number;
    }>;
    const sequenceOffsets = new Map<string, number>();
    for (const process of active) {
      database.prepare(`
        UPDATE execution_policy_processes
        SET status='interrupted',reason_code='PROCESS_HOST_RESTARTED',version=version+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND status IN ('starting','running','ready','stopping')
      `).run(process.id);
      const offset = sequenceOffsets.get(process.executionId) ?? 0;
      const sequence = process.sequence + offset;
      sequenceOffsets.set(process.executionId, offset + 1);
      const eventId = randomUUID();
      const payload = {
        processId: process.id,
        reasonCode: "PROCESS_HOST_RESTARTED",
        status: "interrupted",
      };
      database.prepare(`
        INSERT INTO execution_events (
          id,project_id,execution_id,sequence,attempt_no,type,actor_type,actor_id,
          payload_json,created_at
        ) VALUES (?,?,?,?,?,'policy_process_interrupted','system',NULL,?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        eventId,
        process.projectId,
        process.executionId,
        sequence,
        process.attemptNo,
        JSON.stringify(payload),
      );
      appendExecutionAuditOutboxRow(database, {
        actorId: null,
        actorType: "system",
        attemptNo: process.attemptNo,
        eventId,
        eventType: "policy_process_interrupted",
        executionId: process.executionId,
        projectId: process.projectId,
        sourcePayload: payload,
      });
    }
    for (const [executionId, offset] of sequenceOffsets) {
      database.prepare(`
        UPDATE executions SET next_event_sequence=next_event_sequence+?
        WHERE id=?
      `).run(offset, executionId);
    }
    database.exec("COMMIT");
    return active.length;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
