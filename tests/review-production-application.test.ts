import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getProjects } from "@/app/api/projects/route";
import { GET as getProjectContext } from "@/app/api/projects/[projectId]/context/route";
import { GET as getProjectTasks } from "@/app/api/projects/[projectId]/tasks/route";
import {
  GET as getReviews,
  POST,
} from "@/app/api/work-items/[workItemId]/reviews/route";
import { createThread } from "@/src/server/collaboration/thread-service";
import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import { validateCurrentDataInvariants } from "@/src/server/storage/current-data-invariants";
import {
  buildDeliveryInput,
  generatePublicDelivery,
} from "@/src/server/review/delivery-application-service";
import type { ModelCallResult } from "@/src/shared/collaboration-contracts";
import { refreshExecutionFrozenFixture } from "@/tests/fixtures/execution/frozen-input";

type ApplicationModule = typeof import("../src/server/review/review-application-service");
const applicationModules = import.meta.glob<ApplicationModule>(
  "../src/server/review/review-application-service.ts",
);
const callOpenAiChat = vi.hoisted(() => vi.fn());
vi.mock("@/src/server/collaboration/openai-chat-client", async (load) => ({
  ...await load<typeof import("@/src/server/collaboration/openai-chat-client")>(),
  callOpenAiChat,
}));
vi.mock("@/src/server/db", async (load) => {
  const actual = await load<typeof import("@/src/server/db")>();
  return {
    ...actual,
    openDatabase(path: string) {
      const probe = new DatabaseSync(path);
      const version = Number(probe.prepare("PRAGMA user_version").get()!.user_version);
      probe.close();
      if (version === 0) return actual.openDatabase(path);
      const database = new DatabaseSync(path);
      database.exec("PRAGMA foreign_keys=ON");
      return database;
    },
  };
});

const NOW = "2026-08-01T08:30:00.000Z";
const roots: string[] = [];
const operationId = "24000000-0000-4000-8000-000000000001";
let databasePath: string;

function output(
  choice: "reject" | "escalate" | "pass",
  resultId = "result",
): ModelCallResult {
  return {
    content: JSON.stringify({
      decision: choice === "reject"
        ? { choice, reworkRequirements: ["修复公开行为"] }
        : choice === "escalate"
        ? { choice, options: ["继续", "终止"], question: "需要 Owner 选择" }
        : { choice },
      evidenceRefs: [{ id: resultId, type: "result", version: "1" }],
      findings: [],
      limitations: [],
      memoryCandidates: choice === "pass"
        ? [{
            content: "复核确认的经验",
            source: { id: resultId, type: "result", version: "1" },
            supersedesMemoryId: null,
            type: "experience",
          }]
        : [],
      publicSummary: `公开裁决 ${choice}`,
    }),
    error: null,
    httpStatus: 200,
    status: "succeeded",
    usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 },
    usageReported: true,
  };
}

function invalidOutput(): ModelCallResult {
  return {
    content: "{",
    error: null,
    httpStatus: 200,
    status: "succeeded",
    usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
    usageReported: true,
  };
}

function seed(path: string): void {
  const database = openDatabase(path);
  const envelope = createCredentialVault().encrypt("provider", "server-secret");
  database.exec("PRAGMA foreign_keys=OFF");
  database.prepare(`
    INSERT INTO projects(id,name,created_at,version)
    VALUES ('project','Production review',?,1)
  `).run(NOW);
  database.prepare(`
    INSERT INTO providers(
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES ('provider','Provider','https://provider.invalid/v1','model',
      ?,?,?,1,1,?,'****',?,1,?,?)
  `).run(
    envelope.apiKeyCipher,
    envelope.apiKeyIv,
    envelope.apiKeyTag,
    envelope.keyId,
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
      ('executor','Executor','Builder','Build','provider','model','E','sage',
       1,1,1,1000,2,1,'${NOW}','${NOW}',0),
      ('reviewer','Reviewer','Review','Review safely','provider','model','R','slate',
       1,0,0,1000,2,1,'${NOW}','${NOW}',1);
    INSERT INTO project_memberships(project_id,agent_id,joined_at)
    VALUES ('project','executor','${NOW}'),('project','reviewer','${NOW}');
    INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','project','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items(
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES
      ('work','mission','Work','Do work','in_progress','executor',1,'${NOW}','${NOW}'),
      ('other-work','mission','Other','Other work','in_progress','executor',1,'${NOW}','${NOW}');
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,1,1,'${NOW}');
  `);
  database.exec("PRAGMA foreign_keys=ON");
  database.close();
  const threadId = createThread(path, "project", {
    memberAgentIds: ["executor", "reviewer"],
    operationId: "24000000-0000-4000-8000-000000000000",
    title: "Production review source",
  }).body.thread.id;
  const seeded = openDatabase(path);
  const contextHash = "3".repeat(64);
  const policyHash = "4".repeat(64);
  seeded.exec(`
    INSERT INTO collaboration_runs(
      id,project_id,thread_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES ('run','project','${threadId}','planned','executor',1,1,1,1,NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO collaboration_thread_facts(
      id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
      run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
    ) VALUES ('run-linked','project','${threadId}',3,3,'run_linked','system',NULL,
      'run',NULL,NULL,NULL,'{"runId":"run"}','${NOW}');
    UPDATE collaboration_threads
    SET next_fact_sequence=4,last_activity_sequence=3,version=version+1,updated_at='${NOW}'
    WHERE project_id='project' AND id='${threadId}';
    UPDATE collaboration_project_thread_sequences
    SET next_activity_sequence=4 WHERE project_id='project';
    INSERT INTO project_validation_policy_revisions(
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES ('policy','project',NULL,'system',1,'${policyHash}',1,0,2,0,'${NOW}');
    INSERT INTO project_validation_policies(project_id,active_revision_id,version,updated_at)
    VALUES ('project','policy',1,'${NOW}');
    INSERT INTO executions(
      id,project_id,source_collaboration_thread_id,source_collaboration_run_id,
      mission_id,work_item_id,agent_id,current_policy_revision_id,status,resume_target,
      reason_code,manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES
      ('execution','project','${threadId}','run','mission','work','executor','policy',
       'merged',NULL,NULL,0,NULL,1,0,0,1,1,'${NOW}',NULL,NULL,'${NOW}','${NOW}'),
      ('other-execution','project','${threadId}','run','mission','other-work','executor','policy',
       'merged',NULL,NULL,0,NULL,1,0,0,1,1,'${NOW}',NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO execution_attempts(
      id,project_id,execution_id,attempt_no,status,sandbox_root,baseline_manifest_path,
      sandbox_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,started_at,finished_at
    ) VALUES
      ('execution-attempt','project','execution',1,'completed','sandbox',NULL,NULL,
       '${"1".repeat(64)}','${"2".repeat(64)}','{}','{}','${contextHash}',
       'policy',1,'${policyHash}','${NOW}','${NOW}'),
      ('other-attempt','project','other-execution',1,'completed','other-sandbox',NULL,NULL,
       '${"6".repeat(64)}','${"7".repeat(64)}','{}','{}','${contextHash}',
       'policy',1,'${policyHash}','${NOW}','${NOW}');
    INSERT INTO execution_operations(
      id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,
      final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES
      ('stage-op','project','execution','stage','${policyHash}',1,1,0,
       'completed',200,'{}','${NOW}','${NOW}'),
      ('other-stage-op','project','other-execution','stage','${"9".repeat(64)}',1,1,0,
       'completed',200,'{}','${NOW}','${NOW}');
    INSERT INTO execution_actions(
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,overall_deadline_at,result_json,created_at,started_at,finished_at
    ) VALUES
      ('action','project','execution','execution-attempt','stage-op',0,'stage_compute',
       'succeeded','${policyHash}','2026-08-01T08:45:00.000Z','{}','${NOW}','${NOW}','${NOW}'),
      ('other-action','project','other-execution','other-attempt','other-stage-op',0,'stage_compute',
       'succeeded','${"9".repeat(64)}','2026-08-01T08:45:00.000Z','{}','${NOW}','${NOW}','${NOW}');
    INSERT INTO execution_staged_results(
      id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
      sandbox_manifest_hash,context_hash,policy_hash,staged_hash,observed_path_count,
      observed_final_bytes,merge_file_count,merge_final_bytes,blocker_count,
      classification,block_reasons_json,created_at
    ) VALUES
      ('staged','project','execution','execution-attempt','action','${"1".repeat(64)}',
       '${"2".repeat(64)}','${contextHash}','${policyHash}','${"5".repeat(64)}',
       1,0,0,0,0,'auto_eligible','[]','${NOW}'),
      ('other-staged','project','other-execution','other-attempt','other-action',
       '${"6".repeat(64)}','${"7".repeat(64)}','${contextHash}','${policyHash}',
       '${"a".repeat(64)}',1,0,0,0,0,'auto_eligible','[]','${NOW}');
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES
      ('result','project','mission','work',1,'execution','staged','journal',NULL,'executor','${NOW}'),
      ('other-result','project','mission','other-work',1,'other-execution','other-staged',
       'other-journal',NULL,'executor','${NOW}');
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,state,version,updated_at
    ) VALUES
      ('work','project','mission','result',NULL,'pending_review',1,'${NOW}'),
      ('other-work','project','mission','other-result',NULL,'pending_review',1,'${NOW}');
  `);
  refreshExecutionFrozenFixture(seeded, "execution");
  refreshExecutionFrozenFixture(seeded, "other-execution");
  seeded.close();
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    expectedHeadVersion: 1,
    operationId,
    resultId: "result",
    reviewerAgentId: "reviewer",
    ...overrides,
  };
}

async function post(workItemId: string, value: unknown): Promise<Response> {
  return POST(new Request(`http://localhost/api/work-items/${workItemId}/reviews`, {
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
    method: "POST",
  }), { params: Promise.resolve({ workItemId }) });
}

function counts() {
  const database = openDatabase(databasePath);
  try {
    return {
      attempts: Number(database.prepare("SELECT count(*) AS n FROM review_attempts").get()!.n),
      decisions: Number(database.prepare("SELECT count(*) AS n FROM review_decisions").get()!.n),
      memories: Number(database.prepare("SELECT count(*) AS n FROM memory_entries").get()!.n),
      receipts: Number(database.prepare("SELECT count(*) AS n FROM review_operations").get()!.n),
    };
  } finally {
    database.close();
  }
}

function appendPlannedRun(threadId: string, runId: string): void {
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    const thread = database.prepare(`
      SELECT next_fact_sequence AS factSequence
      FROM collaboration_threads WHERE project_id='project' AND id=?
    `).get(threadId) as { factSequence: number };
    const project = database.prepare(`
      SELECT next_activity_sequence AS activitySequence
      FROM collaboration_project_thread_sequences WHERE project_id='project'
    `).get() as { activitySequence: number };
    database.prepare(`
      INSERT INTO collaboration_runs(
        id,project_id,thread_id,status,current_agent_id,round_count,next_event_sequence,
        version,execution_epoch,pause_reason,pause_category,created_at,updated_at
      ) VALUES (?, 'project', ?, 'planned', 'executor', 0, 1, 1, 1, NULL, NULL, ?, ?)
    `).run(runId, threadId, NOW, NOW);
    database.prepare(`
      INSERT INTO collaboration_thread_facts(
        id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
        run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
      ) VALUES (?, 'project', ?, ?, ?, 'run_linked', 'system', NULL,
        ?, NULL, NULL, NULL, ?, ?)
    `).run(
      `fact-${runId}`,
      threadId,
      thread.factSequence,
      project.activitySequence,
      runId,
      JSON.stringify({ runId }),
      NOW,
    );
    database.prepare(`
      UPDATE collaboration_threads
      SET next_fact_sequence=next_fact_sequence+1,last_activity_sequence=?,
          version=version+1,updated_at=?
      WHERE project_id='project' AND id=?
    `).run(project.activitySequence, NOW, threadId);
    database.prepare(`
      UPDATE collaboration_project_thread_sequences
      SET next_activity_sequence=next_activity_sequence+1 WHERE project_id='project'
    `).run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

async function application(): Promise<ApplicationModule> {
  const load = applicationModules["../src/server/review/review-application-service.ts"];
  expect(load, "public-input review application service must exist").toBeTypeOf("function");
  return load();
}

beforeEach(() => {
  process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 24).toString("base64url");
  const root = mkdtempSync(join(tmpdir(), "review-production-"));
  roots.push(root);
  databasePath = join(root, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  callOpenAiChat.mockReset();
  seed(databasePath);
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("public production review application", () => {
  it("strictly rejects forged internal fields with 422 and no side effects", async () => {
    const response = await post("work", body({
      attemptId: "forged",
      credential: "forged",
      frozenMaterialJson: "{}",
      providerRequest: {},
      validationContext: {},
    }));
    expect(response.status).toBe(422);
    expect(counts()).toEqual({ attempts: 0, decisions: 0, memories: 0, receipts: 0 });
    expect(callOpenAiChat).not.toHaveBeenCalled();
  });

  it("fails closed before review when the frozen execution tuple is corrupt", async () => {
    const database = openDatabase(databasePath);
    database.prepare(`
      UPDATE execution_attempts
      SET frozen_public_json=json_set(
        frozen_public_json,
        '$.facts.source.threadId',
        'other-thread'
      )
      WHERE id='execution-attempt'
    `).run();
    database.close();

    const response = await post("work", body());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "REVIEW_MATERIAL_INVALID",
        message: "公开复核材料无效",
      },
    });
    expect(counts()).toEqual({ attempts: 0, decisions: 0, memories: 0, receipts: 0 });
    expect(callOpenAiChat).not.toHaveBeenCalled();
  });

  it("fails assembly/acquire drift with the fixed 409 and zero writes", async () => {
    const { startPublicReview } = await application();
    await expect(startPublicReview(databasePath, "work", body(), {
      afterSnapshot: (database) => {
        database.prepare(
          "UPDATE work_item_review_heads SET version=version+1 WHERE work_item_id='work'",
        ).run();
      },
    })).rejects.toMatchObject({
      code: "REVIEW_CONTEXT_STALE",
      message: "复核上下文已变化，请基于最新内容重试",
      status: 409,
    });
    expect(counts()).toEqual({ attempts: 0, decisions: 0, memories: 0, receipts: 0 });
    expect(callOpenAiChat).not.toHaveBeenCalled();
  });

  it.each([
    ["reject", "rework", "rejected", 0],
    ["escalate", "waiting_owner", "escalated", 0],
    ["pass", "passed", "passed", 1],
  ] as const)("drives provider, checkpoint and atomic %s finalization", async (
    choice,
    expectedHead,
    expectedAttempt,
    expectedMemories,
  ) => {
    callOpenAiChat.mockResolvedValue(output(choice));
    const response = await post("work", body());
    expect(response.status).toBe(200);
    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(
        "SELECT state FROM work_item_review_heads WHERE work_item_id='work'",
      ).get()).toEqual({ state: expectedHead });
      expect(database.prepare("SELECT status FROM review_attempts").get())
        .toEqual({ status: expectedAttempt });
      expect(database.prepare(
        "SELECT parsed_output_hash IS NOT NULL AS checkpointed FROM review_attempts",
      ).get()).toEqual({ checkpointed: 1 });
      expect(Number(database.prepare("SELECT count(*) AS n FROM memory_entries").get()!.n))
        .toBe(expectedMemories);
      expect(database.prepare("SELECT status FROM work_items WHERE id='work'").get())
        .toEqual({ status: choice === "pass" ? "done" : "in_progress" });
    } finally {
      database.close();
    }
  });

  it("replays the canonical tuple and conflicts on non-path or path changes", async () => {
    callOpenAiChat.mockResolvedValue(output("pass"));
    const first = await post("work", body());
    const firstPayload = await first.json();
    expect(await (await post("work", body())).json()).toEqual(firstPayload);
    expect(callOpenAiChat).toHaveBeenCalledTimes(1);
    const afterReplay = counts();

    const changed = await post("work", body({ expectedHeadVersion: 2 }));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: "OPERATION_CONFLICT" } });

    const changedPath = await post("other-work", body({
      resultId: "other-result",
    }));
    expect(changedPath.status).toBe(409);
    expect(await changedPath.json()).toMatchObject({ error: { code: "OPERATION_CONFLICT" } });
    expect(callOpenAiChat).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual(afterReplay);
  });

  it("atomically restores the review head after primary and repair are both invalid", async () => {
    callOpenAiChat.mockResolvedValue(invalidOutput());

    const first = await post("work", body());
    expect(first.status).toBe(200);
    const payload = await first.json();
    expect(payload).toMatchObject({
      errorCategory: "structured_output_invalid",
      state: "failed",
    });
    expect(callOpenAiChat).toHaveBeenCalledTimes(2);

    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(`
        SELECT status,error_category AS errorCategory,finished_at IS NOT NULL AS finished,
               lease_token AS leaseToken,project_id AS projectId,mission_id AS missionId,
               work_item_id AS workItemId,result_id AS resultId,operation_id AS operationId
        FROM review_attempts
      `).get()).toMatchObject({
        errorCategory: "structured_output_invalid",
        finished: 1,
        leaseToken: expect.any(String),
        missionId: "mission",
        operationId,
        projectId: "project",
        resultId: "result",
        status: "failed",
        workItemId: "work",
      });
      expect(database.prepare(`
        SELECT kind,parent_id AS parentId,status,http_status AS httpStatus,
               request_hash AS requestHash
        FROM review_operations WHERE project_id='project' AND id=?
      `).get(operationId)).toMatchObject({
        httpStatus: 502,
        kind: "start_review",
        parentId: "work",
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        status: "completed",
      });
      expect(database.prepare(`
        SELECT project_id AS projectId,mission_id AS missionId,
               current_result_id AS currentResultId,current_attempt_id AS currentAttemptId,
               state,version
        FROM work_item_review_heads WHERE work_item_id='work'
      `).get()).toEqual({
        currentAttemptId: null,
        currentResultId: "result",
        missionId: "mission",
        projectId: "project",
        state: "pending_review",
        version: 3,
      });
      expect(database.prepare("SELECT count(*) AS n FROM review_decisions").get()).toEqual({ n: 0 });
      expect(validateCurrentDataInvariants(database)).not.toBe("SCHEMA_DATA_INVALID");
    } finally {
      database.close();
    }

    const replay = await post("work", body());
    expect(await replay.json()).toEqual(payload);
    expect(callOpenAiChat).toHaveBeenCalledTimes(2);
    expect(counts()).toEqual({ attempts: 1, decisions: 0, memories: 0, receipts: 1 });

    const reopened = openDatabase(databasePath);
    expect(reopened.prepare(`
      SELECT state,current_attempt_id AS currentAttemptId
      FROM work_item_review_heads WHERE work_item_id='work'
    `).get()).toEqual({ currentAttemptId: null, state: "pending_review" });
    reopened.close();

    const responses = await Promise.all([
      getProjects(),
      getProjectTasks(
        new Request("http://localhost/api/projects/project/tasks"),
        { params: Promise.resolve({ projectId: "project" }) },
      ),
      getProjectContext(
        new Request("http://localhost/api/projects/project/context?agentId=reviewer"),
        { params: Promise.resolve({ projectId: "project" }) },
      ),
      getReviews(
        new Request("http://localhost/api/work-items/work/reviews"),
        { params: Promise.resolve({ workItemId: "work" }) },
      ),
    ]);
    expect(responses.map((response) => response.status)).not.toContain(500);
  });

  it("keeps delivery source and hash stable after newer threads and runs exist", async () => {
    callOpenAiChat
      .mockResolvedValueOnce(output("pass"))
      .mockResolvedValueOnce(output("pass", "other-result"));
    expect((await post("work", body())).status).toBe(200);
    const otherReview = await post("other-work", body({
      operationId: "24000000-0000-4000-8000-000000000009",
      resultId: "other-result",
    }));
    expect(await otherReview.json()).toMatchObject({ state: "passed" });
    const first = await generatePublicDelivery(databasePath, "mission", {
      expectedHeadVersion: 1,
      operationId: "24000000-0000-4000-8000-000000000010",
    });
    const database = openDatabase(databasePath);
    const source = database.prepare(`
      SELECT source_collaboration_thread_id AS threadId,
             source_collaboration_run_id AS runId
      FROM executions WHERE id='execution'
    `).get() as { runId: string; threadId: string };
    database.close();

    const newerThread = createThread(databasePath, "project", {
      memberAgentIds: ["executor", "reviewer"],
      operationId: "24000000-0000-4000-8000-000000000011",
      title: "Newer delivery-irrelevant thread",
    }).body.thread.id;
    appendPlannedRun(newerThread, "newer-other-thread-run");
    appendPlannedRun(source.threadId, "newer-source-thread-run");

    const reset = openDatabase(databasePath);
    reset.prepare(`
      UPDATE mission_delivery_heads
      SET state='ongoing',current_delivery_id=NULL,version=version+1
      WHERE mission_id='mission'
    `).run();
    const retryVersion = Number(reset.prepare(`
      SELECT version FROM mission_delivery_heads WHERE mission_id='mission'
    `).get()!.version);
    reset.close();
    const second = await generatePublicDelivery(databasePath, "mission", {
      expectedHeadVersion: retryVersion,
      operationId: "24000000-0000-4000-8000-000000000012",
    });

    expect(second.delivery.id).toBe(first.delivery.id);
    expect(second.delivery.bundle.inputFingerprint)
      .toBe(first.delivery.bundle.inputFingerprint);
    expect(second.delivery.bundle.summary.tasks.find(
      (task) => task.execution.id === "execution",
    )!.execution).toEqual({
      id: "execution",
      sourceCollaborationRunId: source.runId,
      sourceCollaborationThreadId: source.threadId,
      sourceHref: `/projects/project?thread=${source.threadId}&run=${source.runId}`,
    });
    const delivered = openDatabase(databasePath);
    expect(delivered.prepare("SELECT count(*) AS count FROM mission_deliveries").get())
      .toEqual({ count: 1 });
    delivered.close();
  });

  it.each([
    ["threadId", "cross-thread"],
    ["runId", "cross-run"],
    ["projectId", "cross-project"],
  ] as const)("rejects corrupt review source %s before writing a delivery", async (
    field,
    corruptValue,
  ) => {
    callOpenAiChat
      .mockResolvedValueOnce(output("pass"))
      .mockResolvedValueOnce(output("pass", "other-result"));
    expect((await post("work", body())).status).toBe(200);
    const otherReview = await post("other-work", body({
      operationId: "24000000-0000-4000-8000-000000000014",
      resultId: "other-result",
    }));
    expect(await otherReview.json()).toMatchObject({ state: "passed" });
    const database = openDatabase(databasePath);
    database.exec("DROP TRIGGER review_attempt_terminal_no_update");
    database.prepare(`
      UPDATE review_attempts
      SET frozen_material_json=json_set(
        frozen_material_json,
        ?,
        ?
      )
      WHERE operation_id=?
    `).run(`$.result.source.${field}`, corruptValue, operationId);

    expect(() => buildDeliveryInput(database, "mission")).toThrowError(expect.objectContaining({
      code: "DELIVERY_INVARIANT_FAILED",
      message: expect.not.stringContaining(corruptValue),
    }));
    expect(database.prepare("SELECT count(*) AS count FROM mission_deliveries").get())
      .toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT count(*) AS count FROM review_operations WHERE kind='generate_delivery'
    `).get()).toEqual({ count: 0 });
    database.close();
  });

  it("uses the backfilled execution tuple for migrated legacy frozen envelopes", async () => {
    callOpenAiChat
      .mockResolvedValueOnce(output("pass"))
      .mockResolvedValueOnce(output("pass", "other-result"));
    expect((await post("work", body())).status).toBe(200);
    expect((await post("other-work", body({
      operationId: "24000000-0000-4000-8000-000000000015",
      resultId: "other-result",
    }))).status).toBe(200);
    const database = openDatabase(databasePath);
    database.prepare(`
      UPDATE execution_attempts
      SET frozen_public_json=json_remove(frozen_public_json,'$.facts.source'),
          frozen_private_json=json_remove(frozen_private_json,'$.facts.source')
      WHERE execution_id IN ('execution','other-execution')
    `).run();

    const assembled = buildDeliveryInput(database, "mission");
    const execution = assembled.input.tasks.find(
      (task) => task.execution.id === "execution",
    )!.execution;
    const source = database.prepare(`
      SELECT source_collaboration_thread_id AS threadId,
             source_collaboration_run_id AS runId
      FROM executions WHERE id='execution'
    `).get() as { runId: string; threadId: string };
    expect(execution).toMatchObject({
      sourceCollaborationRunId: source.runId,
      sourceCollaborationThreadId: source.threadId,
      sourceHref: `/projects/project?thread=${source.threadId}&run=${source.runId}`,
    });
    database.close();
  });
});
