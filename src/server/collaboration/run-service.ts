import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  collaborationErrorBody,
  CollaborationError,
} from "@/src/server/collaboration/collaboration-errors";
import {
  canonicalRequestHash,
  completeOperationReceipt,
  readOperationReceipt,
} from "@/src/server/collaboration/operation-receipts";
import {
  reconcileExpiredAttempt,
  reconcileProjectExpiredAttempt,
} from "@/src/server/collaboration/turn-orchestrator";
import {
  createCredentialVault,
  type CredentialEnvelope,
} from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import type {
  AnswerDecisionResponse,
  CollaborationReadResponse,
  CollaborationRun,
  CursorPage,
  DecisionRequest,
  ProjectMessageResponse,
  ProjectMessage,
  StartCollaborationResponse,
  TimelineEvent,
  TimelineEventType,
  UsageTotals,
} from "@/src/shared/collaboration-contracts";
import { timelinePayloadSchemas } from "@/src/shared/collaboration-contracts";

type StartInput = {
  operationId: string;
  message: string;
  mentionAgentId?: string;
};

type MessageInput = {
  operationId: string;
  content: string;
  mentionAgentId?: string;
};

type ControlInput = {
  operationId: string;
  action: "pause" | "continue" | "retry" | "stop";
  expectedVersion: number;
};

type AnswerDecisionInput = {
  operationId: string;
  answer: string;
  mentionAgentId?: string;
  expectedVersion: number;
};

export type ControlRunResponse = {
  run: CollaborationRun;
};

type RunRow = {
  id: string;
  projectId: string;
  status: CollaborationRun["status"];
  currentAgentId: string;
  roundCount: number;
  pauseCategory: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type MessageRow = Omit<ProjectMessage, "mentionMemberStatus">;
type EventRow = {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  actorType: "owner" | "agent" | "system";
  actorId: string | null;
  payloadJson: string;
  createdAt: string;
};
type DecisionRow = Omit<DecisionRequest, "options"> & { optionsJson: string };

export type ReadCursor = {
  after: number;
  limit: number;
};

export type CollaborationReadOptions = {
  messages?: ReadCursor;
  events?: ReadCursor;
};

export { CollaborationError } from "@/src/server/collaboration/collaboration-errors";

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
      // Preserve the stable collaboration error.
    }
    throw error;
  }
}

function graphemeLength(value: string): number {
  return Array.from(new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(value))
    .length;
}

function parseStartInput(input: unknown): Required<StartInput> {
  if (!input || typeof input !== "object") {
    throw new CollaborationError("INVALID_INPUT", 400, "Collaboration input is invalid.");
  }
  const value = input as Record<string, unknown>;
  const operationId = typeof value.operationId === "string" ? value.operationId : "";
  const message = typeof value.message === "string" ? value.message.trim() : "";
  const mentionAgentId =
    value.mentionAgentId === undefined
      ? ""
      : typeof value.mentionAgentId === "string"
        ? value.mentionAgentId
        : "\0";
  const fields: Record<string, string> = {};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    fields.operationId = "invalid_format";
  }
  const length = graphemeLength(message);
  if (length === 0) fields.message = "required";
  else if (length > 10_000) fields.message = "too_long";
  if (mentionAgentId === "\0" || (mentionAgentId && mentionAgentId.length > 200)) {
    fields.mentionAgentId = "invalid_format";
  }
  if (Object.keys(fields).length > 0) {
    throw new CollaborationError(
      "INVALID_INPUT",
      400,
      "Collaboration input is invalid.",
      { fields },
    );
  }
  return { message, mentionAgentId, operationId };
}

function parseMessageInput(input: unknown): Required<MessageInput> {
  if (!input || typeof input !== "object") {
    throw new CollaborationError("INVALID_INPUT", 400, "Project message input is invalid.");
  }
  const value = input as Record<string, unknown>;
  const operationId = typeof value.operationId === "string" ? value.operationId : "";
  const content = typeof value.content === "string" ? value.content.trim() : "";
  const mentionAgentId =
    value.mentionAgentId === undefined
      ? ""
      : typeof value.mentionAgentId === "string"
        ? value.mentionAgentId
        : "\0";
  const fields: Record<string, string> = {};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    fields.operationId = "invalid_format";
  }
  const length = graphemeLength(content);
  if (length === 0) fields.content = "required";
  else if (length > 10_000) fields.content = "too_long";
  if (mentionAgentId === "\0" || (mentionAgentId && mentionAgentId.length > 200)) {
    fields.mentionAgentId = "invalid_format";
  }
  if (Object.keys(fields).length > 0) {
    throw new CollaborationError(
      "INVALID_INPUT",
      400,
      "Project message input is invalid.",
      { fields },
    );
  }
  return { content, mentionAgentId, operationId };
}

function parseControlInput(input: unknown): ControlInput {
  if (!input || typeof input !== "object") {
    throw new CollaborationError("INVALID_INPUT", 400, "Run control input is invalid.");
  }
  const value = input as Record<string, unknown>;
  const operationId = typeof value.operationId === "string" ? value.operationId : "";
  const action =
    value.action === "pause" ||
    value.action === "continue" ||
    value.action === "retry" ||
    value.action === "stop"
      ? value.action
      : null;
  const expectedVersion = value.expectedVersion;
  const fields: Record<string, string> = {};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    fields.operationId = "invalid_format";
  }
  if (!action) fields.action = "invalid_format";
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) {
    fields.expectedVersion = "invalid_format";
  }
  if (Object.keys(fields).length > 0) {
    throw new CollaborationError("INVALID_INPUT", 400, "Run control input is invalid.", {
      fields,
    });
  }
  return {
    action: action!,
    expectedVersion: Number(expectedVersion),
    operationId,
  };
}

function parseAnswerDecisionInput(input: unknown): Required<AnswerDecisionInput> {
  if (!input || typeof input !== "object") {
    throw new CollaborationError("INVALID_INPUT", 400, "Decision answer input is invalid.");
  }
  const value = input as Record<string, unknown>;
  const operationId = typeof value.operationId === "string" ? value.operationId : "";
  const answer = typeof value.answer === "string" ? value.answer.trim() : "";
  const mentionAgentId =
    value.mentionAgentId === undefined
      ? ""
      : typeof value.mentionAgentId === "string"
        ? value.mentionAgentId
        : "\0";
  const expectedVersion = value.expectedVersion;
  const fields: Record<string, string> = {};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    fields.operationId = "invalid_format";
  }
  const length = graphemeLength(answer);
  if (length === 0) fields.answer = "required";
  else if (length > 5_000) fields.answer = "too_long";
  if (mentionAgentId === "\0" || (mentionAgentId && mentionAgentId.length > 200)) {
    fields.mentionAgentId = "invalid_format";
  }
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) {
    fields.expectedVersion = "invalid_format";
  }
  if (Object.keys(fields).length > 0) {
    throw new CollaborationError("INVALID_INPUT", 400, "Decision answer input is invalid.", {
      fields,
    });
  }
  return {
    answer,
    expectedVersion: Number(expectedVersion),
    mentionAgentId,
    operationId,
  };
}

function runFromRow(row: RunRow): CollaborationRun {
  return { ...row };
}

function runById(database: DatabaseSync, runId: string): CollaborationRun {
  const row = database
    .prepare(
      `SELECT id, project_id AS projectId, status,
              current_agent_id AS currentAgentId, round_count AS roundCount,
              pause_category AS pauseCategory, version,
              created_at AS createdAt, updated_at AS updatedAt
       FROM collaboration_runs WHERE id = ?`,
    )
    .get(runId) as RunRow | undefined;
  if (!row) {
    throw new CollaborationError("RUN_NOT_FOUND", 404, "Collaboration run was not found.");
  }
  return runFromRow(row);
}

function decisionFromRow(row: DecisionRow): DecisionRequest {
  return {
    ...row,
    options: JSON.parse(row.optionsJson) as string[],
  };
}

function decisionById(
  database: DatabaseSync,
  runId: string,
  decisionId: string,
): DecisionRequest {
  const row = database
    .prepare(
      `SELECT id, run_id AS runId, turn_id AS turnId,
              requesting_agent_id AS requestingAgentId, question,
              options_json AS optionsJson, status, answer,
              answer_message_id AS answerMessageId, version,
              created_at AS createdAt, answered_at AS answeredAt
       FROM decision_requests WHERE id = ? AND run_id = ?`,
    )
    .get(decisionId, runId) as DecisionRow | undefined;
  if (!row) {
    throw new CollaborationError("DECISION_NOT_FOUND", 404, "Decision request was not found.");
  }
  return decisionFromRow(row);
}

function activeRun(database: DatabaseSync, projectId: string): CollaborationRun | null {
  const row = database
    .prepare(
      `SELECT id, project_id AS projectId, status,
              current_agent_id AS currentAgentId, round_count AS roundCount,
              pause_category AS pauseCategory, version,
              created_at AS createdAt, updated_at AS updatedAt
       FROM collaboration_runs
       WHERE project_id = ?
         AND status IN ('running','waiting_owner','paused','failed')
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(projectId) as RunRow | undefined;
  return row ? runFromRow(row) : null;
}

function currentRun(database: DatabaseSync, projectId: string): CollaborationRun | null {
  const row = database
    .prepare(
      `SELECT id, project_id AS projectId, status,
              current_agent_id AS currentAgentId, round_count AS roundCount,
              pause_category AS pauseCategory, version,
              created_at AS createdAt, updated_at AS updatedAt
       FROM collaboration_runs
       WHERE project_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(projectId) as RunRow | undefined;
  return row ? runFromRow(row) : null;
}

export function parseReadCursor(
  searchParams: URLSearchParams,
  afterName = "after",
  limitName = "limit",
): ReadCursor {
  const rawAfter = searchParams.get(afterName);
  const rawLimit = searchParams.get(limitName);
  const after = rawAfter === null || rawAfter === "" ? 0 : Number(rawAfter);
  const limit = rawLimit === null || rawLimit === "" ? 50 : Number(rawLimit);
  const fields: Record<string, string> = {};
  if (!Number.isSafeInteger(after) || after < 0) fields[afterName] = "invalid_format";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    fields[limitName] = "invalid_range";
  }
  if (Object.keys(fields).length > 0) {
    throw new CollaborationError("INVALID_INPUT", 400, "Pagination input is invalid.", {
      fields,
    });
  }
  return { after, limit };
}

function ensureProject(database: DatabaseSync, projectId: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw new CollaborationError("PROJECT_NOT_FOUND", 404, "Project was not found.");
  }
}

function readiness(database: DatabaseSync, projectId: string): { ready: boolean; missing: string[] } {
  ensureProject(database, projectId);
  const missing: string[] = [];
  const project = database
    .prepare("SELECT workspace_path AS workspacePath FROM projects WHERE id = ?")
    .get(projectId) as { workspacePath: string | null };
  if (!project.workspacePath) missing.push("workspace");
  const memberCount = (
    database
      .prepare("SELECT COUNT(*) AS count FROM project_memberships WHERE project_id = ?")
      .get(projectId) as { count: number }
  ).count;
  if (memberCount < 2) missing.push("members");
  if (!database.prepare("SELECT 1 FROM missions WHERE project_id = ?").get(projectId)) {
    missing.push("mission");
  }
  const unavailableProvider = database
    .prepare(
      `SELECT 1
       FROM project_memberships AS membership
       JOIN agents ON agents.id = membership.agent_id
       JOIN providers ON providers.id = agents.provider_id
       WHERE membership.project_id = ? AND providers.verified_at = ''
       LIMIT 1`,
    )
    .get(projectId);
  if (memberCount > 0 && unavailableProvider) missing.push("provider");
  return { missing, ready: missing.length === 0 };
}

function firstAgent(database: DatabaseSync, projectId: string, mentionAgentId: string): string {
  if (mentionAgentId) {
    const member = database
      .prepare(
        `SELECT agent_id AS agentId
         FROM project_memberships
         WHERE project_id = ? AND agent_id = ?`,
      )
      .get(projectId, mentionAgentId) as { agentId: string } | undefined;
    if (!member) {
      throw new CollaborationError("AGENT_NOT_MEMBER", 409, "Mentioned Agent is not a member.");
    }
    return member.agentId;
  }
  const member = database
    .prepare(
      `SELECT agent_id AS agentId
       FROM project_memberships
       WHERE project_id = ?
       ORDER BY joined_at ASC, agent_id ASC
       LIMIT 1`,
    )
    .get(projectId) as { agentId: string } | undefined;
  if (!member) {
    throw new CollaborationError("CONTEXT_NOT_READY", 409, "Collaboration context is not ready.");
  }
  return member.agentId;
}

function operationHash(input: Required<StartInput>): string {
  return canonicalRequestHash({
    mentionAgentId: input.mentionAgentId || null,
    message: input.message,
  });
}

function completedOperation(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
  requestHash: string,
): { body: StartCollaborationResponse; status: number } | null {
  return readOperationReceipt<StartCollaborationResponse>(
    database,
    projectId,
    operationId,
    "start",
    requestHash,
  );
}

function nextMessageSequence(database: DatabaseSync, projectId: string): number {
  database
    .prepare(
      `INSERT OR IGNORE INTO collaboration_project_sequences (
         project_id, next_message_sequence
       ) VALUES (?, 1)`,
    )
    .run(projectId);
  const sequence = (
    database
      .prepare(
        `SELECT next_message_sequence AS sequence
         FROM collaboration_project_sequences WHERE project_id = ?`,
      )
      .get(projectId) as { sequence: number }
  ).sequence;
  database
    .prepare(
      `UPDATE collaboration_project_sequences
       SET next_message_sequence = next_message_sequence + 1
       WHERE project_id = ?`,
    )
    .run(projectId);
  return sequence;
}

function mentionName(
  database: DatabaseSync,
  mentionAgentId: string,
): string | null {
  if (!mentionAgentId) return null;
  const row = database
    .prepare("SELECT name FROM agents WHERE id = ?")
    .get(mentionAgentId) as { name: string } | undefined;
  return row?.name ?? null;
}

function insertOwnerMessage(
  database: DatabaseSync,
  projectId: string,
  runId: string | null,
  input: { content: string; mentionAgentId: string },
  timestamp: string,
): ProjectMessage {
  const message: ProjectMessage = {
    authorAgentId: null,
    authorDisplayName: "Owner",
    authorType: "owner",
    content: input.content,
    createdAt: timestamp,
    id: randomUUID(),
    mentionAgentId: input.mentionAgentId || null,
    mentionDisplayName: mentionName(database, input.mentionAgentId),
    mentionMemberStatus: input.mentionAgentId ? "current" : null,
    runId,
    sequence: nextMessageSequence(database, projectId),
  };
  database
    .prepare(
      `INSERT INTO collaboration_messages (
         id, project_id, run_id, author_type, author_agent_id,
         author_display_name, content, mention_agent_id, mention_display_name,
         sequence, consumed_at, created_at
       ) VALUES (?, ?, ?, 'owner', NULL, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      message.id,
      projectId,
      runId,
      message.authorDisplayName,
      message.content,
      message.mentionAgentId,
      message.mentionDisplayName,
      message.sequence,
      message.createdAt,
    );
  return message;
}

function appendEvent(
  database: DatabaseSync,
  runId: string,
  type: TimelineEvent["type"],
  actorType: TimelineEvent["actorType"],
  actorId: string | null,
  payload: Record<string, string | number | null>,
  timestamp: string,
): void {
  const sequence = (
    database
      .prepare(
        `SELECT next_event_sequence AS sequence
         FROM collaboration_runs WHERE id = ?`,
      )
      .get(runId) as { sequence: number }
  ).sequence;
  database
    .prepare(
      `INSERT INTO collaboration_events (
         id, run_id, sequence, type, actor_type, actor_id, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), runId, sequence, type, actorType, actorId, JSON.stringify(payload), timestamp);
  database
    .prepare(
      `UPDATE collaboration_runs
       SET next_event_sequence = next_event_sequence + 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(timestamp, runId);
}

function ensureNoCallingAttempt(database: DatabaseSync, runId: string): void {
  if (
    database
      .prepare(
        `SELECT 1 FROM collaboration_attempts
         WHERE run_id = ? AND status = 'calling'`,
      )
      .get(runId)
  ) {
    throw new CollaborationError("TURN_IN_PROGRESS", 409, "An Agent turn is in progress.");
  }
}

function ensureProviderRetryReady(
  database: DatabaseSync,
  runId: string,
  currentAgentId: string,
  category: string,
): void {
  const failure = database
    .prepare(
      `SELECT failure_credential_generation AS credentialGeneration,
              failure_verified_at AS verifiedAt
       FROM collaboration_attempts
       WHERE run_id = ? AND status = 'failed' AND error_category = ?
       ORDER BY finished_at DESC, started_at DESC
       LIMIT 1`,
    )
    .get(runId, category) as
    | {
        credentialGeneration: number | null;
        verifiedAt: string | null;
      }
    | undefined;
  const provider = database
    .prepare(
      `SELECT providers.id AS providerId,
              providers.credential_version AS credentialVersion,
              providers.credential_generation AS credentialGeneration,
              providers.verified_at AS verifiedAt,
              providers.api_key_cipher AS apiKeyCipher,
              providers.api_key_iv AS apiKeyIv,
              providers.api_key_tag AS apiKeyTag,
              providers.api_key_mask AS apiKeyMask,
              providers.key_id AS keyId
       FROM agents
       JOIN providers ON providers.id = agents.provider_id
       WHERE agents.id = ?`,
    )
    .get(currentAgentId) as
    | {
        providerId: string;
        credentialVersion: number;
        credentialGeneration: number;
        verifiedAt: string;
        apiKeyCipher: string;
        apiKeyIv: string;
        apiKeyTag: string;
        apiKeyMask: string;
        keyId: string;
      }
    | undefined;
  const changed = Boolean(
    failure
      && provider
      && provider.verifiedAt
      && (
        provider.credentialGeneration > (failure.credentialGeneration ?? 0)
        || provider.verifiedAt > (failure.verifiedAt ?? "")
      ),
  );
  if (!provider || !changed) {
    throw new CollaborationError(
      "CREDENTIAL_UNAVAILABLE",
      503,
      "Provider credentials are unavailable.",
      { category: "credential_unavailable" },
    );
  }
  if (category === "credential_unavailable") {
    const envelope: CredentialEnvelope = {
      apiKeyCipher: provider.apiKeyCipher,
      apiKeyIv: provider.apiKeyIv,
      apiKeyMask: provider.apiKeyMask,
      apiKeyTag: provider.apiKeyTag,
      credentialVersion: provider.credentialVersion as 1,
      keyId: provider.keyId,
    };
    try {
      createCredentialVault().decrypt(provider.providerId, envelope);
    } catch {
      throw new CollaborationError(
        "CREDENTIAL_UNAVAILABLE",
        503,
        "Provider credentials are unavailable.",
        { category: "credential_unavailable" },
      );
    }
  }
}

function ensureBoundaryRetryReady(
  database: DatabaseSync,
  run: {
    id: string;
    currentAgentId: string;
    roundCount: number;
    pauseReason: string | null;
  },
): void {
  let reached = false;
  if (run.pauseReason === "rounds") {
    reached = run.roundCount >= 50;
  } else if (run.pauseReason === "handoffs") {
    const row = database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM collaboration_turns
         WHERE run_id = ? AND agent_id = ? AND disposition = 'handoff'`,
      )
      .get(run.id, run.currentAgentId) as { count: number };
    const agent = database
      .prepare("SELECT max_handoffs AS limitValue FROM agents WHERE id = ?")
      .get(run.currentAgentId) as { limitValue: number };
    reached = row.count >= agent.limitValue;
  } else if (run.pauseReason === "tokens") {
    const row = database
      .prepare(
        `SELECT COALESCE(SUM(calls.total_tokens), 0) AS total
         FROM collaboration_model_calls AS calls
         JOIN collaboration_attempts AS attempts ON attempts.id = calls.attempt_id
         WHERE attempts.run_id = ? AND attempts.agent_id = ?
           AND calls.total_tokens IS NOT NULL`,
      )
      .get(run.id, run.currentAgentId) as { total: number };
    const agent = database
      .prepare("SELECT max_tokens AS limitValue FROM agents WHERE id = ?")
      .get(run.currentAgentId) as { limitValue: number };
    reached = row.total >= agent.limitValue;
  }
  if (reached) {
    throw new CollaborationError(
      "BOUNDARY_REACHED",
      409,
      "Collaboration run boundary is still reached.",
      { category: "boundary_reached" },
    );
  }
}

export function controlRun(
  databasePath: string,
  runId: string,
  rawInput: unknown,
): { body: ControlRunResponse; status: number } {
  reconcileExpiredAttempt(databasePath, runId);
  const input = parseControlInput(rawInput);
  const requestHash = canonicalRequestHash({
    action: input.action,
    expectedVersion: input.expectedVersion,
  });
  const database = openDatabase(databasePath);
  let projectId: string | null = null;
  try {
    return transaction(database, () => {
      const row = database
        .prepare(
          `SELECT id, project_id AS projectId, status,
                  current_agent_id AS currentAgentId, round_count AS roundCount,
                  version, execution_epoch AS executionEpoch,
                  pause_category AS pauseCategory, pause_reason AS pauseReason
           FROM collaboration_runs WHERE id = ?`,
        )
        .get(runId) as
        | {
            id: string;
            projectId: string;
            status: CollaborationRun["status"];
            currentAgentId: string;
            roundCount: number;
            version: number;
            executionEpoch: number;
            pauseCategory: string | null;
            pauseReason: string | null;
          }
        | undefined;
      if (!row) {
        throw new CollaborationError("RUN_NOT_FOUND", 404, "Collaboration run was not found.");
      }
      projectId = row.projectId;
      const prior = readOperationReceipt<ControlRunResponse>(
        database,
        row.projectId,
        input.operationId,
        "control",
        requestHash,
      );
      if (prior) return prior;
      if (row.version !== input.expectedVersion) {
        throw new CollaborationError(
          "RUN_STATE_CONFLICT",
          409,
          "Collaboration run version is stale.",
          { currentVersion: row.version },
        );
      }
      if (row.status === "planned" || row.status === "stopped") {
        throw new CollaborationError(
          "RUN_STATE_CONFLICT",
          409,
          "Collaboration run is terminal.",
        );
      }

      let nextStatus: CollaborationRun["status"];
      let nextCategory: string | null;
      let eventType: TimelineEvent["type"];
      let eventPayload: Record<string, string | number | null>;
      if (input.action === "pause") {
        if (row.status !== "running") {
          throw new CollaborationError(
            "RUN_STATE_CONFLICT",
            409,
            "Only a running collaboration can be paused.",
          );
        }
        nextStatus = "paused";
        nextCategory = "manual";
        eventType = "run_paused";
        eventPayload = { category: "manual" };
      } else if (input.action === "continue") {
        if (row.status !== "paused" || row.pauseCategory !== "manual") {
          throw new CollaborationError(
            "RUN_STATE_CONFLICT",
            409,
            "Only a manual pause can continue.",
          );
        }
        ensureNoCallingAttempt(database, runId);
        nextStatus = "running";
        nextCategory = null;
        eventType = "run_resumed";
        eventPayload = { currentAgentId: row.currentAgentId };
      } else if (input.action === "retry") {
        if (
          !(
            row.status === "failed" ||
            (row.status === "paused" && row.pauseCategory !== "manual")
          )
        ) {
          throw new CollaborationError(
            "RUN_STATE_CONFLICT",
            409,
            "This collaboration run cannot be retried.",
          );
        }
        ensureNoCallingAttempt(database, runId);
        if (
          row.pauseCategory === "credential_unavailable" ||
          row.pauseCategory === "provider_auth" ||
          row.pauseCategory === "usage_invalid"
        ) {
          ensureProviderRetryReady(database, runId, row.currentAgentId, row.pauseCategory);
        }
        if (row.pauseCategory === "boundary_reached") {
          ensureBoundaryRetryReady(database, row);
        }
        nextStatus = "running";
        nextCategory = null;
        eventType = "run_retried";
        eventPayload = { currentAgentId: row.currentAgentId };
      } else {
        nextStatus = "stopped";
        nextCategory = null;
        eventType = "run_stopped";
        eventPayload = {};
      }

      const timestamp = new Date().toISOString();
      const update = database
        .prepare(
          `UPDATE collaboration_runs
           SET status = ?, pause_category = ?, pause_reason = NULL,
               version = version + 1, execution_epoch = execution_epoch + 1,
               updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(nextStatus, nextCategory, timestamp, runId, input.expectedVersion);
      if (update.changes !== 1) {
        const current = runById(database, runId);
        throw new CollaborationError(
          "RUN_STATE_CONFLICT",
          409,
          "Collaboration run version is stale.",
          { currentVersion: current.version },
        );
      }
      appendEvent(database, runId, eventType, "owner", null, eventPayload, timestamp);
      const body = { run: runById(database, runId) };
      completeOperationReceipt(database, {
        body,
        kind: "control",
        operationId: input.operationId,
        projectId: row.projectId,
        requestHash,
        runId,
        status: 200,
        timestamp,
      });
      return { body, status: 200 };
    });
  } catch (error) {
    if (
      projectId &&
      error instanceof CollaborationError &&
      error.code !== "OPERATION_CONFLICT" &&
      error.code !== "OPERATION_IN_PROGRESS"
    ) {
      const timestamp = new Date().toISOString();
      completeOperationReceipt(database, {
        body: collaborationErrorBody(error),
        kind: "control",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId,
        status: error.httpStatus,
        timestamp,
      });
    }
    throw error;
  } finally {
    database.close();
  }
}

export function answerDecision(
  databasePath: string,
  runId: string,
  decisionId: string,
  rawInput: unknown,
): { body: AnswerDecisionResponse; status: number } {
  reconcileExpiredAttempt(databasePath, runId);
  const input = parseAnswerDecisionInput(rawInput);
  const requestHash = canonicalRequestHash({
    answer: input.answer,
    expectedVersion: input.expectedVersion,
    mentionAgentId: input.mentionAgentId || null,
  });
  const database = openDatabase(databasePath);
  let projectId: string | null = null;
  try {
    return transaction(database, () => {
      const run = runById(database, runId);
      projectId = run.projectId;
      const prior = readOperationReceipt<AnswerDecisionResponse>(
        database,
        run.projectId,
        input.operationId,
        "answer_decision",
        requestHash,
      );
      if (prior) return prior;

      const decision = decisionById(database, runId, decisionId);
      if (decision.status === "answered") {
        throw new CollaborationError(
          "DECISION_ALREADY_ANSWERED",
          409,
          "Decision request was already answered.",
          { currentVersion: decision.version },
        );
      }
      if (decision.version !== input.expectedVersion) {
        throw new CollaborationError(
          "RUN_STATE_CONFLICT",
          409,
          "Decision request version is stale.",
          { currentVersion: decision.version },
        );
      }
      if (run.status !== "waiting_owner") {
        throw new CollaborationError(
          "RUN_STATE_CONFLICT",
          409,
          "Collaboration run is not waiting for an owner decision.",
          { currentVersion: decision.version },
        );
      }

      const nextAgentId = input.mentionAgentId || decision.requestingAgentId;
      const nextAgent = database
        .prepare(
          `SELECT agents.name
           FROM project_memberships AS memberships
           JOIN agents ON agents.id = memberships.agent_id
           WHERE memberships.project_id = ? AND memberships.agent_id = ?`,
        )
        .get(run.projectId, nextAgentId) as { name: string } | undefined;
      if (!nextAgent) {
        throw new CollaborationError(
          "AGENT_NOT_MEMBER",
          409,
          "Mentioned Agent is not a member.",
        );
      }

      const timestamp = new Date().toISOString();
      const message = insertOwnerMessage(
        database,
        run.projectId,
        runId,
        { content: input.answer, mentionAgentId: input.mentionAgentId },
        timestamp,
      );
      const decisionUpdate = database
        .prepare(
          `UPDATE decision_requests
           SET status = 'answered', answer = ?, answer_message_id = ?,
               version = version + 1, answered_at = ?
           WHERE id = ? AND run_id = ? AND status = 'open' AND version = ?`,
        )
        .run(
          input.answer,
          message.id,
          timestamp,
          decisionId,
          runId,
          input.expectedVersion,
        );
      if (decisionUpdate.changes !== 1) {
        const current = decisionById(database, runId, decisionId);
        throw new CollaborationError(
          current.status === "answered"
            ? "DECISION_ALREADY_ANSWERED"
            : "RUN_STATE_CONFLICT",
          409,
          current.status === "answered"
            ? "Decision request was already answered."
            : "Decision request version is stale.",
          { currentVersion: current.version },
        );
      }
      const runUpdate = database
        .prepare(
          `UPDATE collaboration_runs
           SET status = 'running', current_agent_id = ?,
               version = version + 1, updated_at = ?
           WHERE id = ? AND status = 'waiting_owner' AND version = ?`,
        )
        .run(nextAgentId, timestamp, runId, run.version);
      if (runUpdate.changes !== 1) {
        const current = runById(database, runId);
        throw new CollaborationError(
          "RUN_STATE_CONFLICT",
          409,
          "Collaboration run changed while answering.",
          { currentVersion: current.version },
        );
      }
      appendEvent(
        database,
        runId,
        "decision_answered",
        "owner",
        null,
        {
          answer: input.answer,
          decisionId,
          messageId: message.id,
          messageSequence: message.sequence,
          nextAgentId,
        },
        timestamp,
      );
      const body = {
        decision: decisionById(database, runId, decisionId),
        run: runById(database, runId),
      };
      completeOperationReceipt(database, {
        body,
        kind: "answer_decision",
        operationId: input.operationId,
        projectId: run.projectId,
        requestHash,
        runId,
        status: 200,
        timestamp,
      });
      return { body, status: 200 };
    });
  } catch (error) {
    if (
      projectId &&
      error instanceof CollaborationError &&
      error.code !== "OPERATION_CONFLICT" &&
      error.code !== "OPERATION_IN_PROGRESS"
    ) {
      const timestamp = new Date().toISOString();
      completeOperationReceipt(database, {
        body: collaborationErrorBody(error),
        kind: "answer_decision",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId,
        status: error.httpStatus,
        timestamp,
      });
    }
    throw error;
  } finally {
    database.close();
  }
}

export function createOrAppendRun(
  databasePath: string,
  projectId: string,
  rawInput: unknown,
): { body: StartCollaborationResponse; status: number } {
  reconcileProjectExpiredAttempt(databasePath, projectId);
  const input = parseStartInput(rawInput);
  const requestHash = operationHash(input);
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      ensureProject(database, projectId);
      const prior = completedOperation(
        database,
        projectId,
        input.operationId,
        requestHash,
      );
      if (prior) return prior;
      const ready = readiness(database, projectId);
      if (!ready.ready) {
        throw new CollaborationError(
          "CONTEXT_NOT_READY",
          409,
          "Collaboration context is not ready.",
          {
            fields: Object.fromEntries(ready.missing.map((item) => [item, "required"])),
          },
        );
      }
      if (input.mentionAgentId) {
        firstAgent(database, projectId, input.mentionAgentId);
      }

      const timestamp = new Date().toISOString();
      let run = activeRun(database, projectId);
      const created = run === null;
      if (!run) {
        const runId = randomUUID();
        const currentAgentId = firstAgent(database, projectId, input.mentionAgentId);
        database
          .prepare(
            `INSERT INTO collaboration_runs (
               id, project_id, status, current_agent_id, round_count,
               next_event_sequence, version, execution_epoch, pause_reason,
               pause_category, created_at, updated_at
             ) VALUES (?, ?, 'running', ?, 0, 1, 1, 1, NULL, NULL, ?, ?)`,
          )
          .run(runId, projectId, currentAgentId, timestamp, timestamp);
        run = runById(database, runId);
      }

      const message = insertOwnerMessage(
        database,
        projectId,
        run.id,
        { content: input.message, mentionAgentId: input.mentionAgentId },
        timestamp,
      );
      if (created) {
        appendEvent(
          database,
          run.id,
          "run_started",
          "owner",
          null,
          {
            currentAgentId: run.currentAgentId,
            messageId: message.id,
            messageSequence: message.sequence,
          },
          timestamp,
        );
      }
      appendEvent(
        database,
        run.id,
        "owner_message",
        "owner",
        null,
        {
          mentionAgentId: message.mentionAgentId,
          mentionDisplayName: message.mentionDisplayName,
          messageId: message.id,
          messageSequence: message.sequence,
        },
        timestamp,
      );
      run = runById(database, run.id);
      const status = created ? 201 : 200;
      const body = { created, message, run };
      completeOperationReceipt(database, {
        body,
        kind: "start",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId: run.id,
        status,
        timestamp,
      });
      return { body, status };
    });
  } catch (error) {
    if (
      error instanceof CollaborationError &&
      error.code !== "OPERATION_CONFLICT" &&
      error.code !== "OPERATION_IN_PROGRESS"
    ) {
      const projectExists = database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
      if (projectExists) {
        const timestamp = new Date().toISOString();
        completeOperationReceipt(database, {
          body: collaborationErrorBody(error),
          kind: "start",
          operationId: input.operationId,
          projectId,
          requestHash,
          runId: null,
          status: error.httpStatus,
          timestamp,
        });
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

export function appendProjectMessage(
  databasePath: string,
  projectId: string,
  rawInput: unknown,
): { body: ProjectMessageResponse; status: number } {
  reconcileProjectExpiredAttempt(databasePath, projectId);
  const input = parseMessageInput(rawInput);
  const requestHash = canonicalRequestHash({
    content: input.content,
    mentionAgentId: input.mentionAgentId || null,
  });
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      ensureProject(database, projectId);
      const prior = readOperationReceipt<ProjectMessageResponse>(
        database,
        projectId,
        input.operationId,
        "message",
        requestHash,
      );
      if (prior) return prior;
      if (input.mentionAgentId) {
        firstAgent(database, projectId, input.mentionAgentId);
      }

      const timestamp = new Date().toISOString();
      let run = activeRun(database, projectId);
      const message = insertOwnerMessage(
        database,
        projectId,
        run?.id ?? null,
        { content: input.content, mentionAgentId: input.mentionAgentId },
        timestamp,
      );
      if (run) {
        appendEvent(
          database,
          run.id,
          "owner_message",
          "owner",
          null,
          {
            mentionAgentId: message.mentionAgentId,
            mentionDisplayName: message.mentionDisplayName,
            messageId: message.id,
            messageSequence: message.sequence,
          },
          timestamp,
        );
        run = runById(database, run.id);
      }
      const body = { message, run };
      completeOperationReceipt(database, {
        body,
        kind: "message",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId: run?.id ?? null,
        status: 201,
        timestamp,
      });
      return { body, status: 201 };
    });
  } catch (error) {
    if (
      error instanceof CollaborationError &&
      error.code !== "OPERATION_CONFLICT" &&
      error.code !== "OPERATION_IN_PROGRESS"
    ) {
      const projectExists = database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
      if (projectExists) {
        const timestamp = new Date().toISOString();
        completeOperationReceipt(database, {
          body: collaborationErrorBody(error),
          kind: "message",
          operationId: input.operationId,
          projectId,
          requestHash,
          runId: null,
          status: error.httpStatus,
          timestamp,
        });
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

function projectMessages(
  database: DatabaseSync,
  projectId: string,
  cursor: ReadCursor,
): CursorPage<ProjectMessage> {
  const rows = database
    .prepare(
      `SELECT id, sequence, run_id AS runId, author_type AS authorType,
              author_agent_id AS authorAgentId, author_display_name AS authorDisplayName,
              content, mention_agent_id AS mentionAgentId,
              mention_display_name AS mentionDisplayName, created_at AS createdAt
       FROM collaboration_messages
       WHERE project_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
    )
    .all(projectId, cursor.after, cursor.limit + 1) as MessageRow[];
  const hasMore = rows.length > cursor.limit;
  const pageRows = hasMore ? rows.slice(0, cursor.limit) : rows;
  const items: ProjectMessage[] = pageRows.map((row) => ({
    ...row,
    mentionMemberStatus: row.mentionAgentId
      ? database
          .prepare(
            `SELECT 1 FROM project_memberships
             WHERE project_id = ? AND agent_id = ?`,
          )
          .get(projectId, row.mentionAgentId)
        ? "current"
        : "left"
      : null,
  }));
  return {
    items,
    nextAfter: hasMore ? items.at(-1)?.sequence ?? null : null,
  };
}

function timeline(
  database: DatabaseSync,
  runId: string | undefined,
  cursor: ReadCursor,
): CursorPage<TimelineEvent> {
  if (!runId) return { items: [], nextAfter: null };
  const rows = database
    .prepare(
      `SELECT id, run_id AS runId, sequence, type, actor_type AS actorType,
              actor_id AS actorId, payload_json AS payloadJson, created_at AS createdAt
       FROM collaboration_events
       WHERE run_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
    )
    .all(runId, cursor.after, cursor.limit + 1) as EventRow[];
  const hasMore = rows.length > cursor.limit;
  const pageRows = hasMore ? rows.slice(0, cursor.limit) : rows;
  const items = pageRows.map(({ payloadJson, ...row }) => {
    const schema = timelinePayloadSchemas[row.type as TimelineEventType];
    if (!schema) throw new Error("Invalid persisted collaboration event type.");
    const payload = schema.parse(JSON.parse(payloadJson));
    return { ...row, payload } as TimelineEvent;
  });
  return {
    items,
    nextAfter: hasMore ? items.at(-1)?.sequence ?? null : null,
  };
}

function pendingDecision(
  database: DatabaseSync,
  runId: string | undefined,
): DecisionRequest | null {
  if (!runId) return null;
  const row = database
    .prepare(
      `SELECT id, run_id AS runId, turn_id AS turnId,
              requesting_agent_id AS requestingAgentId, question,
              options_json AS optionsJson, status, answer,
              answer_message_id AS answerMessageId, version,
              created_at AS createdAt, answered_at AS answeredAt
       FROM decision_requests
       WHERE run_id = ? AND status = 'open'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(runId) as DecisionRow | undefined;
  return row ? decisionFromRow(row) : null;
}

function usageTotals(database: DatabaseSync, runId: string | undefined): UsageTotals {
  if (!runId) {
    return {
      byAgent: [],
      completionTokens: 0,
      promptTokens: 0,
      repairCalls: 0,
      totalTokens: 0,
      unreportedCalls: 0,
    };
  }
  const rows = database
    .prepare(
      `SELECT attempts.agent_id AS agentId,
              COALESCE(SUM(CASE
                WHEN calls.prompt_tokens IS NOT NULL
                 AND calls.completion_tokens IS NOT NULL
                 AND calls.total_tokens IS NOT NULL
                 AND calls.prompt_tokens >= 0
                 AND calls.completion_tokens >= 0
                 AND calls.total_tokens = calls.prompt_tokens + calls.completion_tokens
                THEN calls.prompt_tokens ELSE 0 END), 0) AS promptTokens,
              COALESCE(SUM(CASE
                WHEN calls.prompt_tokens IS NOT NULL
                 AND calls.completion_tokens IS NOT NULL
                 AND calls.total_tokens IS NOT NULL
                 AND calls.prompt_tokens >= 0
                 AND calls.completion_tokens >= 0
                 AND calls.total_tokens = calls.prompt_tokens + calls.completion_tokens
                THEN calls.completion_tokens ELSE 0 END), 0) AS completionTokens,
              COALESCE(SUM(CASE
                WHEN calls.prompt_tokens IS NOT NULL
                 AND calls.completion_tokens IS NOT NULL
                 AND calls.total_tokens IS NOT NULL
                 AND calls.prompt_tokens >= 0
                 AND calls.completion_tokens >= 0
                 AND calls.total_tokens = calls.prompt_tokens + calls.completion_tokens
                THEN calls.total_tokens ELSE 0 END), 0) AS totalTokens,
              SUM(CASE WHEN calls.kind = 'repair' THEN 1 ELSE 0 END) AS repairCalls,
              SUM(CASE
                WHEN calls.prompt_tokens IS NULL
                  OR calls.completion_tokens IS NULL
                  OR calls.total_tokens IS NULL
                  OR calls.prompt_tokens < 0
                  OR calls.completion_tokens < 0
                  OR calls.total_tokens != calls.prompt_tokens + calls.completion_tokens
                THEN 1 ELSE 0 END) AS unreportedCalls,
              (SELECT COUNT(*) FROM collaboration_turns AS turns
               WHERE turns.run_id = ? AND turns.agent_id = attempts.agent_id
                 AND turns.disposition = 'handoff') AS handoffs
       FROM collaboration_model_calls AS calls
       JOIN collaboration_attempts AS attempts ON attempts.id = calls.attempt_id
       WHERE attempts.run_id = ?
       GROUP BY attempts.agent_id
       ORDER BY attempts.agent_id ASC`,
    )
    .all(runId, runId) as Array<{
    agentId: string;
    completionTokens: number;
    handoffs: number;
    promptTokens: number;
    repairCalls: number;
    totalTokens: number;
    unreportedCalls: number;
  }>;
  return {
    byAgent: rows.map(
      ({
        agentId,
        completionTokens,
        handoffs,
        promptTokens,
        totalTokens,
      }) => ({
        agentId,
        completionTokens,
        handoffs,
        promptTokens,
        totalTokens,
      }),
    ),
    completionTokens: rows.reduce((sum, row) => sum + row.completionTokens, 0),
    promptTokens: rows.reduce((sum, row) => sum + row.promptTokens, 0),
    repairCalls: rows.reduce((sum, row) => sum + row.repairCalls, 0),
    totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
    unreportedCalls: rows.reduce((sum, row) => sum + row.unreportedCalls, 0),
  };
}

export function getCollaboration(
  databasePath: string,
  projectId: string,
  options: CollaborationReadOptions = {},
): CollaborationReadResponse {
  reconcileProjectExpiredAttempt(databasePath, projectId);
  const database = openDatabase(databasePath);
  try {
    const ready = readiness(database, projectId);
    const run = currentRun(database, projectId);
    const messageCursor = options.messages ?? { after: 0, limit: 50 };
    const eventCursor = options.events ?? { after: 0, limit: 50 };
    return {
      pendingDecision: pendingDecision(database, run?.id),
      projectMessagesPage: projectMessages(database, projectId, messageCursor),
      readiness: ready,
      run,
      timelinePage: timeline(database, run?.id, eventCursor),
      usage: usageTotals(database, run?.id),
    };
  } finally {
    database.close();
  }
}

export function getRunTimeline(
  databasePath: string,
  runId: string,
  cursor: ReadCursor,
): CursorPage<TimelineEvent> {
  reconcileExpiredAttempt(databasePath, runId);
  const database = openDatabase(databasePath);
  try {
    runById(database, runId);
    return timeline(database, runId, cursor);
  } finally {
    database.close();
  }
}
