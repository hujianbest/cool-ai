import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { controlExecution } from "@/src/server/execution/execution-control-service";
import { execV7Fixture } from "@/tests/fixtures/execution/current-graph";
import { refreshExecutionFrozenFixture } from "@/tests/fixtures/execution/frozen-input";

type ApprovalModule = {
  createStagedMergeApproval(input: {
    attemptId: string;
    contextHash: string;
    database: DatabaseSync;
    executionId: string;
    inputHash: string;
    projectId: string;
    stagedHash: string;
  }): { approvalId: string };
  decideExecutionApproval(
    databasePath: string,
    executionId: string,
    approvalId: string,
    input: {
      action: "approve" | "reject" | "replace" | "revoke";
      expectedVersion: number;
      operationId: string;
    },
  ): Promise<{ body: Record<string, unknown>; status: number }>;
  consumeApprovedCommand(input: {
    database: DatabaseSync;
    executionId: string;
    expectedVersion: number;
    operationId: string;
    operationRequestHash: string;
  }): {
    actionId: string;
    approvalId: string;
    attemptId: string;
    projectId: string;
    requestHash: string;
  };
};

type AdvanceModule = {
  advanceExecution(
    databasePath: string,
    executionId: string,
    input: { expectedVersion: number; operationId: string },
    dependencies: { fileAdapter: object },
  ): Promise<{ body: Record<string, unknown>; status: number }>;
};

const NOW = "2026-07-30T08:00:00.000Z";
const PROJECT_ID = "approval-project";
const EXECUTION_ID = "approval-execution";
const ATTEMPT_ID = "approval-attempt";
const TOOL_CALL_ID = "approval-tool-call";
const APPROVAL_ID = "approval-command";
const INITIAL_CONTEXT_HASH = "c".repeat(64);
const REQUEST_HASH = "a".repeat(64);
const MANIFEST_HASH = "b".repeat(64);
const MASTER_KEY = Buffer.alloc(32, 43).toString("base64url");
const STAGED_HASH = "d".repeat(64);
const POLICY_HASH =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

let directory: string;
let databasePath: string;
let database: DatabaseSync;
let approvals: ApprovalModule;
let advance: AdvanceModule;
let contextHash: string;
let sequence: number;

function operationId(): string {
  sequence += 1;
  return `25000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

function seed(): void {
  const credential = createCredentialVault().encrypt("approval-provider", "approval-secret");
  const sandboxRoot = join(directory, "sandbox").replaceAll("'", "''");
  mkdirSync(sandboxRoot, { recursive: true });
  execV7Fixture(databasePath, database, `
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Approvals','${NOW}','D:\\approval','d:/approval',1);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'approval-provider','Provider','http://127.0.0.1:4000/v1','model',
      '${credential.apiKeyCipher}','${credential.apiKeyIv}','${credential.apiKeyTag}',
      1,1,'${credential.keyId}','${credential.apiKeyMask}','${NOW}',1,'${NOW}','${NOW}'
    );
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES (
      'approval-agent','Agent','Builder','private','approval-provider','model','A','sage',
      1,1,1,1000,5,1,'${NOW}','${NOW}'
    );
    INSERT INTO project_memberships (project_id,agent_id,joined_at)
    VALUES ('${PROJECT_ID}','approval-agent','${NOW}');
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('approval-mission','${PROJECT_ID}','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES (
      'approval-work','approval-mission','Work','','in_progress','approval-agent',1,
      '${NOW}','${NOW}'
    );
    INSERT INTO collaboration_runs (
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES (
      'approval-run','${PROJECT_ID}','planned','approval-agent',1,1,1,1,NULL,NULL,
      '${NOW}','${NOW}'
    );
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES (
      'approval-policy','${PROJECT_ID}',NULL,'system',1,'${POLICY_HASH}',1,0,2,0,'${NOW}'
    );
    INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
    VALUES ('${PROJECT_ID}','approval-policy',1,'${NOW}');
    INSERT INTO executions (
      id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES (
      '${EXECUTION_ID}','${PROJECT_ID}','approval-run','approval-mission','approval-work',
      'approval-agent','approval-policy','waiting_approval',NULL,
      'COMMAND_APPROVAL_REQUIRED',0,NULL,1,1,1,1,1,'${NOW}',
      '2099-07-30T08:15:00.000Z','2099-07-30T08:00:00.000Z','${NOW}',NULL
    );
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES (
      '${ATTEMPT_ID}','${PROJECT_ID}','${EXECUTION_ID}',1,'ready','${sandboxRoot}',
      NULL,'${MANIFEST_HASH}','${MANIFEST_HASH}','{}','{}','${INITIAL_CONTEXT_HASH}',
      'approval-policy',1,'${POLICY_HASH}','${NOW}',NULL
    );
  `);
  contextHash = refreshExecutionFrozenFixture(database, EXECUTION_ID);
  seedCommandApproval();
}

function commandPublicRequest() {
  const markerPath = join(directory, "one-shot-spawned.txt");
  return {
    agentPermission: "execute",
    args: ["-e", `require("node:fs").appendFileSync(${JSON.stringify(markerPath)}, "spawned\\n")`],
    attemptId: ATTEMPT_ID,
    attemptNo: 1,
    classifierVersion: 1,
    contextHash,
    executable: process.execPath,
    executableIdentity: "f".repeat(64),
    expectedEffect: "Run tests",
    inputHash: MANIFEST_HASH,
    policySource: { hash: POLICY_HASH, revisionId: "approval-policy", version: 1 },
    riskReasons: ["UNLISTED_COMMAND"],
    type: "command",
    workdir: ".",
  };
}

function seedCommandApproval(): void {
  const publicRequest = commandPublicRequest();
  database.prepare(`
    INSERT INTO execution_tool_calls (
      id,project_id,execution_id,attempt_id,action_id,business_round,type,
      request_hash,status,public_request_json,public_result_json,
      before_sandbox_hash,after_sandbox_hash,started_at,finished_at
    ) VALUES (?, ?, ?, ?, NULL, 1, 'command', ?, 'waiting_approval', ?, NULL,
      ?, NULL, ?, NULL)
  `).run(
    TOOL_CALL_ID,
    PROJECT_ID,
    EXECUTION_ID,
    ATTEMPT_ID,
    REQUEST_HASH,
    JSON.stringify(publicRequest),
    MANIFEST_HASH,
    NOW,
  );
  database.prepare(`
    INSERT INTO execution_approvals (
      id,project_id,execution_id,attempt_id,tool_call_id,kind,status,
      request_hash,input_hash,staged_hash,public_request_json,
      decided_at,consumed_at,created_at
    ) VALUES (?, ?, ?, ?, ?, 'command', 'pending', ?, ?, NULL, ?, NULL, NULL, ?)
  `).run(
    APPROVAL_ID,
    PROJECT_ID,
    EXECUTION_ID,
    ATTEMPT_ID,
    TOOL_CALL_ID,
    REQUEST_HASH,
    MANIFEST_HASH,
    JSON.stringify({ ...publicRequest, parseResult: "unknown_non_path", requestHash: REQUEST_HASH }),
    NOW,
  );
}

function row(
  table: string,
  where: string,
  ...parameters: Array<string | number | null | Uint8Array>
): Record<string, unknown> {
  return database.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...parameters) as Record<
    string,
    unknown
  >;
}

async function decide(
  action: "approve" | "reject" | "replace" | "revoke",
  expectedVersion = Number(row("executions", "id=?", EXECUTION_ID).version),
  id = operationId(),
) {
  return approvals.decideExecutionApproval(
    databasePath,
    EXECUTION_ID,
    APPROVAL_ID,
    { action, expectedVersion, operationId: id },
  );
}

beforeEach(async () => {
  vi.stubEnv("COCKPIT_MASTER_KEY", MASTER_KEY);
  directory = mkdtempSync(join(tmpdir(), "cool-ai-execution-approvals-"));
  databasePath = join(directory, "cockpit.sqlite");
  database = openDatabase(databasePath);
  sequence = 0;
  seed();
  try {
    const servicePath = "@/src/server/execution/execution-approval-service";
    approvals = await import(/* @vite-ignore */ servicePath) as ApprovalModule;
    const advancePath = "@/src/server/execution/action-orchestrator";
    advance = await import(/* @vite-ignore */ advancePath) as AdvanceModule;
  } catch {
    expect.fail("The T-25 execution approval service is unavailable.");
  }
});

afterEach(() => {
  database.close();
  rmSync(directory, { force: true, recursive: true });
  vi.unstubAllEnvs();
});

describe("execution approvals", () => {
  it("advances an approved one-shot command through consume and executes it exactly once", async () => {
    await decide("approve");
    const markerPath = join(directory, "one-shot-spawned.txt");
    const advanceOperationId = operationId();

    const result = await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 2, operationId: advanceOperationId },
      { fileAdapter: {} },
    );

    expect(result.status).toBe(200);
    expect(existsSync(markerPath)).toBe(true);
    expect(row("execution_approvals", "id=?", APPROVAL_ID).status).toBe("consumed");
    expect(database.prepare(`
      SELECT count(*) AS count FROM execution_actions WHERE status='running'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT count(*) AS count FROM execution_operations WHERE status='pending'
    `).get()).toEqual({ count: 0 });

    await expect(advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 2, operationId: advanceOperationId },
      { fileAdapter: {} },
    )).resolves.toEqual(result);
    expect(readFileSync(markerPath, "utf8")).toBe("spawned\n");
  });

  it("approves an exact command once and atomically consumes it into one command action", async () => {
    const approved = await decide("approve");
    expect(approved.body).toMatchObject({
      approval: { id: APPROVAL_ID, kind: "command", status: "approved" },
      execution: { status: "waiting_approval", version: 2 },
    });

    const consumeOperation = operationId();
    const consumed = approvals.consumeApprovedCommand({
      database,
      executionId: EXECUTION_ID,
      expectedVersion: 2,
      operationId: consumeOperation,
      operationRequestHash: canonicalRequestHash({
        executionId: EXECUTION_ID,
        expectedVersion: 2,
        kind: "advance",
      }),
    });
    expect(consumed).toMatchObject({
      approvalId: APPROVAL_ID,
      attemptId: ATTEMPT_ID,
      requestHash: REQUEST_HASH,
    });
    expect(row("execution_approvals", "id=?", APPROVAL_ID).status).toBe("consumed");
    expect(row("executions", "id=?", EXECUTION_ID)).toMatchObject({
      status: "running",
      reason_code: null,
      version: 3,
    });
    expect(row("execution_actions", "operation_id=?", consumeOperation)).toMatchObject({
      kind: "command",
      request_hash: REQUEST_HASH,
      status: "pending",
    });
    expect(() => approvals.consumeApprovedCommand({
      database,
      executionId: EXECUTION_ID,
      expectedVersion: 3,
      operationId: operationId(),
      operationRequestHash: REQUEST_HASH,
    })).toThrowError(expect.objectContaining({ code: "APPROVAL_STATE_CONFLICT" }));
    expect(database.prepare("SELECT count(*) AS count FROM execution_actions").get())
      .toEqual({ count: 1 });
  });

  it.each([
    ["reject", "rejected", "COMMAND_APPROVAL_REJECTED"],
    ["replace", "replaced", "COMMAND_APPROVAL_REPLACED"],
  ] as const)("%s permanently invalidates the request and pauses for exact running resume", async (
    action,
    status,
    reasonCode,
  ) => {
    const result = await decide(action);
    expect(result.body).toMatchObject({
      approval: { status },
      execution: { reasonCode, resumeTarget: "running", status: "paused" },
    });
    expect(row("execution_tool_calls", "id=?", TOOL_CALL_ID)).toMatchObject({
      status: "rejected",
    });
    expect(JSON.parse(String(row(
      "execution_tool_calls",
      "id=?",
      TOOL_CALL_ID,
    ).public_result_json))).toMatchObject({ code: reasonCode, status: "rejected" });
  });

  it("revokes an approved request before consumption and cannot revoke consumed authorization", async () => {
    await decide("approve");
    const revoked = await decide("revoke");
    expect(revoked.body).toMatchObject({
      approval: { status: "revoked" },
      execution: {
        reasonCode: "COMMAND_APPROVAL_REVOKED",
        resumeTarget: "running",
        status: "paused",
      },
    });

    expect(() => approvals.consumeApprovedCommand({
      database,
      executionId: EXECUTION_ID,
      expectedVersion: 3,
      operationId: operationId(),
      operationRequestHash: REQUEST_HASH,
    })).toThrowError(expect.objectContaining({ code: "APPROVAL_STATE_CONFLICT" }));
  });

  it("continues after rejection so the next model step can receive the typed outcome", async () => {
    await decide("reject");
    const result = await controlExecution(databasePath, EXECUTION_ID, {
      action: "continue",
      expectedVersion: 2,
      operationId: operationId(),
    }, {
      executionRoot: join(directory, "executions"),
      requestProcessTermination: () => true,
      sandboxExecutor: () => new Promise<never>(() => undefined),
    });
    expect(result.body.execution).toMatchObject({
      reasonCode: null,
      resumeTarget: null,
      status: "running",
    });
    expect(row("execution_tool_calls", "id=?", TOOL_CALL_ID)).toMatchObject({
      status: "rejected",
    });
  });

  it("stop permanently expires approved authorization and terminal decisions stay denied", async () => {
    await decide("approve");
    await controlExecution(databasePath, EXECUTION_ID, {
      action: "stop",
      expectedVersion: 2,
      operationId: operationId(),
    }, {
      executionRoot: join(directory, "executions"),
      requestProcessTermination: () => true,
      sandboxExecutor: () => new Promise<never>(() => undefined),
    });
    expect(row("execution_approvals", "id=?", APPROVAL_ID).status).toBe("expired");
    await expect(decide("revoke", 3)).rejects.toMatchObject({
      code: "EXECUTION_STATE_CONFLICT",
    });
  });

  it("persists same-operation success/failure receipts and rejects different input or stale versions", async () => {
    const id = operationId();
    const first = await decide("approve", 1, id);
    await expect(decide("approve", 1, id)).resolves.toEqual(first);
    await expect(decide("reject", 1, id)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    await expect(decide("revoke", 1)).rejects.toMatchObject({
      code: "EXECUTION_STATE_CONFLICT",
    });

    const badId = operationId();
    await expect(approvals.decideExecutionApproval(
      databasePath,
      EXECUTION_ID,
      "missing-approval",
      { action: "approve", expectedVersion: 2, operationId: badId },
    )).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    await expect(approvals.decideExecutionApproval(
      databasePath,
      EXECUTION_ID,
      "missing-approval",
      { action: "approve", expectedVersion: 2, operationId: badId },
    )).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    await expect(approvals.decideExecutionApproval(
      databasePath,
      EXECUTION_ID,
      "missing-approval",
      { action: "reject", expectedVersion: 2, operationId: badId },
    )).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    expect(row("execution_operations", "id=?", badId)).toMatchObject({
      http_status: 404,
      status: "completed",
    });
  });

  it.each([
    ["execution attempt", () => database.prepare(
      "UPDATE executions SET current_attempt_no=2",
    ).run()],
    ["attempt context", () => database.prepare(
      "UPDATE execution_attempts SET frozen_context_hash=? WHERE id=?",
    ).run("9".repeat(64), ATTEMPT_ID)],
    ["sandbox input", () => database.prepare(
      "UPDATE execution_attempts SET sandbox_manifest_hash=? WHERE id=?",
    ).run("8".repeat(64), ATTEMPT_ID)],
    ["command tuple", () => database.prepare(
      "UPDATE execution_tool_calls SET public_request_json=? WHERE id=?",
    ).run(JSON.stringify({ ...commandPublicRequest(), args: ["tampered"] }), TOOL_CALL_ID)],
  ])("expires and denies approval after %s changes", async (_label, tamper) => {
    tamper();
    await expect(decide("approve")).rejects.toMatchObject({ code: "APPROVAL_STALE" });
    expect(row("execution_approvals", "id=?", APPROVAL_ID).status).toBe("expired");
  });

  it("expires an approved command when the manifest changes before public advance", async () => {
    await decide("approve");
    database.prepare(`
      UPDATE execution_attempts SET sandbox_manifest_hash=? WHERE id=?
    `).run("7".repeat(64), ATTEMPT_ID);

    await expect(advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 2, operationId: operationId() },
      { fileAdapter: {} },
    )).rejects.toMatchObject({ code: "APPROVAL_STALE" });
    expect(row("execution_approvals", "id=?", APPROVAL_ID).status).toBe("expired");
    expect(database.prepare(`
      SELECT count(*) AS count FROM execution_actions WHERE kind='command'
    `).get()).toEqual({ count: 0 });
    expect(existsSync(join(directory, "one-shot-spawned.txt"))).toBe(false);
  });

  it("keeps standing policy execution as a distinct audit source without an approval row", () => {
    database.prepare("DELETE FROM execution_approvals").run();
    database.prepare("DELETE FROM execution_tool_calls").run();
    database.prepare(`
      UPDATE executions SET status='running',reason_code=NULL,version=2
    `).run();
    database.prepare(`
      INSERT INTO execution_operations (
        id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,
        final_action_index,status,http_status,response_json,created_at,updated_at
      ) VALUES (?, ?, ?, 'advance', ?, 1, 1, NULL, 'pending', NULL, NULL, ?, ?)
    `).run(operationId(), PROJECT_ID, EXECUTION_ID, REQUEST_HASH, NOW, NOW);
    expect(database.prepare("SELECT count(*) AS count FROM execution_approvals").get())
      .toEqual({ count: 0 });
    expect(commandPublicRequest()).toMatchObject({ policySource: { revisionId: "approval-policy" } });
  });

  it("creates a distinct exact staged approval and denies tamper, conflict, stale, and terminal use", async () => {
    database.prepare("DELETE FROM execution_approvals").run();
    database.prepare("DELETE FROM execution_tool_calls").run();
    database.prepare(`
      UPDATE executions SET status='staged',reason_code=NULL,version=2
    `).run();
    database.exec(`
      INSERT INTO execution_operations (
        id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,
        final_action_index,status,http_status,response_json,created_at,updated_at
      ) VALUES ('stage-operation', '${PROJECT_ID}', '${EXECUTION_ID}', 'stage',
        '${REQUEST_HASH}', 1, 1, 0, 'completed', 200, '{}', '${NOW}', '${NOW}');
      INSERT INTO execution_actions (
        id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
        request_hash,lease_token,lease_expires_at,overall_deadline_at,last_heartbeat_at,
        result_json,error_code,created_at,started_at,finished_at
      ) VALUES (
        'stage-action','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}','stage-operation',
        0,'stage_compute','succeeded','${REQUEST_HASH}',NULL,NULL,
        '2099-07-30T08:02:00.000Z',NULL,'{}',NULL,'${NOW}','${NOW}','${NOW}'
      );
      INSERT INTO execution_staged_results (
        id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
        sandbox_manifest_hash,context_hash,policy_hash,staged_hash,
        observed_path_count,observed_final_bytes,merge_file_count,merge_final_bytes,
        blocker_count,classification,block_reasons_json,created_at
      ) VALUES (
        'staged-result','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}','stage-action',
        '${MANIFEST_HASH}','${MANIFEST_HASH}','${contextHash}','${POLICY_HASH}',
        '${STAGED_HASH}',1,1,1,1,0,'approval_required','[]','${NOW}'
      );
      INSERT INTO execution_staged_observations (
        id,staged_result_id,position,path,path_key,kind,baseline_hash,observed_hash,
        final_size,diff_text,diff_bytes,diff_truncated
      ) VALUES (
        'staged-observation','staged-result',0,'file.txt','file.txt','modified',
        '${MANIFEST_HASH}','${STAGED_HASH}',1,'x',1,0
      );
      INSERT INTO execution_staged_files (
        id,staged_result_id,observation_id,position,path,path_key,kind,
        baseline_hash,staged_hash,size
      ) VALUES (
        'staged-file','staged-result','staged-observation',0,'file.txt','file.txt',
        'modified','${MANIFEST_HASH}','${STAGED_HASH}',1
      );
    `);

    const created = approvals.createStagedMergeApproval({
      attemptId: ATTEMPT_ID,
      contextHash,
      database,
      executionId: EXECUTION_ID,
      inputHash: MANIFEST_HASH,
      projectId: PROJECT_ID,
      stagedHash: STAGED_HASH,
    });
    expect(row("execution_staged_results", "attempt_id=?", ATTEMPT_ID)).toMatchObject({
      staged_hash: STAGED_HASH,
    });
    const result = await approvals.decideExecutionApproval(
      databasePath,
      EXECUTION_ID,
      created.approvalId,
      { action: "approve", expectedVersion: 2, operationId: operationId() },
    );
    expect(result.body).toMatchObject({
      approval: {
        command: null,
        kind: "staged_merge",
        stagedHash: STAGED_HASH,
        status: "approved",
      },
      execution: { status: "staged" },
    });

    database.prepare(
      "UPDATE execution_staged_results SET staged_hash=? WHERE id='staged-result'",
    ).run("7".repeat(64));
    await expect(approvals.decideExecutionApproval(
      databasePath,
      EXECUTION_ID,
      created.approvalId,
      { action: "revoke", expectedVersion: 3, operationId: operationId() },
    )).rejects.toMatchObject({ code: "APPROVAL_STALE" });
  });

  it("exposes the owner-only mutation route with strict input", async () => {
    vi.stubEnv("COCKPIT_DB_PATH", databasePath);
    const routePath = "@/app/api/executions/[executionId]/approvals/[approvalId]/route";
    const route = await import(/* @vite-ignore */ routePath);
    const response = await route.POST(
      new Request("http://localhost/api/executions/x/approvals/y", {
        body: JSON.stringify({
          action: "approve",
          expectedVersion: 1,
          operationId: operationId(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ approvalId: APPROVAL_ID, executionId: EXECUTION_ID }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      approval: { status: "approved" },
      execution: { status: "waiting_approval" },
    });
  });
});
