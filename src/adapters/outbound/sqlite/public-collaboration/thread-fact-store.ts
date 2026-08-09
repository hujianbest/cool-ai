import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/modules/public-collaboration";

type FactBase = {
  actorId: string | null;
  actorType: "owner" | "agent" | "system";
  factId: string;
  payload: Record<string, unknown>;
  projectId: string;
  threadId: string;
  timestamp: string;
};

export type ThreadFactIntent =
  | (FactBase & { type: "thread_created" })
  | (FactBase & { policyRevisionId: string; type: "policy_changed" })
  | (FactBase & {
      messageId: string;
      runId: string | null;
      type: "owner_message" | "agent_message";
    })
  | (FactBase & { runId: string; type: "run_linked" })
  | (FactBase & { runEventId: string; runId: string; type: "run_event" })
  | (FactBase & {
      businessReceiptId: string;
      inlineDecisionId: string;
      runId: string;
      type: "inline_decision";
    });

export type StoredThreadFact = ThreadFactIntent & {
  activitySequence: number;
  sequence: number;
};

type AppendBatchOptions = {
  preserveThreadVersion?: boolean;
};

function unavailable(): never {
  throw new CollaborationError(
    "STORAGE_UNAVAILABLE",
    503,
    "Thread fact storage is unavailable.",
  );
}

export function nextThreadActivitySequenceTx(
  database: DatabaseSync,
  projectId: string,
): number {
  database.prepare(
    `INSERT OR IGNORE INTO collaboration_project_thread_sequences(
       project_id,next_activity_sequence
     ) VALUES (?,1)`,
  ).run(projectId);
  const row = database.prepare(
    `SELECT next_activity_sequence AS nextActivitySequence
     FROM collaboration_project_thread_sequences WHERE project_id=?`,
  ).get(projectId) as { nextActivitySequence: number } | undefined;
  if (!row) unavailable();
  return row.nextActivitySequence;
}

export function appendBatchTx(
  database: DatabaseSync,
  intents: readonly [ThreadFactIntent, ...ThreadFactIntent[]],
  options: AppendBatchOptions = {},
): StoredThreadFact[] {
  const [{ projectId, threadId }] = intents;
  if (intents.some((intent) => intent.projectId !== projectId || intent.threadId !== threadId)) {
    unavailable();
  }
  const thread = database.prepare(
    `SELECT next_fact_sequence AS nextFactSequence
     FROM collaboration_threads WHERE project_id=? AND id=?`,
  ).get(projectId, threadId) as { nextFactSequence: number } | undefined;
  if (!thread) unavailable();

  const nextActivitySequence = nextThreadActivitySequenceTx(database, projectId);

  const stored = intents.map((intent, index) => ({
    ...intent,
    activitySequence: nextActivitySequence + index,
    sequence: thread.nextFactSequence + index,
  }));
  const insert = database.prepare(
    `INSERT INTO collaboration_thread_facts(
       id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
       run_id,message_id,run_event_id,policy_revision_id,inline_decision_id,
       business_receipt_id,payload_json,created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const fact of stored) {
    insert.run(
      fact.factId,
      fact.projectId,
      fact.threadId,
      fact.sequence,
      fact.activitySequence,
      fact.type,
      fact.actorType,
      fact.actorId,
      "runId" in fact ? fact.runId : null,
      "messageId" in fact ? fact.messageId : null,
      "runEventId" in fact ? fact.runEventId : null,
      "policyRevisionId" in fact ? fact.policyRevisionId : null,
      "inlineDecisionId" in fact ? fact.inlineDecisionId : null,
      "businessReceiptId" in fact ? fact.businessReceiptId : null,
      JSON.stringify(fact.payload),
      fact.timestamp,
    );
  }

  const last = stored[stored.length - 1];
  const versionSql = options.preserveThreadVersion ? "version=version" : "version=version+1";
  const threadUpdate = database.prepare(
    `UPDATE collaboration_threads
     SET next_fact_sequence=next_fact_sequence+?,last_activity_sequence=?,
         ${versionSql},updated_at=?
     WHERE project_id=? AND id=? AND next_fact_sequence=?`,
  ).run(
    stored.length,
    last.activitySequence,
    last.timestamp,
    projectId,
    threadId,
    thread.nextFactSequence,
  );
  const activityUpdate = database.prepare(
    `UPDATE collaboration_project_thread_sequences
     SET next_activity_sequence=next_activity_sequence+?
     WHERE project_id=? AND next_activity_sequence=?`,
  ).run(stored.length, projectId, nextActivitySequence);
  if (threadUpdate.changes !== 1 || activityUpdate.changes !== 1) unavailable();
  return stored;
}
