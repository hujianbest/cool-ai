import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { decideInline } from "@/src/adapters/outbound/sqlite/public-collaboration/inline-decision-service";
import { appendStructuredMessage } from "@/src/adapters/outbound/sqlite/public-collaboration/structured-message-store";
import { seedCurrentAdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";
import { workItemLeaseBind } from "@/tests/fixtures/sqlite/work-item-lease-columns";

type ApprovalCenterItem = {
  approvalId: string;
  createdAt: string;
  decisionHint: "expired" | "replaced" | "revoked" | null;
  domain: "execution" | "inline_decision";
  impactSummary: string | null;
  kind: "command" | "staged_merge" | "proposal";
  sourceRef: {
    executionId: string | null;
    messageId: string | null;
    runId: string | null;
    threadId: string | null;
  };
  status: "pending" | "expired" | "replaced" | "revoked";
  title: string | null;
};

type ApprovalCenterModule = {
  listPendingApprovals: (databasePath: string, projectId: string) => ApprovalCenterItem[];
};

const modules = import.meta.glob<ApprovalCenterModule>(
  "../../../src/adapters/outbound/sqlite/governance/approval-center-queries.ts",
);

const NOW = "2026-08-10T04:00:00.000Z";
const PROJECT_ID = "project-approval-center";
const MISSION_ID = "mission-approval-center";
const RUN_ID = "run-approval-center";
const EXECUTION_ID = "execution-approval-center";
const ATTEMPT_ID = "attempt-approval-center";
const POLICY_ID = "policy-approval-center";
const AGENT_ID = "agent-ac-a";

const POLICY_HASH = createHash("sha256").update("policy").digest("hex");
const CONTEXT_HASH = createHash("sha256").update("context").digest("hex");
const INPUT_HASH = createHash("sha256").update("input").digest("hex");
const STAGED_HASH = createHash("sha256").update("staged").digest("hex");

let databasePath: string;
let database: DatabaseSync;
let threadId: string;
let generatedId: number;

async function service(): Promise<ApprovalCenterModule> {
  const load = modules[
    "../../../src/adapters/outbound/sqlite/governance/approval-center-queries.ts"
  ];
  expect(load, "Approval center query seam must exist").toBeTypeOf("function");
  return load();
}

function hashFor(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function seedExecutionGraph(input: {
  agentId: string;
  attemptId: string;
  executionId: string;
  missionId: string;
  policyId: string;
  projectId: string;
  runId: string;
  threadId: string;
  workItemId: string;
}): void {
  database.prepare(
    `INSERT INTO work_items(
       id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at,
       lease_token,lease_expires_at,last_heartbeat_at
     ) VALUES (?,?,'Work','', 'in_progress',?,1,?,?,?,?,?)`,
  ).run(
    input.workItemId,
    input.missionId,
    input.agentId,
    NOW,
    NOW,
    ...workItemLeaseBind("in_progress", input.agentId, {
      at: NOW,
      token: `${input.workItemId}-lease`,
    }),
  );
  database.prepare(
    `INSERT INTO project_validation_policy_revisions(
       id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
       classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
     ) VALUES (?,?,NULL,'system',1,?,1,0,2,0,?)`,
  ).run(input.policyId, input.projectId, POLICY_HASH, NOW);
  database.prepare(
    `INSERT INTO executions(
       id,project_id,source_collaboration_thread_id,source_collaboration_run_id,
       mission_id,work_item_id,agent_id,current_policy_revision_id,status,
       resume_target,reason_code,manual_recovery_required,recovery_resolution,
       current_attempt_no,business_round_count,tool_call_count,next_event_sequence,
       version,created_at,business_deadline_at,first_running_at,updated_at,merged_at
     ) VALUES (?,?,?,?,?,?,?,?,'waiting_approval',NULL,'COMMAND_APPROVAL_REQUIRED',
               0,NULL,1,0,0,1,1,?,NULL,NULL,?,NULL)`,
  ).run(
    input.executionId,
    input.projectId,
    input.threadId,
    input.runId,
    input.missionId,
    input.workItemId,
    input.agentId,
    input.policyId,
    NOW,
    NOW,
  );
  database.prepare(
    `INSERT INTO execution_attempts(
       id,project_id,execution_id,attempt_no,status,sandbox_root,
       baseline_manifest_path,sandbox_manifest_path,baseline_manifest_hash,
       sandbox_manifest_hash,frozen_public_json,frozen_private_json,
       frozen_context_hash,frozen_policy_revision_id,frozen_policy_version,
       frozen_policy_hash,started_at,finished_at
     ) VALUES (?,?,?,1,'acting',?,NULL,NULL,NULL,NULL,'{}','{}',?,?,1,?,?,NULL)`,
  ).run(
    input.attemptId,
    input.projectId,
    input.executionId,
    "D:\\sandbox\\approval-center",
    CONTEXT_HASH,
    input.policyId,
    POLICY_HASH,
    NOW,
  );
}

// execution_one_pending_approval 部分唯一索引限制每个 execution 至多一条
// pending/approved 审批；execution_one_active_agent 限制每个 agent 至多一条
// 活跃 execution。需要多条在列审批的用例为每条审批挂独立 execution + agent。
function seedAdditionalExecution(
  executionId: string,
  attemptId: string,
  agentId: string,
): void {
  database.prepare(
    `INSERT INTO work_items(
       id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at,
       lease_token,lease_expires_at,last_heartbeat_at
     ) VALUES (?,?,'Work','', 'in_progress',?,1,?,?,?,?,?)`,
  ).run(
    `work-${executionId}`,
    MISSION_ID,
    agentId,
    NOW,
    NOW,
    ...workItemLeaseBind("in_progress", agentId, {
      at: NOW,
      token: `work-${executionId}-lease`,
    }),
  );
  database.prepare(
    `INSERT INTO executions(
       id,project_id,source_collaboration_thread_id,source_collaboration_run_id,
       mission_id,work_item_id,agent_id,current_policy_revision_id,status,
       resume_target,reason_code,manual_recovery_required,recovery_resolution,
       current_attempt_no,business_round_count,tool_call_count,next_event_sequence,
       version,created_at,business_deadline_at,first_running_at,updated_at,merged_at
     ) VALUES (?,?,?,?,?,?,?,?,'waiting_approval',NULL,'COMMAND_APPROVAL_REQUIRED',
               0,NULL,1,0,0,1,1,?,NULL,NULL,?,NULL)`,
  ).run(
    executionId,
    PROJECT_ID,
    threadId,
    RUN_ID,
    MISSION_ID,
    `work-${executionId}`,
    agentId,
    POLICY_ID,
    NOW,
    NOW,
  );
  database.prepare(
    `INSERT INTO execution_attempts(
       id,project_id,execution_id,attempt_no,status,sandbox_root,
       baseline_manifest_path,sandbox_manifest_path,baseline_manifest_hash,
       sandbox_manifest_hash,frozen_public_json,frozen_private_json,
       frozen_context_hash,frozen_policy_revision_id,frozen_policy_version,
       frozen_policy_hash,started_at,finished_at
     ) VALUES (?,?,?,1,'acting',?,NULL,NULL,NULL,NULL,'{}','{}',?,?,1,?,?,NULL)`,
  ).run(
    attemptId,
    PROJECT_ID,
    executionId,
    "D:\\sandbox\\approval-center",
    CONTEXT_HASH,
    POLICY_ID,
    POLICY_HASH,
    NOW,
  );
}

function commandPublicRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentPermission: "execute",
    args: ["-v"],
    attemptId: ATTEMPT_ID,
    attemptNo: 1,
    classifierVersion: 1,
    contextHash: CONTEXT_HASH,
    executable: "node",
    executableIdentity: hashFor("executable-identity"),
    expectedEffect: "Run the build",
    inputHash: INPUT_HASH,
    policySource: { hash: POLICY_HASH, revisionId: POLICY_ID, version: 1 },
    riskReasons: ["UNLISTED_COMMAND"],
    type: "command",
    workdir: ".",
    ...extra,
  };
}

function insertCommandApproval(input: {
  approvalId: string;
  attemptId?: string;
  businessRound: number;
  createdAt: string;
  consumedAt?: string | null;
  decidedAt?: string | null;
  executionId?: string;
  projectId?: string;
  publicRequest?: Record<string, unknown>;
  status?: string;
  toolCallId: string;
}): void {
  const projectId = input.projectId ?? PROJECT_ID;
  const executionId = input.executionId ?? EXECUTION_ID;
  const attemptId = input.attemptId ?? ATTEMPT_ID;
  const publicRequest = JSON.stringify(input.publicRequest ?? commandPublicRequest());
  database.prepare(
    `INSERT INTO execution_tool_calls(
       id,project_id,execution_id,attempt_id,action_id,business_round,type,
       request_hash,status,public_request_json,public_result_json,
       before_sandbox_hash,after_sandbox_hash,started_at,finished_at
     ) VALUES (?,?,?,?,NULL,?,'command',?,'waiting_approval',?,NULL,NULL,NULL,?,NULL)`,
  ).run(
    input.toolCallId,
    projectId,
    executionId,
    attemptId,
    input.businessRound,
    hashFor(input.toolCallId),
    publicRequest,
    NOW,
  );
  database.prepare(
    `INSERT INTO execution_approvals(
       id,project_id,execution_id,attempt_id,tool_call_id,kind,status,
       request_hash,input_hash,staged_hash,public_request_json,
       decided_at,consumed_at,created_at
     ) VALUES (?,?,?,?,?,'command',?,?,?,NULL,?,?,?,?)`,
  ).run(
    input.approvalId,
    projectId,
    executionId,
    attemptId,
    input.toolCallId,
    input.status ?? "pending",
    hashFor(input.approvalId),
    INPUT_HASH,
    publicRequest,
    input.decidedAt ?? null,
    input.consumedAt ?? null,
    input.createdAt,
  );
}

function insertStagedMergeApproval(input: {
  approvalId: string;
  attemptId?: string;
  createdAt: string;
  consumedAt?: string | null;
  decidedAt?: string | null;
  executionId?: string;
  projectId?: string;
  status?: string;
}): void {
  const projectId = input.projectId ?? PROJECT_ID;
  const executionId = input.executionId ?? EXECUTION_ID;
  const attemptId = input.attemptId ?? ATTEMPT_ID;
  database.prepare(
    `INSERT INTO execution_approvals(
       id,project_id,execution_id,attempt_id,tool_call_id,kind,status,
       request_hash,input_hash,staged_hash,public_request_json,
       decided_at,consumed_at,created_at
     ) VALUES (?,?,?,?,NULL,'staged_merge',?,?,?,?,?,?,?,?)`,
  ).run(
    input.approvalId,
    projectId,
    executionId,
    attemptId,
    input.status ?? "pending",
    hashFor(input.approvalId),
    INPUT_HASH,
    STAGED_HASH,
    JSON.stringify({
      approvalId: input.approvalId,
      attemptId,
      contextHash: CONTEXT_HASH,
      inputHash: INPUT_HASH,
      kind: "staged_merge",
      requestHash: hashFor(input.approvalId),
      stagedHash: STAGED_HASH,
    }),
    input.decidedAt ?? null,
    input.consumedAt ?? null,
    input.createdAt,
  );
}

function addProposal(input: {
  body: string;
  factId: string;
  logicalBlockId: string;
  messageId: string;
  projectId?: string;
  runId?: string;
  threadId?: string;
  timestamp: string;
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
    projectId: input.projectId ?? PROJECT_ID,
    runId: input.runId ?? RUN_ID,
    threadId: input.threadId ?? threadId,
    timestamp: input.timestamp,
  });
  const block = database.prepare(
    "SELECT id FROM structured_message_blocks WHERE message_id=?",
  ).get(input.messageId) as { id: string };
  return block.id;
}

function decisionDependencies() {
  return {
    clock: () => new Date(NOW),
    randomUUID: () => {
      generatedId += 1;
      return `90000000-0000-4000-8000-${generatedId.toString().padStart(12, "0")}`;
    },
  };
}

function decideProposal(input: {
  action: "accept" | "reject";
  blockId: string;
  expectedStateVersion: number;
  messageId: string;
  operationId: string;
}) {
  return decideInline(
    databasePath,
    {
      blockId: input.blockId,
      messageId: input.messageId,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      threadId,
    },
    JSON.stringify({
      action: input.action,
      expectedStateVersion: input.expectedStateVersion,
      operationId: input.operationId,
    }),
    decisionDependencies(),
  );
}

beforeEach(() => {
  generatedId = 0;
  databasePath = memoryDatabasePath();
  database = openDatabase(databasePath);
  threadId = seedCurrentAdvanceFixture(databasePath, {
    additionalAgents: [{ id: "agent-ac-c", prompt: "Extra" }],
    agentId: AGENT_ID,
    agentPrompt: "Plan",
    missionId: MISSION_ID,
    now: NOW,
    ownerMessage: null,
    projectId: PROJECT_ID,
    projectName: "Approval Center",
    providerId: "provider-ac",
    runId: RUN_ID,
    secondAgentId: "agent-ac-b",
    secondAgentPrompt: "Review",
    threadCreateOperationId: "00000000-0000-4000-8000-00000000ac01",
  });
  seedExecutionGraph({
    agentId: AGENT_ID,
    attemptId: ATTEMPT_ID,
    executionId: EXECUTION_ID,
    missionId: MISSION_ID,
    policyId: POLICY_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    threadId,
    workItemId: "work-ac",
  });
});

afterEach(() => {
  database.close();
});

describe("listPendingApprovals cross-domain aggregation", () => {
  it("returns an empty list for a project with no pending requests", async () => {
    const { listPendingApprovals } = await service();
    expect(listPendingApprovals(databasePath, PROJECT_ID)).toEqual([]);
  });

  it("fails closed with PROJECT_NOT_FOUND for an unknown project tuple", async () => {
    const { listPendingApprovals } = await service();
    let caught: unknown;
    try {
      listPendingApprovals(databasePath, "project-missing");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "PROJECT_NOT_FOUND", name: "GovernanceError" });
  });

  it("aggregates pending execution approvals and inline proposals newest-first", async () => {
    const { listPendingApprovals } = await service();
    insertCommandApproval({
      approvalId: "approval-command-1",
      businessRound: 1,
      createdAt: "2026-08-10T04:00:00.005Z",
      toolCallId: "tool-call-1",
    });
    const blockId = addProposal({
      body: "Ship it.",
      factId: "fact-proposal-1",
      logicalBlockId: "proposal-1",
      messageId: "message-proposal-1",
      timestamp: "2026-08-10T04:00:00.004Z",
      title: "Adopt plan",
    });
    seedAdditionalExecution("execution-ac-merge", "attempt-ac-merge", "agent-ac-b");
    insertStagedMergeApproval({
      approvalId: "approval-merge-1",
      attemptId: "attempt-ac-merge",
      createdAt: "2026-08-10T04:00:00.003Z",
      executionId: "execution-ac-merge",
    });

    const items = listPendingApprovals(databasePath, PROJECT_ID);

    expect(items).toEqual([
      {
        approvalId: "approval-command-1",
        createdAt: "2026-08-10T04:00:00.005Z",
        decisionHint: null,
        domain: "execution",
        impactSummary: "Run the build",
        kind: "command",
        sourceRef: {
          executionId: EXECUTION_ID,
          messageId: null,
          runId: null,
          threadId: null,
        },
        status: "pending",
        title: "node -v",
      },
      {
        approvalId: blockId,
        createdAt: "2026-08-10T04:00:00.004Z",
        decisionHint: null,
        domain: "inline_decision",
        impactSummary: "Ship it.",
        kind: "proposal",
        sourceRef: {
          executionId: null,
          messageId: "message-proposal-1",
          runId: RUN_ID,
          threadId,
        },
        status: "pending",
        title: "Adopt plan",
      },
      {
        approvalId: "approval-merge-1",
        createdAt: "2026-08-10T04:00:00.003Z",
        decisionHint: null,
        domain: "execution",
        impactSummary: null,
        kind: "staged_merge",
        sourceRef: {
          executionId: "execution-ac-merge",
          messageId: null,
          runId: null,
          threadId: null,
        },
        status: "pending",
        title: null,
      },
    ]);
  });

  it("breaks createdAt ties by approvalId ascending across both domains", async () => {
    const { listPendingApprovals } = await service();
    const blockId = addProposal({
      body: "Tie.",
      factId: "fact-proposal-tie",
      logicalBlockId: "proposal-tie",
      messageId: "message-proposal-tie",
      timestamp: "2026-08-10T04:00:00.010Z",
      title: "Tie proposal",
    });
    insertCommandApproval({
      approvalId: `${blockId}-a`,
      businessRound: 1,
      createdAt: "2026-08-10T04:00:00.010Z",
      toolCallId: "tool-call-tie-1",
    });
    seedAdditionalExecution("execution-tie-1", "attempt-tie-1", "agent-ac-b");
    insertCommandApproval({
      approvalId: "approval-tie-1",
      attemptId: "attempt-tie-1",
      businessRound: 1,
      createdAt: "2026-08-10T04:00:00.009Z",
      executionId: "execution-tie-1",
      toolCallId: "tool-call-tie-2",
    });
    seedAdditionalExecution("execution-tie-2", "attempt-tie-2", "agent-ac-c");
    insertStagedMergeApproval({
      approvalId: "approval-tie-2",
      attemptId: "attempt-tie-2",
      createdAt: "2026-08-10T04:00:00.009Z",
      executionId: "execution-tie-2",
    });

    const items = listPendingApprovals(databasePath, PROJECT_ID);

    expect(items.map((item) => item.approvalId)).toEqual([
      blockId,
      `${blockId}-a`,
      "approval-tie-1",
      "approval-tie-2",
    ]);
  });

  it("lists invalidated execution approvals with a reason and excludes settled states", async () => {
    const { listPendingApprovals } = await service();
    const decided = "2026-08-10T04:00:01.000Z";
    insertCommandApproval({
      approvalId: "approval-pending",
      businessRound: 1,
      createdAt: "2026-08-10T04:00:00.007Z",
      toolCallId: "tool-call-pending",
    });
    insertCommandApproval({
      approvalId: "approval-expired",
      businessRound: 2,
      createdAt: "2026-08-10T04:00:00.006Z",
      decidedAt: decided,
      status: "expired",
      toolCallId: "tool-call-expired",
    });
    insertCommandApproval({
      approvalId: "approval-replaced",
      businessRound: 3,
      createdAt: "2026-08-10T04:00:00.005Z",
      decidedAt: decided,
      status: "replaced",
      toolCallId: "tool-call-replaced",
    });
    insertStagedMergeApproval({
      approvalId: "approval-revoked",
      createdAt: "2026-08-10T04:00:00.004Z",
      decidedAt: decided,
      status: "revoked",
    });
    seedAdditionalExecution("execution-approved", "attempt-approved", "agent-ac-b");
    insertCommandApproval({
      approvalId: "approval-approved",
      attemptId: "attempt-approved",
      businessRound: 1,
      createdAt: "2026-08-10T04:00:00.003Z",
      decidedAt: decided,
      executionId: "execution-approved",
      status: "approved",
      toolCallId: "tool-call-approved",
    });
    insertCommandApproval({
      approvalId: "approval-consumed",
      businessRound: 5,
      consumedAt: decided,
      createdAt: "2026-08-10T04:00:00.002Z",
      decidedAt: decided,
      status: "consumed",
      toolCallId: "tool-call-consumed",
    });
    insertStagedMergeApproval({
      approvalId: "approval-rejected",
      createdAt: "2026-08-10T04:00:00.001Z",
      decidedAt: decided,
      status: "rejected",
    });

    const items = listPendingApprovals(databasePath, PROJECT_ID);

    expect(items.map((item) => [item.approvalId, item.status, item.decisionHint])).toEqual([
      ["approval-pending", "pending", null],
      ["approval-expired", "expired", "expired"],
      ["approval-replaced", "replaced", "replaced"],
      ["approval-revoked", "revoked", "revoked"],
    ]);
  });

  it("keeps a proposal decidable after a stale attempt and drops resolved proposals", async () => {
    const { listPendingApprovals } = await service();
    const staleBlockId = addProposal({
      body: "Stale target.",
      factId: "fact-proposal-stale",
      logicalBlockId: "proposal-stale",
      messageId: "message-proposal-stale",
      timestamp: "2026-08-10T04:00:00.002Z",
      title: "Stale proposal",
    });
    const acceptedBlockId = addProposal({
      body: "Accept me.",
      factId: "fact-proposal-accept",
      logicalBlockId: "proposal-accept",
      messageId: "message-proposal-accept",
      timestamp: "2026-08-10T04:00:00.003Z",
      title: "Accept proposal",
    });
    const rejectedBlockId = addProposal({
      body: "Reject me.",
      factId: "fact-proposal-reject",
      logicalBlockId: "proposal-reject",
      messageId: "message-proposal-reject",
      timestamp: "2026-08-10T04:00:00.004Z",
      title: "Reject proposal",
    });

    const conflict = decideProposal({
      action: "reject",
      blockId: staleBlockId,
      expectedStateVersion: 7,
      messageId: "message-proposal-stale",
      operationId: "00000000-0000-4000-8000-00000000ac11",
    });
    expect(conflict.status).toBe(409);

    const afterConflict = listPendingApprovals(databasePath, PROJECT_ID);
    expect(afterConflict.map((item) => item.approvalId)).toEqual([
      rejectedBlockId,
      acceptedBlockId,
      staleBlockId,
    ]);
    expect(afterConflict.every((item) => item.decisionHint === null)).toBe(true);

    expect(decideProposal({
      action: "accept",
      blockId: acceptedBlockId,
      expectedStateVersion: 1,
      messageId: "message-proposal-accept",
      operationId: "00000000-0000-4000-8000-00000000ac12",
    }).status).toBe(200);
    expect(decideProposal({
      action: "reject",
      blockId: rejectedBlockId,
      expectedStateVersion: 1,
      messageId: "message-proposal-reject",
      operationId: "00000000-0000-4000-8000-00000000ac13",
    }).status).toBe(200);

    const afterResolve = listPendingApprovals(databasePath, PROJECT_ID);
    expect(afterResolve.map((item) => item.approvalId)).toEqual([staleBlockId]);
  });

  it("isolates items by project tuple", async () => {
    const { listPendingApprovals } = await service();
    insertCommandApproval({
      approvalId: "approval-own",
      businessRound: 1,
      createdAt: "2026-08-10T04:00:00.002Z",
      toolCallId: "tool-call-own",
    });
    addProposal({
      body: "Own.",
      factId: "fact-proposal-own",
      logicalBlockId: "proposal-own",
      messageId: "message-proposal-own",
      timestamp: "2026-08-10T04:00:00.001Z",
      title: "Own proposal",
    });

    const otherThreadId = seedCurrentAdvanceFixture(databasePath, {
      agentId: "agent-other-a",
      agentPrompt: "Plan",
      idPrefix: "other",
      missionId: "mission-other",
      now: NOW,
      ownerMessage: null,
      projectId: "project-other",
      projectName: "Other",
      providerId: "provider-ac-2",
      runId: "run-other",
      secondAgentId: "agent-other-b",
      secondAgentPrompt: "Review",
      threadCreateOperationId: "00000000-0000-4000-8000-00000000ac02",
    });
    seedExecutionGraph({
      agentId: "agent-other-a",
      attemptId: "attempt-other",
      executionId: "execution-other",
      missionId: "mission-other",
      policyId: "policy-other",
      projectId: "project-other",
      runId: "run-other",
      threadId: otherThreadId,
      workItemId: "work-other",
    });
    addProposal({
      body: "Foreign.",
      factId: "fact-proposal-foreign",
      logicalBlockId: "proposal-foreign",
      messageId: "message-proposal-foreign",
      projectId: "project-other",
      runId: "run-other",
      threadId: otherThreadId,
      timestamp: "2026-08-10T04:00:00.009Z",
      title: "Foreign proposal",
    });
    insertStagedMergeApproval({
      approvalId: "approval-foreign",
      attemptId: "attempt-other",
      createdAt: "2026-08-10T04:00:00.008Z",
      executionId: "execution-other",
      projectId: "project-other",
    });

    const own = listPendingApprovals(databasePath, PROJECT_ID);
    expect(own.map((item) => item.domain)).toEqual(["execution", "inline_decision"]);
    expect(JSON.stringify(own)).not.toContain("foreign");

    const other = listPendingApprovals(databasePath, "project-other");
    expect(other.map((item) => item.approvalId)).toEqual([
      otherProposalBlockId(otherThreadId),
      "approval-foreign",
    ]);
  });

  it("strips non-whitelisted request fields from execution summaries", async () => {
    const { listPendingApprovals } = await service();
    insertCommandApproval({
      approvalId: "approval-canary",
      businessRound: 1,
      createdAt: "2026-08-10T04:00:00.001Z",
      publicRequest: commandPublicRequest({
        privateNote: "CANARY-SECRET-PROMPT",
      }),
      toolCallId: "tool-call-canary",
    });

    const items = listPendingApprovals(databasePath, PROJECT_ID);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      impactSummary: "Run the build",
      title: "node -v",
    });
    const wire = JSON.stringify(items);
    expect(wire).not.toContain("CANARY-SECRET-PROMPT");
    expect(wire).not.toContain(CONTEXT_HASH);
    expect(wire).not.toContain(INPUT_HASH);
    expect(wire).not.toContain(POLICY_HASH);
    expect(wire).not.toContain(hashFor("executable-identity"));
    expect(wire).not.toContain(ATTEMPT_ID);
    expect(wire).not.toContain("agentPermission");
    expect(wire).not.toContain("policySource");
  });
});

function otherProposalBlockId(otherThreadId: string): string {
  const block = database.prepare(
    "SELECT id FROM structured_message_blocks WHERE thread_id=?",
  ).get(otherThreadId) as { id: string };
  return block.id;
}
