

import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { heartbeatExecutionAction } from "@/src/adapters/outbound/sqlite/safe-execution/execution-actions";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type Permissions = { read: boolean; write: boolean; execute: boolean };
type ExecuteInput = {
  actionId: string;
  businessRound: number;
  database: DatabaseSync;
  leaseToken: string;
  permissions: Permissions;
  projectId: string;
  request: {
    apiKey: string;
    baseUrl: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    model: string;
  };
  context: { attemptId: string; correlationId: string; runId: string };
};
type StructuredModule = {
  executeStructuredExecutionAction(input: ExecuteInput): Promise<{
    status: "completed" | "paused" | "provider_failed" | "lease_lost";
    action: { summary: string; action: { type: string } } | null;
    pauseCategory: "structured_output_invalid" | "permission_denied" | null;
    calls: Array<{
      callIndex: 1 | 2;
      kind: "primary" | "repair";
      usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
    }>;
  }>;
};

const modules = import.meta.glob<StructuredModule>(
  "../../../src/adapters/outbound/sqlite/safe-execution/execution-structured-repair.ts",
);
const PROJECT_ID = "structured-project";
const EXECUTION_ID = "structured-execution";
const ATTEMPT_ID = "structured-attempt";
const ACTION_ID = "structured-model-action";
const OPERATION_ID = "00000000-0000-4000-8000-000000000014";
const LEASE_TOKEN = "structured-lease";
const hash = "a".repeat(64);
const request = {
  apiKey: "provider-secret",
  baseUrl: "https://provider.example/v1",
  messages: [
    { role: "system" as const, content: "PRIVATE EXECUTION CONTEXT" },
    { role: "user" as const, content: "Implement the task." },
  ],
  model: "test-model",
};
const context = {
  attemptId: ATTEMPT_ID,
  correlationId: "correlation-14",
  runId: "run",
};
const permissions = { read: true, write: true, execute: true };

let database: DatabaseSync;
let structured: StructuredModule;

function providerResponse(content: string, promptTokens: number, completionTokens: number): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function validAction(type: "list" | "staged" = "list"): string {
  return JSON.stringify({
    summary: "Visible execution summary.",
    action: type === "list" ? { type: "list", path: "." } : { type: "staged" },
  });
}

async function loadModule(): Promise<StructuredModule> {
  const load = modules["../../../src/adapters/outbound/sqlite/safe-execution/execution-structured-repair.ts"];
  expect(load, "the execution structured repair executor must exist").toBeTypeOf("function");
  return load();
}

function seedDatabase(path: string): DatabaseSync {
  const threadId = seedV7AdvanceFixture(path, {
    agentId: "agent",
    agentPrompt: "private",
    missionId: "mission",
    now: "2026-08-08T09:00:00.000Z",
    ownerMessage: "Implement the task.",
    projectId: PROJECT_ID,
    projectName: "Structured",
    providerId: "provider",
    runId: "run",
    secondAgentId: "agent-reviewer",
    secondAgentPrompt: "private reviewer",
    threadCreateOperationId: "00000000-0000-4000-8000-000000000013",
  });
  const seeded = openDatabase(path);
  seeded.exec(`
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at,
      lease_token,lease_expires_at,last_heartbeat_at
    ) VALUES ('work','mission','Work','','in_progress','agent',1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      'work-lease','2099-01-01T00:00:00.000Z',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    UPDATE collaboration_runs
    SET status='planned',round_count=1
    WHERE project_id='${PROJECT_ID}' AND id='run';
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES ('policy','${PROJECT_ID}',NULL,'system',1,
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      1,0,2,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
    VALUES ('${PROJECT_ID}','policy',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO executions (
      id,project_id,source_collaboration_thread_id,source_collaboration_run_id,
      mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES (
      '${EXECUTION_ID}','${PROJECT_ID}','${threadId}','run',
      'mission','work','agent','policy',
      'running',NULL,NULL,0,NULL,1,0,0,1,1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+900 seconds'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL
    );
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES (
      '${ATTEMPT_ID}','${PROJECT_ID}','${EXECUTION_ID}',1,'acting','D:\\sandbox',
      NULL,NULL,NULL,'{}','{}','${"c".repeat(64)}','policy',1,'${"d".repeat(64)}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL
    );
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,
      action_count,final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES (
      '${OPERATION_ID}','${PROJECT_ID}','${EXECUTION_ID}','advance','${hash}',
      1,1,NULL,'pending',NULL,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    );
    INSERT INTO execution_actions (
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,lease_token,lease_expires_at,overall_deadline_at,last_heartbeat_at,
      result_json,error_code,created_at,started_at,finished_at
    ) VALUES (
      '${ACTION_ID}','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}','${OPERATION_ID}',
      0,'model','running','${hash}','${LEASE_TOKEN}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+900 seconds'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL
    );
  `);
  return seeded;
}

function execute(overrides: Partial<ExecuteInput> = {}) {
  return structured.executeStructuredExecutionAction({
    actionId: ACTION_ID,
    businessRound: 1,
    database,
    leaseToken: LEASE_TOKEN,
    permissions,
    projectId: PROJECT_ID,
    request,
    context,
    ...overrides,
  });
}

function modelCalls(): Array<Record<string, unknown>> {
  return database.prepare(`
    SELECT action_id AS actionId,business_round AS businessRound,kind,
           call_index AS callIndex,status,prompt_tokens AS promptTokens,
           completion_tokens AS completionTokens,total_tokens AS totalTokens,
           call_started_at AS callStartedAt,call_deadline_at AS callDeadlineAt
    FROM execution_model_calls ORDER BY call_index
  `).all() as Array<Record<string, unknown>>;
}

beforeEach(async () => {
  database = seedDatabase(memoryDatabasePath());
  structured = await loadModule();
});

afterEach(() => {
  vi.unstubAllGlobals();
  database.close();
});

describe("execution primary and one structured repair", () => {
  it("persists one valid primary call and advances one business round", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(validAction(), 7, 3));
    vi.stubGlobal("fetch", fetchMock);

    await expect(execute()).resolves.toMatchObject({
      status: "completed",
      action: { summary: "Visible execution summary.", action: { type: "list" } },
      pauseCategory: null,
      calls: [{
        callIndex: 1,
        kind: "primary",
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(modelCalls()).toMatchObject([{
      actionId: ACTION_ID,
      businessRound: 1,
      callIndex: 1,
      kind: "primary",
      status: "succeeded",
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    }]);
    expect(database.prepare(
      "SELECT business_round_count AS rounds FROM executions WHERE id=?",
    ).get(EXECUTION_ID)).toEqual({ rounds: 1 });
  });

  it("uses the same child for one repair, stores both usage facts, and sends only invalid content plus schema", async () => {
    const invalid = '{"summary":"bad","action":{"type":"list"}}';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(providerResponse(invalid, 5, 2))
      .mockResolvedValueOnce(providerResponse(validAction("staged"), 11, 4));
    vi.stubGlobal("fetch", fetchMock);

    await expect(execute()).resolves.toMatchObject({
      status: "completed",
      action: { action: { type: "staged" } },
      calls: [
        { callIndex: 1, kind: "primary", usage: { totalTokens: 7 } },
        { callIndex: 2, kind: "repair", usage: { totalTokens: 15 } },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(repairBody.messages).toHaveLength(2);
    expect(repairBody.messages.map(({ content }) => content).join("\n")).toContain(invalid);
    expect(JSON.stringify(repairBody.messages)).toMatch(/schema|strict|JSON/i);
    expect(JSON.stringify(repairBody.messages)).not.toContain("PRIVATE EXECUTION CONTEXT");
    expect(JSON.stringify(repairBody.messages)).not.toContain("Implement the task.");

    const calls = modelCalls();
    expect(calls).toHaveLength(2);
    expect(calls.map(({ actionId, businessRound, callIndex, kind, status, totalTokens }) => ({
      actionId, businessRound, callIndex, kind, status, totalTokens,
    }))).toEqual([
      { actionId: ACTION_ID, businessRound: 1, callIndex: 1, kind: "primary", status: "response_invalid", totalTokens: 7 },
      { actionId: ACTION_ID, businessRound: 1, callIndex: 2, kind: "repair", status: "succeeded", totalTokens: 15 },
    ]);
    for (const call of calls) {
      expect(Date.parse(String(call.callDeadlineAt)) - Date.parse(String(call.callStartedAt))).toBe(90_000);
    }
    expect(database.prepare(
      "SELECT business_round_count AS rounds FROM executions WHERE id=?",
    ).get(EXECUTION_ID)).toEqual({ rounds: 1 });
  });

  it("allows only call indexes one and two and rejects a duplicate for the same action", () => {
    const insert = database.prepare(`
      INSERT INTO execution_model_calls (
        id,project_id,execution_id,attempt_id,action_id,business_round,kind,call_index,
        status,prompt_hash,prompt_tokens,completion_tokens,total_tokens,error_category,
        call_started_at,call_deadline_at,finished_at,created_at
      ) VALUES (?,?,?,?,?,?,?,?,'calling',?,NULL,NULL,NULL,NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 seconds'),NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `);
    const values = (id: string, kind: string, index: number) => [
      id, PROJECT_ID, EXECUTION_ID, ATTEMPT_ID, ACTION_ID, 1, kind, index, hash,
    ];
    expect(() => insert.run(...values("call-1", "primary", 1))).not.toThrow();
    expect(() => insert.run(...values("call-2", "repair", 2))).not.toThrow();
    expect(() => insert.run(...values("duplicate", "primary", 1))).toThrow();
    expect(() => insert.run(...values("call-3", "repair", 3))).toThrow();
  });

  it("renews only the 120 second lease while preserving call, action, and business deadlines", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));
    const pending = execute();
    await new Promise((resolve) => setImmediate(resolve));

    const before = database.prepare(`
      SELECT a.lease_expires_at AS leaseDeadline,a.overall_deadline_at AS actionDeadline,
             e.business_deadline_at AS businessDeadline,c.call_deadline_at AS callDeadline
      FROM execution_actions a
      JOIN executions e ON e.id=a.execution_id
      JOIN execution_model_calls c ON c.action_id=a.id AND c.call_index=1
      WHERE a.id=?
    `).get(ACTION_ID) as Record<string, string>;
    expect(heartbeatExecutionAction(database, {
      actionId: ACTION_ID,
      leaseToken: LEASE_TOKEN,
      projectId: PROJECT_ID,
    })).toEqual({ affectedRows: 1 });
    const after = database.prepare(`
      SELECT a.lease_expires_at AS leaseDeadline,a.overall_deadline_at AS actionDeadline,
             e.business_deadline_at AS businessDeadline,c.call_deadline_at AS callDeadline
      FROM execution_actions a
      JOIN executions e ON e.id=a.execution_id
      JOIN execution_model_calls c ON c.action_id=a.id AND c.call_index=1
      WHERE a.id=?
    `).get(ACTION_ID) as Record<string, string>;
    expect(after.actionDeadline).toBe(before.actionDeadline);
    expect(after.businessDeadline).toBe(before.businessDeadline);
    expect(after.callDeadline).toBe(before.callDeadline);
    expect(after.leaseDeadline >= before.leaseDeadline).toBe(true);

    resolveFetch(providerResponse(validAction(), 1, 1));
    await expect(pending).resolves.toMatchObject({ status: "completed" });
  });

  it("pauses after a second invalid response without creating a tool or staged fact", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(providerResponse('{"summary":"invalid"}', 3, 2))
      .mockResolvedValueOnce(providerResponse('{"summary":"still invalid","action":{"type":"other"}}', 4, 2));
    vi.stubGlobal("fetch", fetchMock);

    await expect(execute()).resolves.toMatchObject({
      status: "paused",
      action: null,
      pauseCategory: "structured_output_invalid",
      calls: [{ kind: "primary" }, { kind: "repair" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(database.prepare(
      "SELECT status,reason_code AS reasonCode,business_round_count AS rounds FROM executions WHERE id=?",
    ).get(EXECUTION_ID)).toEqual({
      status: "paused",
      reasonCode: "STRUCTURED_OUTPUT_INVALID",
      rounds: 1,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM execution_tool_calls").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM execution_staged_results").get()).toEqual({ count: 0 });
    expect(JSON.stringify(modelCalls())).not.toContain('still invalid');
  });

  it("does not repair a structurally valid action that lacks its Agent permission", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(validAction(), 2, 1));
    vi.stubGlobal("fetch", fetchMock);

    await expect(execute({
      permissions: { read: false, write: true, execute: true },
    })).resolves.toMatchObject({
      status: "paused",
      action: null,
      pauseCategory: "permission_denied",
      calls: [{ kind: "primary" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(database.prepare(
      "SELECT status,reason_code AS reasonCode FROM executions WHERE id=?",
    ).get(EXECUTION_ID)).toEqual({
      status: "paused",
      reasonCode: "READ_PERMISSION_REQUIRED",
    });
  });
});
