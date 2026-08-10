import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import canonicalize from "canonicalize";

import {
  canonicalizeStructuredJson,
  decodePersistedStructuredJson,
  hashCanonicalBytes,
  parseCanonicalStructuredJson,
} from "@/src/modules/public-collaboration/internal/structured-message-codec";
import {
  blockCodecSchema,
  persistedStructuredBlockSchema,
} from "@/src/modules/public-collaboration/internal/structured-message-schema";

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
  `SELECT d.project_id FROM thread_drafts d
   WHERE d.reply_to_message_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM collaboration_messages m
                    WHERE (m.project_id,m.thread_id,m.id)=(d.project_id,d.thread_id,d.reply_to_message_id))`,
  `SELECT h.project_id FROM input_history_entries h
   WHERE NOT EXISTS(SELECT 1 FROM collaboration_threads t
                    WHERE (t.project_id,t.id)=(h.project_id,h.thread_id))`,
  `SELECT a.id FROM message_attachments a
   WHERE NOT EXISTS(SELECT 1 FROM collaboration_threads t
                    WHERE (t.project_id,t.id)=(a.project_id,a.thread_id))`,
  `SELECT e.id FROM attachment_events e
   WHERE NOT EXISTS(SELECT 1 FROM collaboration_threads t
                    WHERE (t.project_id,t.id)=(e.project_id,e.thread_id))`,
  `SELECT a.id FROM message_attachments a
   WHERE (a.status='linked')<>(a.message_id IS NOT NULL AND a.linked_at IS NOT NULL)
      OR (a.linked_at IS NOT NULL AND a.linked_at<a.created_at)`,
  `SELECT a.id FROM message_attachments a
   WHERE a.storage_relpath<>a.project_id||'/'||a.id`,
  `SELECT e.id FROM attachment_events e
   JOIN message_attachments a ON a.id=e.attachment_id
   WHERE (a.project_id,a.thread_id)<>(e.project_id,e.thread_id)`,
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

function replyEdgesAreValid(database: DatabaseSync): boolean {
  const messages = database.prepare(`
    SELECT id,project_id AS projectId,thread_id AS threadId,sequence,
           reply_to_message_id AS replyToMessageId,
           reply_to_sequence AS replyToSequence,
           reply_to_author_display_name AS replyToAuthorDisplayName,
           reply_to_excerpt AS replyToExcerpt
    FROM collaboration_messages
  `).all() as Array<{
    id: string;
    projectId: string;
    replyToAuthorDisplayName: string | null;
    replyToExcerpt: string | null;
    replyToMessageId: string | null;
    replyToSequence: number | null;
    sequence: number;
    threadId: string;
  }>;
  const readTarget = database.prepare(`
    SELECT sequence,author_display_name AS authorDisplayName,content
    FROM collaboration_messages
    WHERE project_id=? AND thread_id=? AND id=?
  `);
  for (const message of messages) {
    const columns = [
      message.replyToMessageId,
      message.replyToSequence,
      message.replyToAuthorDisplayName,
      message.replyToExcerpt,
    ];
    const nullCount = columns.filter((value) => value === null).length;
    if (nullCount === columns.length) continue;
    if (nullCount !== 0) return false;
    if (message.replyToMessageId === message.id) return false;
    const target = readTarget.get(
      message.projectId,
      message.threadId,
      message.replyToMessageId,
    ) as { authorDisplayName: string; content: string; sequence: number } | undefined;
    if (
      target === undefined
      || target.sequence >= message.sequence
      || message.replyToSequence !== target.sequence
      || message.replyToAuthorDisplayName !== target.authorDisplayName
      || message.replyToExcerpt !== target.content.trim()
    ) return false;
  }
  return true;
}

function structuredFactsAreValid(database: DatabaseSync): boolean {
  try {
    const handoffEventByKey = new Map<string, string>();
    const runEventFacts = database.prepare(`
      SELECT project_id AS projectId,thread_id AS threadId,run_id AS runId,id,
             run_event_id AS eventId
      FROM collaboration_thread_facts
      WHERE type='run_event'
    `).all() as Array<{
      eventId: string;
      id: string;
      projectId: string;
      runId: string;
      threadId: string;
    }>;
    for (const fact of runEventFacts) {
      handoffEventByKey.set(
        `${fact.projectId}\0${fact.threadId}\0${fact.runId}\0${fact.id}`,
        fact.eventId,
      );
    }
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
      if (decoded.kind === "known") {
        const parsedBlock = persistedStructuredBlockSchema.parse(decoded.value);
        if (parsedBlock.blockType === "diff_preview") {
          if (
            row.sourceKind !== "execution"
            || row.sourceId !== parsedBlock.observationId
            || row.sourceVersion !== parsedBlock.observationHash
          ) return false;
        } else if (parsedBlock.blockType === "file_reference") {
          if (
            row.sourceKind !== "artifact"
            || row.sourceId !== parsedBlock.artifactId
            || row.sourceVersion !== parsedBlock.artifactHash
          ) return false;
        } else if (parsedBlock.blockType === "handoff_card") {
          if (
            row.sourceKind !== "handoff"
            || row.sourceId !== parsedBlock.factId
            || row.sourceVersion === null
            || handoffEventByKey.get(
              `${String(row.projectId)}\0${String(row.threadId)}\0${String(row.runId)}\0${parsedBlock.factId}`,
            ) !== row.sourceVersion
          ) return false;
        } else if (row.sourceKind !== "message") {
          return false;
        }
      }
    }

    return true;
  } catch {
    return false;
  }
}

// Enumerates the full block/state-revision/head sets from a consistent
// snapshot and validates them bidirectionally: every state fact must map to
// exactly one block, every block must own a continuous, exactly-once,
// fork-free 1..N revision chain whose kind matches the block type, and the
// head must point at the unique terminal version. This never relies on
// single-direction foreign keys or reachable-path sampling.
function structuredStateGraphsAreValid(database: DatabaseSync): boolean {
  type BlockRow = {
    blockType: string;
    id: string;
    logicalBlockId: string;
    messageId: string;
    projectId: string;
    runId: string | null;
    threadId: string;
  };
  type RevisionRow = {
    blockId: string;
    priorStateVersion: number | null;
    projectId: string;
    stateKind: string;
    stateVersion: number;
    threadId: string;
  };
  type HeadRow = {
    blockId: string;
    currentStateVersion: number;
    projectId: string;
    threadId: string;
  };
  const blocks = database.prepare(`
    SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
           message_id AS messageId,logical_block_id AS logicalBlockId,
           block_type AS blockType
    FROM structured_message_blocks
  `).all() as BlockRow[];
  const revisions = database.prepare(`
    SELECT project_id AS projectId,thread_id AS threadId,block_id AS blockId,
           state_version AS stateVersion,prior_state_version AS priorStateVersion,
           state_kind AS stateKind
    FROM structured_message_state_revisions
  `).all() as RevisionRow[];
  const heads = database.prepare(`
    SELECT project_id AS projectId,thread_id AS threadId,block_id AS blockId,
           current_state_version AS currentStateVersion
    FROM structured_message_state_heads
  `).all() as HeadRow[];
  const messages = database.prepare(`
    SELECT project_id AS projectId,thread_id AS threadId,id,run_id AS runId
    FROM collaboration_messages
  `).all() as Array<{ id: string; projectId: string; runId: string | null; threadId: string }>;

  const key = (projectId: string, threadId: string, id: string) =>
    `${projectId}\0${threadId}\0${id}`;

  const blockByKey = new Map<string, BlockRow>();
  for (const block of blocks) {
    const blockKey = key(block.projectId, block.threadId, block.id);
    if (blockByKey.has(blockKey)) return false;
    blockByKey.set(blockKey, block);
  }

  const messageRunByKey = new Map<string, string | null>();
  for (const message of messages) {
    messageRunByKey.set(key(message.projectId, message.threadId, message.id), message.runId);
  }

  const logicalIdentityByMessage = new Set<string>();
  for (const block of blocks) {
    const messageKey = key(block.projectId, block.threadId, block.messageId);
    if (!messageRunByKey.has(messageKey) || messageRunByKey.get(messageKey) !== block.runId) {
      return false;
    }
    const logicalKey = `${messageKey}\0${block.logicalBlockId}`;
    if (logicalIdentityByMessage.has(logicalKey)) return false;
    logicalIdentityByMessage.add(logicalKey);
  }

  const revisionsByBlock = new Map<string, RevisionRow[]>();
  for (const revision of revisions) {
    const blockKey = key(revision.projectId, revision.threadId, revision.blockId);
    if (!blockByKey.has(blockKey)) return false;
    const chain = revisionsByBlock.get(blockKey);
    if (chain === undefined) revisionsByBlock.set(blockKey, [revision]);
    else chain.push(revision);
  }

  const headVersionByBlock = new Map<string, number>();
  for (const head of heads) {
    const blockKey = key(head.projectId, head.threadId, head.blockId);
    if (!blockByKey.has(blockKey) || headVersionByBlock.has(blockKey)) return false;
    headVersionByBlock.set(blockKey, head.currentStateVersion);
  }

  for (const block of blocks) {
    const blockKey = key(block.projectId, block.threadId, block.id);
    const headVersion = headVersionByBlock.get(blockKey);
    const chain = revisionsByBlock.get(blockKey);
    if (headVersion === undefined || chain === undefined || chain.length !== headVersion) {
      return false;
    }
    const expectedKind = block.blockType === "proposal" || block.blockType === "checklist"
      ? block.blockType
      : "read_only";
    const versions = new Set<number>();
    for (const revision of chain) {
      if (
        revision.stateVersion < 1
        || revision.stateVersion > chain.length
        || versions.has(revision.stateVersion)
        || revision.priorStateVersion !== (revision.stateVersion === 1
          ? null
          : revision.stateVersion - 1)
        || revision.stateKind !== expectedKind
      ) return false;
      versions.add(revision.stateVersion);
    }
  }
  return true;
}

// Enumerates the full inline_decision operation/Decision/Business
// Receipt/decision Fact sets from a consistent snapshot and validates them
// bidirectionally with exactly-once cardinality: every completed operation
// owns exactly one decision triple, non-success terminals stay result-free,
// every triple belongs to exactly one completed operation, and the stored
// receipt/fact/response JSON must equal the field-by-field reconstruction
// from the decision row. Each decision must justify exactly one state
// transition and every revision beyond v1 must be produced by exactly one
// decision; Checklist transitions may only flip the target item's checked
// bit in the action's legal direction while every other item, order, and
// non-state content stays untouched.
function structuredOutcomesAreValid(database: DatabaseSync): boolean {
  type DecisionRow = {
    action: string;
    actorId: string | null;
    actorType: string;
    blockId: string;
    blockRevision: number;
    fromStateVersion: number;
    id: string;
    itemId: string | null;
    operationId: string;
    projectId: string;
    runId: string | null;
    threadId: string;
    toStateVersion: number;
  };
  type ReceiptRow = {
    blockId: string;
    blockRevision: number;
    decisionId: string;
    fromStateVersion: number;
    id: string;
    operationId: string;
    projectId: string;
    requestHash: string;
    resultJson: string;
    runId: string | null;
    threadId: string;
    toStateVersion: number;
  };
  type FactRow = {
    decisionId: string | null;
    id: string;
    payloadJson: string;
    projectId: string;
    receiptId: string | null;
    runId: string | null;
    threadId: string;
  };
  type OperationRow = {
    id: string;
    projectId: string;
    requestHash: string;
    responseJson: string | null;
    runId: string | null;
    status: string;
    threadId: string;
  };
  type BlockRow = {
    blockRevision: number;
    blockType: string;
    id: string;
    projectId: string;
    runId: string | null;
    threadId: string;
  };
  const key = (projectId: string, threadId: string, id: string) =>
    JSON.stringify([projectId, threadId, id]);
  try {
    const decisions = database.prepare(`
      SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
             operation_id AS operationId,block_id AS blockId,
             block_revision AS blockRevision,from_state_version AS fromStateVersion,
             to_state_version AS toStateVersion,action,item_id AS itemId,
             actor_type AS actorType,actor_id AS actorId
      FROM inline_decisions
    `).all() as DecisionRow[];
    const receipts = database.prepare(`
      SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
             decision_id AS decisionId,operation_id AS operationId,
             request_hash AS requestHash,block_id AS blockId,
             block_revision AS blockRevision,
             from_state_version AS fromStateVersion,
             to_state_version AS toStateVersion,result_json AS resultJson
      FROM business_action_receipts
    `).all() as ReceiptRow[];
    const facts = database.prepare(`
      SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
             inline_decision_id AS decisionId,business_receipt_id AS receiptId,
             payload_json AS payloadJson
      FROM collaboration_thread_facts WHERE type='inline_decision'
    `).all() as FactRow[];
    const operations = database.prepare(`
      SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
             request_hash AS requestHash,status,response_json AS responseJson
      FROM collaboration_operations WHERE kind='inline_decision'
    `).all() as OperationRow[];
    const blocks = database.prepare(`
      SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
             block_type AS blockType,block_revision AS blockRevision
      FROM structured_message_blocks
    `).all() as BlockRow[];
    const revisionRows = database.prepare(`
      SELECT project_id AS projectId,thread_id AS threadId,block_id AS blockId,
             state_version AS stateVersion,state_json AS stateJson
      FROM structured_message_state_revisions
    `).all() as Array<{
      blockId: string;
      projectId: string;
      stateJson: string;
      stateVersion: number;
      threadId: string;
    }>;

    const operationByKey = new Map<string, OperationRow>();
    for (const operation of operations) {
      const operationKey = key(operation.projectId, operation.threadId, operation.id);
      if (operationByKey.has(operationKey)) return false;
      operationByKey.set(operationKey, operation);
    }
    const blockByKey = new Map<string, BlockRow>();
    for (const block of blocks) {
      blockByKey.set(key(block.projectId, block.threadId, block.id), block);
    }
    const stateJsonByRevisionKey = new Map<string, string>();
    const versionsByBlock = new Map<string, Set<number>>();
    for (const revision of revisionRows) {
      const blockKey = key(revision.projectId, revision.threadId, revision.blockId);
      const revisionKey = `${blockKey}:${revision.stateVersion}`;
      if (stateJsonByRevisionKey.has(revisionKey)) return false;
      stateJsonByRevisionKey.set(revisionKey, revision.stateJson);
      const versions = versionsByBlock.get(blockKey);
      if (versions === undefined) versionsByBlock.set(blockKey, new Set([revision.stateVersion]));
      else versions.add(revision.stateVersion);
    }
    const decisionByKey = new Map<string, DecisionRow>();
    const decisionCountByOperation = new Map<string, number>();
    const decisionsByBlock = new Map<string, DecisionRow[]>();
    for (const decision of decisions) {
      const decisionKey = key(decision.projectId, decision.threadId, decision.id);
      if (decisionByKey.has(decisionKey)) return false;
      decisionByKey.set(decisionKey, decision);
      const operationKey = key(decision.projectId, decision.threadId, decision.operationId);
      decisionCountByOperation.set(
        operationKey,
        (decisionCountByOperation.get(operationKey) ?? 0) + 1,
      );
      const blockKey = key(decision.projectId, decision.threadId, decision.blockId);
      const siblings = decisionsByBlock.get(blockKey);
      if (siblings === undefined) decisionsByBlock.set(blockKey, [decision]);
      else siblings.push(decision);
    }
    const receiptByDecisionKey = new Map<string, ReceiptRow>();
    for (const receipt of receipts) {
      const decisionKey = key(receipt.projectId, receipt.threadId, receipt.decisionId);
      if (receiptByDecisionKey.has(decisionKey)) return false;
      receiptByDecisionKey.set(decisionKey, receipt);
    }
    const factByDecisionKey = new Map<string, FactRow>();
    for (const fact of facts) {
      if (fact.decisionId === null) return false;
      const decisionKey = key(fact.projectId, fact.threadId, fact.decisionId);
      if (factByDecisionKey.has(decisionKey)) return false;
      factByDecisionKey.set(decisionKey, fact);
    }

    for (const operation of operations) {
      const count = decisionCountByOperation.get(
        key(operation.projectId, operation.threadId, operation.id),
      ) ?? 0;
      if (operation.status === "completed") {
        if (count !== 1) return false;
      } else if (operation.status === "version_conflict") {
        if (count !== 0) return false;
        if (operation.responseJson === null) return false;
        const body = canonicalJson(operation.responseJson, 256 * 1024);
        if (!versionConflictBodyIsValid(body)) return false;
      } else {
        return false;
      }
    }

    for (const decision of decisions) {
      const operation = operationByKey.get(
        key(decision.projectId, decision.threadId, decision.operationId),
      );
      if (operation === undefined || operation.status !== "completed") return false;
      if (decision.runId !== operation.runId) return false;
      const block = blockByKey.get(
        key(decision.projectId, decision.threadId, decision.blockId),
      );
      if (
        block === undefined
        || (block.blockType !== "proposal" && block.blockType !== "checklist")
        || block.blockRevision !== decision.blockRevision
        || block.runId !== decision.runId
      ) return false;
      if (
        decision.actorType !== "owner"
        || decision.fromStateVersion < 1
        || decision.toStateVersion !== decision.fromStateVersion + 1
        || ((decision.action === "accept" || decision.action === "reject")
          !== (decision.itemId === null))
      ) return false;
      const decisionKey = key(decision.projectId, decision.threadId, decision.id);
      const receipt = receiptByDecisionKey.get(decisionKey);
      const fact = factByDecisionKey.get(decisionKey);
      if (receipt === undefined || fact === undefined) return false;
      if (
        receipt.operationId !== decision.operationId
        || receipt.blockId !== decision.blockId
        || receipt.blockRevision !== decision.blockRevision
        || receipt.fromStateVersion !== decision.fromStateVersion
        || receipt.toStateVersion !== decision.toStateVersion
        || receipt.runId !== decision.runId
        || receipt.requestHash !== operation.requestHash
        || fact.receiptId !== receipt.id
        || fact.runId !== decision.runId
      ) return false;
      const expectedReceipt = {
        action: decision.action,
        blockId: decision.blockId,
        blockRevision: decision.blockRevision,
        decisionId: decision.id,
        fromStateVersion: decision.fromStateVersion,
        ...(decision.itemId === null ? {} : { itemId: decision.itemId }),
        operationId: decision.operationId,
        receiptId: receipt.id,
        receiptSchemaVersion: 1,
        requestHash: operation.requestHash,
        toStateVersion: decision.toStateVersion,
      };
      const storedReceipt = canonicalJson(receipt.resultJson, 256 * 1024);
      if (canonicalize(storedReceipt) !== canonicalize(expectedReceipt)) return false;
      const storedFactPayload = canonicalJson(fact.payloadJson, 64 * 1024);
      if (
        canonicalize(storedFactPayload) !== canonicalize({
          action: decision.action,
          blockId: decision.blockId,
          blockRevision: decision.blockRevision,
          decisionId: decision.id,
          fromStateVersion: decision.fromStateVersion,
          itemId: decision.itemId,
          operationId: decision.operationId,
          receiptId: receipt.id,
          toStateVersion: decision.toStateVersion,
        })
      ) return false;
      if (operation.responseJson === null) return false;
      const storedResponse = canonicalJson(operation.responseJson, 256 * 1024);
      if (
        canonicalize(storedResponse) !== canonicalize({
          kind: "completed",
          receipt: expectedReceipt,
        })
      ) return false;
      const blockKey = key(decision.projectId, decision.threadId, decision.blockId);
      const fromJson = stateJsonByRevisionKey.get(`${blockKey}:${decision.fromStateVersion}`);
      const toJson = stateJsonByRevisionKey.get(`${blockKey}:${decision.toStateVersion}`);
      if (fromJson === undefined || toJson === undefined) return false;
      if (
        !decisionTransitionIsValid(
          decision,
          block.blockType,
          canonicalJson(fromJson, 64 * 1024),
          canonicalJson(toJson, 64 * 1024),
        )
      ) return false;
    }

    for (const [blockKey, versions] of versionsByBlock) {
      const siblings = decisionsByBlock.get(blockKey) ?? [];
      const justifiedVersions = new Set<number>();
      for (const decision of siblings) {
        if (justifiedVersions.has(decision.toStateVersion)) return false;
        justifiedVersions.add(decision.toStateVersion);
      }
      if (siblings.length !== versions.size - 1) return false;
      for (const version of versions) {
        if (version > 1 && !justifiedVersions.has(version)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function versionConflictBodyIsValid(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 3 || body.kind !== "version_conflict") return false;
  if (
    typeof body.currentStateVersion !== "number"
    || !Number.isInteger(body.currentStateVersion)
    || body.currentStateVersion < 1
  ) return false;
  const error = body.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return false;
  const detail = error as Record<string, unknown>;
  return Object.keys(detail).length === 2
    && detail.code === "VERSION_CONFLICT"
    && typeof detail.message === "string";
}

function proposalStateIs(value: unknown, status: string): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as Record<string, unknown>).status === status;
}

function checklistItems(value: unknown): Array<{ checked: boolean; id: string }> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.items)) return null;
  for (const item of record.items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (
      Object.keys(entry).length !== 2
      || typeof entry.checked !== "boolean"
      || typeof entry.id !== "string"
    ) return null;
  }
  return record.items as Array<{ checked: boolean; id: string }>;
}

function decisionTransitionIsValid(
  decision: {
    action: string;
    itemId: string | null;
  },
  blockType: string,
  fromState: unknown,
  toState: unknown,
): boolean {
  if (blockType === "proposal") {
    if (decision.itemId !== null) return false;
    if (decision.action === "accept") {
      return proposalStateIs(fromState, "pending") && proposalStateIs(toState, "accepted");
    }
    if (decision.action === "reject") {
      return proposalStateIs(fromState, "pending") && proposalStateIs(toState, "rejected");
    }
    return false;
  }
  if (blockType !== "checklist") return false;
  if (
    decision.itemId === null
    || (decision.action !== "check_item" && decision.action !== "uncheck_item")
  ) return false;
  const fromItems = checklistItems(fromState);
  const toItems = checklistItems(toState);
  if (fromItems === null || toItems === null || fromItems.length !== toItems.length) {
    return false;
  }
  const target = decision.action === "check_item";
  let changed = 0;
  for (const [index, fromItem] of fromItems.entries()) {
    const toItem = toItems[index];
    if (toItem === undefined || fromItem.id !== toItem.id) return false;
    if (fromItem.checked === toItem.checked) continue;
    changed += 1;
    if (fromItem.id !== decision.itemId || fromItem.checked === target) return false;
  }
  return changed === 1;
}

export function validateCurrentDataInvariants(
  database: DatabaseSync,
): "SCHEMA_DATA_INVALID" | null {
  try {
    for (const query of CURRENT_DATA_INVARIANTS) {
      if (database.prepare(query).get()) return "SCHEMA_DATA_INVALID";
    }
    if (!chunkFactsAreValid(database)) return "SCHEMA_DATA_INVALID";
    if (!replyEdgesAreValid(database)) return "SCHEMA_DATA_INVALID";
    if (!structuredFactsAreValid(database)) return "SCHEMA_DATA_INVALID";
    if (!structuredStateGraphsAreValid(database)) return "SCHEMA_DATA_INVALID";
    if (!structuredOutcomesAreValid(database)) return "SCHEMA_DATA_INVALID";
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
