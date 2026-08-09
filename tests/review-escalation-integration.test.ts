import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getAttempt } from "@/app/api/reviews/[attemptId]/route";
import {
  POST as startReview,
} from "@/app/api/work-items/[workItemId]/reviews/route";
import { GET as getWorkspace } from "@/app/api/work-items/[workItemId]/review/route";
import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import type { ModelCallResult } from "@/src/shared/collaboration-contracts";
import { refreshExecutionFrozenFixture } from "@/tests/fixtures/execution/frozen-input";

type AnswerRoute = {
  POST(request: Request, context: {
    params: Promise<{ escalationId: string }>;
  }): Promise<Response>;
};

const answerRoutes = import.meta.glob<AnswerRoute>(
  "../app/api/escalations/[escalationId]/answer/route.ts",
);
const callOpenAiChat = vi.hoisted(() => vi.fn());
vi.mock("@/src/server/collaboration/openai-chat-client", async (load) => ({
  ...await load<typeof import("@/src/server/collaboration/openai-chat-client")>(),
  callOpenAiChat,
}));
vi.mock("@/src/adapters/outbound/sqlite/connection", async (load) => {
  const actual = await load<typeof import("@/src/adapters/outbound/sqlite/connection")>();
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

const NOW = "2026-08-01T10:00:00.000Z";
let root: string;
let databasePath: string;

function escalateOutput(round: number): ModelCallResult {
  return {
    content: JSON.stringify({
      decision: {
        choice: "escalate",
        options: ["继续复核", "返工", "终止使命"],
        question: `第 ${round} 轮需要 Owner 补充`,
      },
      evidenceRefs: [{ id: "result", type: "result", version: "1" }],
      findings: [],
      limitations: [],
      memoryCandidates: [],
      publicSummary: `第 ${round} 轮升级`,
    }),
    error: null,
    httpStatus: 200,
    status: "succeeded",
    usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 },
    usageReported: true,
  };
}

function rejectOutput(): ModelCallResult {
  return {
    content: JSON.stringify({
      decision: { choice: "reject", reworkRequirements: ["根据 Owner 回答返工"] },
      evidenceRefs: [{ id: "result", type: "result", version: "1" }],
      findings: [],
      limitations: [],
      memoryCandidates: [],
      publicSummary: "两轮回答已完整进入冻结材料",
    }),
    error: null,
    httpStatus: 200,
    status: "succeeded",
    usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 },
    usageReported: true,
  };
}

function seed(): void {
  const database = openDatabase(databasePath);
  const envelope = createCredentialVault().encrypt("provider", "server-secret");
  database.exec("PRAGMA foreign_keys=OFF");
  database.prepare(`
    INSERT INTO projects(id,name,created_at,version)
    VALUES ('project','Escalation integration',?,1)
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
    ) VALUES ('work','mission','Work','Do work','in_progress','executor',1,'${NOW}','${NOW}');
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,1,1,'${NOW}');
  `);
  database.exec("PRAGMA foreign_keys=ON");
  database.close();
  const threadId = createThread(databasePath, "project", {
    memberAgentIds: ["executor", "reviewer"],
    operationId: "25000000-0000-4000-8000-000000000000",
    title: "Escalation source",
  }).body.thread.id;
  const seeded = openDatabase(databasePath);
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
    ) VALUES ('execution','project','${threadId}','run','mission','work','executor','policy',
      'merged',NULL,NULL,0,NULL,1,0,0,1,1,'${NOW}',NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO execution_attempts(
      id,project_id,execution_id,attempt_no,status,sandbox_root,baseline_manifest_path,
      sandbox_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,started_at,finished_at
    ) VALUES ('execution-attempt','project','execution',1,'completed','sandbox',NULL,NULL,
      '${"1".repeat(64)}','${"2".repeat(64)}','{}','{}','${contextHash}',
      'policy',1,'${policyHash}','${NOW}','${NOW}');
    INSERT INTO execution_operations(
      id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,
      final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES ('stage-op','project','execution','stage','${policyHash}',1,1,0,
      'completed',200,'{}','${NOW}','${NOW}');
    INSERT INTO execution_actions(
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,overall_deadline_at,result_json,created_at,started_at,finished_at
    ) VALUES ('action','project','execution','execution-attempt','stage-op',0,'stage_compute',
      'succeeded','${policyHash}','2026-08-01T10:15:00.000Z','{}','${NOW}','${NOW}','${NOW}');
    INSERT INTO execution_staged_results(
      id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
      sandbox_manifest_hash,context_hash,policy_hash,staged_hash,observed_path_count,
      observed_final_bytes,merge_file_count,merge_final_bytes,blocker_count,
      classification,block_reasons_json,created_at
    ) VALUES ('staged','project','execution','execution-attempt','action',
      '${"1".repeat(64)}','${"2".repeat(64)}','${contextHash}','${policyHash}',
      '${"5".repeat(64)}',1,0,0,0,0,'auto_eligible','[]','${NOW}');
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES ('result','project','mission','work',1,'execution','staged','journal',
      NULL,'executor','${NOW}');
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
      state,version,updated_at
    ) VALUES ('work','project','mission','result',NULL,'pending_review',1,'${NOW}');
  `);
  refreshExecutionFrozenFixture(seeded, "execution");
  seeded.close();
}

async function answerRoute(): Promise<AnswerRoute> {
  const load = answerRoutes[
    "../app/api/escalations/[escalationId]/answer/route.ts"
  ];
  expect(load, "strict escalation answer route must exist").toBeTypeOf("function");
  return load!();
}

async function review(operationId: string, expectedHeadVersion: number) {
  const response = await startReview(new Request(
    "http://localhost/api/work-items/work/reviews",
    {
      body: JSON.stringify({
        expectedHeadVersion,
        operationId,
        resultId: "result",
        reviewerAgentId: "reviewer",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  ), { params: Promise.resolve({ workItemId: "work" }) });
  const payload = await response.json() as {
    attemptId: string;
    escalationId?: string;
    state: string;
  } & Record<string, unknown>;
  expect(response.status, JSON.stringify(payload)).toBe(200);
  return payload;
}

async function answer(
  escalationId: string,
  operationId: string,
  expectedHeadVersion: number,
  action: "continue_review" | "rework" | "terminate_mission" = "continue_review",
) {
  const { POST } = await answerRoute();
  const response = await POST(new Request(
    `http://localhost/api/escalations/${escalationId}/answer`,
    {
      body: JSON.stringify({
        action,
        answer: `Owner answer for ${operationId}`,
        expectedHeadVersion,
        operationId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  ), { params: Promise.resolve({ escalationId }) });
  return response;
}

async function workspace() {
  const response = await getWorkspace(
    new Request("http://localhost/api/work-items/work/review"),
    { params: Promise.resolve({ workItemId: "work" }) },
  );
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return response.json() as Promise<Record<string, any>>;
}

async function detail(attemptId: string) {
  const response = await getAttempt(
    new Request(`http://localhost/api/reviews/${attemptId}`),
    { params: Promise.resolve({ attemptId }) },
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, any>>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "review-escalation-integration-"));
  databasePath = join(root, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 26).toString("base64url");
  callOpenAiChat.mockReset();
  seed();
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(root, { force: true, recursive: true });
});

describe("escalation answer production chain", () => {
  it("keeps the open issue bound to its immutable escalated attempt when currentAttempt is null", async () => {
    callOpenAiChat.mockResolvedValue(escalateOutput(1));
    const first = await review("26000000-0000-4000-8000-000000000101", 1);
    expect(first.state).toBe("escalated");

    const current = await workspace();
    expect(current).toMatchObject({
      answeredEscalations: [],
      currentAttempt: null,
      currentEscalation: {
        attemptId: first.attemptId,
        escalationId: first.escalationId,
        resultId: "result",
      },
      effectiveStatus: "waiting_owner",
    });
    expect((await detail(first.attemptId)).currentEscalation).toEqual(
      current.currentEscalation,
    );
  });

  it("preserves two continue answers in stable workspace and frozen-material order across reopen", async () => {
    callOpenAiChat
      .mockResolvedValueOnce(escalateOutput(1))
      .mockResolvedValueOnce(escalateOutput(2))
      .mockResolvedValueOnce(rejectOutput());

    const first = await review("26000000-0000-4000-8000-000000000111", 1);
    const firstOpenVersion = Number((await workspace()).headVersion);
    const firstAnswer = await answer(
      first.escalationId!,
      "26000000-0000-4000-8000-000000000112",
      firstOpenVersion,
    );
    expect(firstAnswer.status).toBe(200);
    const replay = await answer(
      first.escalationId!,
      "26000000-0000-4000-8000-000000000112",
      firstOpenVersion,
    );
    expect(await replay.json()).toEqual(await firstAnswer.clone().json());

    const secondReadyVersion = Number((await workspace()).headVersion);
    const second = await review(
      "26000000-0000-4000-8000-000000000113",
      secondReadyVersion,
    );
    expect(second.attemptId).not.toBe(first.attemptId);
    const secondOpenVersion = Number((await workspace()).headVersion);
    const secondAnswer = await answer(
      second.escalationId!,
      "26000000-0000-4000-8000-000000000114",
      secondOpenVersion,
    );
    expect(secondAnswer.status).toBe(200);
    const thirdReadyVersion = Number((await workspace()).headVersion);
    const third = await review(
      "26000000-0000-4000-8000-000000000115",
      thirdReadyVersion,
    );
    expect(new Set([first.attemptId, second.attemptId, third.attemptId]).size).toBe(3);

    const firstDetail = await detail(first.attemptId);
    const secondDetail = await detail(second.attemptId);
    const thirdDetail = await detail(third.attemptId);
    expect(firstDetail.answeredEscalations).toHaveLength(1);
    expect(firstDetail.currentEscalation).toBeNull();
    expect(secondDetail.answeredEscalations).toHaveLength(1);
    expect(secondDetail.currentEscalation).toBeNull();
    expect(thirdDetail.answeredEscalations).toEqual([]);
    expect(thirdDetail.frozenMaterial.ownerAnswers).toHaveLength(2);
    expect(thirdDetail.frozenMaterial.ownerAnswers.map(
      (item: Record<string, unknown>) => item.escalationId,
    )).toEqual([first.escalationId, second.escalationId]);
    expect(new Set([
      firstDetail.material.hash,
      secondDetail.material.hash,
      thirdDetail.material.hash,
    ]).size).toBe(3);

    const refreshed = await workspace();
    expect(refreshed.answeredEscalations.map(
      (item: Record<string, unknown>) => item.escalationId,
    )).toEqual([first.escalationId, second.escalationId]);
    const reopened = openDatabase(databasePath);
    reopened.close();
    expect((await workspace()).answeredEscalations).toEqual(
      refreshed.answeredEscalations,
    );
  });

  it.each([
    ["rework", "rework", "new_execution_result"],
    ["terminate_mission", "waiting_owner", "mission_terminated"],
  ] as const)("applies %s atomically and emits canonical events", async (
    action,
    expectedHead,
    expectedNext,
  ) => {
    callOpenAiChat.mockResolvedValue(escalateOutput(1));
    const first = await review("26000000-0000-4000-8000-000000000121", 1);
    const openVersion = Number((await workspace()).headVersion);
    const response = await answer(
      first.escalationId!,
      action === "rework"
        ? "26000000-0000-4000-8000-000000000122"
        : "26000000-0000-4000-8000-000000000123",
      openVersion,
      action,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      answer: { action, next: expectedNext },
      workspace: { effectiveStatus: expectedHead },
    });
    const database = openDatabase(databasePath);
    try {
      const events = database.prepare(`
        SELECT type,payload_json AS payload FROM review_events
        WHERE type IN ('escalation_answered','mission_terminated')
        ORDER BY sequence
      `).all() as Array<{ payload: string; type: string }>;
      expect(events.map(({ type }) => type)).toEqual(action === "terminate_mission"
        ? ["escalation_answered", "mission_terminated"]
        : ["escalation_answered"]);
      expect(JSON.parse(events[0]!.payload)).toEqual({
        action,
        answerId: expect.any(String),
        escalationId: first.escalationId,
      });
      expect(database.prepare(
        "SELECT count(*) AS count FROM review_decisions WHERE choice='pass'",
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
