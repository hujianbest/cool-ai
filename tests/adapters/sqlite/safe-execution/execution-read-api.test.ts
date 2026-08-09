import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  createBoundedUtf8Text,
  persistArtifactOutput,
} from "@/src/adapters/outbound/sqlite/safe-execution/stage-service";
import {
  executionEventDtoSchema,
  executionEventTypeSchema,
} from "@/src/shared/execution-contracts";
import {
  assertV7Fixture,
  execV7Fixture,
} from "@/tests/fixtures/execution/current-graph";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type ReadModule = typeof import("@/src/adapters/outbound/sqlite/safe-execution/execution-read-service");
type GetRoute = {
  GET(
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<GetRoute>([
  "../../../../app/api/executions/[executionId]/route.ts",
  "../../../../app/api/executions/[executionId]/events/route.ts",
]);

const NOW = "2026-07-30T08:00:00.000Z";
const PROJECT_ID = "read-project";
const EXECUTION_ID = "read-execution";
const ATTEMPT_ID = "read-attempt";
const STAGED_ID = "read-staged";
const HASH = "a".repeat(64);
const POLICY_HASH =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

const expectedPersistedEventTypes = [
  "action_finished",
  "action_queued",
  "action_reconciled",
  "action_started",
  "approval_consumed",
  "approval_decided",
  "approval_requested",
  "attempt_interrupted",
  "attempt_started",
  "boundary_paused",
  "conflict_detected",
  "control_applied",
  "execution_created",
  "manual_recovery_required",
  "manual_recovery_resolved",
  "merge_prepared",
  "merge_recovered",
  "merged",
  "model_call_failed",
  "model_call_started",
  "model_call_succeeded",
  "operation_replayed",
  "sandbox_preflight",
  "sandbox_ready",
  "staged_created",
  "stale_detected",
  "status_changed",
  "tool_failed",
  "tool_rejected",
  "tool_requested",
  "tool_succeeded",
  "usage_recorded",
  "validation_recorded",
] as const;

const persistedEventFixtures = [
  ["execution_created", { agentId: "read-agent", attemptNo: 1, workItemId: "read-work" }],
  ["sandbox_preflight", { copiedBytes: 128, excludedCount: 2, itemCount: 4 }],
  ["sandbox_ready", { manifestHash: HASH }],
  ["action_queued", {
    actionId: "read-action",
    actionIndex: 0,
    attemptNo: 1,
    kind: "sandbox_build",
    operationId: "26000000-0000-4000-8000-000000000001",
    overallDeadlineAt: "2026-07-30T08:15:00.000Z",
  }],
  ["attempt_started", { attemptNo: 2 }],
  ["action_started", {
    actionId: "read-action",
    actionIndex: 0,
    attemptNo: 1,
    kind: "sandbox_build",
    operationId: "26000000-0000-4000-8000-000000000001",
    overallDeadlineAt: "2026-07-30T08:15:00.000Z",
  }],
  ["action_finished", {
    actionId: "read-action",
    actionIndex: 0,
    code: "MERGED",
    kind: "merge_apply",
    operationId: "26000000-0000-4000-8000-000000000001",
    status: "succeeded",
  }],
  ["action_reconciled", {
    actionId: "read-action",
    actionIndex: 0,
    kind: "command",
    operationId: "26000000-0000-4000-8000-000000000001",
    resumeTarget: null,
  }],
  ["status_changed", { from: "running", reasonCode: null, to: "staged" }],
  ["attempt_interrupted", { attemptNo: 2, kind: "model" }],
  ["model_call_started", {
    attemptNo: 2,
    kind: "primary",
    modelCallId: "model-call-started",
    round: 1,
  }],
  ["model_call_succeeded", {
    attemptNo: 2,
    kind: "primary",
    modelCallId: "model-call-succeeded",
    round: 1,
  }],
  ["model_call_failed", {
    attemptNo: 2,
    category: "provider_unavailable",
    kind: "repair",
    modelCallId: "model-call-failed",
    round: 2,
  }],
  ["usage_recorded", {
    agentId: "read-agent",
    completionTokens: 3,
    modelCallId: "model-call",
    promptTokens: 2,
    reported: true,
    totalTokens: 5,
  }],
  ["boundary_paused", { agentId: "read-agent", boundary: "tokens", limit: 10, value: 11 }],
  ["tool_requested", {
    requestSummary: { authorization: "one_shot", requestHash: HASH },
    toolCallId: "tool-call",
    type: "command",
  }],
  ["tool_succeeded", {
    afterHash: null,
    beforeHash: null,
    resultSummary: { entryCount: 1, path: ".", totalObserved: 1, truncated: false },
    toolCallId: "tool-call",
    type: "list",
  }],
  ["tool_rejected", {
    guardCode: "COMMAND_APPROVAL_REQUIRED",
    recovery: "request_approval",
    toolCallId: "tool-call-rejected",
    type: "command",
  }],
  ["tool_failed", { code: "SANDBOX_UNVERIFIABLE", toolCallId: "tool-call", type: "read" }],
  ["approval_requested", {
    approvalId: "approval",
    kind: "command",
    requestHash: HASH,
    riskReasons: ["unlisted"],
  }],
  ["approval_decided", {
    action: "approve",
    approvalId: "approval",
    authorizationSource: "one_shot",
    kind: "command",
    status: "approved",
  }],
  ["approval_consumed", { approvalId: "approval" }],
  ["validation_recorded", {
    exitCode: 0,
    policyEntryId: "policy-entry",
    required: true,
    sandboxManifestHash: HASH,
    succeeded: true,
    truncated: false,
    validationId: "validation",
  }],
  ["staged_created", {
    blockReasons: [],
    blockerCount: 0,
    classification: "auto_eligible",
    mergeFileCount: 2,
    mergeFinalBytes: 256,
    observedFinalBytes: 512,
    observedPathCount: 3,
    stagedHash: HASH,
    stagedId: STAGED_ID,
  }],
  ["stale_detected", { categories: ["external_workspace"], pathCount: 1 }],
  ["conflict_detected", { otherExecutionIds: ["other-execution"], pathCount: 1 }],
  ["control_applied", { action: "pause" }],
  ["merge_prepared", { journalId: "journal", mergeFileCount: 2, stagedHash: HASH }],
  ["merge_recovered", { direction: "roll_forward", journalId: "journal" }],
  ["merged", { journalId: "journal", resultId: "result", stagedHash: HASH }],
  ["manual_recovery_required", {
    journalId: "journal",
    mismatchPhase: "apply",
    observedManifestHash: HASH,
    oldManifestHash: HASH,
    pathCount: 2,
    postManifestHash: HASH,
  }],
  ["manual_recovery_resolved", {
    journalId: "journal",
    resolution: "recovered_new",
    uncleanedOwnedPathCount: 0,
  }],
  ["operation_replayed", {
    kind: "stage",
    operationId: "26000000-0000-4000-8000-000000000001",
  }],
] as const;

let databasePath: string;
let database: DatabaseSync;
let reads: ReadModule;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function seed(): void {
  execV7Fixture(databasePath, database, `
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Read project','${NOW}','D:\\canonical-secret','d:/canonical-secret',1);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'read-provider','Provider','http://provider.invalid/v1','model',
      'cipher-secret','iv-secret','tag-secret',1,1,'key-secret','***','${NOW}',
      1,'${NOW}','${NOW}'
    );
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES (
      'read-agent','Reader','Builder','private-chain-of-thought-secret','read-provider',
      'model','R','sage',1,1,1,1000,5,7,'${NOW}','${NOW}'
    );
    INSERT INTO project_memberships (project_id,agent_id,joined_at)
    VALUES ('${PROJECT_ID}','read-agent','${NOW}');
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('read-mission','${PROJECT_ID}','Mission','Goal',3,'${NOW}','${NOW}');
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES (
      'read-work','read-mission','Read APIs','','in_progress','read-agent',2,'${NOW}','${NOW}'
    );
    INSERT INTO collaboration_runs (
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES (
      'read-run','${PROJECT_ID}','planned','read-agent',1,1,1,1,NULL,NULL,'${NOW}','${NOW}'
    );
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES (
      'read-policy','${PROJECT_ID}',NULL,'system',1,'${POLICY_HASH}',1,0,2,0,'${NOW}'
    );
    INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
    VALUES ('${PROJECT_ID}','read-policy',1,'${NOW}');
    INSERT INTO executions (
      id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES (
      '${EXECUTION_ID}','${PROJECT_ID}','read-run','read-mission','read-work','read-agent',
      'read-policy','staged',NULL,NULL,0,NULL,1,2,3,4,5,'${NOW}',
      '2026-07-30T08:15:00.000Z','${NOW}','${NOW}',NULL
    );
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES (
      '${ATTEMPT_ID}','${PROJECT_ID}','${EXECUTION_ID}',1,'ready',
      'D:\\sandbox-secret',NULL,'${HASH}','${HASH}',
      '{"fingerprintVersion":1,"facts":{"task":{"version":2},"mission":{"version":3},"sharedMemory":[],"members":[],"provider":{"id":"read-provider"},"validationPolicy":{"revisionId":"read-policy","version":1,"policyHash":"${POLICY_HASH}"},"workspaceBaselineHash":"${HASH}"}}',
      '{"fingerprintVersion":1,"facts":{"currentAgent":{"systemPrompt":"private-chain-of-thought-secret","skills":[],"permissions":{"read":true}}}}',
      '${HASH}','read-policy',1,'${POLICY_HASH}','${NOW}',NULL
    );
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,
      final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES (
      '26000000-0000-4000-8000-000000000001','${PROJECT_ID}','${EXECUTION_ID}',
      'stage','${HASH}',1,1,0,'completed',200,'{}','${NOW}','${NOW}'
    );
    INSERT INTO execution_actions (
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,lease_token,lease_expires_at,overall_deadline_at,last_heartbeat_at,
      result_json,error_code,created_at,started_at,finished_at
    ) VALUES (
      'read-action','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',
      '26000000-0000-4000-8000-000000000001',0,'stage_compute','succeeded',
      '${HASH}',NULL,NULL,'2026-07-30T08:15:00.000Z',NULL,'{}',NULL,
      '${NOW}','${NOW}','${NOW}'
    );
    INSERT INTO execution_staged_results (
      id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
      sandbox_manifest_hash,context_hash,policy_hash,staged_hash,
      observed_path_count,observed_final_bytes,merge_file_count,merge_final_bytes,
      blocker_count,classification,block_reasons_json,created_at
    ) VALUES (
      '${STAGED_ID}','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}','read-action',
      '${HASH}','${HASH}','${HASH}','${POLICY_HASH}','${HASH}',101,101,0,0,101,
      'blocked','["file_count_limit"]','${NOW}'
    );
  `, { validate: false });
  const insertObservation = database.prepare(`
    INSERT INTO execution_staged_observations (
      id,staged_result_id,position,path,path_key,kind,baseline_hash,observed_hash,
      final_size,diff_text,diff_bytes,diff_truncated
    ) VALUES (?, ?, ?, ?, ?, 'added', NULL, ?, 1, ?, ?, 0)
  `);
  const insertBlocker = database.prepare(`
    INSERT INTO execution_staged_blockers (
      staged_result_id,observation_id,position,path,kind,detail_json
    ) VALUES (?, ?, ?, ?, 'file_count_limit', ?)
  `);
  for (let position = 0; position < 101; position += 1) {
    const id = `observation-${position.toString().padStart(6, "0")}`;
    const path = `src/file-${position.toString().padStart(6, "0")}.txt`;
    const diff = position === 100 ? "界".repeat(30_000) : `+${path}`;
    insertObservation.run(
      id,
      STAGED_ID,
      position,
      path,
      path,
      sha256(path),
      diff,
      Buffer.byteLength(diff, "utf8"),
    );
    insertBlocker.run(
      STAGED_ID,
      id,
      position,
      path,
      JSON.stringify({ detailCode: "FILE_COUNT_LIMIT", secondaryCodes: [] }),
    );
  }
  const insertEvent = database.prepare(`
    INSERT INTO execution_events (
      id,project_id,execution_id,sequence,attempt_no,type,actor_type,actor_id,
      payload_json,created_at
    ) VALUES (?, ?, ?, ?, 1, 'status_changed', 'system', NULL, ?, ?)
  `);
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    insertEvent.run(
      `event-${sequence}`,
      PROJECT_ID,
      EXECUTION_ID,
      sequence,
      JSON.stringify({ from: "running", reasonCode: null, to: "staged" }),
      NOW,
    );
  }
  assertV7Fixture(database);
}

beforeEach(async () => {
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  database = openDatabase(databasePath);
  seed();
  reads = await import("@/src/adapters/outbound/sqlite/safe-execution/execution-read-service");
});

afterEach(() => {
  database.close();
  delete process.env.COCKPIT_DB_PATH;
});

describe("bounded execution read APIs", () => {
  it("exposes sanitized route errors without reflecting cursor or stored secrets", async () => {
    const load = routeModules["../../../../app/api/executions/[executionId]/events/route.ts"];
    expect(load).toBeTypeOf("function");
    const route = await load!();
    const response = await route.GET(
      new Request(`http://localhost/api/executions/${EXECUTION_ID}/events?after=Bearer-secret`),
      { params: Promise.resolve({ executionId: EXECUTION_ID }) },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      error: { code: "INVALID_CURSOR", message: "The request is invalid." },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /Bearer|secret|D:\\|provider\.invalid|private-chain|systemPrompt/i,
    );
  });

  it("round-trips the complete persisted event union in sequence order across pages", async () => {
    expect(expectedPersistedEventTypes).toHaveLength(33);
    expect(persistedEventFixtures).toHaveLength(expectedPersistedEventTypes.length);
    expect(persistedEventFixtures.map(([type]) => type).sort()).toEqual(
      [...expectedPersistedEventTypes].sort(),
    );
    expect([...executionEventTypeSchema.options].sort()).toEqual(
      [...expectedPersistedEventTypes].sort(),
    );
    database.prepare("DELETE FROM execution_events WHERE execution_id=?").run(EXECUTION_ID);
    const insert = database.prepare(`
      INSERT INTO execution_events (
        id,project_id,execution_id,sequence,attempt_no,type,actor_type,actor_id,
        payload_json,created_at
      ) VALUES (?, ?, ?, ?, 1, ?, 'system', NULL, ?, ?)
    `);
    persistedEventFixtures.forEach(([type, payload], index) => {
      insert.run(
        `round-trip-${String(index).padStart(2, "0")}`,
        PROJECT_ID,
        EXECUTION_ID,
        index + 1,
        type,
        JSON.stringify(payload),
        NOW,
      );
    });

    const items: Array<{ payload: unknown; sequence: number; type: string }> = [];
    let after: string | undefined;
    do {
      const page = await reads.listExecutionEvents(
        databasePath,
        EXECUTION_ID,
        { after, limit: "5" },
      );
      items.push(...page.items);
      after = page.nextCursor ?? undefined;
    } while (after);

    expect(items.map(({ sequence }) => sequence)).toEqual(
      persistedEventFixtures.map((_, index) => index + 1),
    );
    expect(items.map(({ type, payload }) => [type, payload])).toEqual(persistedEventFixtures);
  });

  it("keeps every enum member discriminated and rejects extras for every persisted payload", () => {
    const discriminatedTypes = executionEventDtoSchema.options
      .map((schema) => schema.shape.type.value)
      .sort();
    expect(discriminatedTypes).toEqual([...executionEventTypeSchema.options].sort());
    for (const [type, payload] of persistedEventFixtures) {
      const event = {
        actorId: null,
        actorType: "system",
        attemptNo: 1,
        createdAt: NOW,
        id: `strict-${type}`,
        payload,
        sequence: 1,
        type,
      };
      expect(executionEventDtoSchema.safeParse(event).success, type).toBe(true);
      expect(executionEventDtoSchema.safeParse({
        ...event,
        payload: { ...payload, extraSecret: "stored-secret-marker" },
      }).success, `${type} payload extra`).toBe(false);
    }
    expect(executionEventDtoSchema.safeParse({
      actorId: null,
      actorType: "system",
      attemptNo: 1,
      createdAt: NOW,
      extraSecret: "stored-secret-marker",
      id: "strict-envelope",
      payload: persistedEventFixtures[0][1],
      sequence: 1,
      type: persistedEventFixtures[0][0],
    }).success).toBe(false);
  });

  it("fails closed when every persisted event payload is tampered in the database", async () => {
    for (const [type, payload] of persistedEventFixtures) {
      database.prepare(`
        UPDATE execution_events SET type=?,payload_json=? WHERE id='event-1'
      `).run(type, JSON.stringify({ ...payload, extraSecret: "stored-secret-marker" }));
      await expect(reads.listExecutionEvents(
        databasePath,
        EXECUTION_ID,
        { limit: "1" },
      ), type).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
    }
  });

  it.each([
    ["unknown type", "future_event", { safe: true }],
    ["missing payload field", "status_changed", { from: "running", to: "staged" }],
    ["extra payload field", "status_changed", {
      extraSecret: "stored-secret-marker",
      from: "running",
      reasonCode: null,
      to: "staged",
    }],
    ["wrong payload type", "status_changed", {
      from: "running",
      reasonCode: null,
      to: 7,
    }],
  ])("fails closed on %s without reflecting stored data", async (_label, type, payload) => {
    database.prepare(`
      UPDATE execution_events SET type=?,payload_json=? WHERE id='event-1'
    `).run(type, JSON.stringify(payload));
    const load = routeModules["../../../../app/api/executions/[executionId]/events/route.ts"];
    expect(load).toBeTypeOf("function");
    const route = await load!();
    const response = await route.GET(
      new Request(`http://localhost/api/executions/${EXECUTION_ID}/events?limit=1`),
      { params: Promise.resolve({ executionId: EXECUTION_ID }) },
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "The execution service is unavailable." },
    });
    expect(JSON.stringify(body)).not.toMatch(/future_event|stored-secret-marker|running|staged/);
  });

  it("fails closed with the same stable error for a non-object stored event payload", async () => {
    database.prepare(`
      UPDATE execution_events SET payload_json=? WHERE id='event-1'
    `).run(JSON.stringify("stored-secret-marker"));
    await expect(reads.listExecutionEvents(
      databasePath,
      EXECUTION_ID,
      { limit: "1" },
    )).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("returns strict list/detail summaries without private or absolute host facts", async () => {
    const list = await reads.listProjectExecutions(databasePath, PROJECT_ID, { limit: "1" });
    const detail = await reads.readExecutionDetail(databasePath, EXECUTION_ID);
    expect(list.items).toHaveLength(1);
    expect(detail).toMatchObject({
      execution: { id: EXECUTION_ID, status: "staged" },
      counts: { events: 3, stagedObservations: 101, stagedBlockers: 101 },
      staged: {
        blockerCount: 101,
        id: STAGED_ID,
        observedPathCount: 101,
        requiredValidations: { ready: true, requiredCount: 0, validCount: 0 },
      },
    });
    expect(Object.keys(detail).sort()).toEqual(
      ["counts", "execution", "frozen", "recovery", "staged"].sort(),
    );
    expect(JSON.stringify({ list, detail })).not.toMatch(
      /D:\\|sandbox-secret|canonical-secret|cipher-secret|provider\.invalid|private-chain|systemPrompt/i,
    );
  });

  it("returns the active approval bound to the current staged hash beyond ten historical approvals", async () => {
    const insertTool = database.prepare(`
      INSERT INTO execution_tool_calls (
        id,project_id,execution_id,attempt_id,action_id,business_round,type,
        request_hash,status,error_code,public_request_json,public_result_json,
        before_sandbox_hash,after_sandbox_hash,started_at,finished_at
      ) VALUES (?, ?, ?, ?, NULL, ?, 'command', ?, 'rejected', NULL, ?, NULL,
        ?, NULL, ?, ?)
    `);
    const insertCommandApproval = database.prepare(`
      INSERT INTO execution_approvals (
        id,project_id,execution_id,attempt_id,tool_call_id,kind,status,
        request_hash,input_hash,staged_hash,public_request_json,
        decided_at,consumed_at,created_at
      ) VALUES (?, ?, ?, ?, ?, 'command', 'rejected', ?, ?, NULL, ?, ?, NULL, ?)
    `);
    for (let index = 0; index < 11; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const toolId = `historical-tool-${suffix}`;
      const createdAt = `2026-07-30T07:59:${suffix}.000Z`;
      insertTool.run(
        toolId,
        PROJECT_ID,
        EXECUTION_ID,
        ATTEMPT_ID,
        index + 10,
        HASH,
        JSON.stringify({ args: [], executable: "test", expectedEffect: "history", riskReasons: [], workdir: "." }),
        HASH,
        createdAt,
        createdAt,
      );
      insertCommandApproval.run(
        `historical-approval-${suffix}`,
        PROJECT_ID,
        EXECUTION_ID,
        ATTEMPT_ID,
        toolId,
        HASH,
        HASH,
        JSON.stringify({ args: [], executable: "test", expectedEffect: "history", riskReasons: [], workdir: "." }),
        createdAt,
        createdAt,
      );
    }
    database.prepare(`
      INSERT INTO execution_approvals (
        id,project_id,execution_id,attempt_id,tool_call_id,kind,status,
        request_hash,input_hash,staged_hash,public_request_json,
        decided_at,consumed_at,created_at
      ) VALUES (
        'stale-staged-approval',?,?,?,NULL,'staged_merge','expired',
        ?,?,?,?,NULL,NULL,'2026-07-30T07:59:30.000Z'
      )
    `).run(
      PROJECT_ID,
      EXECUTION_ID,
      ATTEMPT_ID,
      HASH,
      HASH,
      "c".repeat(64),
      "{}",
    );
    database.prepare(`
      INSERT INTO execution_approvals (
        id,project_id,execution_id,attempt_id,tool_call_id,kind,status,
        request_hash,input_hash,staged_hash,public_request_json,
        decided_at,consumed_at,created_at
      ) VALUES (
        'current-staged-approval',?,?,?,NULL,'staged_merge','pending',
        ?,?,?,?,NULL,NULL,'2026-07-30T08:01:00.000Z'
      )
    `).run(PROJECT_ID, EXECUTION_ID, ATTEMPT_ID, HASH, HASH, HASH, "{}");

    const firstPage = await reads.listExecutionApprovals(
      databasePath,
      EXECUTION_ID,
      { limit: "10" },
    );
    const detail = await reads.readExecutionDetail(databasePath, EXECUTION_ID);

    expect(firstPage.items).toHaveLength(10);
    expect(firstPage.items.every(({ kind }) => kind === "command")).toBe(true);
    expect(detail.staged?.activeApproval).toMatchObject({
      command: null,
      id: "current-staged-approval",
      kind: "staged_merge",
      stagedHash: HASH,
      status: "pending",
    });
    expect(detail.staged?.activeApproval?.stagedHash).toBe(detail.staged?.stagedHash);
  });

  it("strictly summarizes every required validation when the policy exceeds one page", async () => {
    database.exec(`
      DROP TRIGGER validation_policy_revision_no_update;
      UPDATE project_validation_policy_revisions
      SET entry_count=21
      WHERE id='read-policy';
      CREATE TRIGGER validation_policy_revision_no_update BEFORE UPDATE ON project_validation_policy_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_POLICY_REVISION'); END;
    `);
    const insertEntry = database.prepare(`
      INSERT INTO project_validation_policy_entries (
        id,project_id,revision_id,position,executable,executable_identity,args_json,
        workdir,required,tuple_hash
      ) VALUES (?, ?, ?, ?, ?, ?, '[]', '.', 1, ?)
    `);
    const insertToolCall = database.prepare(`
      INSERT INTO execution_tool_calls (
        id,project_id,execution_id,attempt_id,action_id,business_round,type,
        request_hash,status,error_code,public_request_json,public_result_json,
        before_sandbox_hash,after_sandbox_hash,started_at,finished_at
      ) VALUES (?, ?, ?, ?, NULL, ?, 'command', ?, 'succeeded', NULL, '{}', '{}',
        ?, ?, ?, ?)
    `);
    const insertValidation = database.prepare(`
      INSERT INTO execution_validation_results (
        id,project_id,execution_id,attempt_id,policy_revision_id,policy_entry_id,
        tool_call_id,sandbox_manifest_hash,required,exit_code,succeeded,
        stdout_bytes,stderr_bytes,stdout_sha256,stderr_sha256,
        stdout_truncated,stderr_truncated,finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, 0, 0, ?, ?, 0, 0, ?)
    `);
    for (let index = 0; index < 21; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const entryId = `required-entry-${suffix}`;
      const toolCallId = `required-tool-${suffix}`;
      const finishedAt = `2026-07-30T08:01:${suffix}.000Z`;
      insertEntry.run(
        entryId,
        PROJECT_ID,
        "read-policy",
        index,
        `test-${suffix}`,
        HASH,
        HASH,
      );
      if (index === 20) continue;
      insertToolCall.run(
        toolCallId,
        PROJECT_ID,
        EXECUTION_ID,
        ATTEMPT_ID,
        index + 10,
        HASH,
        HASH,
        HASH,
        finishedAt,
        finishedAt,
      );
      insertValidation.run(
        `required-validation-${suffix}`,
        PROJECT_ID,
        EXECUTION_ID,
        ATTEMPT_ID,
        "read-policy",
        entryId,
        toolCallId,
        HASH,
        HASH,
        HASH,
        finishedAt,
      );
    }

    const detail = await reads.readExecutionDetail(databasePath, EXECUTION_ID);
    expect(detail.staged?.requiredValidations).toEqual({
      ready: false,
      requiredCount: 21,
      validCount: 20,
    });
    expect(Object.keys(detail.staged?.requiredValidations ?? {}).sort()).toEqual(
      ["ready", "requiredCount", "validCount"].sort(),
    );
  });

  it("uses independent tamper-proof cursors and bounded pages for events and 101+ staged facts", async () => {
    const events = await reads.listExecutionEvents(databasePath, EXECUTION_ID, { limit: "1" });
    const observations = await reads.listStagedObservations(
      databasePath,
      EXECUTION_ID,
      STAGED_ID,
      { limit: "20" },
    );
    const blockers = await reads.listStagedBlockers(
      databasePath,
      EXECUTION_ID,
      STAGED_ID,
      { limit: "20" },
    );
    expect(events.items).toHaveLength(1);
    expect(observations.items).toHaveLength(20);
    expect(blockers.items).toHaveLength(20);
    expect(observations.nextCursor).toEqual(expect.any(String));
    const second = await reads.listStagedObservations(
      databasePath,
      EXECUTION_ID,
      STAGED_ID,
      { after: observations.nextCursor!, limit: "20" },
    );
    expect(second.items[0]).toMatchObject({ position: 20 });
    await expect(reads.listExecutionEvents(databasePath, EXECUTION_ID, {
      after: observations.nextCursor!,
      limit: "1",
    })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(reads.listStagedObservations(databasePath, EXECUTION_ID, STAGED_ID, {
      after: `${observations.nextCursor!.slice(0, -1)}x`,
      limit: "20",
    })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("keeps the maximum 100000 observation and blocker set behind bounded pages", async () => {
    database.exec(`
      WITH RECURSIVE positions(value) AS (
        SELECT 101 UNION ALL SELECT value + 1 FROM positions WHERE value < 99999
      )
      INSERT INTO execution_staged_observations (
        id,staged_result_id,position,path,path_key,kind,baseline_hash,observed_hash,
        final_size,diff_text,diff_bytes,diff_truncated
      )
      SELECT
        printf('bulk-observation-%06d',value),'${STAGED_ID}',value,
        printf('bulk/file-%06d.txt',value),printf('bulk/file-%06d.txt',value),
        'added',NULL,'${HASH}',1,NULL,0,0
      FROM positions;
      WITH RECURSIVE positions(value) AS (
        SELECT 101 UNION ALL SELECT value + 1 FROM positions WHERE value < 99999
      )
      INSERT INTO execution_staged_blockers (
        staged_result_id,observation_id,position,path,kind,detail_json
      )
      SELECT
        '${STAGED_ID}',printf('bulk-observation-%06d',value),value,
        printf('bulk/file-%06d.txt',value),'file_count_limit',
        '{"detailCode":"FILE_COUNT_LIMIT","secondaryCodes":[]}'
      FROM positions;
      UPDATE execution_staged_results
      SET observed_path_count=100000,observed_final_bytes=100000,blocker_count=100000
      WHERE id='${STAGED_ID}';
    `);
    const page = await reads.listStagedObservations(
      databasePath,
      EXECUTION_ID,
      STAGED_ID,
      { limit: "20" },
    );
    const blockers = await reads.listStagedBlockers(
      databasePath,
      EXECUTION_ID,
      STAGED_ID,
      { limit: "20" },
    );
    const detail = await reads.readExecutionDetail(databasePath, EXECUTION_ID);
    expect(page.items).toHaveLength(20);
    expect(blockers.items).toHaveLength(20);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(detail.counts).toMatchObject({
      stagedBlockers: 100_000,
      stagedObservations: 100_000,
    });
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(512 * 1024);
  });

  it("reads a legal multibyte 1 MiB artifact through contiguous <=64KiB chunks", async () => {
    const text = `${"界".repeat(349_525)}a`;
    expect(Buffer.byteLength(text, "utf8")).toBe(1_048_576);
    const artifactId = persistArtifactOutput(database, {
      attemptId: ATTEMPT_ID,
      executionId: EXECUTION_ID,
      name: "full.txt",
      output: createBoundedUtf8Text(text),
      path: "full.txt",
      projectId: PROJECT_ID,
    });
    const summary = await reads.listExecutionArtifacts(databasePath, EXECUTION_ID, { limit: "20" });
    expect(summary.items).toEqual([
      expect.objectContaining({ contentBytes: 1_048_576, id: artifactId }),
    ]);
    const chunks: Array<{ byteLength: number; chunkIndex: number; text: string }> = [];
    let after: string | undefined;
    do {
      const page = await reads.listArtifactChunks(
        databasePath,
        EXECUTION_ID,
        artifactId,
        { after, limit: "1" },
      );
      chunks.push(...page.items);
      after = page.nextCursor ?? undefined;
    } while (after);
    expect(chunks).toHaveLength(17);
    expect(chunks.map(({ chunkIndex }) => chunkIndex)).toEqual(
      Array.from({ length: 17 }, (_, index) => index),
    );
    expect(chunks.every(({ byteLength }) => byteLength <= 65_536)).toBe(true);
    expect(chunks.map(({ text: value }) => value).join("")).toBe(text);
  });

  it("rejects chunk gaps/hash corruption and keeps diff responses <=64KiB", async () => {
    const artifactId = persistArtifactOutput(database, {
      attemptId: ATTEMPT_ID,
      executionId: EXECUTION_ID,
      name: "body.txt",
      output: createBoundedUtf8Text("safe body"),
      path: "body.txt",
      projectId: PROJECT_ID,
    });
    database.prepare(
      "UPDATE execution_artifact_chunks SET sha256=? WHERE artifact_id=? AND chunk_index=0",
    ).run("f".repeat(64), artifactId);
    await expect(reads.listArtifactChunks(
      databasePath,
      EXECUTION_ID,
      artifactId,
      { limit: "1" },
    )).rejects.toMatchObject({ code: "SCHEMA_DATA_INVALID" });
    database.prepare(
      "UPDATE execution_artifact_chunks SET sha256=? WHERE artifact_id=? AND chunk_index=0",
    ).run(sha256("safe body"), artifactId);

    const diff = await reads.readObservationDiff(
      databasePath,
      EXECUTION_ID,
      STAGED_ID,
      "observation-000100",
      { limit: "65536", offset: "0" },
    );
    expect(Buffer.byteLength(diff.text, "utf8")).toBeLessThanOrEqual(65_536);
    expect(diff.nextOffset).toBeGreaterThan(0);
  });

  it("rejects oversized limits and remains stable after reopening the database", async () => {
    await expect(reads.listExecutionEvents(databasePath, EXECUTION_ID, {
      limit: "101",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    database.close();
    database = openDatabase(databasePath);
    const reopened = await reads.listStagedBlockers(
      databasePath,
      EXECUTION_ID,
      STAGED_ID,
      { limit: "20" },
    );
    expect(reopened.items).toHaveLength(20);
    expect(JSON.stringify(reopened)).not.toMatch(/secret|D:\\/i);
  });
});
