import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as createMission } from "@/app/api/projects/[projectId]/mission/route";
import { POST as startCollaboration } from "@/app/api/projects/[projectId]/threads/[threadId]/runs/route";
import { PUT as bindWorkspace } from "@/app/api/projects/[projectId]/workspace/route";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createThread } from "@/src/server/collaboration/thread-service";
import {
  executionDtoFromDatabase,
  startExecution,
} from "@/src/adapters/outbound/sqlite/safe-execution/execution-service";
import {
  preflightSandbox,
  type SandboxFsAdapter,
} from "@/src/adapters/outbound/workspace/sandbox-preflight";
import { generatePublicDelivery } from "@/src/server/review/delivery-application-service";
import { startPublicReview } from "@/src/server/review/review-application-service";
import { parseWorkspaceGuideEnvelope } from "@/src/shared/onboarding-guide-machine";
import type { ModelCallResult } from "@/src/shared/collaboration-contracts";

const PROJECT_ID = "onboarding-governance-project";
const EXECUTOR_ID = "onboarding-executor";
const REVIEWER_ID = "onboarding-reviewer";
const NOW = "2026-08-08T04:00:00.000Z";
const HASH = "a".repeat(64);
const CREATE_MISSION_OPERATION = "13000000-0000-4000-8000-000000000006";
const START_RUN_OPERATION = "13000000-0000-4000-8000-000000000001";
const CREATE_THREAD_OPERATION = "13000000-0000-4000-8000-000000000005";
const START_EXECUTION_OPERATION = "13000000-0000-4000-8000-000000000002";
const START_REVIEW_OPERATION = "13000000-0000-4000-8000-000000000003";
const GENERATE_DELIVERY_OPERATION = "13000000-0000-4000-8000-000000000004";

let root: string;
let databasePath: string;
let initialWorkspace: string;
let reboundWorkspace: string;
let executionRoot: string;

function context() {
  return { params: Promise.resolve({ projectId: PROJECT_ID }) };
}

function threadContext(threadId: string) {
  return { params: Promise.resolve({ projectId: PROJECT_ID, threadId }) };
}

function jsonRequest(url: string, method: "POST" | "PUT", body: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

function seedOnboardingResources(): void {
  const database = openDatabase(databasePath);
  try {
    const credential = createCredentialVault().encrypt("provider", "provider-secret");
    database.prepare(`
      INSERT INTO projects(id,name,created_at,version)
      VALUES (?, 'Onboarding governance', ?, 1)
    `).run(PROJECT_ID, NOW);
    database.prepare(`
      INSERT INTO providers(
        id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
        credential_version,credential_generation,key_id,api_key_mask,verified_at,
        version,created_at,updated_at
      ) VALUES ('provider','Provider','https://provider.invalid/v1','model',
        ?,?,?,1,1,?,'****',?,1,?,?)
    `).run(
      credential.apiKeyCipher,
      credential.apiKeyIv,
      credential.apiKeyTag,
      credential.keyId,
      NOW,
      NOW,
      NOW,
    );
    database.exec(`
      INSERT INTO agents(
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,
        created_at,updated_at,review_capable
      ) VALUES
        ('${EXECUTOR_ID}','Executor','Builder','Build safely','provider','model','E','sage',
         1,1,1,1000,2,1,'${NOW}','${NOW}',0),
        ('${REVIEWER_ID}','Reviewer','Reviewer','Review safely','provider','model','R','slate',
         1,0,0,1000,2,1,'${NOW}','${NOW}',1);
      INSERT INTO project_memberships(project_id,agent_id,joined_at)
      VALUES
        ('${PROJECT_ID}','${EXECUTOR_ID}','${NOW}'),
        ('${PROJECT_ID}','${REVIEWER_ID}','${NOW}');
    `);
  } finally {
    database.close();
  }
}

async function establishFormalOnboardingGoal(): Promise<{
  missionId: string;
  runId: string;
  threadId: string;
}> {
  const workspaceResponse = await bindWorkspace(
    jsonRequest(
      `http://localhost/api/projects/${PROJECT_ID}/workspace`,
      "PUT",
      { confirmRebind: false, expectedVersion: 1, path: initialWorkspace },
    ),
    context(),
  );
  expect(workspaceResponse.status).toBe(200);
  expect(parseWorkspaceGuideEnvelope(await workspaceResponse.json())).toMatchObject({
    kind: "success",
    projectVersion: 2,
    workspace: { status: "ready" },
  });

  const missionResponse = await createMission(
    jsonRequest(
      `http://localhost/api/projects/${PROJECT_ID}/mission`,
      "POST",
      {
        expectedVersion: 0,
        goal: "Prove the governed delivery chain.",
        operationId: CREATE_MISSION_OPERATION,
        title: "Governed onboarding",
      },
    ),
    context(),
  );
  expect(missionResponse.status).toBe(201);
  const missionBody = await missionResponse.json() as { mission: { id: string } };

  const threadBody = createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [EXECUTOR_ID, REVIEWER_ID],
    operationId: CREATE_THREAD_OPERATION,
    title: "Governed onboarding",
  }).body;

  const runResponse = await startCollaboration(
    jsonRequest(
      `http://localhost/api/projects/${PROJECT_ID}/threads/${threadBody.thread.id}/runs`,
      "POST",
      {
        message: "Accept this goal into formal collaboration.",
        operationId: START_RUN_OPERATION,
      },
    ),
    threadContext(threadBody.thread.id),
  );
  expect(runResponse.status).toBe(201);
  const runBody = await runResponse.json() as {
    created: boolean;
    message: { id: string };
    run: { id: string };
  };
  expect(runBody.created).toBe(true);

  const database = openDatabase(databasePath);
  try {
    expect(database.prepare(`
      SELECT type,json_extract(payload_json,'$.messageId') AS messageId
      FROM collaboration_events WHERE run_id=? AND type='run_started'
    `).get(runBody.run.id)).toEqual({
      messageId: runBody.message.id,
      type: "run_started",
    });
    expect(database.prepare("SELECT count(*) AS count FROM executions").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM review_attempts").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM mission_deliveries").get())
      .toEqual({ count: 0 });
  } finally {
    database.close();
  }
  return {
    missionId: missionBody.mission.id,
    runId: runBody.run.id,
    threadId: threadBody.thread.id,
  };
}

function planClaimedWork(
  missionId: string,
  threadId: string,
  runId: string,
): string {
  const workItemId = "onboarding-work";
  const database = openDatabase(databasePath);
  try {
    const message = database.prepare(`
      SELECT id FROM collaboration_messages WHERE run_id=? ORDER BY sequence LIMIT 1
    `).get(runId) as { id: string };
    database.exec("BEGIN IMMEDIATE");
    database.prepare(`
      UPDATE collaboration_runs
      SET status='planned',version=version+1,updated_at=?
      WHERE id=?
    `).run(NOW, runId);
    database.prepare(`
      INSERT INTO work_items(
        id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
      ) VALUES (?,?,'Governed work','Execute safely','in_progress',?,1,?,?)
    `).run(workItemId, missionId, EXECUTOR_ID, NOW, NOW);
    database.prepare(`
      INSERT INTO collaboration_attempts(
        id,project_id,thread_id,run_id,agent_id,operation_id,status,lease_token,lease_expires_at,
        prompt_hash,acquire_execution_epoch,acquire_context_hash,included_message_sequence,
        error_category,started_at,finished_at
      ) VALUES (
        'onboarding-plan-attempt',?,?,?,?,?,'committed','lease',?,
        ?,1,?,1,NULL,?,?
      )
    `).run(
      PROJECT_ID,
      threadId,
      runId,
      EXECUTOR_ID,
      START_RUN_OPERATION,
      NOW,
      HASH,
      HASH,
      NOW,
      NOW,
    );
    database.prepare(`
      INSERT INTO collaboration_turns(
        id,project_id,thread_id,attempt_id,run_id,agent_id,round_number,message_id,disposition,created_at
      ) VALUES ('onboarding-plan-turn',?,?,'onboarding-plan-attempt',?,?,1,?,'plan_ready',?)
    `).run(PROJECT_ID, threadId, runId, EXECUTOR_ID, message.id, NOW);
    const nextSequence = Number((database.prepare(`
      SELECT next_event_sequence AS sequence FROM collaboration_runs WHERE id=?
    `).get(runId) as { sequence: number }).sequence);
    database.prepare(`
      INSERT INTO collaboration_events(
        id,project_id,thread_id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
      ) VALUES ('onboarding-task-claimed',?,?,?,?,'task_claimed','agent',?,?,?)
    `).run(
      PROJECT_ID,
      threadId,
      runId,
      nextSequence,
      EXECUTOR_ID,
      JSON.stringify({
        agentId: EXECUTOR_ID,
        turnId: "onboarding-plan-turn",
        workItemId,
      }),
      NOW,
    );
    database.prepare(`
      UPDATE collaboration_runs SET next_event_sequence=next_event_sequence+1 WHERE id=?
    `).run(runId);
    const threadSequence = database.prepare(`
      SELECT next_fact_sequence AS factSequence
      FROM collaboration_threads WHERE project_id=? AND id=?
    `).get(PROJECT_ID, threadId) as { factSequence: number };
    const projectSequence = database.prepare(`
      SELECT next_activity_sequence AS activitySequence
      FROM collaboration_project_thread_sequences WHERE project_id=?
    `).get(PROJECT_ID) as { activitySequence: number };
    database.prepare(`
      INSERT INTO collaboration_thread_facts(
        id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
        run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
      ) VALUES (
        'onboarding-task-claimed-fact',?,?,?,?, 'run_event','agent',?,
        ?,NULL,'onboarding-task-claimed',NULL,?,?
      )
    `).run(
      PROJECT_ID,
      threadId,
      threadSequence.factSequence,
      projectSequence.activitySequence,
      EXECUTOR_ID,
      runId,
      JSON.stringify({ eventType: "task_claimed" }),
      NOW,
    );
    database.prepare(`
      UPDATE collaboration_threads
      SET next_fact_sequence=next_fact_sequence+1,last_activity_sequence=?,
          version=version+1,updated_at=?
      WHERE project_id=? AND id=?
    `).run(projectSequence.activitySequence, NOW, PROJECT_ID, threadId);
    database.prepare(`
      UPDATE collaboration_project_thread_sequences
      SET next_activity_sequence=next_activity_sequence+1 WHERE project_id=?
    `).run(PROJECT_ID);
    database.prepare(`
      INSERT INTO project_validation_policy_revisions(
        id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
        classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
      ) VALUES ('onboarding-policy',?,NULL,'system',1,?,1,0,2,0,?)
    `).run(PROJECT_ID, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", NOW);
    database.prepare(`
      INSERT INTO project_validation_policies(project_id,active_revision_id,version,updated_at)
      VALUES (?,'onboarding-policy',1,?)
    `).run(PROJECT_ID, NOW);
    database.exec("COMMIT");
    return workItemId;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function verifiedEmptyAdapter(openedRoots: string[]): SandboxFsAdapter {
  type Handle = { identity: string; path: string };
  return {
    attributes: () => ({ directory: true, reparsePoint: false, size: 0 }),
    close: () => undefined,
    finalPath: (handle) => (handle as Handle).path,
    identity: (handle) => (handle as Handle).identity,
    list: () => [],
    openChildDirectoryNoFollow: () => {
      throw new Error("empty directory");
    },
    openFileNoFollow: () => {
      throw new Error("empty directory");
    },
    openRootDirectory: (path) => {
      openedRoots.push(path);
      return { identity: `verified:${path}`, path };
    },
  };
}

async function startGovernedExecution(
  threadId: string,
  runId: string,
  workItemId: string,
): Promise<string> {
  const rebindResponse = await bindWorkspace(
    jsonRequest(
      `http://localhost/api/projects/${PROJECT_ID}/workspace`,
      "PUT",
      { confirmRebind: true, expectedVersion: 2, path: reboundWorkspace },
    ),
    context(),
  );
  expect(rebindResponse.status).toBe(200);
  const openedRoots: string[] = [];
  let observedCanonicalRoot = "";
  const result = await startExecution(
    databasePath,
    PROJECT_ID,
    {
      operationId: START_EXECUTION_OPERATION,
      source: { projectId: PROJECT_ID, runId, threadId },
      workItemId,
    },
    async (input) => {
      observedCanonicalRoot = input.canonicalRoot;
      await preflightSandbox({
        canonicalRoot: input.canonicalRoot,
        managedSandboxRoot: executionRoot,
        platform: verifiedEmptyAdapter(openedRoots),
      });
      const database = openDatabase(databasePath);
      try {
        database.exec("BEGIN IMMEDIATE");
        database.prepare(`
          UPDATE execution_actions
          SET status='succeeded',lease_token=NULL,lease_expires_at=NULL,
              result_json=?,finished_at=?
          WHERE id=? AND lease_token=?
        `).run(JSON.stringify({ manifestHash: HASH }), NOW, input.actionId, input.leaseToken);
        database.prepare(`
          UPDATE execution_attempts
          SET status='ready',baseline_manifest_path=?,baseline_manifest_hash=?,
              sandbox_manifest_path=?,sandbox_manifest_hash=?
          WHERE id=?
        `).run("verified://baseline", HASH, "verified://sandbox", HASH, input.attemptId);
        const body = {
          execution: executionDtoFromDatabase(database, input.executionId),
        };
        database.prepare(`
          UPDATE execution_operations
          SET status='completed',final_action_index=0,http_status=201,response_json=?,updated_at=?
          WHERE project_id=? AND id=?
        `).run(JSON.stringify(body), NOW, PROJECT_ID, START_EXECUTION_OPERATION);
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      } finally {
        database.close();
      }
      return { kind: "completed" };
    },
    executionRoot,
  );

  expect(result.status).toBe(201);
  expect(result.body).toMatchObject({
    execution: {
      sourceCollaborationRunId: runId,
      sourceCollaborationThreadId: threadId,
      status: "queued",
      workItem: { id: workItemId },
    },
  });
  const reboundState = openDatabase(databasePath);
  try {
    const bound = reboundState.prepare(`
      SELECT workspace_path AS workspacePath FROM projects WHERE id=?
    `).get(PROJECT_ID) as { workspacePath: string };
    expect(observedCanonicalRoot).toBe(bound.workspacePath);
  } finally {
    reboundState.close();
  }
  expect(observedCanonicalRoot.toLocaleLowerCase("en-US")).toContain(
    "workspace-rebound",
  );
  expect(observedCanonicalRoot.toLocaleLowerCase("en-US")).not.toContain(
    "workspace-initial",
  );
  expect(openedRoots).toEqual(
    expect.arrayContaining([observedCanonicalRoot, executionRoot]),
  );

  const database = openDatabase(databasePath);
  try {
    expect(database.prepare(`
      SELECT kind,status FROM execution_actions
      WHERE operation_id=?
    `).get(START_EXECUTION_OPERATION)).toEqual({
      kind: "sandbox_build",
      status: "succeeded",
    });
    expect(database.prepare("SELECT count(*) AS count FROM execution_approvals").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM execution_tool_calls").get())
      .toEqual({ count: 0 });
    return (database.prepare(`
      SELECT id FROM executions WHERE work_item_id=?
    `).get(workItemId) as { id: string }).id;
  } finally {
    database.close();
  }
}

function prepareReviewMaterial(
  executionId: string,
  missionId: string,
  workItemId: string,
): { resultId: string } {
  const resultId = "onboarding-result";
  const database = openDatabase(databasePath);
  try {
    const attempt = database.prepare(`
      SELECT id,frozen_context_hash AS frozenContextHash
      FROM execution_attempts WHERE execution_id=?
    `).get(executionId) as { frozenContextHash: string; id: string };
    const action = database.prepare(`
      SELECT id FROM execution_actions WHERE execution_id=? ORDER BY action_index LIMIT 1
    `).get(executionId) as { id: string };
    database.exec("BEGIN IMMEDIATE");
    database.prepare(`
      UPDATE executions SET status='merged',merged_at=?,updated_at=? WHERE id=?
    `).run(NOW, NOW, executionId);
    database.prepare(`
      INSERT INTO execution_staged_results(
        id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
        sandbox_manifest_hash,context_hash,policy_hash,staged_hash,observed_path_count,
        observed_final_bytes,merge_file_count,merge_final_bytes,blocker_count,
        classification,block_reasons_json,created_at
      ) VALUES (
        'onboarding-staged',?,?,?,?,?,?,?,?,?,1,1,1,1,0,'auto_eligible','[]',?
      )
    `).run(
      PROJECT_ID,
      executionId,
      attempt.id,
      action.id,
      HASH,
      HASH,
      attempt.frozenContextHash,
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      "b".repeat(64),
      NOW,
    );
    database.prepare(`
      INSERT INTO execution_staged_observations(
        id,staged_result_id,position,path,path_key,kind,baseline_hash,observed_hash,
        final_size,diff_text,diff_bytes,diff_truncated
      ) VALUES (
        'onboarding-observation','onboarding-staged',0,'result.txt','result.txt',
        'added',NULL,?,1,NULL,0,0
      )
    `).run("b".repeat(64));
    database.prepare(`
      INSERT INTO execution_staged_files(
        id,staged_result_id,observation_id,position,path,path_key,kind,
        baseline_hash,staged_hash,size
      ) VALUES (
        'onboarding-staged-file','onboarding-staged','onboarding-observation',0,
        'result.txt','result.txt','added',NULL,?,1
      )
    `).run("b".repeat(64));
    database.prepare(`
      INSERT INTO execution_merge_journals(
        id,project_id,execution_id,attempt_id,staged_result_id,merge_action_id,
        operation_id,status,next_file_position,old_manifest_hash,post_manifest_hash,
        observed_manifest_hash,mismatch_phase,mismatch_path_key,journal_root,error_code,
        created_at,updated_at
      ) VALUES (
        'onboarding-journal',?,?,?,'onboarding-staged',?,?,'completed',0,?,?,?,
        NULL,NULL,'verified://journal',NULL,?,?
      )
    `).run(
      PROJECT_ID,
      executionId,
      attempt.id,
      action.id,
      START_EXECUTION_OPERATION,
      HASH,
      HASH,
      HASH,
      NOW,
      NOW,
    );
    database.prepare(`
      INSERT INTO work_item_result_versions(
        id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
        merge_journal_id,supersedes_result_id,executor_agent_id,created_at
      ) VALUES (?, ?, ?, ?, 1, ?, 'onboarding-staged','onboarding-journal',NULL,?,?)
    `).run(resultId, PROJECT_ID, missionId, workItemId, executionId, EXECUTOR_ID, NOW);
    database.prepare(`
      INSERT INTO work_item_review_heads(
        work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
        state,version,updated_at
      ) VALUES (?, ?, ?, ?, NULL, 'pending_review', 1, ?)
    `).run(workItemId, PROJECT_ID, missionId, resultId, NOW);
    const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyFailures.length > 0) {
      throw new Error(`fixture foreign keys: ${JSON.stringify(foreignKeyFailures)}`);
    }
    const invalidChecks = [
      ["mission-head", `SELECT COUNT(*) count FROM missions m
        WHERE NOT EXISTS(SELECT 1 FROM mission_delivery_heads h
          WHERE h.mission_id=m.id AND h.project_id=m.project_id)`],
      ["review-event-count", `SELECT COUNT(*) count FROM mission_delivery_heads h
        WHERE h.next_event_sequence<>(SELECT COUNT(*)+1 FROM review_events e
          WHERE e.mission_id=h.mission_id)`],
      ["review-event-sequence", `SELECT COUNT(*) count FROM (
        SELECT mission_id,sequence,ROW_NUMBER() OVER(PARTITION BY mission_id ORDER BY sequence,id) expected
        FROM review_events) WHERE sequence<>expected`],
      ["result-link", `SELECT COUNT(*) count FROM work_item_result_versions r
        JOIN executions e ON e.id=r.execution_id
        WHERE r.executor_agent_id<>e.agent_id OR r.project_id<>e.project_id
          OR r.mission_id<>e.mission_id OR r.work_item_id<>e.work_item_id`],
      ["result-sequence", `SELECT COUNT(*) count FROM (
        SELECT work_item_id,id,version,supersedes_result_id,
          LAG(id) OVER(PARTITION BY work_item_id ORDER BY version) expected_id,
          ROW_NUMBER() OVER(PARTITION BY work_item_id ORDER BY version) expected_version
        FROM work_item_result_versions)
        WHERE version<>expected_version OR supersedes_result_id IS NOT expected_id`],
      ["result-head", `SELECT COUNT(*) count FROM work_item_result_versions r
        WHERE r.version=(SELECT MAX(x.version) FROM work_item_result_versions x WHERE x.work_item_id=r.work_item_id)
          AND NOT EXISTS(SELECT 1 FROM work_item_review_heads h
            WHERE h.work_item_id=r.work_item_id AND h.current_result_id=r.id
              AND h.project_id=r.project_id AND h.mission_id=r.mission_id)`],
      ["head-state", `SELECT COUNT(*) count FROM work_item_review_heads h
        LEFT JOIN review_attempts a ON a.id=h.current_attempt_id
        WHERE (h.current_result_id IS NULL AND h.state<>'executing')
          OR (h.state='reviewing' AND (a.id IS NULL OR a.status NOT IN ('calling','finalizing')))
          OR (h.state<>'reviewing' AND a.status IN ('calling','finalizing'))`],
      ["done-without-pass", `SELECT COUNT(*) count FROM work_items w
        WHERE w.status='done' AND NOT EXISTS(
          SELECT 1 FROM work_item_review_heads h
          WHERE h.work_item_id=w.id AND h.state='passed')`],
      ["pass-invalid", `SELECT COUNT(*) count FROM work_item_review_heads h
        JOIN work_items w ON w.id=h.work_item_id
        WHERE h.state='passed' AND (w.status<>'done' OR NOT EXISTS(
          SELECT 1 FROM review_attempts a JOIN review_decisions d ON d.attempt_id=a.id
          WHERE a.id=h.current_attempt_id AND d.choice='pass'
            AND d.result_id=h.current_result_id))`],
      ["delivery-head", `SELECT COUNT(*) count FROM mission_delivery_heads h
        WHERE (h.state='completed')<>(h.current_delivery_id IS NOT NULL)
          OR (h.state='completed' AND NOT EXISTS(
            SELECT 1 FROM mission_deliveries d WHERE d.id=h.current_delivery_id
              AND d.mission_id=h.mission_id AND d.project_id=h.project_id))`],
    ] as const;
    const invalid = invalidChecks.flatMap(([label, sql]) => {
      const count = Number((database.prepare(sql).get() as { count: number }).count);
      return count > 0 ? [`${label}:${count}`] : [];
    });
    if (invalid.length > 0) throw new Error(`fixture v6: ${invalid.join(",")}`);
    database.exec("COMMIT");
    return { resultId };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function addIneligibleReviewers(): void {
  const database = openDatabase(databasePath);
  try {
    const credential = createCredentialVault().encrypt("unverified-provider", "other-secret");
    database.prepare(`
      INSERT INTO providers(
        id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
        credential_version,credential_generation,key_id,api_key_mask,verified_at,
        version,created_at,updated_at
      ) VALUES ('unverified-provider','Unverified','https://provider.invalid/v1','model',
        ?,?,?,1,1,?,'****','',1,?,?)
    `).run(
      credential.apiKeyCipher,
      credential.apiKeyIv,
      credential.apiKeyTag,
      credential.keyId,
      NOW,
      NOW,
    );
    database.exec(`
      INSERT INTO agents(
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,
        created_at,updated_at,review_capable
      ) VALUES
        ('not-review-capable','Not reviewer','Builder','Build','provider','model','N','sage',
         1,0,0,1000,2,1,'${NOW}','${NOW}',0),
        ('unverified-reviewer','Unverified reviewer','Reviewer','Review','unverified-provider',
         'model','U','slate',1,0,0,1000,2,1,'${NOW}','${NOW}',1);
      INSERT INTO project_memberships(project_id,agent_id,joined_at)
      VALUES
        ('${PROJECT_ID}','not-review-capable','${NOW}'),
        ('${PROJECT_ID}','unverified-reviewer','${NOW}');
    `);
  } finally {
    database.close();
  }
}

function passedReviewOutput(): ModelCallResult {
  return {
    content: JSON.stringify({
      decision: { choice: "pass" },
      evidenceRefs: [{ id: "onboarding-result", type: "result", version: "1" }],
      findings: [],
      limitations: [],
      memoryCandidates: [],
      publicSummary: "Governed work independently reviewed.",
    }),
    error: null,
    httpStatus: 200,
    status: "succeeded",
    usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 },
    usageReported: true,
  };
}

beforeEach(() => {
  process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 51).toString("base64url");
  root = mkdtempSync(join(tmpdir(), "onboarding-governance-"));
  databasePath = join(root, "cockpit.sqlite");
  initialWorkspace = join(root, "workspace-initial");
  reboundWorkspace = join(root, "workspace-rebound");
  executionRoot = join(root, "managed-executions");
  mkdirSync(initialWorkspace);
  mkdirSync(reboundWorkspace);
  mkdirSync(executionRoot);
  process.env.COCKPIT_DB_PATH = databasePath;
  seedOnboardingResources();
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(root, { force: true, recursive: true });
});

describe("progressive onboarding T-15 formal governance linkage", () => {
  it("keeps accepted/run_started distinct and preserves workspace, review, approval, and run provenance gates", async () => {
    const { missionId, runId, threadId } =
      await establishFormalOnboardingGoal();
    const workItemId = planClaimedWork(missionId, threadId, runId);
    const executionId = await startGovernedExecution(
      threadId,
      runId,
      workItemId,
    );
    const { resultId } = prepareReviewMaterial(executionId, missionId, workItemId);
    addIneligibleReviewers();

    const reviewInput = (reviewerAgentId: string, operationId: string) => ({
      expectedHeadVersion: 1,
      operationId,
      resultId,
      reviewerAgentId,
    });
    for (const [reviewerAgentId, operationId] of [
      [EXECUTOR_ID, "13000000-0000-4000-8000-000000000010"],
      ["not-review-capable", "13000000-0000-4000-8000-000000000011"],
      ["unverified-reviewer", "13000000-0000-4000-8000-000000000012"],
    ]) {
      await expect(
        startPublicReview(
          databasePath,
          workItemId,
          reviewInput(reviewerAgentId, operationId),
        ),
      ).rejects.toMatchObject({ code: "REVIEWER_INELIGIBLE" });
    }

    const review = await startPublicReview(
      databasePath,
      workItemId,
      reviewInput(REVIEWER_ID, START_REVIEW_OPERATION),
      {
        callProvider: async () => passedReviewOutput(),
        scheduleHeartbeat: () => () => undefined,
      },
    );
    expect(review).toMatchObject({ state: "passed" });

    const database = openDatabase(databasePath);
    let deliveryHeadVersion: number;
    try {
      const attempt = database.prepare(`
        SELECT reviewer_agent_id AS reviewerAgentId,frozen_material_json AS materialJson
        FROM review_attempts WHERE operation_id=?
      `).get(START_REVIEW_OPERATION) as {
        materialJson: string;
        reviewerAgentId: string;
      };
      expect(attempt.reviewerAgentId).toBe(REVIEWER_ID);
      expect(JSON.parse(attempt.materialJson)).toMatchObject({
        result: {
          executionId,
          sourceCollaborationRunId: runId,
          sourceCollaborationThreadId: threadId,
        },
      });
      expect(database.prepare(`
        SELECT execution.source_collaboration_run_id AS sourceCollaborationRunId
        FROM review_attempts attempt
        JOIN work_item_result_versions result ON result.id=attempt.result_id
        JOIN executions execution ON execution.id=result.execution_id
        WHERE attempt.operation_id=?
      `).get(START_REVIEW_OPERATION)).toEqual({ sourceCollaborationRunId: runId });
      deliveryHeadVersion = Number((database.prepare(`
        SELECT version FROM mission_delivery_heads WHERE mission_id=?
      `).get(missionId) as { version: number }).version);
    } finally {
      database.close();
    }

    await generatePublicDelivery(
      databasePath,
      missionId,
      {
        expectedHeadVersion: deliveryHeadVersion,
        operationId: GENERATE_DELIVERY_OPERATION,
      },
    );
    const delivered = openDatabase(databasePath);
    try {
      const row = delivered.prepare(`
        SELECT summary_json AS summaryJson FROM mission_deliveries WHERE mission_id=?
      `).get(missionId) as { summaryJson: string };
      expect(JSON.parse(row.summaryJson)).toMatchObject({
        tasks: [{
          execution: {
            id: executionId,
            sourceCollaborationRunId: runId,
          },
        }],
      });
      expect(delivered.prepare(`
        SELECT execution.source_collaboration_run_id AS sourceCollaborationRunId
        FROM mission_deliveries delivery
        JOIN json_each(delivery.summary_json,'$.tasks') task
        JOIN executions execution
          ON execution.id=json_extract(task.value,'$.execution.id')
        WHERE delivery.mission_id=?
      `).get(missionId)).toEqual({ sourceCollaborationRunId: runId });
    } finally {
      delivered.close();
    }
  });
});
