import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  canonicalizeStructuredJson,
  decodePersistedStructuredJson,
  hashCanonicalBytes,
  parseCanonicalStructuredJson,
} from "@/src/server/structured-messages/structured-message-codec";
import {
  blockCodecSchema,
  persistedStructuredBlockSchema,
} from "@/src/server/structured-messages/structured-message-schema";

export const CURRENT_DATA_INVARIANTS = [
  `SELECT p.project_id FROM project_validation_policies p
   JOIN project_validation_policy_revisions r
     ON r.project_id=p.project_id AND r.id=p.active_revision_id
   WHERE p.version<>r.revision_no`,
  `SELECT r.id FROM project_validation_policy_revisions r
   WHERE r.entry_count<>(SELECT COUNT(*) FROM project_validation_policy_entries e
                         WHERE e.project_id=r.project_id AND e.revision_id=r.id)`,
  `SELECT id FROM executions
   WHERE (first_running_at IS NULL)<>(business_deadline_at IS NULL)
      OR (first_running_at IS NOT NULL
          AND (unixepoch(business_deadline_at)-unixepoch(first_running_at))<>900)`,
  `SELECT o.id FROM execution_operations o
   WHERE o.action_count<>(SELECT COUNT(*) FROM execution_actions a
                          WHERE a.project_id=o.project_id AND a.operation_id=o.id)
      OR EXISTS(SELECT 1 FROM execution_actions a
                WHERE a.project_id=o.project_id AND a.operation_id=o.id
                  AND (a.action_index<0 OR a.action_index>=o.action_count))`,
  `SELECT e.id FROM executions e JOIN execution_attempts a
     ON a.execution_id=e.id AND a.attempt_no=e.current_attempt_no
   WHERE e.current_policy_revision_id<>a.frozen_policy_revision_id`,
  `SELECT v.id FROM execution_validation_results v
   JOIN execution_attempts a
     ON a.project_id=v.project_id AND a.execution_id=v.execution_id AND a.id=v.attempt_id
   JOIN project_validation_policy_entries entry
     ON entry.project_id=v.project_id AND entry.revision_id=v.policy_revision_id
      AND entry.id=v.policy_entry_id
   WHERE v.policy_revision_id<>a.frozen_policy_revision_id OR v.required<>entry.required`,
  `SELECT f.path FROM execution_merge_files f
   JOIN execution_merge_journals j ON j.id=f.journal_id
   WHERE NOT json_valid(f.old_target_ref_json)
      OR NOT json_valid(f.durable_new_ref_json)
      OR NOT json_valid(f.canonical_temp_locator_json)
      OR json_extract(f.durable_new_ref_json,'$.rootKind')<>'journal'
      OR json_extract(f.durable_new_ref_json,'$.ownerId')<>j.merge_action_id
      OR json_extract(f.canonical_temp_locator_json,'$.rootKind')<>'canonical'
      OR json_extract(f.canonical_temp_locator_json,'$.ownerId')<>j.merge_action_id
      OR (f.backup_ref_json IS NOT NULL AND (
           NOT json_valid(f.backup_ref_json)
           OR json_extract(f.backup_ref_json,'$.rootKind')<>'journal'
           OR json_extract(f.backup_ref_json,'$.ownerId')<>j.merge_action_id))
      OR (f.post_target_ref_json IS NOT NULL AND NOT json_valid(f.post_target_ref_json))
      OR (f.canonical_temp_ref_json IS NOT NULL AND (
           NOT json_valid(f.canonical_temp_ref_json)
           OR json_extract(f.canonical_temp_ref_json,'$.rootKind')<>'canonical'
           OR json_extract(f.canonical_temp_ref_json,'$.ownerId')<>j.merge_action_id))`,
  `SELECT s.id FROM execution_staged_results s
   WHERE s.observed_path_count<>(SELECT COUNT(*) FROM execution_staged_observations o
                                 WHERE o.staged_result_id=s.id)
      OR s.observed_final_bytes<>(SELECT COALESCE(SUM(o.final_size),0)
                                  FROM execution_staged_observations o
                                  WHERE o.staged_result_id=s.id)
      OR s.blocker_count<>(SELECT COUNT(*) FROM execution_staged_blockers b
                           WHERE b.staged_result_id=s.id)
      OR s.merge_file_count<>(SELECT COUNT(*) FROM execution_staged_files f
                              WHERE f.staged_result_id=s.id)
      OR s.merge_final_bytes<>(SELECT COALESCE(SUM(f.size),0)
                               FROM execution_staged_files f
                               WHERE f.staged_result_id=s.id)
      OR (s.classification='blocked' AND (s.merge_file_count<>0 OR s.merge_final_bytes<>0))
      OR (s.classification<>'blocked'
          AND (s.blocker_count<>0 OR s.merge_file_count<>s.observed_path_count))`,
  `SELECT m.id FROM missions m
   WHERE NOT EXISTS(SELECT 1 FROM mission_delivery_heads h
                    WHERE h.mission_id=m.id AND h.project_id=m.project_id)`,
  `SELECT h.mission_id FROM mission_delivery_heads h
   WHERE h.next_event_sequence<>(SELECT COUNT(*)+1 FROM review_events e
                                  WHERE e.mission_id=h.mission_id)`,
  `SELECT mission_id FROM (
     SELECT mission_id,sequence,
            ROW_NUMBER() OVER(PARTITION BY mission_id ORDER BY sequence,id) expected
     FROM review_events
   ) WHERE sequence<>expected`,
  `SELECT r.id FROM work_item_result_versions r JOIN executions e ON e.id=r.execution_id
   WHERE r.executor_agent_id<>e.agent_id OR r.project_id<>e.project_id
      OR r.mission_id<>e.mission_id OR r.work_item_id<>e.work_item_id`,
  `SELECT id FROM (
     SELECT work_item_id,id,version,supersedes_result_id,
            LAG(id) OVER(PARTITION BY work_item_id ORDER BY version) expected_id,
            ROW_NUMBER() OVER(PARTITION BY work_item_id ORDER BY version) expected_version
     FROM work_item_result_versions
   ) WHERE version<>expected_version OR supersedes_result_id IS NOT expected_id`,
  `SELECT r.id FROM work_item_result_versions r
   WHERE r.version=(SELECT MAX(x.version) FROM work_item_result_versions x
                    WHERE x.work_item_id=r.work_item_id)
     AND NOT EXISTS(SELECT 1 FROM work_item_review_heads h
                    WHERE h.work_item_id=r.work_item_id AND h.current_result_id=r.id
                      AND h.project_id=r.project_id AND h.mission_id=r.mission_id)`,
  `SELECT h.work_item_id FROM work_item_review_heads h
   LEFT JOIN review_attempts a ON a.id=h.current_attempt_id
   WHERE (h.current_result_id IS NULL AND h.state<>'executing')
      OR (h.state='reviewing' AND (a.id IS NULL OR a.status NOT IN ('calling','finalizing')))
      OR (h.state<>'reviewing' AND a.status IN ('calling','finalizing'))`,
  `SELECT a.id FROM review_attempts a
   JOIN work_item_result_versions r ON r.id=a.result_id
   LEFT JOIN agents reviewer ON reviewer.id=a.reviewer_agent_id
   LEFT JOIN project_memberships membership
     ON membership.project_id=a.project_id AND membership.agent_id=a.reviewer_agent_id
   WHERE a.reviewer_agent_id=r.executor_agent_id OR membership.agent_id IS NULL
      OR reviewer.review_capable<>1`,
  `SELECT a.id FROM review_attempts a
   WHERE (a.status IN ('rejected','escalated','passed')
          AND (SELECT COUNT(*) FROM review_decisions d WHERE d.attempt_id=a.id)<>1)
      OR (a.status IN ('failed','interrupted','discarded')
          AND EXISTS(SELECT 1 FROM review_decisions d WHERE d.attempt_id=a.id))`,
  `SELECT d.id FROM review_decisions d JOIN review_attempts a ON a.id=d.attempt_id
   WHERE d.result_id<>a.result_id OR d.reviewer_agent_id<>a.reviewer_agent_id`,
  `SELECT m.id FROM memory_entries m
   WHERE (m.version=1 AND m.supersedes_id IS NOT NULL)
      OR (m.version>1 AND NOT EXISTS(
          SELECT 1 FROM memory_entries p WHERE p.id=m.supersedes_id
            AND p.project_id=m.project_id AND p.chain_id=m.chain_id
            AND p.type=m.type AND p.version=m.version-1))`,
  `SELECT a.id FROM memory_entries a
   JOIN memory_entries b ON b.project_id=a.project_id AND b.type=a.type
     AND b.dedupe_hash=a.dedupe_hash AND b.id>a.id
   WHERE NOT EXISTS(SELECT 1 FROM memory_entries child WHERE child.supersedes_id=a.id)
     AND NOT EXISTS(SELECT 1 FROM memory_entries child WHERE child.supersedes_id=b.id)`,
  `SELECT w.id FROM work_items w WHERE w.status='done'
   AND NOT EXISTS(SELECT 1 FROM work_item_review_heads h
                  WHERE h.work_item_id=w.id AND h.state='passed')`,
  `SELECT h.work_item_id FROM work_item_review_heads h JOIN work_items w ON w.id=h.work_item_id
   WHERE h.state='passed' AND (w.status<>'done' OR NOT EXISTS(
     SELECT 1 FROM review_attempts a JOIN review_decisions d ON d.attempt_id=a.id
     WHERE a.id=h.current_attempt_id AND d.choice='pass' AND d.result_id=h.current_result_id))`,
  `SELECT h.mission_id FROM mission_delivery_heads h
   WHERE (h.state='completed')<>(h.current_delivery_id IS NOT NULL)
      OR (h.state='completed' AND NOT EXISTS(
          SELECT 1 FROM mission_deliveries d WHERE d.id=h.current_delivery_id
            AND d.mission_id=h.mission_id AND d.project_id=h.project_id))`,
  `SELECT p.id FROM projects p LEFT JOIN collaboration_project_thread_sequences s
     ON s.project_id=p.id
   WHERE EXISTS(SELECT 1 FROM collaboration_threads t WHERE t.project_id=p.id)
     AND s.project_id IS NULL`,
  `SELECT t.id FROM collaboration_threads t
   LEFT JOIN collaboration_thread_policy_revisions r
     ON (r.project_id,r.thread_id,r.id)=(t.project_id,t.id,t.active_policy_revision_id)
   WHERE r.id IS NULL OR r.version<>t.policy_version
      OR r.version<>(SELECT max(x.version) FROM collaboration_thread_policy_revisions x
                     WHERE (x.project_id,x.thread_id)=(t.project_id,t.id))`,
  `SELECT revision_id FROM (
     SELECT revision_id,position,
            row_number() OVER(PARTITION BY project_id,thread_id,revision_id ORDER BY position)-1 expected
     FROM collaboration_thread_policy_members
   ) WHERE position<>expected`,
  `SELECT id FROM (
     SELECT id,sequence,row_number() OVER(PARTITION BY project_id,thread_id ORDER BY sequence) expected
     FROM collaboration_messages
   ) WHERE sequence<>expected
   UNION ALL SELECT id FROM (
     SELECT id,sequence,row_number() OVER(PARTITION BY run_id ORDER BY sequence) expected
     FROM collaboration_events
   ) WHERE sequence<>expected
   UNION ALL SELECT id FROM (
     SELECT id,sequence,row_number() OVER(PARTITION BY project_id,thread_id ORDER BY sequence) expected
     FROM collaboration_thread_facts
   ) WHERE sequence<>expected`,
  `SELECT t.id FROM collaboration_threads t
   WHERE t.next_fact_sequence<>1+(SELECT count(*) FROM collaboration_thread_facts f
                                  WHERE (f.project_id,f.thread_id)=(t.project_id,t.id))
      OR t.last_activity_sequence<>(SELECT max(f.activity_sequence)
                                    FROM collaboration_thread_facts f
                                    WHERE (f.project_id,f.thread_id)=(t.project_id,t.id))`,
  `SELECT s.project_id FROM collaboration_project_thread_sequences s
   WHERE s.next_activity_sequence<>1+coalesce(
     (SELECT max(f.activity_sequence) FROM collaboration_thread_facts f
      WHERE f.project_id=s.project_id),0)`,
  `SELECT t.id FROM collaboration_threads t
   WHERE (SELECT count(*) FROM collaboration_thread_facts f
          WHERE (f.project_id,f.thread_id,f.type)=(t.project_id,t.id,'thread_created'))<>1
      OR EXISTS(SELECT 1 FROM collaboration_thread_policy_revisions r
                WHERE (r.project_id,r.thread_id)=(t.project_id,t.id)
                  AND (SELECT count(*) FROM collaboration_thread_facts f
                       WHERE f.policy_revision_id=r.id AND f.type='policy_changed')<>1)`,
  `SELECT m.id FROM collaboration_messages m
   WHERE (SELECT count(*) FROM collaboration_thread_facts f
          WHERE f.message_id=m.id
            AND f.type=CASE m.author_type WHEN 'owner' THEN 'owner_message' ELSE 'agent_message' END)<>1
   UNION ALL SELECT r.id FROM collaboration_runs r
   WHERE (SELECT count(*) FROM collaboration_thread_facts f
          WHERE f.run_id=r.id AND f.type='run_linked')<>1
   UNION ALL SELECT e.id FROM collaboration_events e
   WHERE (SELECT count(*) FROM collaboration_thread_facts f
          WHERE f.run_event_id=e.id AND f.type='run_event')
         <>CASE e.type WHEN 'owner_message' THEN 0 WHEN 'agent_message' THEN 0 ELSE 1 END`,
  `SELECT o.id FROM collaboration_operations o
   WHERE (o.status='pending')<>(o.http_status IS NULL AND o.response_json IS NULL
                                AND o.response_schema_version IS NULL)
      OR (o.status IN('completed','version_conflict'))<>(
        o.http_status BETWEEN 100 AND 599 AND json_valid(o.response_json)
        AND o.response_schema_version IN(7,8))`,
  `SELECT o.id FROM collaboration_operations o
   WHERE o.status='pending' AND (
     o.kind<>'advance'
     OR (SELECT count(*) FROM collaboration_attempts a
         WHERE (a.project_id,a.thread_id,a.run_id,a.operation_id)=
               (o.project_id,o.thread_id,o.run_id,o.id)
           AND a.status='calling')<>1
     OR EXISTS(SELECT 1 FROM collaboration_attempts a
               WHERE (a.project_id,a.thread_id,a.run_id,a.operation_id)=
                     (o.project_id,o.thread_id,o.run_id,o.id)
                 AND (a.status<>'calling'
                   OR EXISTS(SELECT 1 FROM collaboration_model_calls c
                             WHERE c.attempt_id=a.id)
                   OR EXISTS(SELECT 1 FROM collaboration_turns t
                             WHERE t.attempt_id=a.id)))
   )`,
  `SELECT project_id FROM collaboration_runs
   WHERE status IN('running','waiting_owner','paused','failed')
   GROUP BY project_id HAVING count(*)>1`,
  `SELECT b.id FROM structured_message_blocks b
   WHERE (SELECT count(*) FROM structured_message_state_revisions s
          WHERE (s.project_id,s.thread_id,s.block_id,s.state_version)=
                (b.project_id,b.thread_id,b.id,1))<>1
      OR (SELECT count(*) FROM structured_message_state_heads h
          WHERE (h.project_id,h.thread_id,h.block_id)=(b.project_id,b.thread_id,b.id))<>1`,
  `SELECT h.block_id FROM structured_message_state_heads h
   WHERE h.current_state_version<>(SELECT max(s.state_version)
                                   FROM structured_message_state_revisions s
                                   WHERE (s.project_id,s.thread_id,s.block_id)=
                                         (h.project_id,h.thread_id,h.block_id))`,
  `SELECT d.id FROM inline_decisions d
   JOIN collaboration_operations o
     ON (o.project_id,o.thread_id,o.id)=(d.project_id,d.thread_id,d.operation_id)
   WHERE o.kind<>'inline_decision' OR o.status<>'completed'
      OR (SELECT count(*) FROM business_action_receipts r
          WHERE (r.project_id,r.thread_id,r.decision_id)=
                (d.project_id,d.thread_id,d.id))<>1
      OR (SELECT count(*) FROM collaboration_thread_facts f
          WHERE (f.project_id,f.thread_id,f.inline_decision_id)=
                (d.project_id,d.thread_id,d.id)
            AND f.type='inline_decision')<>1`,
] as const;

function canonicalJson(value: string, maximum: number): unknown {
  const parsed = parseCanonicalStructuredJson(value, {
    maxCanonicalBytes: maximum,
    maxWireBytes: maximum,
  });
  if (Buffer.from(parsed.canonicalBytes).toString("utf8") !== value) throw new Error("invalid");
  return parsed.value;
}

function chunkSetIsValid(
  expectedBytes: number,
  expectedHash: string,
  chunks: Array<{
    byteLength: number;
    byteOffset: number;
    chunkIndex: number;
    hash: string;
    text: string;
  }>,
): boolean {
  if (chunks.length === 0) return true;
  let bytes = 0;
  const hash = createHash("sha256");
  for (const [index, chunk] of chunks.entries()) {
    const content = Buffer.from(chunk.text);
    if (
      chunk.chunkIndex !== index
      || chunk.byteOffset !== bytes
      || chunk.byteLength !== content.byteLength
      || createHash("sha256").update(content).digest("hex") !== chunk.hash
    ) return false;
    bytes += content.byteLength;
    hash.update(content);
  }
  return bytes === expectedBytes && hash.digest("hex") === expectedHash;
}

function chunkFactsAreValid(database: DatabaseSync): boolean {
  const artifacts = database.prepare(
    "SELECT id,content_bytes AS bytes,sha256 AS hash FROM execution_artifacts",
  ).all() as Array<{ bytes: number; hash: string; id: string }>;
  const artifactChunks = database.prepare(`
    SELECT chunk_index AS chunkIndex,byte_offset AS byteOffset,
           byte_length AS byteLength,text,sha256 AS hash
    FROM execution_artifact_chunks WHERE artifact_id=? ORDER BY chunk_index
  `);
  for (const artifact of artifacts) {
    if (!chunkSetIsValid(
      artifact.bytes,
      artifact.hash,
      artifactChunks.all(artifact.id) as Parameters<typeof chunkSetIsValid>[2],
    )) return false;
  }
  const validations = database.prepare(`
    SELECT id,stdout_bytes AS stdoutBytes,stdout_sha256 AS stdoutHash,
           stderr_bytes AS stderrBytes,stderr_sha256 AS stderrHash
    FROM execution_validation_results
  `).all() as Array<{
    id: string;
    stderrBytes: number;
    stderrHash: string;
    stdoutBytes: number;
    stdoutHash: string;
  }>;
  const validationChunks = database.prepare(`
    SELECT chunk_index AS chunkIndex,byte_offset AS byteOffset,
           byte_length AS byteLength,text,sha256 AS hash
    FROM execution_validation_output_chunks
    WHERE validation_id=? AND stream=? ORDER BY chunk_index
  `);
  for (const validation of validations) {
    if (
      !chunkSetIsValid(
        validation.stdoutBytes,
        validation.stdoutHash,
        validationChunks.all(validation.id, "stdout") as Parameters<typeof chunkSetIsValid>[2],
      )
      || !chunkSetIsValid(
        validation.stderrBytes,
        validation.stderrHash,
        validationChunks.all(validation.id, "stderr") as Parameters<typeof chunkSetIsValid>[2],
      )
    ) return false;
  }
  return true;
}

function structuredFactsAreValid(database: DatabaseSync): boolean {
  try {
    const blocks = database.prepare(`
      SELECT b.payload_json AS json,b.payload_hash AS hash,
             b.block_schema_version AS schemaVersion,b.block_revision AS blockRevision,
             b.block_type AS blockType,b.logical_block_id AS logicalBlockId,
             b.project_id AS projectId,b.thread_id AS threadId,b.run_id AS runId,
             b.source_kind AS sourceKind,b.source_id AS sourceId,
             b.source_entity_version AS sourceVersion,b.actor_type AS actorType,
             b.actor_id AS actorId,b.actor_display_name AS actorDisplayName,
             m.id AS messageId,m.project_id AS messageProjectId,
             m.thread_id AS messageThreadId,m.run_id AS messageRunId,
             m.author_type AS messageActorType,m.author_agent_id AS messageActorId,
             m.author_display_name AS messageActorDisplayName
      FROM structured_message_blocks b
      JOIN collaboration_messages m ON m.id=b.message_id
    `).all() as Array<Record<string, unknown> & { hash: string; json: string }>;
    for (const row of blocks) {
      const decoded = decodePersistedStructuredJson(row.json, {
        maxCanonicalBytes: 64 * 1024,
        maxWireBytes: 64 * 1024,
        schema: blockCodecSchema,
      });
      const canonical = canonicalizeStructuredJson(row.json, {
        maxCanonicalBytes: 64 * 1024,
        maxWireBytes: 64 * 1024,
      });
      if (hashCanonicalBytes(canonical) !== row.hash || decoded.kind === "invalid") return false;
      const value = canonicalJson(row.json, 64 * 1024) as Record<string, unknown>;
      if (
        value.blockSchemaVersion !== row.schemaVersion
        || value.blockRevision !== row.blockRevision
        || value.blockType !== row.blockType
        || value.logicalBlockId !== row.logicalBlockId
        || row.projectId !== row.messageProjectId
        || row.threadId !== row.messageThreadId
        || row.runId !== row.messageRunId
        || row.actorType !== row.messageActorType
        || row.actorId !== row.messageActorId
        || row.actorDisplayName !== row.messageActorDisplayName
        || (row.sourceKind === "message"
          && (row.sourceId !== row.messageId || row.sourceVersion !== null))
      ) return false;
      if (decoded.kind === "known") persistedStructuredBlockSchema.parse(decoded.value);
    }

    const graphRows = database.prepare(`
      SELECT d.id AS decisionId,d.action,d.item_id AS itemId,
             d.block_id AS blockId,d.block_revision AS blockRevision,
             d.from_state_version AS fromVersion,d.to_state_version AS toVersion,
             r.id AS receiptId,r.result_json AS receiptJson,
             f.payload_json AS factJson,o.response_json AS responseJson,
             fs.state_json AS fromJson,ts.state_json AS toJson
      FROM inline_decisions d
      JOIN business_action_receipts r ON r.decision_id=d.id
      JOIN collaboration_thread_facts f ON f.inline_decision_id=d.id
      JOIN collaboration_operations o ON o.id=d.operation_id AND o.project_id=d.project_id
      JOIN structured_message_state_revisions fs
        ON (fs.project_id,fs.thread_id,fs.block_id,fs.state_version)=
           (d.project_id,d.thread_id,d.block_id,d.from_state_version)
      JOIN structured_message_state_revisions ts
        ON (ts.project_id,ts.thread_id,ts.block_id,ts.state_version)=
           (d.project_id,d.thread_id,d.block_id,d.to_state_version)
    `).all() as Array<Record<string, unknown> & {
      factJson: string; fromJson: string; receiptJson: string; responseJson: string; toJson: string;
    }>;
    for (const row of graphRows) {
      const receipt = canonicalJson(row.receiptJson, 256 * 1024) as Record<string, unknown>;
      const fact = canonicalJson(row.factJson, 64 * 1024) as Record<string, unknown>;
      const response = canonicalJson(row.responseJson, 256 * 1024) as {
        receipt: Record<string, unknown>;
      };
      const fromState = canonicalJson(row.fromJson, 64 * 1024) as Record<string, unknown>;
      const toState = canonicalJson(row.toJson, 64 * 1024) as Record<string, unknown>;
      for (const value of [receipt, fact, response.receipt]) {
        if (
          value.decisionId !== row.decisionId
          || value.blockId !== row.blockId
          || value.blockRevision !== row.blockRevision
          || value.fromStateVersion !== row.fromVersion
          || value.toStateVersion !== row.toVersion
          || (value.itemId ?? null) !== row.itemId
          || ("receiptId" in value && value.receiptId !== row.receiptId)
          || ("action" in value && value.action !== row.action)
        ) return false;
      }
      if (
        row.toVersion !== Number(row.fromVersion) + 1
        || (row.action === "accept" && toState.status !== "accepted")
        || (row.action === "reject" && toState.status !== "rejected")
        || (["accept", "reject"].includes(String(row.action)) && fromState.status !== "pending")
      ) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function validateCurrentDataInvariants(
  database: DatabaseSync,
): "SCHEMA_DATA_INVALID" | null {
  try {
    for (const query of CURRENT_DATA_INVARIANTS) {
      if (database.prepare(query).get()) return "SCHEMA_DATA_INVALID";
    }
    if (!chunkFactsAreValid(database)) return "SCHEMA_DATA_INVALID";
    if (!structuredFactsAreValid(database)) return "SCHEMA_DATA_INVALID";
    const invalidHashes = database.prepare(`
      SELECT id FROM structured_message_blocks
      WHERE length(payload_hash)<>64
    `).get();
    if (invalidHashes) return "SCHEMA_DATA_INVALID";
  } catch {
    return "SCHEMA_DATA_INVALID";
  }
  return null;
}
