import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { insertCommandApprovalRequest } from "@/src/adapters/outbound/sqlite/governance/approval-store";
import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import {
  CLASSIFIER_VERSION,
  classifyExecutionCommand,
  commandTupleHash,
  normalizeRelativeWorkdir,
  type CommandPolicyContext,
  type StandingPolicyEntry,
} from "@/src/server/execution/command-policy";

type CommandRequestInput = {
  command: {
    args: string[];
    executable: string;
    executableIdentity: string;
    expectedEffect: string;
    workdir: string;
  };
  completedResponseBody?: unknown;
  contextHash: string;
  database: DatabaseSync;
  deniedResponseBody?: unknown;
  executionId?: string;
  expectedVersion: number;
  operationId: string;
  operationRequestHash?: string;
  policyContext: CommandPolicyContext;
  projectId: string;
};

export type CommandRequestResult = {
  actionId: string | null;
  approvalId: string | null;
  decision: "denied" | "one_shot" | "standing_exact";
  reasonCode: string | null;
  requestHash: string;
  toolCallId: string | null;
};

type ExecutionCommandRow = {
  attemptId: string;
  attemptNo: number;
  attemptStatus: string;
  businessDeadlineAt: string | null;
  businessRound: number;
  canExecute: number;
  contextHash: string;
  executionId: string;
  executionVersion: number;
  frozenPolicyHash: string;
  frozenPolicyRevisionId: string;
  frozenPolicyVersion: number;
  policyClassifierVersion: number;
  sandboxManifestHash: string | null;
  status: string;
};

export class CommandRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "CommandRequestError";
  }
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the stable command request error.
    }
    throw error;
  }
}

function validHash(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function validateInput(input: CommandRequestInput): void {
  const command = input.command;
  if (
    !input
    || typeof input.projectId !== "string"
    || typeof input.operationId !== "string"
    || !Number.isInteger(input.expectedVersion)
    || input.expectedVersion < 1
    || !validHash(input.contextHash)
    || !command
    || typeof command.executable !== "string"
    || Buffer.byteLength(command.executable, "utf8") < 1
    || Buffer.byteLength(command.executable, "utf8") > 4096
    || !validHash(command.executableIdentity)
    || !Array.isArray(command.args)
    || command.args.length > 64
    || typeof command.workdir !== "string"
    || typeof command.expectedEffect !== "string"
    || Buffer.byteLength(command.expectedEffect, "utf8") < 1
    || Buffer.byteLength(command.expectedEffect, "utf8") > 2000
  ) {
    throw new CommandRequestError("INVALID_INPUT", "Command request input is invalid.");
  }
  let argumentBytes = 0;
  for (const argument of command.args) {
    if (typeof argument !== "string" || Buffer.byteLength(argument, "utf8") > 4096) {
      throw new CommandRequestError("INVALID_INPUT", "Command argument is invalid.");
    }
    argumentBytes += Buffer.byteLength(argument, "utf8");
  }
  if (argumentBytes > 32_768) {
    throw new CommandRequestError("INVALID_INPUT", "Command arguments exceed 32768 bytes.");
  }
}

function commandRow(
  database: DatabaseSync,
  projectId: string,
  executionId?: string,
): ExecutionCommandRow {
  const row = database.prepare(`
    SELECT e.id AS executionId,e.status,e.version AS executionVersion,
           e.current_attempt_no AS attemptNo,e.business_round_count AS businessRound,
           e.business_deadline_at AS businessDeadlineAt,
           a.id AS attemptId,a.status AS attemptStatus,
           a.frozen_context_hash AS contextHash,
           a.sandbox_manifest_hash AS sandboxManifestHash,
           a.frozen_policy_revision_id AS frozenPolicyRevisionId,
           a.frozen_policy_version AS frozenPolicyVersion,
           a.frozen_policy_hash AS frozenPolicyHash,
           r.classifier_version AS policyClassifierVersion,
           agents.can_execute AS canExecute
    FROM executions e
    JOIN execution_attempts a
      ON a.project_id=e.project_id AND a.execution_id=e.id
     AND a.attempt_no=e.current_attempt_no
    JOIN project_validation_policy_revisions r
      ON r.project_id=a.project_id AND r.id=a.frozen_policy_revision_id
    JOIN agents ON agents.id=e.agent_id
    WHERE e.project_id=? AND (? IS NULL OR e.id=?)
  `).get(projectId, executionId ?? null, executionId ?? null) as ExecutionCommandRow | undefined;
  if (!row) {
    throw new CommandRequestError("EXECUTION_NOT_FOUND", "Execution was not found.");
  }
  return row;
}

function loadStandingEntries(
  database: DatabaseSync,
  projectId: string,
  row: ExecutionCommandRow,
): StandingPolicyEntry[] {
  if (row.policyClassifierVersion !== CLASSIFIER_VERSION) return [];
  const entries = database.prepare(`
    SELECT executable,executable_identity AS executableIdentity,args_json AS argsJson,
           workdir,required,tuple_hash AS tupleHash
    FROM project_validation_policy_entries
    WHERE project_id=? AND revision_id=? ORDER BY position
  `).all(projectId, row.frozenPolicyRevisionId) as Array<{
    argsJson: string;
    executable: string;
    executableIdentity: string;
    required: number;
    tupleHash: string;
    workdir: string;
  }>;
  return entries.flatMap((entry) => {
    let args: unknown;
    try {
      args = JSON.parse(entry.argsJson);
    } catch {
      return [];
    }
    if (!Array.isArray(args) || !args.every((value) => typeof value === "string")) return [];
    const value: StandingPolicyEntry = {
      args,
      executable: entry.executable,
      executableIdentity: entry.executableIdentity,
      required: entry.required === 1,
      tupleHash: entry.tupleHash,
      workdir: entry.workdir,
    };
    return commandTupleHash(value) === value.tupleHash ? [value] : [];
  });
}

function insertEvent(
  database: DatabaseSync,
  input: {
    attemptNo: number;
    executionId: string;
    payload: unknown;
    projectId: string;
    sequence: number;
    type: string;
  },
): void {
  database.prepare(`
    INSERT INTO execution_events (
      id,project_id,execution_id,sequence,attempt_no,type,actor_type,
      actor_id,payload_json,created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'agent', NULL, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    randomUUID(),
    input.projectId,
    input.executionId,
    input.sequence,
    input.attemptNo,
    input.type,
    JSON.stringify(input.payload),
  );
}

export function requestExecutionCommand(input: CommandRequestInput): CommandRequestResult {
  validateInput(input);
  return transaction(input.database, () => {
    const row = commandRow(input.database, input.projectId, input.executionId);
    const recovery = input.database.prepare(`
      SELECT manual_recovery_required AS required FROM executions WHERE id=?
    `).get(row.executionId) as { required: number };
    if (recovery.required === 1) {
      throw new CommandRequestError(
        "MANUAL_RECOVERY_REQUIRED",
        "Only an exact manual recovery resolution is allowed.",
        row.executionVersion,
      );
    }
    if (row.status !== "running" || !["acting", "ready"].includes(row.attemptStatus)) {
      throw new CommandRequestError(
        "EXECUTION_STATE_CONFLICT",
        "Execution cannot accept a command request in its current state.",
        row.executionVersion,
      );
    }
    if (row.executionVersion !== input.expectedVersion) {
      throw new CommandRequestError(
        "EXECUTION_STATE_CONFLICT",
        "Execution changed concurrently.",
        row.executionVersion,
      );
    }
    if (row.contextHash !== input.contextHash) {
      throw new CommandRequestError("STALE_EXECUTION", "Command context hash is stale.");
    }
    if (!row.sandboxManifestHash || !validHash(row.sandboxManifestHash)) {
      throw new CommandRequestError(
        "SANDBOX_UNVERIFIABLE",
        "The current sandbox manifest is unavailable.",
        row.executionVersion,
      );
    }
    const openApproval = input.database.prepare(`
      SELECT 1 FROM execution_approvals
      WHERE execution_id=? AND status IN ('pending','approved')
    `).get(row.executionId);
    if (openApproval) {
      throw new CommandRequestError(
        "APPROVAL_STATE_CONFLICT",
        "Execution already has an open approval request.",
      );
    }

    let normalizedWorkdir: string;
    try {
      normalizedWorkdir = normalizeRelativeWorkdir(input.command.workdir);
    } catch {
      normalizedWorkdir = input.command.workdir;
    }
    const command = { ...input.command, workdir: normalizedWorkdir };
    const entries = loadStandingEntries(input.database, input.projectId, row);
    const classification = classifyExecutionCommand(command, entries, input.policyContext);
    const permissionDenied = row.canExecute !== 1;
    const reasonCode = permissionDenied ? "AGENT_PERMISSION_REQUIRED" : classification.code;
    const decision = reasonCode ? "denied" : classification.decision;
    if (decision !== "denied" && decision !== "one_shot" && decision !== "standing_exact") {
      throw new CommandRequestError("INTERNAL_ERROR", "Unexpected command classification.");
    }
    const policySource = {
      hash: row.frozenPolicyHash,
      revisionId: row.frozenPolicyRevisionId,
      version: row.frozenPolicyVersion,
    };
    const requestHash = canonicalRequestHash({
      agentPermission: "execute",
      args: command.args,
      attemptId: row.attemptId,
      attemptNo: row.attemptNo,
      classifierVersion: classification.classifierVersion,
      contextHash: input.contextHash,
      executable: command.executable,
      executableIdentity: command.executableIdentity,
      expectedEffect: command.expectedEffect,
      kind: "command_request",
      parseResult: classification.parseResult,
      policySource,
      projectId: input.projectId,
      riskReasons: classification.riskReasons,
      workdir: command.workdir,
    });
    const operationRequestHash = input.operationRequestHash ?? requestHash;
    const publicRequest = {
      agentPermission: "execute" as const,
      args: command.args,
      attemptId: row.attemptId,
      attemptNo: row.attemptNo,
      classifierVersion: classification.classifierVersion,
      contextHash: input.contextHash,
      executable: command.executable,
      executableIdentity: command.executableIdentity,
      expectedEffect: command.expectedEffect,
      inputHash: row.sandboxManifestHash,
      policySource,
      riskReasons: classification.riskReasons,
      type: "command" as const,
      workdir: command.workdir,
    };

    if (reasonCode) {
      const updated = input.database.prepare(`
        UPDATE executions
        SET status='paused',resume_target='running',reason_code=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1
        WHERE project_id=? AND id=? AND version=? AND status='running'
      `).run(reasonCode, input.projectId, row.executionId, row.executionVersion);
      if (updated.changes !== 1) {
        throw new CommandRequestError("EXECUTION_STATE_CONFLICT", "Execution changed.");
      }
      const deniedResult: CommandRequestResult = {
        actionId: null,
        approvalId: null,
        decision: "denied",
        reasonCode,
        requestHash,
        toolCallId: null,
      };
      input.database.prepare(`
        INSERT INTO execution_operations (
          id,project_id,execution_id,kind,request_hash,has_external_actions,
          action_count,final_action_index,status,http_status,response_json,created_at,updated_at
        ) VALUES (?, ?, ?, 'advance', ?, 0, 0, NULL, 'completed', 403, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        input.operationId,
        input.projectId,
        row.executionId,
        operationRequestHash,
        JSON.stringify(input.deniedResponseBody ?? deniedResult),
      );
      return deniedResult;
    }

    const toolCallId = randomUUID();
    const eventSequence = Number((input.database.prepare(`
      SELECT next_event_sequence AS sequence FROM executions
      WHERE project_id=? AND id=?
    `).get(input.projectId, row.executionId) as { sequence: number }).sequence);
    if (decision === "standing_exact") {
      const actionId = randomUUID();
      input.database.prepare(`
        INSERT INTO execution_operations (
          id,project_id,execution_id,kind,request_hash,has_external_actions,
          action_count,final_action_index,status,http_status,response_json,created_at,updated_at
        ) VALUES (?, ?, ?, 'advance', ?, 1, 1, NULL, 'pending', NULL, NULL,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(input.operationId, input.projectId, row.executionId, operationRequestHash);
      input.database.prepare(`
        INSERT INTO execution_actions (
          id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
          request_hash,overall_deadline_at,created_at
        ) VALUES (?, ?, ?, ?, ?, 0, 'command', 'pending', ?,
          min(strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds'),?),
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        actionId,
        input.projectId,
        row.executionId,
        row.attemptId,
        input.operationId,
        requestHash,
        row.businessDeadlineAt ?? "9999-12-31T23:59:59.999Z",
      );
      input.database.prepare(`
        INSERT INTO execution_tool_calls (
          id,project_id,execution_id,attempt_id,action_id,business_round,type,
          request_hash,status,public_request_json,public_result_json,
          before_sandbox_hash,after_sandbox_hash,started_at,finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'command', ?, 'requested', ?, NULL, ?, NULL,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL)
      `).run(
        toolCallId,
        input.projectId,
        row.executionId,
        row.attemptId,
        actionId,
        Math.max(1, row.businessRound),
        requestHash,
        JSON.stringify(publicRequest),
        row.sandboxManifestHash,
      );
      const updated = input.database.prepare(`
        UPDATE executions
        SET tool_call_count=tool_call_count+1,
            next_event_sequence=next_event_sequence+1,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1
        WHERE project_id=? AND id=? AND version=? AND status='running'
      `).run(input.projectId, row.executionId, row.executionVersion);
      if (updated.changes !== 1) throw new CommandRequestError("EXECUTION_STATE_CONFLICT", "Execution changed.");
      insertEvent(input.database, {
        attemptNo: row.attemptNo,
        executionId: row.executionId,
        payload: {
          requestSummary: { authorization: "standing_policy", requestHash },
          toolCallId,
          type: "command",
        },
        projectId: input.projectId,
        sequence: eventSequence,
        type: "tool_requested",
      });
      return {
        actionId,
        approvalId: null,
        decision: "standing_exact",
        reasonCode: null,
        requestHash,
        toolCallId,
      };
    }

    const approvalId = randomUUID();
    const approvalRequest = {
      ...publicRequest,
      parseResult: classification.parseResult,
      requestHash,
    };
    input.database.prepare(`
      INSERT INTO execution_operations (
        id,project_id,execution_id,kind,request_hash,has_external_actions,
        action_count,final_action_index,status,http_status,response_json,created_at,updated_at
      ) VALUES (?, ?, ?, 'advance', ?, 0, 0, NULL, 'completed', 200, ?,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      input.operationId,
      input.projectId,
      row.executionId,
      operationRequestHash,
      JSON.stringify(input.completedResponseBody ?? {}),
    );
    input.database.prepare(`
      INSERT INTO execution_tool_calls (
        id,project_id,execution_id,attempt_id,action_id,business_round,type,
        request_hash,status,public_request_json,public_result_json,
        before_sandbox_hash,after_sandbox_hash,started_at,finished_at
      ) VALUES (?, ?, ?, ?, NULL, ?, 'command', ?, 'waiting_approval', ?, NULL,
        ?,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL)
    `).run(
      toolCallId,
      input.projectId,
      row.executionId,
      row.attemptId,
      Math.max(1, row.businessRound),
      requestHash,
      JSON.stringify(publicRequest),
      row.sandboxManifestHash,
    );
    insertCommandApprovalRequest(input.database, {
      approvalId,
      attemptId: row.attemptId,
      executionId: row.executionId,
      inputHash: row.sandboxManifestHash,
      projectId: input.projectId,
      publicRequestJson: JSON.stringify(approvalRequest),
      requestHash,
      toolCallId,
    });
    const updated = input.database.prepare(`
      UPDATE executions
      SET status='waiting_approval',resume_target=NULL,
          reason_code='COMMAND_APPROVAL_REQUIRED',
          tool_call_count=tool_call_count+1,
          next_event_sequence=next_event_sequence+2,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1
      WHERE project_id=? AND id=? AND version=? AND status='running'
    `).run(input.projectId, row.executionId, row.executionVersion);
    if (updated.changes !== 1) throw new CommandRequestError("EXECUTION_STATE_CONFLICT", "Execution changed.");
    insertEvent(input.database, {
      attemptNo: row.attemptNo,
      executionId: row.executionId,
      payload: {
        requestSummary: { authorization: "one_shot", requestHash },
        toolCallId,
        type: "command",
      },
      projectId: input.projectId,
      sequence: eventSequence,
      type: "tool_requested",
    });
    insertEvent(input.database, {
      attemptNo: row.attemptNo,
      executionId: row.executionId,
      payload: {
        approvalId,
        kind: "command",
        requestHash,
        riskReasons: classification.riskReasons,
      },
      projectId: input.projectId,
      sequence: eventSequence + 1,
      type: "approval_requested",
    });
    return {
      actionId: null,
      approvalId,
      decision: "one_shot",
      reasonCode: null,
      requestHash,
      toolCallId,
    };
  });
}
