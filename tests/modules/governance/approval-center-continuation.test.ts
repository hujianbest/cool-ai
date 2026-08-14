import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { GET as getExecutionDetail } from "@/app/api/executions/[executionId]/route";
import { POST as postApprovalDecision } from "@/app/api/executions/[executionId]/approvals/[approvalId]/route";
import { GET as getPendingApprovals } from "@/app/api/projects/[projectId]/approvals/pending/route";
import { GET as getBlock } from "@/app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/messages/[messageId]/blocks/[blockId]/route";
import { POST as postBlockDecision } from "@/app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/messages/[messageId]/blocks/[blockId]/decision/route";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { listPendingApprovals } from "@/src/adapters/outbound/sqlite/governance/approval-center-queries";
import { expireOpenApprovalsForProjectExecution } from "@/src/adapters/outbound/sqlite/governance/approval-store";
import { canonicalRequestHash } from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import { appendStructuredMessage } from "@/src/adapters/outbound/sqlite/public-collaboration/structured-message-store";
import { consumeApprovedCommand } from "@/src/adapters/outbound/sqlite/safe-execution/execution-approval-service";
import { controlExecution } from "@/src/adapters/outbound/sqlite/safe-execution/execution-control-service";
import {
  approvalCenterItemDtoSchema,
  type ApprovalCenterItemDto,
} from "@/src/shared/approval-center-contracts";
import { seedCurrentAdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";
import { workItemLeaseBind } from "@/tests/fixtures/sqlite/work-item-lease-columns";

const NOW = "2026-08-10T04:00:00.000Z";
const PROJECT_ID = "project-ac-continuation";
const MISSION_ID = "mission-ac-continuation";
const RUN_ID = "run-ac-continuation";
const EXECUTION_ID = "execution-ac-continuation";
const ATTEMPT_ID = "attempt-ac-continuation";
const TOOL_CALL_ID = "tool-call-ac-continuation";
const APPROVAL_ID = "approval-ac-continuation";
const POLICY_ID = "policy-ac-continuation";
const AGENT_ID = "agent-ac-continuation-a";

function hashFor(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

const POLICY_HASH = hashFor("ac-continuation-policy");
const CONTEXT_HASH = hashFor("ac-continuation-context");
const MANIFEST_HASH = hashFor("ac-continuation-manifest");
const REQUEST_HASH = hashFor("ac-continuation-request");

const pageSchema = z.object({
  approvals: z.array(approvalCenterItemDtoSchema),
}).strict();

let directory: string;
let databasePath: string;
let database: DatabaseSync;
let threadId: string;
let sequence: number;

function operationId(): string {
  sequence += 1;
  return `29000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

function row(
  table: string,
  where: string,
  ...parameters: Array<string | number>
): Record<string, unknown> {
  return database.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...parameters) as Record<
    string,
    unknown
  >;
}

// 与审批中心 UI 相同的只读链：经既有 GET 路由取当前版本，再 POST 既有裁决路由。
async function readExecutionVersion(): Promise<number> {
  const response = await getExecutionDetail(
    new Request(`http://localhost/api/executions/${EXECUTION_ID}`),
    { params: Promise.resolve({ executionId: EXECUTION_ID }) },
  );
  expect(response.status).toBe(200);
  const detail = (await response.json()) as { execution: { version: number } };
  return detail.execution.version;
}

async function postExecutionDecision(
  action: "approve" | "reject",
  expectedVersion: number,
): Promise<Response> {
  return postApprovalDecision(
    new Request(`http://localhost/api/executions/${EXECUTION_ID}/approvals/${APPROVAL_ID}`, {
      body: JSON.stringify({ action, expectedVersion, operationId: operationId() }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ approvalId: APPROVAL_ID, executionId: EXECUTION_ID }) },
  );
}

async function decideExecutionFromCenter(action: "approve" | "reject"): Promise<Response> {
  return postExecutionDecision(action, await readExecutionVersion());
}

function blockTuple(messageId: string, blockId: string) {
  return {
    params: Promise.resolve({
      blockId,
      messageId,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      threadId,
    }),
  };
}

function blockUrl(messageId: string, blockId: string): string {
  return `http://localhost/api/projects/${PROJECT_ID}/threads/${threadId}`
    + `/runs/${RUN_ID}/messages/${messageId}/blocks/${blockId}`;
}

async function readBlockStateVersion(messageId: string, blockId: string): Promise<number> {
  const response = await getBlock(new Request(blockUrl(messageId, blockId)), blockTuple(messageId, blockId));
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { block: { stateVersion: number } };
  return payload.block.stateVersion;
}

async function postProposalDecision(
  messageId: string,
  blockId: string,
  action: "accept" | "reject",
  expectedStateVersion: number,
): Promise<Response> {
  return postBlockDecision(
    new Request(`${blockUrl(messageId, blockId)}/decision`, {
      body: JSON.stringify({ action, expectedStateVersion, operationId: operationId() }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    blockTuple(messageId, blockId),
  );
}

async function decideProposalFromCenter(
  messageId: string,
  blockId: string,
  action: "accept" | "reject",
): Promise<Response> {
  return postProposalDecision(messageId, blockId, action, await readBlockStateVersion(messageId, blockId));
}

// 中心列表断言走 UI 同一条 GET 路由，并按 UI 的 strict schema 解析。
async function centerApprovals(): Promise<ApprovalCenterItemDto[]> {
  const response = await getPendingApprovals(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/approvals/pending`),
    { params: Promise.resolve({ projectId: PROJECT_ID }) },
  );
  expect(response.status).toBe(200);
  return pageSchema.parse(await response.json()).approvals;
}

function commandPublicRequest(): Record<string, unknown> {
  return {
    agentPermission: "execute",
    args: ["-v"],
    attemptId: ATTEMPT_ID,
    attemptNo: 1,
    classifierVersion: 1,
    contextHash: CONTEXT_HASH,
    executable: "node",
    executableIdentity: hashFor("ac-continuation-executable"),
    expectedEffect: "Run the build",
    inputHash: MANIFEST_HASH,
    policySource: { hash: POLICY_HASH, revisionId: POLICY_ID, version: 1 },
    riskReasons: ["UNLISTED_COMMAND"],
    type: "command",
    workdir: ".",
  };
}

// 造数对齐 execution-approvals 先例：审批事实（requestHash/inputHash/contextHash/
// attemptId 与工具调用、当前 attempt 完全一致）使裁决路由的事实核对可通过。
function seedCommandApprovalWaiting(): void {
  const publicRequest = commandPublicRequest();
  database.prepare(
    `INSERT INTO work_items(
       id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at,
       lease_token,lease_expires_at,last_heartbeat_at
     ) VALUES (?,?,'Work','', 'in_progress',?,1,?,?,?,?,?)`,
  ).run(
    "work-ac-continuation",
    MISSION_ID,
    AGENT_ID,
    NOW,
    NOW,
    ...workItemLeaseBind("in_progress", AGENT_ID, {
      at: NOW,
      token: "work-ac-continuation-lease",
    }),
  );
  database.prepare(
    `INSERT INTO project_validation_policy_revisions(
       id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
       classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
     ) VALUES (?,?,NULL,'system',1,?,1,0,2,0,?)`,
  ).run(POLICY_ID, PROJECT_ID, POLICY_HASH, NOW);
  database.prepare(
    `INSERT INTO executions(
       id,project_id,source_collaboration_thread_id,source_collaboration_run_id,
       mission_id,work_item_id,agent_id,current_policy_revision_id,status,
       resume_target,reason_code,manual_recovery_required,recovery_resolution,
       current_attempt_no,business_round_count,tool_call_count,next_event_sequence,
       version,created_at,business_deadline_at,first_running_at,updated_at,merged_at
     ) VALUES (?,?,?,?,?,?,?,?,'waiting_approval',NULL,'COMMAND_APPROVAL_REQUIRED',
               0,NULL,1,1,1,1,1,?,?,?,?,NULL)`,
  ).run(
    EXECUTION_ID,
    PROJECT_ID,
    threadId,
    RUN_ID,
    MISSION_ID,
    "work-ac-continuation",
    AGENT_ID,
    POLICY_ID,
    NOW,
    "2099-08-10T04:15:00.000Z",
    "2099-08-10T04:00:00.000Z",
    NOW,
  );
  database.prepare(
    `INSERT INTO execution_attempts(
       id,project_id,execution_id,attempt_no,status,sandbox_root,
       baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
       frozen_public_json,frozen_private_json,frozen_context_hash,
       frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
       started_at,finished_at
     ) VALUES (?,?,?,1,'acting',?,NULL,NULL,?,'{}','{}',?,?,1,?,?,NULL)`,
  ).run(
    ATTEMPT_ID,
    PROJECT_ID,
    EXECUTION_ID,
    join(directory, "sandbox"),
    MANIFEST_HASH,
    CONTEXT_HASH,
    POLICY_ID,
    POLICY_HASH,
    NOW,
  );
  database.prepare(
    `INSERT INTO execution_tool_calls(
       id,project_id,execution_id,attempt_id,action_id,business_round,type,
       request_hash,status,public_request_json,public_result_json,
       before_sandbox_hash,after_sandbox_hash,started_at,finished_at
     ) VALUES (?,?,?,?,NULL,1,'command',?,'waiting_approval',?,NULL,?,NULL,?,NULL)`,
  ).run(
    TOOL_CALL_ID,
    PROJECT_ID,
    EXECUTION_ID,
    ATTEMPT_ID,
    REQUEST_HASH,
    JSON.stringify(publicRequest),
    MANIFEST_HASH,
    NOW,
  );
  database.prepare(
    `INSERT INTO execution_approvals(
       id,project_id,execution_id,attempt_id,tool_call_id,kind,status,
       request_hash,input_hash,staged_hash,public_request_json,
       decided_at,consumed_at,created_at
     ) VALUES (?,?,?,?,?,'command','pending',?,?,NULL,?,NULL,NULL,?)`,
  ).run(
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

function addProposal(input: {
  body: string;
  factId: string;
  logicalBlockId: string;
  messageId: string;
  title: string;
}): string {
  appendStructuredMessage(databasePath, {
    actor: { displayName: "Agent Alpha", id: AGENT_ID, type: "agent" },
    blocksRaw: JSON.stringify({
      blocks: [{
        actions: ["accept", "reject"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        body: input.body,
        logicalBlockId: input.logicalBlockId,
        title: input.title,
      }],
    }),
    content: "Decide.",
    factId: input.factId,
    messageId: input.messageId,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    threadId,
    timestamp: NOW,
  });
  const block = database.prepare(
    "SELECT id FROM structured_message_blocks WHERE message_id=?",
  ).get(input.messageId) as { id: string };
  return block.id;
}

beforeEach(() => {
  sequence = 0;
  directory = mkdtempSync(join(tmpdir(), "cool-ai-approval-center-continuation-"));
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  database = openDatabase(databasePath);
  threadId = seedCurrentAdvanceFixture(databasePath, {
    agentId: AGENT_ID,
    agentPrompt: "Plan",
    missionId: MISSION_ID,
    now: NOW,
    ownerMessage: null,
    projectId: PROJECT_ID,
    projectName: "Approval Center Continuation",
    providerId: "provider-ac-continuation",
    runId: RUN_ID,
    secondAgentId: "agent-ac-continuation-b",
    secondAgentPrompt: "Review",
    threadCreateOperationId: "00000000-0000-4000-8000-00000000ac71",
  });
});

afterEach(() => {
  database.close();
  rmSync(directory, { force: true, recursive: true });
  delete process.env.COCKPIT_DB_PATH;
});

describe("approval center decision dispatch continuation", () => {
  it("resumes an approved command execution through consumption and delists the approval", async () => {
    seedCommandApprovalWaiting();
    expect((await centerApprovals()).map((item) => item.approvalId)).toEqual([APPROVAL_ID]);

    const decided = await decideExecutionFromCenter("approve");
    expect(decided.status).toBe(200);
    await expect(decided.json()).resolves.toMatchObject({
      approval: { id: APPROVAL_ID, kind: "command", status: "approved" },
      execution: { status: "waiting_approval", version: 2 },
    });
    expect(listPendingApprovals(databasePath, PROJECT_ID)).toEqual([]);
    expect(await centerApprovals()).toEqual([]);

    const consumeOperationId = operationId();
    const consumed = consumeApprovedCommand({
      database,
      executionId: EXECUTION_ID,
      expectedVersion: 2,
      operationId: consumeOperationId,
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
      reason_code: null,
      resume_target: null,
      status: "running",
      version: 3,
    });
    expect(row("execution_tool_calls", "id=?", TOOL_CALL_ID)).toMatchObject({
      action_id: consumed.actionId,
      status: "requested",
    });
    expect(row("execution_actions", "operation_id=?", consumeOperationId)).toMatchObject({
      kind: "command",
      request_hash: REQUEST_HASH,
      status: "pending",
    });
    expect(await centerApprovals()).toEqual([]);
  });

  it("settles an accepted proposal block at the next state version and delists it", async () => {
    const messageId = "message-ac-accept";
    const blockId = addProposal({
      body: "Ship it.",
      factId: "fact-ac-accept",
      logicalBlockId: "proposal-ac-accept",
      messageId,
      title: "Adopt plan",
    });
    expect((await centerApprovals()).map((item) => item.approvalId)).toEqual([blockId]);

    const decided = await decideProposalFromCenter(messageId, blockId, "accept");
    expect(decided.status).toBe(200);
    await expect(decided.json()).resolves.toMatchObject({
      kind: "completed",
      receipt: {
        action: "accept",
        blockId,
        fromStateVersion: 1,
        toStateVersion: 2,
      },
    });

    expect(row("structured_message_state_heads", "block_id=?", blockId))
      .toMatchObject({ current_state_version: 2 });
    const revision = row(
      "structured_message_state_revisions",
      "block_id=? AND state_version=?",
      blockId,
      2,
    );
    expect(JSON.parse(String(revision.state_json))).toEqual({ status: "accepted" });
    expect(row("inline_decisions", "block_id=?", blockId)).toMatchObject({
      action: "accept",
      from_state_version: 1,
      to_state_version: 2,
    });
    expect(await centerApprovals()).toEqual([]);

    const terminal = await postProposalDecision(messageId, blockId, "accept", 2);
    expect(terminal.status).toBe(409);
    await expect(terminal.json()).resolves.toEqual({
      error: { code: "ACTION_CONFLICT", message: "Proposal is already terminal." },
    });
  });

  it("refuses decisions on an expired execution approval and keeps it visibly invalidated", async () => {
    seedCommandApprovalWaiting();
    expireOpenApprovalsForProjectExecution(database, PROJECT_ID, EXECUTION_ID);

    const before = await centerApprovals();
    expect(before).toEqual([expect.objectContaining({
      approvalId: APPROVAL_ID,
      decisionHint: "expired",
      status: "expired",
    })]);

    const decided = await decideExecutionFromCenter("approve");
    expect(decided.status).toBe(409);
    await expect(decided.json()).resolves.toEqual({
      error: {
        code: "APPROVAL_STATE_CONFLICT",
        message: "The execution state conflicts with this request.",
      },
    });

    expect(row("executions", "id=?", EXECUTION_ID)).toMatchObject({
      status: "waiting_approval",
      version: 1,
    });
    expect(row("execution_approvals", "id=?", APPROVAL_ID).status).toBe("expired");
    const after = await centerApprovals();
    expect(after).toEqual([expect.objectContaining({
      approvalId: APPROVAL_ID,
      decisionHint: "expired",
      status: "expired",
    })]);
  });

  it("pauses a rejected command execution with exact resume semantics and delists the approval", async () => {
    seedCommandApprovalWaiting();

    const decided = await decideExecutionFromCenter("reject");
    expect(decided.status).toBe(200);
    await expect(decided.json()).resolves.toMatchObject({
      approval: { status: "rejected" },
      execution: {
        reasonCode: "COMMAND_APPROVAL_REJECTED",
        resumeTarget: "running",
        status: "paused",
      },
    });
    expect(row("execution_tool_calls", "id=?", TOOL_CALL_ID)).toMatchObject({
      status: "rejected",
    });
    expect(JSON.parse(String(row("execution_tool_calls", "id=?", TOOL_CALL_ID).public_result_json)))
      .toMatchObject({ code: "COMMAND_APPROVAL_REJECTED", status: "rejected" });
    expect(await centerApprovals()).toEqual([]);

    const continued = await controlExecution(databasePath, EXECUTION_ID, {
      action: "continue",
      expectedVersion: 2,
      operationId: operationId(),
    }, {
      executionRoot: join(directory, "executions"),
      requestProcessTermination: () => true,
      sandboxExecutor: () => new Promise<never>(() => undefined),
    });
    expect(continued.body.execution).toMatchObject({
      reasonCode: null,
      resumeTarget: null,
      status: "running",
    });
    expect(await centerApprovals()).toEqual([]);
  });

  it("settles a rejected proposal block and delists it", async () => {
    const messageId = "message-ac-reject";
    const blockId = addProposal({
      body: "Hold off.",
      factId: "fact-ac-reject",
      logicalBlockId: "proposal-ac-reject",
      messageId,
      title: "Defer plan",
    });

    const decided = await decideProposalFromCenter(messageId, blockId, "reject");
    expect(decided.status).toBe(200);
    await expect(decided.json()).resolves.toMatchObject({
      kind: "completed",
      receipt: {
        action: "reject",
        blockId,
        fromStateVersion: 1,
        toStateVersion: 2,
      },
    });

    const revision = row(
      "structured_message_state_revisions",
      "block_id=? AND state_version=?",
      blockId,
      2,
    );
    expect(JSON.parse(String(revision.state_json))).toEqual({ status: "rejected" });
    expect(row("inline_decisions", "block_id=?", blockId)).toMatchObject({
      action: "reject",
      from_state_version: 1,
      to_state_version: 2,
    });
    expect(await centerApprovals()).toEqual([]);
  });

  it("fails a stale execution decision with a sanitized 409 while the center reflects the settled truth", async () => {
    seedCommandApprovalWaiting();
    const staleVersion = await readExecutionVersion();

    const first = await postExecutionDecision("approve", staleVersion);
    expect(first.status).toBe(200);

    const stale = await postExecutionDecision("reject", staleVersion);
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body).toEqual({
      error: {
        code: "EXECUTION_STATE_CONFLICT",
        message: "The execution state conflicts with this request.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("Execution version is stale");

    expect(row("execution_approvals", "id=?", APPROVAL_ID).status).toBe("approved");
    expect(await centerApprovals()).toEqual([]);
  });

  it("fails a stale proposal decision with VERSION_CONFLICT while the center reflects the settled truth", async () => {
    const messageId = "message-ac-drift";
    const blockId = addProposal({
      body: "Race me.",
      factId: "fact-ac-drift",
      logicalBlockId: "proposal-ac-drift",
      messageId,
      title: "Race plan",
    });
    const staleStateVersion = await readBlockStateVersion(messageId, blockId);

    const first = await postProposalDecision(messageId, blockId, "accept", staleStateVersion);
    expect(first.status).toBe(200);

    const stale = await postProposalDecision(messageId, blockId, "reject", staleStateVersion);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      currentStateVersion: 2,
      error: { code: "VERSION_CONFLICT", message: "Structured message state changed." },
      kind: "version_conflict",
    });
    expect(await centerApprovals()).toEqual([]);
  });
});
