import { createHash, randomUUID } from "node:crypto";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  commitStructuredMessageTx,
  ingestStructuredBlocks,
  materializeStructuredBlocks,
} from "@/src/adapters/outbound/sqlite/public-collaboration/structured-message-store";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export type FileReferenceGraph = {
  artifactHash: string;
  artifactId: string;
  artifactName: string;
  artifactPath: string;
  executionId: string;
};

export type FileReferenceGraphInput = {
  agentId: string;
  artifactContent?: string;
  artifactName?: string;
  artifactPath?: string;
  missionId: string;
  now: string;
  projectId: string;
  runId: string;
  threadId: string;
};

// Builds the minimal legal safe-execution graph a File Reference can point at:
// work item → system validation policy → staged execution → ready attempt →
// artifact + chunk. Follows the same insert chain as the structured-messages
// browser fixture so reopen invariants (policy/execution/artifact/chunk) hold.
export function seedFileReferenceGraph(
  databasePath: string,
  input: FileReferenceGraphInput,
): FileReferenceGraph {
  const artifactContent = input.artifactContent ?? "safe";
  const artifactName = input.artifactName ?? "safe-report.txt";
  const artifactPath = input.artifactPath ?? "D:\\private\\never-public.txt";
  const executionId = `execution-${randomUUID()}`;
  const attemptId = `attempt-${randomUUID()}`;
  const artifactId = `artifact-${randomUUID()}`;
  const workItemId = `work-${randomUUID()}`;
  const policyRevisionId = `policy-revision-${randomUUID()}`;
  const artifactHash = sha256(artifactContent);
  const artifactBytes = Buffer.byteLength(artifactContent);
  const businessDeadlineAt = new Date(Date.parse(input.now) + 900_000).toISOString();

  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(
        `INSERT INTO work_items(
           id,mission_id,title,description,status,version,created_at,updated_at
         ) VALUES (?,?,'File work','Produce the file','in_progress',1,?,?)`,
      ).run(workItemId, input.missionId, input.now, input.now);
      database.prepare(
        `INSERT INTO project_validation_policy_revisions(
           id,project_id,created_operation_id,created_actor_type,revision_no,
           policy_hash,classifier_version,warning_accepted,canonical_bytes,
           entry_count,created_at
         ) VALUES (?,?,NULL,'system',1,?,1,0,2,0,?)`,
      ).run(policyRevisionId, input.projectId, sha256(`policy-${policyRevisionId}`), input.now);
      database.prepare(
        `INSERT INTO project_validation_policies(project_id,active_revision_id,version,updated_at)
         VALUES (?,?,1,?)`,
      ).run(input.projectId, policyRevisionId, input.now);
      database.prepare(
        `INSERT INTO executions(
           id,project_id,source_collaboration_thread_id,source_collaboration_run_id,
           mission_id,work_item_id,agent_id,current_policy_revision_id,status,
           current_attempt_no,created_at,business_deadline_at,first_running_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,'staged',1,?,?,?,?)`,
      ).run(
        executionId,
        input.projectId,
        input.threadId,
        input.runId,
        input.missionId,
        workItemId,
        input.agentId,
        policyRevisionId,
        input.now,
        businessDeadlineAt,
        input.now,
        input.now,
      );
      database.prepare(
        `INSERT INTO execution_attempts(
           id,project_id,execution_id,attempt_no,status,sandbox_root,
           baseline_manifest_hash,sandbox_manifest_hash,
           frozen_public_json,frozen_private_json,frozen_context_hash,
           frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
           started_at
         ) VALUES (?,?,?,1,'ready',?,?,?,'{}','{}',?,?,1,?,?)`,
      ).run(
        attemptId,
        input.projectId,
        executionId,
        "D:\\sandbox\\file-reference",
        sha256(`baseline-${executionId}`),
        sha256(`sandbox-${executionId}`),
        sha256(`context-${executionId}`),
        policyRevisionId,
        sha256(`policy-${policyRevisionId}`),
        input.now,
      );
      database.prepare(
        `INSERT INTO execution_artifacts(
           id,project_id,execution_id,attempt_id,name,path,content_bytes,sha256,
           truncated,created_at
         ) VALUES (?,?,?,?,?,?,?,?,0,?)`,
      ).run(
        artifactId,
        input.projectId,
        executionId,
        attemptId,
        artifactName,
        artifactPath,
        artifactBytes,
        artifactHash,
        input.now,
      );
      database.prepare(
        `INSERT INTO execution_artifact_chunks(
           artifact_id,chunk_index,byte_offset,byte_length,text,sha256
         ) VALUES (?,0,0,?,?,?)`,
      ).run(artifactId, artifactBytes, artifactContent, artifactHash);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
  return { artifactHash, artifactId, artifactName, artifactPath, executionId };
}

// Commits one agent message holding a single File Reference block through the
// same write Interface the turn orchestrator uses, so the frozen projection is
// produced by the production commit transaction.
export function commitFileReferenceMessage(
  databasePath: string,
  input: {
    actor: { displayName: string; id: string; type: "agent" };
    graph: FileReferenceGraph;
    now: string;
    projectId: string;
    runId: string;
    threadId: string;
  },
): { blockId: string; messageId: string } {
  const messageId = `message-${randomUUID()}`;
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const blocks = ingestStructuredBlocks(JSON.stringify({
        blocks: [{
          artifactHash: input.graph.artifactHash,
          artifactId: input.graph.artifactId,
          blockRevision: 1,
          blockSchemaVersion: 1,
          blockType: "file_reference",
          executionId: input.graph.executionId,
          logicalBlockId: `file-${messageId}`,
          title: "File Reference",
        }],
      }));
      const persisted = materializeStructuredBlocks(
        database,
        { projectId: input.projectId, runId: input.runId, threadId: input.threadId },
        input.actor,
        blocks,
      );
      commitStructuredMessageTx(database, {
        actor: input.actor,
        blocks: persisted,
        content: "Review this file.",
        factId: `fact-${randomUUID()}`,
        messageId,
        projectId: input.projectId,
        runId: input.runId,
        threadId: input.threadId,
        timestamp: input.now,
      });
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
    const row = database.prepare(
      "SELECT id FROM structured_message_blocks WHERE message_id=?",
    ).get(messageId) as { id: string };
    return { blockId: row.id, messageId };
  } finally {
    database.close();
  }
}

// Simulates the owner renaming the artifact after the File Reference was
// committed; the persisted block graph is untouched.
export function renameFileReferenceSource(
  databasePath: string,
  artifactId: string,
  nextName: string,
): void {
  const database = openDatabase(databasePath);
  try {
    database.prepare(
      "UPDATE execution_artifacts SET name=? WHERE id=?",
    ).run(nextName, artifactId);
  } finally {
    database.close();
  }
}

// Simulates a new latest artifact version replacing the original row while
// keeping chunk invariants intact, so reopen stays legal.
export function supersedeFileReferenceSource(
  databasePath: string,
  artifactId: string,
  nextContent: string,
): { nextHash: string } {
  const nextHash = sha256(nextContent);
  const nextBytes = Buffer.byteLength(nextContent);
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(
        "UPDATE execution_artifacts SET sha256=?,content_bytes=? WHERE id=?",
      ).run(nextHash, nextBytes, artifactId);
      database.prepare(
        `UPDATE execution_artifact_chunks
         SET text=?,byte_length=?,sha256=? WHERE artifact_id=? AND chunk_index=0`,
      ).run(nextContent, nextBytes, nextHash, artifactId);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
  return { nextHash };
}
