import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { appendGovernanceAuditOutboxRow } from "@/src/adapters/outbound/sqlite/governance/audit-event-outbox";
import {
  consumeApprovedApprovalById,
  consumeStagedMergeApproval,
  expireApprovedApprovalById,
  expireOpenApprovalById,
  expireOpenApprovalsForExecution,
  expireOpenApprovalsForExecutionAt,
  expireOpenApprovalsForProjectExecution,
  insertCommandApprovalRequest,
  insertStagedMergeApprovalRequest,
  recordApprovalVerdict,
} from "@/src/adapters/outbound/sqlite/governance/approval-store";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { seedCurrentAdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";
import { workItemLeaseBind } from "@/tests/fixtures/sqlite/work-item-lease-columns";

const NOW = "2026-08-13T03:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 13).toString("base64url");
const PROJECT_ID = "governance-audit-project";
const MISSION_ID = "mission-governance-audit";
const RUN_ID = "run-governance-audit";
const POLICY_ID = "policy-governance-audit";
const PROVIDER_ID = "provider-governance-audit";
const AGENT_A = "agent-governance-audit-a";
const AGENT_B = "agent-governance-audit-b";
const AGENT_C = "agent-governance-audit-c";
const AGENT_D = "agent-governance-audit-d";
const AGENT_E = "agent-governance-audit-e";
const HASH = "a".repeat(64);
const HASH_B = "b".repeat(64);
const POLICY_HASH = "c".repeat(64);
const CONTEXT_HASH = "d".repeat(64);

let databasePath: string;
let database: DatabaseSync;
let threadId: string;

// The credential-classification seam must stay live in this suite: the shared
// fixture seeds a placeholder provider envelope, so it is replaced with a real
// envelope encrypted under the test master key. With the vault available,
// enum/identity payload values pass the seam unchanged while credential-like
// values redact fail-closed.
function seedBase(): void {
  threadId = seedCurrentAdvanceFixture(databasePath, {
    additionalAgents: [
      { id: AGENT_C, prompt: "Extra C" },
      { id: AGENT_D, prompt: "Extra D" },
      { id: AGENT_E, prompt: "Extra E" },
    ],
    agentId: AGENT_A,
    agentPrompt: "Plan",
    missionId: MISSION_ID,
    now: NOW,
    ownerMessage: null,
    projectId: PROJECT_ID,
    projectName: "GovernanceAudit",
    providerId: PROVIDER_ID,
    runId: RUN_ID,
    secondAgentId: AGENT_B,
    secondAgentPrompt: "Review",
    threadCreateOperationId: "00000000-0000-4000-8000-000000370001",
  });
  const encrypted = createCredentialVault().encrypt(PROVIDER_ID, "provider-key-governance-audit");
  database.prepare(`
    UPDATE providers SET api_key_cipher=?,api_key_iv=?,api_key_tag=?,key_id=?
    WHERE id=?
  `).run(encrypted.apiKeyCipher, encrypted.apiKeyIv, encrypted.apiKeyTag, encrypted.keyId, PROVIDER_ID);
  database.prepare(
    `INSERT INTO project_validation_policy_revisions(
       id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
       classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
     ) VALUES (?,?,NULL,'system',1,?,1,0,2,0,?)`,
  ).run(POLICY_ID, PROJECT_ID, POLICY_HASH, NOW);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  databasePath = memoryDatabasePath();
  database = openDatabase(databasePath);
  seedBase();
});

afterEach(() => {
  try {
    database.close();
  } catch {
    // The connection may already be closed by reopen exercises.
  }
  delete process.env.COCKPIT_MASTER_KEY;
  vi.useRealTimers();
});

function nextOutboxSeq(): number {
  return (database.prepare(
    "SELECT COALESCE(MAX(outbox_seq),0)+1 AS nextSeq FROM audit_event_outbox",
  ).get() as { nextSeq: number }).nextSeq;
}

// execution_one_pending_approval allows at most one pending/approved approval
// per execution and execution_one_active_agent at most one active execution per
// agent, so every seeded approval gets its own execution + agent tuple.
function seedExecution(input: {
  agentId: string;
  attemptId: string;
  executionId: string;
}): void {
  database.prepare(
    `INSERT INTO work_items(
       id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at,
       lease_token,lease_expires_at,last_heartbeat_at
     ) VALUES (?,?,'Work','','in_progress',?,1,?,?,?,?,?)`,
  ).run(
    `work-${input.executionId}`,
    MISSION_ID,
    input.agentId,
    NOW,
    NOW,
    ...workItemLeaseBind("in_progress", input.agentId, {
      at: NOW,
      token: `work-${input.executionId}-lease`,
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
    input.executionId,
    PROJECT_ID,
    threadId,
    RUN_ID,
    MISSION_ID,
    `work-${input.executionId}`,
    input.agentId,
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
    input.attemptId,
    PROJECT_ID,
    input.executionId,
    "D:\\sandbox\\governance-audit",
    CONTEXT_HASH,
    POLICY_ID,
    POLICY_HASH,
    NOW,
  );
}

function seedCommandToolCall(input: {
  attemptId: string;
  executionId: string;
  toolCallId: string;
}): void {
  database.prepare(
    `INSERT INTO execution_tool_calls(
       id,project_id,execution_id,attempt_id,action_id,business_round,type,
       request_hash,status,public_request_json,public_result_json,
       before_sandbox_hash,after_sandbox_hash,started_at,finished_at
     ) VALUES (?,?,?,?,NULL,1,'command',?,'waiting_approval',?,NULL,NULL,NULL,?,NULL)`,
  ).run(input.toolCallId, PROJECT_ID, input.executionId, input.attemptId, HASH, "{}", NOW);
}

function insertCommandApproval(input: {
  agentId?: string;
  approvalId: string;
  executionId: string;
}): void {
  const agentId = input.agentId ?? AGENT_A;
  const attemptId = `attempt-${input.executionId}`;
  const toolCallId = `tool-call-${input.executionId}`;
  seedExecution({ agentId, attemptId, executionId: input.executionId });
  seedCommandToolCall({ attemptId, executionId: input.executionId, toolCallId });
  insertCommandApprovalRequest(database, {
    approvalId: input.approvalId,
    attemptId,
    executionId: input.executionId,
    inputHash: HASH,
    projectId: PROJECT_ID,
    publicRequestJson: JSON.stringify({
      command: "rm -rf ~/secrets",
      requestHash: HASH,
      riskReasons: ["destructive"],
    }),
    requestHash: HASH,
    toolCallId,
  });
}

function insertStagedMergeApproval(input: {
  agentId?: string;
  approvalId: string;
  executionId: string;
}): void {
  const agentId = input.agentId ?? AGENT_B;
  const attemptId = `attempt-${input.executionId}`;
  seedExecution({ agentId, attemptId, executionId: input.executionId });
  insertStagedMergeApprovalRequest(database, {
    approvalId: input.approvalId,
    attemptId,
    executionId: input.executionId,
    inputHash: HASH,
    projectId: PROJECT_ID,
    publicRequestJson: "{}",
    requestHash: HASH,
    stagedHash: HASH_B,
  });
}

describe("governance audit outbox schema", () => {
  it("bootstraps identity 25 and accepts the governance outbox source", () => {
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
    database.prepare(`
      INSERT INTO audit_event_outbox (
        id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
      ) VALUES ('gov-event-1',?,'governance','approval_requested','{}',?,?)
    `).run(PROJECT_ID, NOW, nextOutboxSeq());
    expect(database.prepare(
      "SELECT source FROM audit_event_outbox WHERE id='gov-event-1'",
    ).get()).toEqual({ source: "governance" });
    expect(() => database.prepare(`
      INSERT INTO audit_event_outbox (
        id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
      ) VALUES ('gov-event-2',?,'Governance','approval_requested','{}',?,?)
    `).run(PROJECT_ID, NOW, nextOutboxSeq())).toThrow();
  });
});

type OutboxRow = {
  eventType: string;
  id: string;
  occurredAt: string;
  payloadJson: string;
  projectId: string;
  seq: number;
  source: string;
};

// This suite's subject is the governance writer seam; the shared outbox may
// also carry other sources' rows (035/036 precedent), so the reader scopes to
// this source. Sequence assertions capture the shared head after seeding and
// stay exact.
function governanceRows(path: string = databasePath): OutboxRow[] {
  const reader = openDatabase(path);
  try {
    return reader.prepare(`
      SELECT id,project_id AS projectId,source,event_type AS eventType,
             payload_json AS payloadJson,occurred_at AS occurredAt,outbox_seq AS seq
      FROM audit_event_outbox WHERE source='governance' ORDER BY outbox_seq
    `).all() as OutboxRow[];
  } finally {
    reader.close();
  }
}

describe("governance audit outbox approval requests", () => {
  it("mirrors command and staged-merge requests into the outbox in the same transaction", () => {
    const firstSeq = nextOutboxSeq();
    insertCommandApproval({ approvalId: "approval-command-1", executionId: "execution-1" });
    insertStagedMergeApproval({ approvalId: "approval-staged-1", executionId: "execution-2" });

    const rows = governanceRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.eventType)).toEqual([
      "approval_requested",
      "approval_requested",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([firstSeq, firstSeq + 1]);
    expect(new Set(rows.map((row) => row.projectId))).toEqual(new Set([PROJECT_ID]));
    expect(new Set(rows.map((row) => row.occurredAt))).toEqual(new Set([NOW]));

    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      approvalId: "approval-command-1",
      executionId: "execution-1",
      kind: "command",
      occurredAt: NOW,
      type: "approval_requested",
    });
    expect(JSON.parse(rows[1]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      approvalId: "approval-staged-1",
      executionId: "execution-2",
      kind: "staged_merge",
      occurredAt: NOW,
      type: "approval_requested",
    });

    // Command text, risk reasons, and hashes never enter the audit payload.
    for (const row of rows) {
      expect(row.payloadJson).not.toContain("rm -rf");
      expect(row.payloadJson).not.toContain("destructive");
      expect(row.payloadJson).not.toContain(HASH);
      expect(row.payloadJson).not.toContain(HASH_B);
    }
  });
});

describe("governance audit outbox approval verdicts", () => {
  it("mirrors approved and rejected verdicts, and stays silent on no-op updates", () => {
    const firstSeq = nextOutboxSeq();
    insertCommandApproval({ approvalId: "approval-approve-1", executionId: "execution-1" });
    insertStagedMergeApproval({ approvalId: "approval-reject-1", executionId: "execution-2" });

    recordApprovalVerdict(database, {
      approvalId: "approval-approve-1",
      expectedStatus: "pending",
      nextStatus: "approved",
    });
    recordApprovalVerdict(database, {
      approvalId: "approval-reject-1",
      expectedStatus: "pending",
      nextStatus: "rejected",
    });
    // No-op: the approval is already decided, so the update matches nothing.
    recordApprovalVerdict(database, {
      approvalId: "approval-approve-1",
      expectedStatus: "pending",
      nextStatus: "approved",
    });

    const rows = governanceRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "approval_requested",
      "approval_requested",
      "approval_approved",
      "approval_rejected",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([
      firstSeq,
      firstSeq + 1,
      firstSeq + 2,
      firstSeq + 3,
    ]);

    expect(JSON.parse(rows[2]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      approvalId: "approval-approve-1",
      decision: "approved",
      executionId: "execution-1",
      kind: "command",
      occurredAt: NOW,
      type: "approval_approved",
    });
    expect(JSON.parse(rows[3]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      approvalId: "approval-reject-1",
      decision: "rejected",
      executionId: "execution-2",
      kind: "staged_merge",
      occurredAt: NOW,
      type: "approval_rejected",
    });
  });
});

describe("governance audit outbox approval expiry", () => {
  it("writes one scoped row per expire call site and stays silent on no-ops", () => {
    const firstSeq = nextOutboxSeq();
    insertCommandApproval({ approvalId: "approval-exp-single", executionId: "execution-1" });
    insertStagedMergeApproval({
      approvalId: "approval-exp-approved",
      executionId: "execution-2",
    });
    insertCommandApproval({
      agentId: AGENT_C,
      approvalId: "approval-exp-execution",
      executionId: "execution-3",
    });
    insertStagedMergeApproval({
      agentId: AGENT_D,
      approvalId: "approval-exp-at",
      executionId: "execution-4",
    });
    insertCommandApproval({
      agentId: AGENT_E,
      approvalId: "approval-exp-project",
      executionId: "execution-5",
    });
    recordApprovalVerdict(database, {
      approvalId: "approval-exp-approved",
      expectedStatus: "pending",
      nextStatus: "approved",
    });

    expireOpenApprovalById(database, "approval-exp-single");
    expireApprovedApprovalById(database, "approval-exp-approved");
    expireOpenApprovalsForExecution(database, "execution-3");
    expireOpenApprovalsForExecutionAt(database, "execution-4", "2026-08-13T02:30:00.000Z");
    expireOpenApprovalsForProjectExecution(database, PROJECT_ID, "execution-5");
    // No-op: the approval is already expired, so the update matches nothing.
    expireOpenApprovalById(database, "approval-exp-single");

    const rows = governanceRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "approval_requested",
      "approval_requested",
      "approval_requested",
      "approval_requested",
      "approval_requested",
      "approval_approved",
      "approval_expired",
      "approval_expired",
      "approval_expired",
      "approval_expired",
      "approval_expired",
    ]);
    expect(rows.map((row) => row.seq)).toEqual(
      Array.from({ length: 11 }, (_, index) => firstSeq + index),
    );

    const expired = rows.slice(6).map((row) => JSON.parse(row.payloadJson));
    expect(expired).toEqual([
      {
        actorId: null,
        actorType: "owner",
        approvalId: "approval-exp-single",
        executionId: "execution-1",
        kind: "command",
        occurredAt: NOW,
        scope: "single",
        type: "approval_expired",
      },
      {
        actorId: null,
        actorType: "owner",
        approvalId: "approval-exp-approved",
        executionId: "execution-2",
        kind: "staged_merge",
        occurredAt: NOW,
        scope: "single",
        type: "approval_expired",
      },
      {
        actorId: null,
        actorType: "owner",
        approvalId: "approval-exp-execution",
        executionId: "execution-3",
        kind: "command",
        occurredAt: NOW,
        scope: "execution",
        type: "approval_expired",
      },
      {
        actorId: null,
        actorType: "owner",
        approvalId: "approval-exp-at",
        executionId: "execution-4",
        kind: "staged_merge",
        occurredAt: "2026-08-13T02:30:00.000Z",
        scope: "execution",
        type: "approval_expired",
      },
      {
        actorId: null,
        actorType: "owner",
        approvalId: "approval-exp-project",
        executionId: "execution-5",
        kind: "command",
        occurredAt: NOW,
        scope: "project",
        type: "approval_expired",
      },
    ]);
  });
});

describe("governance audit outbox approval consumption", () => {
  it("mirrors consumes for both kinds and stays silent on no-op updates", () => {
    const firstSeq = nextOutboxSeq();
    insertCommandApproval({ approvalId: "approval-consume-1", executionId: "execution-1" });
    insertStagedMergeApproval({ approvalId: "approval-consume-2", executionId: "execution-2" });
    recordApprovalVerdict(database, {
      approvalId: "approval-consume-1",
      expectedStatus: "pending",
      nextStatus: "approved",
    });
    recordApprovalVerdict(database, {
      approvalId: "approval-consume-2",
      expectedStatus: "pending",
      nextStatus: "approved",
    });

    consumeApprovedApprovalById(database, "approval-consume-1");
    consumeStagedMergeApproval(database, {
      attemptId: "attempt-execution-2",
      executionId: "execution-2",
      projectId: PROJECT_ID,
      stagedHash: HASH_B,
    });
    // No-op: the approval is already consumed, so the update matches nothing.
    consumeApprovedApprovalById(database, "approval-consume-1");

    const rows = governanceRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "approval_requested",
      "approval_requested",
      "approval_approved",
      "approval_approved",
      "approval_consumed",
      "approval_consumed",
    ]);
    expect(rows.map((row) => row.seq)).toEqual(
      Array.from({ length: 6 }, (_, index) => firstSeq + index),
    );

    expect(JSON.parse(rows[4]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      approvalId: "approval-consume-1",
      executionId: "execution-1",
      kind: "command",
      occurredAt: NOW,
      type: "approval_consumed",
    });
    expect(JSON.parse(rows[5]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      approvalId: "approval-consume-2",
      executionId: "execution-2",
      kind: "staged_merge",
      occurredAt: NOW,
      type: "approval_consumed",
    });
  });
});

describe("governance audit outbox discipline", () => {
  it("rolls the outbox row back with the domain write in the same transaction", () => {
    const attemptId = "attempt-execution-tx";
    seedExecution({ agentId: AGENT_A, attemptId, executionId: "execution-tx" });
    seedCommandToolCall({
      attemptId,
      executionId: "execution-tx",
      toolCallId: "tool-call-execution-tx",
    });

    database.exec("BEGIN IMMEDIATE");
    insertCommandApprovalRequest(database, {
      approvalId: "approval-tx",
      attemptId,
      executionId: "execution-tx",
      inputHash: HASH,
      projectId: PROJECT_ID,
      publicRequestJson: "{}",
      requestHash: HASH,
      toolCallId: "tool-call-execution-tx",
    });
    database.exec("ROLLBACK");

    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM execution_approvals WHERE id='approval-tx'",
    ).get()).toEqual({ count: 0 });
    expect(governanceRows()).toHaveLength(0);

    database.exec("BEGIN IMMEDIATE");
    insertCommandApprovalRequest(database, {
      approvalId: "approval-tx",
      attemptId,
      executionId: "execution-tx",
      inputHash: HASH,
      projectId: PROJECT_ID,
      publicRequestJson: "{}",
      requestHash: HASH,
      toolCallId: "tool-call-execution-tx",
    });
    database.exec("COMMIT");

    expect(database.prepare(
      "SELECT status FROM execution_approvals WHERE id='approval-tx'",
    ).get()).toEqual({ status: "pending" });
    expect(governanceRows().map((row) => row.eventType)).toEqual(["approval_requested"]);
  });

  it("keeps exactly the whitelisted keys and drops malformed values fail-closed", () => {
    const firstSeq = nextOutboxSeq();
    appendGovernanceAuditOutboxRow(database, {
      eventType: "approval_requested",
      projectId: PROJECT_ID,
      sourcePayload: {
        approvalId: "approval-whitelist",
        command: "rm -rf ~/secrets",
        executionId: "execution-whitelist",
        hostPath: "D:\\cool-ai",
        kind: "command",
        list: ["not", "public"],
        nested: { not: "public" },
        notANumber: Number.NaN,
        requestHash: HASH,
        riskLevel: "high",
      },
    });
    // Unknown event types never enter the trail.
    appendGovernanceAuditOutboxRow(database, {
      eventType: "approval_browsed",
      projectId: PROJECT_ID,
      sourcePayload: { kind: "command" },
    });

    const rows = governanceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seq).toBe(firstSeq);
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      approvalId: "approval-whitelist",
      executionId: "execution-whitelist",
      kind: "command",
      occurredAt: NOW,
      riskLevel: "high",
      type: "approval_requested",
    });
  });

  it("truncates oversized text to 200 graphemes and redacts credential-like text", () => {
    appendGovernanceAuditOutboxRow(database, {
      eventType: "approval_requested",
      projectId: PROJECT_ID,
      sourcePayload: { kind: "x".repeat(250) },
    });
    appendGovernanceAuditOutboxRow(database, {
      eventType: "approval_requested",
      projectId: PROJECT_ID,
      sourcePayload: { kind: "leaked provider-key-governance-audit inside" },
    });

    const rows = governanceRows();
    expect(rows).toHaveLength(2);
    const truncated = JSON.parse(rows[0]!.payloadJson) as { kind: string };
    expect(truncated.kind).toBe(`${"x".repeat(200)}…`);
    expect(Array.from(truncated.kind)).toHaveLength(201);
    const redacted = JSON.parse(rows[1]!.payloadJson) as { kind: string };
    expect(redacted.kind).toBe("[redacted]");
  });

  it("reopens idempotently and continues the shared sequence", () => {
    insertCommandApproval({ approvalId: "approval-reopen-1", executionId: "execution-1" });
    const before = governanceRows();
    expect(before).toHaveLength(1);

    database.close();
    database = openDatabase(databasePath);

    expect(governanceRows()).toEqual(before);
    insertStagedMergeApproval({ approvalId: "approval-reopen-2", executionId: "execution-2" });
    const after = governanceRows();
    expect(after).toHaveLength(2);
    expect(after.map((row) => row.seq)).toEqual([before[0]!.seq, before[0]!.seq + 1]);
  });
});
