import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { CURRENT_SCHEMA } from "@/src/adapters/outbound/sqlite/current-schema";
import { validateCurrentSchema } from "@/src/adapters/outbound/sqlite/validate-current-schema";
import {
  commitStructuredMessageTx,
  ingestStructuredBlocks,
  materializeStructuredBlocks,
} from "@/src/adapters/outbound/sqlite/public-collaboration/structured-message-store";

const databasePath = process.env.STRUCTURED_SMOKE_DB_PATH;
const mode = process.env.STRUCTURED_SMOKE_FIXTURE_MODE ?? "sources";
if (!databasePath) throw new Error("STRUCTURED_SMOKE_DB_PATH is required.");

const now = "2026-08-09T06:00:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const triggerSql = (name: string): string => {
  const object = CURRENT_SCHEMA.objects.find(
    (candidate) => candidate.kind === "trigger" && candidate.name === name,
  );
  if (!object) throw new Error(`Current trigger ${name} is unavailable.`);
  return object.createSql;
};

if (mode === "rename-source") {
  const database = openDatabase(databasePath);
  try {
    const updated = database.prepare(`
      UPDATE execution_artifacts SET name='renamed-later.txt'
      WHERE id='structured-smoke-artifact'
    `).run();
    if (updated.changes !== 1) throw new Error("Structured smoke artifact is unavailable.");
  } finally {
    database.close();
  }
  console.log(JSON.stringify({ renamed: "structured-smoke-artifact" }));
  process.exit(0);
}

if (mode === "invalid") {
  const database = new DatabaseSync(databasePath);
  const trigger = triggerSql("structured_message_blocks_no_update");
  const row = database.prepare(`
    SELECT id FROM structured_message_blocks
    WHERE logical_block_id='smoke-unknown' LIMIT 1
  `).get() as { id: string } | undefined;
  if (!row) throw new Error("Unknown fixture block is unavailable.");
  const payload = '{"actions":["accept","reject"],"blockRevision":1,"blockSchemaVersion":1,"blockType":"proposal","body":3,"logicalBlockId":"smoke-unknown","title":"Invalid persisted block"}';
  database.exec("DROP TRIGGER structured_message_blocks_no_update");
  database.prepare(`
    UPDATE structured_message_blocks
    SET block_schema_version=1,payload_json=?,payload_hash=? WHERE id=?
  `).run(payload, hash(payload), row.id);
  database.exec(trigger);
  database.close();
  console.log(JSON.stringify({ invalidBlockId: row.id }));
  process.exit(0);
}

const projectId = process.env.STRUCTURED_SMOKE_PROJECT_ID;
const threadId = process.env.STRUCTURED_SMOKE_THREAD_ID;
const runId = process.env.STRUCTURED_SMOKE_RUN_ID;
const agentId = process.env.STRUCTURED_SMOKE_AGENT_ID;
const privateHostPath = process.env.STRUCTURED_SMOKE_PRIVATE_PATH ?? "D:\\private\\never-public.txt";
if (!projectId || !threadId || !runId || !agentId) {
  throw new Error("Structured source tuple is required.");
}

const database = openDatabase(databasePath);
try {
  const mission = database.prepare(`
    SELECT id FROM missions WHERE project_id=? ORDER BY created_at,id LIMIT 1
  `).get(projectId) as { id: string };
  const work = database.prepare(`
    SELECT id FROM work_items WHERE mission_id=? ORDER BY created_at,id LIMIT 1
  `).get(mission.id) as { id: string };
  const policy = database.prepare(`
    SELECT active_revision_id AS id FROM project_validation_policies WHERE project_id=?
  `).get(projectId) as { id: string };
  const handoff = database.prepare(`
    SELECT f.id AS factId,e.payload_json AS payloadJson,e.actor_id AS actorId,
           m.author_display_name AS actorDisplayName
    FROM collaboration_thread_facts f
    JOIN collaboration_events e
      ON e.project_id=f.project_id AND e.thread_id=f.thread_id
     AND e.run_id=f.run_id AND e.id=f.run_event_id
    JOIN collaboration_turns t
      ON t.project_id=e.project_id AND t.thread_id=e.thread_id
     AND t.run_id=e.run_id AND t.id=json_extract(e.payload_json,'$.turnId')
    JOIN collaboration_messages m
      ON m.project_id=t.project_id AND m.thread_id=t.thread_id
     AND m.run_id=t.run_id AND m.id=t.message_id
    WHERE f.project_id=? AND f.thread_id=? AND f.run_id=? AND e.type='handoff'
    ORDER BY f.sequence LIMIT 1
  `).get(projectId, threadId, runId) as {
    actorDisplayName: string;
    actorId: string;
    factId: string;
    payloadJson: string;
  };
  const handoffPayload = JSON.parse(handoff.payloadJson) as { turnId: string };

  const executionId = "structured-smoke-execution";
  const attemptId = "structured-smoke-attempt";
  const operationId = "00000000-0000-4000-8000-000000009901";
  const actionId = "structured-smoke-stage-action";
  const stagedId = "structured-smoke-staged";
  const observationId = "structured-smoke-observation";
  const artifactId = "structured-smoke-artifact";
  const baseline = hash("baseline");
  const observed = hash("safe-redacted-diff");
  const artifactHash = hash("safe");
  const context = hash("context");
  const policyHash = database.prepare(`
    SELECT policy_hash AS hash FROM project_validation_policy_revisions
    WHERE project_id=? AND id=?
  `).get(projectId, policy.id) as { hash: string };
  const diffText = "src/safe.txt: one redacted persisted change";

  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      INSERT INTO executions(
        id,project_id,source_collaboration_thread_id,source_collaboration_run_id,
        mission_id,work_item_id,agent_id,current_policy_revision_id,status,
        resume_target,reason_code,manual_recovery_required,recovery_resolution,
        current_attempt_no,business_round_count,tool_call_count,next_event_sequence,
        version,created_at,business_deadline_at,first_running_at,updated_at,merged_at
      ) VALUES (?,?,?,?,?,?,?,?,'staged',NULL,NULL,0,NULL,1,0,0,1,1,?,
        '2026-08-09T06:15:00.000Z',?,?,NULL)
    `).run(
      executionId,
      projectId,
      threadId,
      runId,
      mission.id,
      work.id,
      agentId,
      policy.id,
      now,
      now,
      now,
    );
    database.prepare(`
      INSERT INTO execution_attempts(
        id,project_id,execution_id,attempt_no,status,sandbox_root,
        baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
        frozen_public_json,frozen_private_json,frozen_context_hash,
        frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
        started_at,finished_at
      ) VALUES (?,?,?,1,'ready',?,NULL,?,?,'{}','{}',?,?,1,?,?,NULL)
    `).run(
      attemptId,
      projectId,
      executionId,
      privateHostPath,
      baseline,
      observed,
      context,
      policy.id,
      policyHash.hash,
      now,
    );
    database.prepare(`
      INSERT INTO execution_operations(
        id,project_id,execution_id,kind,request_hash,has_external_actions,
        action_count,final_action_index,status,http_status,response_json,created_at,updated_at
      ) VALUES (?,?,?,'stage',?,1,1,0,'completed',200,'{}',?,?)
    `).run(operationId, projectId, executionId, hash("stage-operation"), now, now);
    database.prepare(`
      INSERT INTO execution_actions(
        id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
        request_hash,overall_deadline_at,result_json,created_at,started_at,finished_at
      ) VALUES (?,?,?,?,?,0,'stage_compute','succeeded',?,
        '2026-08-09T06:15:00.000Z','{}',?,?,?)
    `).run(
      actionId,
      projectId,
      executionId,
      attemptId,
      operationId,
      hash("stage-action"),
      now,
      now,
      now,
    );
    database.prepare(`
      INSERT INTO execution_staged_results(
        id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
        sandbox_manifest_hash,context_hash,policy_hash,staged_hash,
        observed_path_count,observed_final_bytes,merge_file_count,merge_final_bytes,
        blocker_count,classification,block_reasons_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,1,4,1,4,0,'auto_eligible','[]',?)
    `).run(
      stagedId,
      projectId,
      executionId,
      attemptId,
      actionId,
      baseline,
      observed,
      context,
      policyHash.hash,
      observed,
      now,
    );
    database.prepare(`
      INSERT INTO execution_staged_observations(
        id,staged_result_id,position,path,path_key,kind,baseline_hash,observed_hash,
        final_size,diff_text,diff_bytes,diff_truncated
      ) VALUES (?,?,0,'src/safe.txt','src/safe.txt','modified',?,?,4,?,?,0)
    `).run(
      observationId,
      stagedId,
      baseline,
      observed,
      diffText,
      Buffer.byteLength(diffText),
    );
    database.prepare(`
      INSERT INTO execution_staged_files(
        id,staged_result_id,observation_id,position,path,path_key,kind,
        baseline_hash,staged_hash,size
      ) VALUES ('structured-smoke-file',?,?,0,'src/safe.txt','src/safe.txt',
        'modified',?,?,4)
    `).run(stagedId, observationId, baseline, observed);
    database.prepare(`
      INSERT INTO execution_artifacts(
        id,project_id,execution_id,attempt_id,name,path,content_bytes,sha256,
        truncated,created_at
      ) VALUES (?,?,?,?, 'safe-report.txt',?,4,?,0,?)
    `).run(artifactId, projectId, executionId, attemptId, privateHostPath, artifactHash, now);
    database.prepare(`
      INSERT INTO execution_artifact_chunks(
        artifact_id,chunk_index,byte_offset,byte_length,text,sha256
      ) VALUES (?,0,0,4,'safe',?)
    `).run(artifactId, hash("safe"));

    const blocks = ingestStructuredBlocks(JSON.stringify({
      blocks: [
        {
          blockRevision: 1,
          blockSchemaVersion: 1,
          blockType: "diff_preview",
          logicalBlockId: "smoke-diff",
          observationHash: observed,
          observationId,
          stagedResultId: stagedId,
          title: "Frozen Diff Preview",
        },
        {
          artifactHash,
          artifactId,
          blockRevision: 1,
          blockSchemaVersion: 1,
          blockType: "file_reference",
          executionId,
          logicalBlockId: "smoke-file-reference",
          title: "Frozen File Reference",
        },
        {
          blockRevision: 1,
          blockSchemaVersion: 1,
          blockType: "handoff_card",
          factId: handoff.factId,
          logicalBlockId: "smoke-handoff",
          title: "Frozen Handoff Card",
          turnId: handoffPayload.turnId,
        },
        {
          actions: ["accept", "reject"],
          blockRevision: 1,
          blockSchemaVersion: 1,
          blockType: "proposal",
          body: "Will become a stable unknown-schema placeholder.",
          logicalBlockId: "smoke-unknown",
          title: "Future structured block",
        },
      ],
    }));
    const actor = {
      displayName: handoff.actorDisplayName,
      id: handoff.actorId,
      type: "agent" as const,
    };
    const persistedBlocks = materializeStructuredBlocks(
      database,
      { projectId, runId, threadId },
      actor,
      blocks,
    );
    commitStructuredMessageTx(database, {
      actor,
      blocks: persistedBlocks,
      content: "Frozen source cards and forward-compatible content.",
      factId: randomUUID(),
      messageId: randomUUID(),
      projectId,
      runId,
      threadId,
      timestamp: now,
    });
    const unknown = database.prepare(`
      SELECT id FROM structured_message_blocks
      WHERE logical_block_id='smoke-unknown'
    `).get() as { id: string };
    const unknownPayload =
      '{"blockRevision":1,"blockSchemaVersion":2,"blockType":"proposal","future":"opaque","logicalBlockId":"smoke-unknown"}';
    const trigger = triggerSql("structured_message_blocks_no_update");
    database.exec("DROP TRIGGER structured_message_blocks_no_update");
    database.prepare(`
      UPDATE structured_message_blocks
      SET block_schema_version=2,payload_json=?,payload_hash=? WHERE id=?
    `).run(unknownPayload, hash(unknownPayload), unknown.id);
    database.exec(trigger);
    database.exec("COMMIT");
    validateCurrentSchema(database);
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }

  console.log(JSON.stringify({
    artifactId,
    executionId,
    handoffFactId: handoff.factId,
    observationId,
    privateHostPath,
    stagedId,
  }));
} finally {
  database.close();
}
