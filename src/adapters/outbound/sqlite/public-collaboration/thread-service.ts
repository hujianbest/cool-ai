import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { DatabaseSync } from "node:sqlite";

import {
  collaborationErrorBody,
  CollaborationError,
} from "@/src/modules/public-collaboration";
import {
  canonicalRequestHash,
  completeOperationReceipt,
  readOperationReceipt,
} from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import {
  ensureActiveThread,
  threadDeletedNotFound,
} from "@/src/adapters/outbound/sqlite/public-collaboration/active-thread-guards";
import {
  appendBatchTx,
  nextThreadActivitySequenceTx,
  type ThreadFactIntent,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-fact-store";
import {
  linkMessageAttachmentsTx,
  readMessageAttachmentRefsTx,
} from "@/src/adapters/outbound/sqlite/public-collaboration/attachment-service";
import { recordOwnerInputAndClearDraftTx } from "@/src/adapters/outbound/sqlite/public-collaboration/input-history-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import {
  CredentialVaultError,
  type CredentialEnvelope,
} from "@/src/modules/identity-capability";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { readPublicStructuredBlocksTx } from "@/src/adapters/outbound/sqlite/public-collaboration/structured-message-store";
import { assertPublicProjectionText } from "@/src/adapters/outbound/sqlite/public-collaboration/verified-source-projection";
import { appendCollaborationAuditOutboxRow } from "@/src/adapters/outbound/sqlite/public-collaboration/audit-event-outbox";
import { timelinePayloadSchemas } from "@/src/shared/collaboration-contracts";
import type {
  CursorPage,
  DispatchReadiness,
  FactPageResponse,
  MemberPolicyDto,
  MessagePageResponse,
  RunStartResponse,
  ThreadDispatchReadiness,
  ThreadFactDto,
  ThreadListItemDto,
  ThreadListResponseDto,
  ThreadMessageDto,
  ThreadQueueCancelResponse,
  ThreadQueueEnqueueResponse,
  ThreadQueueItemDto,
  ThreadQueueListResponseDto,
  ThreadQueueReorderResponse,
  ThreadQueueSteerResponse,
  ThreadMessageReplySnapshot,
  ThreadTagRefDto,
} from "@/src/shared/collaboration-contracts";

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export type ThreadMemberPolicy = MemberPolicyDto;

export type ThreadDispatchSelection =
  | { kind: "start"; mentionAgentId?: string | null }
  | { kind: "advance"; currentAgentId: string }
  | {
      kind: "handoff";
      mentionAgentId?: string | null;
      targetAgentId: string;
    };

export type ThreadDispatchOptions = {
  missingProjectFacts?: string[];
  projectRunActive?: boolean;
};

export type ThreadDispatchResult = ThreadDispatchReadiness & {
  policy: ThreadMemberPolicy;
};

export type ThreadSummary = {
  id: string;
  projectId: string;
  title: string;
  policyVersion: number;
  availability: "ready" | "repair_required";
  lastActivitySequence: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ThreadDetail = ThreadSummary & {
  policy: ThreadMemberPolicy;
};

export type ThreadCreatedFact = {
  id: string;
  projectId: string;
  threadId: string;
  sequence: number;
  activitySequence: number;
  type: "thread_created";
  actorType: "owner";
  actorId: null;
  runId: null;
  messageId: null;
  runEventId: null;
  policyRevisionId: null;
  payload: { title: string };
  message: null;
  createdAt: string;
};

export type ThreadPolicyChangedFact = {
  id: string;
  projectId: string;
  threadId: string;
  sequence: number;
  activitySequence: number;
  type: "policy_changed";
  actorType: "owner";
  actorId: null;
  runId: null;
  messageId: null;
  runEventId: null;
  policyRevisionId: string;
  payload: { policyVersion: number };
  message: null;
  createdAt: string;
};

export type ThreadCreateResponse = {
  created: true;
  thread: ThreadDetail;
  fact: ThreadCreatedFact;
};

export type PolicyUpdateResponse = {
  thread: ThreadDetail;
  policy: ThreadMemberPolicy;
  fact: ThreadPolicyChangedFact;
};

export type OwnerMessageFact = Extract<ThreadFactDto, { messageId: string }> & {
  type: "owner_message";
};

export type ThreadMessageResponse = {
  message: ThreadMessageDto;
  fact: OwnerMessageFact;
  run: null;
};

export type ThreadMessageWriteFaultPoint =
  | "after_receipt"
  | "after_message"
  | "after_attachment_link"
  | "after_fact"
  | "after_thread_update";

export type ThreadMessageWriteHooks = {
  credentialCheck?: (content: string) => void;
  fault?: (point: ThreadMessageWriteFaultPoint) => void;
};

export type ThreadOperationLookupResponse = {
  operationId: string;
  kind:
    | "thread_create"
    | "policy_update"
    | "start"
    | "message"
    | "control"
    | "answer_decision"
    | "advance"
    | "recover";
  status: "pending" | "completed";
  httpStatus: number | null;
  response: unknown | null;
};

export type ThreadListResponse = ThreadListResponseDto;

export type ThreadRun = {
  id: string;
  projectId: string;
  threadId: string;
  status: "running" | "waiting_owner" | "paused" | "failed" | "planned" | "stopped";
  currentAgentId: string;
  roundCount: number;
  pauseCategory: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ThreadDetailResponse = {
  thread: ThreadDetail;
  runs: ThreadRun[];
  selectedRun: ThreadRun | null;
  activeRun: { threadId: string; runId: string } | null;
  readiness: ThreadDispatchReadiness;
};

type CreateInput = {
  operationId: string;
  title: string;
  memberAgentIds: string[];
};

type PolicyUpdateInput = {
  operationId: string;
  expectedVersion: number;
  memberAgentIds: string[];
};

type MessageInput = {
  operationId: string;
  content: string;
  mentionAgentId: string | null;
  replyToMessageId: string | null;
  recordInputHistory: boolean;
  attachmentIds: string[];
};

type RunStartInput = {
  operationId: string;
  message: string;
  mentionAgentId: string | null;
  recordInputHistory: boolean;
};

type QueueEnqueueInput = {
  content: string;
  expectedVersion: number;
  operationId: string;
};

type QueueCancelInput = {
  expectedVersion: number;
  operationId: string;
};

type QueueReorderInput = {
  expectedVersion: number;
  operationId: string;
  position: number;
};

type QueueSteerInput = {
  expectedVersion: number;
  operationId: string;
};

export type ThreadRunStartFaultPoint =
  | "after_receipt"
  | "after_run"
  | "after_message"
  | "after_event"
  | "after_facts"
  | "after_sequences";

export type ThreadRunStartHooks = {
  credentialCheck?: (content: string) => void;
  fault?: (point: ThreadRunStartFaultPoint) => void;
};

type CursorValue = {
  v: 1;
  a: number;
  id: string;
};

type SequencePageInput = {
  after: number;
  limit: number;
};

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  database.exec("PRAGMA defer_foreign_keys=ON");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function invalidInput(message: string, fields: Record<string, string>): never {
  throw new CollaborationError("INVALID_INPUT", 400, message, { fields });
}

function resourceNotFound(): never {
  throw new CollaborationError(
    "RESOURCE_NOT_FOUND",
    404,
    "Resource was not found.",
  );
}

function graphemeLength(value: string): number {
  return Array.from(
    new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(value),
  ).length;
}

function parseCreateInput(rawInput: unknown): CreateInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput("Thread input is invalid.", { input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const allowedKeys = new Set(["operationId", "title", "memberAgentIds"]);
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) fields[key] = "unknown";
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(input, key)) fields[key] = "required";
  }

  const operationId = typeof input.operationId === "string" ? input.operationId : "";
  if (!OPERATION_ID.test(operationId)) fields.operationId = "invalid_format";

  const title = typeof input.title === "string" ? input.title.trim() : "";
  const titleLength = graphemeLength(title);
  if (titleLength === 0) fields.title = "required";
  else if (titleLength > 80) fields.title = "too_long";

  const rawMembers = input.memberAgentIds;
  const memberAgentIds = Array.isArray(rawMembers)
    ? rawMembers.filter((member): member is string => typeof member === "string")
    : [];
  if (!Array.isArray(rawMembers) || memberAgentIds.length !== rawMembers.length) {
    fields.memberAgentIds = "invalid_format";
  } else if (memberAgentIds.length < 2 || memberAgentIds.length > 100) {
    fields.memberAgentIds = "invalid_range";
  } else if (
    memberAgentIds.some((memberId) => !RESOURCE_ID.test(memberId))
    || new Set(memberAgentIds).size !== memberAgentIds.length
  ) {
    fields.memberAgentIds = "invalid_format";
  }

  if (Object.keys(fields).length > 0) {
    invalidInput("Thread input is invalid.", fields);
  }
  return { memberAgentIds, operationId, title };
}

function parsePolicyUpdateInput(rawInput: unknown): PolicyUpdateInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput("Policy update input is invalid.", { input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const allowedKeys = new Set(["operationId", "expectedVersion", "memberAgentIds"]);
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) fields[key] = "unknown";
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(input, key)) fields[key] = "required";
  }

  const operationId = typeof input.operationId === "string" ? input.operationId : "";
  if (!OPERATION_ID.test(operationId)) fields.operationId = "invalid_format";

  const expectedVersion = input.expectedVersion;
  if (
    !Number.isSafeInteger(expectedVersion)
    || Number(expectedVersion) < 1
  ) {
    fields.expectedVersion = "invalid_range";
  }

  const rawMembers = input.memberAgentIds;
  const memberAgentIds = Array.isArray(rawMembers)
    ? rawMembers.filter((member): member is string => typeof member === "string")
    : [];
  if (!Array.isArray(rawMembers) || memberAgentIds.length !== rawMembers.length) {
    fields.memberAgentIds = "invalid_format";
  } else if (memberAgentIds.length < 2 || memberAgentIds.length > 100) {
    fields.memberAgentIds = "invalid_range";
  } else if (
    memberAgentIds.some((memberId) => !RESOURCE_ID.test(memberId))
    || new Set(memberAgentIds).size !== memberAgentIds.length
  ) {
    fields.memberAgentIds = "invalid_format";
  }

  if (Object.keys(fields).length > 0) {
    invalidInput("Policy update input is invalid.", fields);
  }
  return {
    expectedVersion: Number(expectedVersion),
    memberAgentIds,
    operationId,
  };
}

function parseMessageInput(rawInput: unknown): MessageInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput("Message input is invalid.", { input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const allowedKeys = new Set([
    "operationId",
    "content",
    "mentionAgentId",
    "replyToMessageId",
    "recordInputHistory",
    "attachmentIds",
  ]);
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) fields[key] = "unknown";
  }
  for (const key of ["operationId", "content"]) {
    if (!Object.hasOwn(input, key)) fields[key] = "required";
  }

  const operationId = typeof input.operationId === "string" ? input.operationId : "";
  if (!OPERATION_ID.test(operationId)) fields.operationId = "invalid_format";

  const content = typeof input.content === "string" ? input.content.trim() : "";
  const contentLength = graphemeLength(content);
  if (contentLength === 0) fields.content = "required";
  else if (contentLength > 10_000) fields.content = "too_long";

  let mentionAgentId: string | null = null;
  if (Object.hasOwn(input, "mentionAgentId")) {
    if (
      typeof input.mentionAgentId !== "string"
      || !RESOURCE_ID.test(input.mentionAgentId)
    ) {
      fields.mentionAgentId = "invalid_format";
    } else {
      mentionAgentId = input.mentionAgentId;
    }
  }

  let replyToMessageId: string | null = null;
  if (Object.hasOwn(input, "replyToMessageId")) {
    if (
      typeof input.replyToMessageId !== "string"
      || !RESOURCE_ID.test(input.replyToMessageId)
    ) {
      fields.replyToMessageId = "invalid_format";
    } else {
      replyToMessageId = input.replyToMessageId;
    }
  }

  if (
    Object.hasOwn(input, "recordInputHistory")
    && typeof input.recordInputHistory !== "boolean"
  ) {
    fields.recordInputHistory = "invalid_format";
  }

  let attachmentIds: string[] = [];
  if (Object.hasOwn(input, "attachmentIds")) {
    const rawIds = input.attachmentIds;
    if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== "string")) {
      fields.attachmentIds = "invalid_format";
    } else if (rawIds.length > 4) {
      fields.attachmentIds = "too_many_items";
    } else if (
      rawIds.some((id) => !RESOURCE_ID.test(id))
      || new Set(rawIds).size !== rawIds.length
    ) {
      fields.attachmentIds = "invalid_format";
    } else {
      attachmentIds = rawIds;
    }
  }

  if (Object.keys(fields).length > 0) {
    invalidInput("Message input is invalid.", fields);
  }
  return {
    attachmentIds,
    content,
    mentionAgentId,
    operationId,
    recordInputHistory: input.recordInputHistory !== false,
    replyToMessageId,
  };
}

function parseQueueEnqueueInput(rawInput: unknown): QueueEnqueueInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput("Queue enqueue input is invalid.", { input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const allowedKeys = new Set(["content", "expectedVersion", "operationId"]);
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) fields[key] = "unknown";
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(input, key)) fields[key] = "required";
  }
  const operationId = typeof input.operationId === "string" ? input.operationId : "";
  if (!OPERATION_ID.test(operationId)) fields.operationId = "invalid_format";
  const expectedVersion = input.expectedVersion;
  if (
    !Number.isSafeInteger(expectedVersion)
    || Number(expectedVersion) < 1
  ) {
    fields.expectedVersion = "invalid_range";
  }
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const contentLength = graphemeLength(content);
  if (contentLength === 0) fields.content = "required";
  else if (contentLength > 10_000) fields.content = "too_long";
  if (Object.keys(fields).length > 0) {
    invalidInput("Queue enqueue input is invalid.", fields);
  }
  return {
    content,
    expectedVersion: Number(expectedVersion),
    operationId,
  };
}

function parseQueueCancelInput(rawInput: unknown): QueueCancelInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput("Queue cancel input is invalid.", { input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const allowedKeys = new Set(["expectedVersion", "operationId"]);
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) fields[key] = "unknown";
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(input, key)) fields[key] = "required";
  }
  const operationId = typeof input.operationId === "string" ? input.operationId : "";
  if (!OPERATION_ID.test(operationId)) fields.operationId = "invalid_format";
  const expectedVersion = input.expectedVersion;
  if (
    !Number.isSafeInteger(expectedVersion)
    || Number(expectedVersion) < 1
  ) {
    fields.expectedVersion = "invalid_range";
  }
  if (Object.keys(fields).length > 0) {
    invalidInput("Queue cancel input is invalid.", fields);
  }
  return {
    expectedVersion: Number(expectedVersion),
    operationId,
  };
}

function parseQueueReorderInput(rawInput: unknown): QueueReorderInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput("Queue reorder input is invalid.", { input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const allowedKeys = new Set(["expectedVersion", "operationId", "position"]);
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) fields[key] = "unknown";
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(input, key)) fields[key] = "required";
  }
  const operationId = typeof input.operationId === "string" ? input.operationId : "";
  if (!OPERATION_ID.test(operationId)) fields.operationId = "invalid_format";
  const expectedVersion = input.expectedVersion;
  if (
    !Number.isSafeInteger(expectedVersion)
    || Number(expectedVersion) < 1
  ) {
    fields.expectedVersion = "invalid_range";
  }
  const position = input.position;
  if (
    !Number.isSafeInteger(position)
    || Number(position) < 1
  ) {
    fields.position = "invalid_range";
  }
  if (Object.keys(fields).length > 0) {
    invalidInput("Queue reorder input is invalid.", fields);
  }
  return {
    expectedVersion: Number(expectedVersion),
    operationId,
    position: Number(position),
  };
}

function parseQueueSteerInput(rawInput: unknown): QueueSteerInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput("Queue steer input is invalid.", { input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const allowedKeys = new Set(["expectedVersion", "operationId"]);
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) fields[key] = "unknown";
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(input, key)) fields[key] = "required";
  }
  const operationId = typeof input.operationId === "string" ? input.operationId : "";
  if (!OPERATION_ID.test(operationId)) fields.operationId = "invalid_format";
  const expectedVersion = input.expectedVersion;
  if (
    !Number.isSafeInteger(expectedVersion)
    || Number(expectedVersion) < 1
  ) {
    fields.expectedVersion = "invalid_range";
  }
  if (Object.keys(fields).length > 0) {
    invalidInput("Queue steer input is invalid.", fields);
  }
  return {
    expectedVersion: Number(expectedVersion),
    operationId,
  };
}

function parseRunStartInput(rawInput: unknown): RunStartInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput("Run start input is invalid.", { input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const allowedKeys = new Set([
    "operationId",
    "message",
    "mentionAgentId",
    "recordInputHistory",
  ]);
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) fields[key] = "unknown";
  }
  for (const key of ["operationId", "message"]) {
    if (!Object.hasOwn(input, key)) fields[key] = "required";
  }

  const operationId = typeof input.operationId === "string" ? input.operationId : "";
  if (!OPERATION_ID.test(operationId)) fields.operationId = "invalid_format";
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const messageLength = graphemeLength(message);
  if (messageLength === 0) fields.message = "required";
  else if (messageLength > 10_000) fields.message = "too_long";

  let mentionAgentId: string | null = null;
  if (Object.hasOwn(input, "mentionAgentId")) {
    if (
      typeof input.mentionAgentId !== "string"
      || !RESOURCE_ID.test(input.mentionAgentId)
    ) {
      fields.mentionAgentId = "invalid_format";
    } else {
      mentionAgentId = input.mentionAgentId;
    }
  }
  if (
    Object.hasOwn(input, "recordInputHistory")
    && typeof input.recordInputHistory !== "boolean"
  ) {
    fields.recordInputHistory = "invalid_format";
  }
  if (Object.keys(fields).length > 0) {
    invalidInput("Run start input is invalid.", fields);
  }
  return {
    message,
    mentionAgentId,
    operationId,
    recordInputHistory: input.recordInputHistory !== false,
  };
}

function parseListInput(rawInput: unknown): {
  cursor: CursorValue | null;
  favoritesOnly: boolean;
  limit: number;
  tagId: string | null;
} {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput("Thread list input is invalid.", { input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (
      key !== "cursor"
      && key !== "favoritesOnly"
      && key !== "limit"
      && key !== "tagId"
    ) {
      fields[key] = "unknown";
    }
  }
  const limit = input.limit === undefined ? 50 : input.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
    fields.limit = "invalid_range";
  }
  let cursor: CursorValue | null = null;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string") {
      fields.cursor = "invalid_format";
    } else {
      try {
        cursor = decodeThreadCursor(input.cursor);
      } catch {
        fields.cursor = "invalid_format";
      }
    }
  }
  let favoritesOnly = false;
  if (input.favoritesOnly !== undefined) {
    if (typeof input.favoritesOnly !== "boolean") {
      fields.favoritesOnly = "invalid_format";
    } else {
      favoritesOnly = input.favoritesOnly;
    }
  }
  // The favorites view orders by favorited_at, not last_activity_sequence, so
  // the activity cursor cannot address a position inside it.
  if (favoritesOnly && cursor !== null) fields.cursor = "not_supported";
  let tagId: string | null = null;
  if (input.tagId !== undefined) {
    if (typeof input.tagId !== "string" || !RESOURCE_ID.test(input.tagId)) {
      fields.tagId = "invalid_format";
    } else {
      tagId = input.tagId;
    }
  }
  // The tag filter keeps the last_activity_sequence ordering (cursor-compatible),
  // which cannot be composed with the favorites ordering (A-186).
  if (tagId !== null && favoritesOnly) fields.tagId = "not_combinable";
  if (Object.keys(fields).length > 0) {
    invalidInput("Thread list input is invalid.", fields);
  }
  return { cursor, favoritesOnly, limit: Number(limit), tagId };
}

function parseSequencePageInput(rawInput: unknown): SequencePageInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    invalidInput("Thread history input is invalid.", { input: "invalid_format" });
  }
  const input = rawInput as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (key !== "after" && key !== "limit") fields[key] = "unknown";
  }
  const after = input.after === undefined ? 0 : input.after;
  const limit = input.limit === undefined ? 50 : input.limit;
  if (!Number.isSafeInteger(after) || Number(after) < 0) {
    fields.after = "invalid_range";
  }
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 200) {
    fields.limit = "invalid_range";
  }
  if (Object.keys(fields).length > 0) {
    invalidInput("Thread history input is invalid.", fields);
  }
  return { after: Number(after), limit: Number(limit) };
}

function ensureProject(database: DatabaseSync, projectId: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) {
    throw new CollaborationError("PROJECT_NOT_FOUND", 404, "Project was not found.");
  }
}

function missingProjectFactsFromDatabase(
  database: DatabaseSync,
  projectId: string,
): string[] {
  const project = database
    .prepare("SELECT workspace_path AS workspacePath FROM projects WHERE id=?")
    .get(projectId) as { workspacePath: string | null } | undefined;
  if (!project) resourceNotFound();
  const missing: string[] = [];
  if (!project.workspacePath) missing.push("workspace");
  const memberCount = (
    database
      .prepare("SELECT count(*) AS count FROM project_memberships WHERE project_id=?")
      .get(projectId) as { count: number }
  ).count;
  if (memberCount < 2) missing.push("members");
  if (!database.prepare("SELECT 1 FROM missions WHERE project_id=?").get(projectId)) {
    missing.push("mission");
  }
  return missing;
}

function currentMembers(
  database: DatabaseSync,
  projectId: string,
  memberAgentIds: string[],
): Array<{ agentId: string; displayName: string }> {
  const readMember = database.prepare(
    `SELECT agents.id AS agentId,agents.name AS displayName
     FROM project_memberships
     JOIN agents ON agents.id=project_memberships.agent_id
     WHERE project_memberships.project_id=? AND project_memberships.agent_id=?`,
  );
  return memberAgentIds.map((agentId) => {
    const member = readMember.get(projectId, agentId) as
      | { agentId: string; displayName: string }
      | undefined;
    if (!member) {
      throw new CollaborationError(
        "AGENT_NOT_MEMBER",
        409,
        "Selected Agent is not a current project member.",
      );
    }
    return member;
  });
}

function appendThreadFactTx(
  database: DatabaseSync,
  input: ThreadFactIntent,
): void {
  appendBatchTx(database, [input]);
}

export function appendRunEventFactTx(
  database: DatabaseSync,
  input: {
    actorId: string | null;
    actorType: "owner" | "agent" | "system";
    eventId: string;
    eventType: keyof typeof timelinePayloadSchemas;
    factId: string;
    projectId: string;
    runId: string;
    threadId: string;
    timestamp: string;
  },
): void {
  if (input.eventType === "owner_message" || input.eventType === "agent_message") return;
  appendThreadFactTx(database, {
    actorId: input.actorId,
    actorType: input.actorType,
    factId: input.factId,
    payload: { eventType: input.eventType },
    projectId: input.projectId,
    runEventId: input.eventId,
    runId: input.runId,
    threadId: input.threadId,
    timestamp: input.timestamp,
    type: "run_event",
  });
}

export function appendAgentMessageFactTx(
  database: DatabaseSync,
  input: {
    agentId: string;
    factId: string;
    messageId: string;
    projectId: string;
    runId: string;
    threadId: string;
    timestamp: string;
  },
): void {
  appendThreadFactTx(database, {
    actorId: input.agentId,
    actorType: "agent",
    factId: input.factId,
    messageId: input.messageId,
    payload: { messageId: input.messageId },
    projectId: input.projectId,
    runId: input.runId,
    threadId: input.threadId,
    timestamp: input.timestamp,
    type: "agent_message",
  });
}

function resolveMessageMention(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
  mentionAgentId: string | null,
): string | null {
  if (mentionAgentId === null) return null;
  const mention = database
    .prepare(
      `SELECT agents.name AS displayName
       FROM collaboration_threads AS threads
       JOIN collaboration_thread_policy_members AS policy
         ON policy.project_id=threads.project_id
        AND policy.thread_id=threads.id
        AND policy.revision_id=threads.active_policy_revision_id
       JOIN project_memberships AS membership
         ON membership.project_id=threads.project_id
        AND membership.agent_id=policy.agent_id
       JOIN agents ON agents.id=membership.agent_id
       WHERE threads.project_id=? AND threads.id=? AND policy.agent_id=?`,
    )
    .get(projectId, threadId, mentionAgentId) as
    | { displayName: string }
    | undefined;
  if (!mention) {
    throw new CollaborationError(
      "AGENT_NOT_MEMBER",
      409,
      "Selected Agent is not available in the thread policy.",
    );
  }
  return mention.displayName;
}

const REPLY_EXCERPT_MAX_GRAPHEMES = 160;

function resolveReplyToSnapshot(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
  replyToMessageId: string | null,
): ThreadMessageReplySnapshot | null {
  if (replyToMessageId === null) return null;
  const target = database
    .prepare(
      `SELECT id,sequence,author_display_name AS authorDisplayName,content
       FROM collaboration_messages
       WHERE project_id=? AND thread_id=? AND id=?`,
    )
    .get(projectId, threadId, replyToMessageId) as
    | {
        authorDisplayName: string;
        content: string;
        id: string;
        sequence: number;
      }
    | undefined;
  if (!target) {
    invalidInput("Message input is invalid.", { replyToMessageId: "not_found" });
  }
  const excerpt = target.content.trim();
  if (graphemeLength(excerpt) > REPLY_EXCERPT_MAX_GRAPHEMES) {
    throw new CollaborationError(
      "CREDENTIAL_CONTENT_REJECTED",
      422,
      "Public source content is not allowed.",
    );
  }
  assertPublicProjectionText(database, excerpt);
  return {
    authorDisplayName: target.authorDisplayName,
    excerpt,
    messageId: target.id,
    sequence: target.sequence,
  };
}

function currentMessageSequence(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
): number {
  database
    .prepare(
      `INSERT OR IGNORE INTO collaboration_project_sequences(
         project_id,thread_id,next_message_sequence
       ) VALUES (?,?,1)`,
    )
    .run(projectId, threadId);
  return (
    database
      .prepare(
        `SELECT next_message_sequence AS value
         FROM collaboration_project_sequences
         WHERE project_id=? AND thread_id=?`,
      )
      .get(projectId, threadId) as { value: number }
  ).value;
}

function readThreadPolicyFromDatabase(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
): ThreadMemberPolicy {
  const revision = database
    .prepare(
      `SELECT threads.active_policy_revision_id AS revisionId,
              revisions.version,revisions.created_at AS createdAt
       FROM collaboration_threads AS threads
       JOIN collaboration_thread_policy_revisions AS revisions
         ON revisions.project_id=threads.project_id
        AND revisions.thread_id=threads.id
        AND revisions.id=threads.active_policy_revision_id
       WHERE threads.project_id=? AND threads.id=?`,
    )
    .get(projectId, threadId) as
    | { revisionId: string; version: number; createdAt: string }
    | undefined;
  if (!revision) {
    throw new CollaborationError("RESOURCE_NOT_FOUND", 404, "Thread was not found.");
  }
  const rows = database
    .prepare(
      `SELECT policy.agent_id AS agentId,
              COALESCE(live_agent.name,policy.agent_display_name) AS displayName,
              policy.position,
              CASE WHEN live.agent_id IS NULL THEN 'removed' ELSE 'current' END AS live
       FROM collaboration_thread_policy_members AS policy
       LEFT JOIN project_memberships AS live
         ON live.project_id=policy.project_id AND live.agent_id=policy.agent_id
       LEFT JOIN agents AS live_agent
         ON live_agent.id=live.agent_id
       WHERE policy.project_id=? AND policy.thread_id=? AND policy.revision_id=?
       ORDER BY policy.position ASC,policy.agent_id ASC`,
    )
    .all(projectId, threadId, revision.revisionId) as Array<{
    agentId: string;
    displayName: string;
    position: number;
    live: "current" | "removed";
  }>;
  const unavailableMemberIds = rows
    .filter(({ live }) => live === "removed")
    .map(({ agentId }) => agentId);
  const availability =
    rows.length >= 2
    && new Set(rows.map(({ agentId }) => agentId)).size === rows.length
    && unavailableMemberIds.length === 0
      ? "ready"
      : "repair_required";
  return {
    availability,
    createdAt: revision.createdAt,
    members: rows.map(({ displayName, ...member }) => ({
      ...member,
      displayNameSnapshot: displayName,
    })),
    revisionId: revision.revisionId,
    unavailableMemberIds,
    version: revision.version,
  };
}

function selectedPolicyMember(
  policy: ThreadMemberPolicy,
  selection: ThreadDispatchSelection,
): string {
  const candidate =
    selection.kind === "start"
      ? selection.mentionAgentId ?? policy.members[0]?.agentId
      : selection.kind === "advance"
        ? selection.currentAgentId
        : selection.mentionAgentId ?? selection.targetAgentId;
  const selected = policy.members.find(
    ({ agentId, live }) => agentId === candidate && live === "current",
  );
  if (!selected) {
    throw new CollaborationError(
      "AGENT_NOT_MEMBER",
      409,
      "Selected Agent is not available in the thread policy.",
    );
  }
  return selected.agentId;
}

function selectedProviderAvailable(database: DatabaseSync, agentId: string): boolean {
  const row = database
    .prepare(
      `SELECT providers.id AS providerId,
              providers.api_key_cipher AS apiKeyCipher,
              providers.api_key_iv AS apiKeyIv,
              providers.api_key_tag AS apiKeyTag,
              providers.credential_version AS credentialVersion,
              providers.key_id AS keyId,
              providers.api_key_mask AS apiKeyMask,
              providers.verified_at AS verifiedAt
       FROM agents
       JOIN providers ON providers.id=agents.provider_id
       WHERE agents.id=?`,
    )
    .get(agentId) as
    | {
        providerId: string;
        apiKeyCipher: string;
        apiKeyIv: string;
        apiKeyTag: string;
        credentialVersion: number;
        keyId: string;
        apiKeyMask: string;
        verifiedAt: string | null;
      }
    | undefined;
  if (!row?.verifiedAt) return false;
  const envelope: CredentialEnvelope = {
    apiKeyCipher: row.apiKeyCipher,
    apiKeyIv: row.apiKeyIv,
    apiKeyMask: row.apiKeyMask,
    apiKeyTag: row.apiKeyTag,
    credentialVersion: row.credentialVersion as 1,
    keyId: row.keyId,
  };
  try {
    createCredentialVault().decrypt(row.providerId, envelope);
    return true;
  } catch (error) {
    if (error instanceof CredentialVaultError) return false;
    throw error;
  }
}

function resolveThreadDispatchFromDatabase(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
  selection: ThreadDispatchSelection,
  options: ThreadDispatchOptions,
): ThreadDispatchResult {
  const policy = readThreadPolicyFromDatabase(database, projectId, threadId);
  const missingProjectFacts = [...(options.missingProjectFacts ?? [])];
  if (policy.availability === "repair_required") {
    return {
      dispatch: "policy_repair_required",
      missingProjectFacts,
      policy,
      selectedMemberId: null,
    };
  }
  const selectedMemberId = selectedPolicyMember(policy, selection);
  if (missingProjectFacts.length > 0) {
    return {
      dispatch: "project_context_not_ready",
      missingProjectFacts,
      policy,
      selectedMemberId,
    };
  }
  if (options.projectRunActive) {
    return {
      dispatch: "project_run_active",
      missingProjectFacts,
      policy,
      selectedMemberId,
    };
  }
  return {
    dispatch: selectedProviderAvailable(database, selectedMemberId)
      ? "ready"
      : "selected_member_provider_unavailable",
    missingProjectFacts,
    policy,
    selectedMemberId,
  };
}

function dispatchFailure(dispatch: DispatchReadiness): CollaborationError | null {
  if (dispatch === "ready") return null;
  if (dispatch === "policy_repair_required") {
    return new CollaborationError(
      "THREAD_POLICY_REPAIR_REQUIRED",
      409,
      "Thread policy requires repair.",
    );
  }
  if (dispatch === "selected_member_provider_unavailable") {
    return new CollaborationError(
      "CREDENTIAL_UNAVAILABLE",
      503,
      "Provider credential is unavailable.",
      { category: "credential_unavailable" },
    );
  }
  if (dispatch === "project_run_active") {
    return new CollaborationError(
      "PROJECT_RUN_ACTIVE",
      409,
      "Another thread has an active project run.",
    );
  }
  return new CollaborationError(
    "CONTEXT_NOT_READY",
    409,
    "Collaboration context is not ready.",
  );
}

export function readThreadPolicy(
  databasePath: string,
  projectId: string,
  threadId: string,
): ThreadMemberPolicy {
  const database = openDatabase(databasePath);
  try {
    return readThreadPolicyFromDatabase(database, projectId, threadId);
  } finally {
    database.close();
  }
}

export function resolveThreadDispatch(
  databasePath: string,
  projectId: string,
  threadId: string,
  selection: ThreadDispatchSelection,
  options: ThreadDispatchOptions = {},
): ThreadDispatchResult {
  const database = openDatabase(databasePath);
  try {
    return resolveThreadDispatchFromDatabase(
      database,
      projectId,
      threadId,
      selection,
      options,
    );
  } finally {
    database.close();
  }
}

function requireThreadDispatchAgent(
  databasePath: string,
  projectId: string,
  threadId: string,
  selection: ThreadDispatchSelection,
): string {
  const result = resolveThreadDispatch(
    databasePath,
    projectId,
    threadId,
    selection,
  );
  const failure = dispatchFailure(result.dispatch);
  if (failure) throw failure;
  return result.selectedMemberId!;
}

export function selectStartAgent(
  databasePath: string,
  projectId: string,
  threadId: string,
  mentionAgentId?: string | null,
): string {
  return requireThreadDispatchAgent(databasePath, projectId, threadId, {
    kind: "start",
    mentionAgentId,
  });
}

export function selectAdvanceAgent(
  databasePath: string,
  projectId: string,
  threadId: string,
  currentAgentId: string,
): string {
  return requireThreadDispatchAgent(databasePath, projectId, threadId, {
    currentAgentId,
    kind: "advance",
  });
}

export function selectHandoffAgent(
  databasePath: string,
  projectId: string,
  threadId: string,
  targetAgentId: string,
  mentionAgentId?: string | null,
): string {
  return requireThreadDispatchAgent(databasePath, projectId, threadId, {
    kind: "handoff",
    mentionAgentId,
    targetAgentId,
  });
}

export function encodeThreadCursor(value: Omit<CursorValue, "v">): string {
  if (
    !Number.isSafeInteger(value.a)
    || value.a < 1
    || !RESOURCE_ID.test(value.id)
  ) {
    invalidInput("Thread list input is invalid.", { cursor: "invalid_format" });
  }
  return Buffer.from(JSON.stringify({ v: 1, a: value.a, id: value.id }), "utf8").toString(
    "base64url",
  );
}

export function decodeThreadCursor(cursor: string): CursorValue {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("INVALID_CURSOR");
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) throw new Error("INVALID_CURSOR");
  const json = utf8.decode(bytes);
  const value = JSON.parse(json) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_CURSOR");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3
    || record.v !== 1
    || !Number.isSafeInteger(record.a)
    || Number(record.a) < 1
    || typeof record.id !== "string"
    || !RESOURCE_ID.test(record.id)
    || JSON.stringify({ v: 1, a: record.a, id: record.id }) !== json
  ) {
    throw new Error("INVALID_CURSOR");
  }
  return { a: Number(record.a), id: record.id, v: 1 };
}

export function createThread(
  databasePath: string,
  projectId: string,
  rawInput: unknown,
): { body: ThreadCreateResponse; status: 201 } {
  const input = parseCreateInput(rawInput);
  const requestHash = canonicalRequestHash({
    memberAgentIds: input.memberAgentIds,
    title: input.title,
  });
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      ensureProject(database, projectId);
      const prior = readOperationReceipt<ThreadCreateResponse>(
        database,
        projectId,
        input.operationId,
        "thread_create",
        requestHash,
      );
      if (prior) return prior as { body: ThreadCreateResponse; status: 201 };

      const members = currentMembers(database, projectId, input.memberAgentIds);
      const timestamp = new Date().toISOString();
      const threadId = randomUUID();
      const revisionId = randomUUID();
      const threadCreatedFactId = randomUUID();
      const policyChangedFactId = randomUUID();
      const firstActivity = nextThreadActivitySequenceTx(database, projectId);

      database
        .prepare(
          `INSERT INTO collaboration_threads(
             id,project_id,title,active_policy_revision_id,policy_version,
             next_fact_sequence,last_activity_sequence,version,created_at,updated_at
           ) VALUES (?,?,?, ?,1,1,?,1,?,?)`,
        )
        .run(
          threadId,
          projectId,
          input.title,
          revisionId,
          firstActivity + 1,
          timestamp,
          timestamp,
        );
      database
        .prepare(
          `INSERT INTO collaboration_thread_policy_revisions(
             id,project_id,thread_id,version,created_operation_id,created_at
           ) VALUES (?,?,?,1,?,?)`,
        )
        .run(revisionId, projectId, threadId, input.operationId, timestamp);
      const insertMember = database.prepare(
        `INSERT INTO collaboration_thread_policy_members(
           project_id,thread_id,revision_id,position,agent_id,agent_display_name
         ) VALUES (?,?,?,?,?,?)`,
      );
      members.forEach((member, position) => {
        insertMember.run(
          projectId,
          threadId,
          revisionId,
          position,
          member.agentId,
          member.displayName,
        );
      });
      appendBatchTx(database, [
        {
          actorId: null,
          actorType: "owner",
          factId: threadCreatedFactId,
          payload: { title: input.title },
          projectId,
          threadId,
          timestamp,
          type: "thread_created",
        },
        {
          actorId: null,
          actorType: "owner",
          factId: policyChangedFactId,
          payload: { policyVersion: 1 },
          policyRevisionId: revisionId,
          projectId,
          threadId,
          timestamp,
          type: "policy_changed",
        },
      ], { preserveThreadVersion: true });

      const policy: ThreadMemberPolicy = {
        availability: "ready",
        createdAt: timestamp,
        members: members.map((member, position) => ({
          agentId: member.agentId,
          displayNameSnapshot: member.displayName,
          live: "current",
          position,
        })),
        revisionId,
        unavailableMemberIds: [],
        version: 1,
      };
      const thread: ThreadDetail = {
        availability: "ready",
        createdAt: timestamp,
        id: threadId,
        lastActivitySequence: firstActivity + 1,
        policy,
        policyVersion: 1,
        projectId,
        title: input.title,
        updatedAt: timestamp,
        version: 1,
      };
      const fact: ThreadCreatedFact = {
        activitySequence: firstActivity,
        actorId: null,
        actorType: "owner",
        createdAt: timestamp,
        id: threadCreatedFactId,
        message: null,
        messageId: null,
        payload: { title: input.title },
        policyRevisionId: null,
        projectId,
        runEventId: null,
        runId: null,
        sequence: 1,
        threadId,
        type: "thread_created",
      };
      const body: ThreadCreateResponse = { created: true, fact, thread };
      completeOperationReceipt(database, {
        body,
        kind: "thread_create",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId: null,
        status: 201,
        threadId,
        timestamp,
      });
      return { body, status: 201 as const };
    });
  } finally {
    database.close();
  }
}

export function updateThreadPolicy(
  databasePath: string,
  projectId: string,
  threadId: string,
  rawInput: unknown,
): { body: PolicyUpdateResponse; status: 200 } {
  const input = parsePolicyUpdateInput(rawInput);
  const requestHash = canonicalRequestHash({
    expectedVersion: input.expectedVersion,
    memberAgentIds: input.memberAgentIds,
  });
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      const current = database
        .prepare(
          `SELECT id,project_id AS projectId,title,
                  active_policy_revision_id AS revisionId,
                  policy_version AS policyVersion,
                  next_fact_sequence AS nextFactSequence,
                  last_activity_sequence AS lastActivitySequence,
                  version,created_at AS createdAt,updated_at AS updatedAt,
                  deleted_at AS deletedAt
           FROM collaboration_threads
           WHERE project_id=? AND id=?`,
        )
        .get(projectId, threadId) as
        | {
            id: string;
            projectId: string;
            title: string;
            revisionId: string;
            policyVersion: number;
            nextFactSequence: number;
            lastActivitySequence: number;
            version: number;
            createdAt: string;
            updatedAt: string;
            deletedAt: string | null;
          }
        | undefined;
      if (!current) {
        throw new CollaborationError(
          "RESOURCE_NOT_FOUND",
          404,
          "Thread was not found.",
        );
      }
      if (current.deletedAt !== null) {
        throw new CollaborationError(
          "RESOURCE_NOT_FOUND",
          404,
          "Thread was not found.",
          { reason: "thread_deleted" },
        );
      }

      const prior = readOperationReceipt<PolicyUpdateResponse>(
        database,
        projectId,
        input.operationId,
        "policy_update",
        requestHash,
      );
      if (prior) {
        if (prior.body.thread.id !== threadId) {
          throw new CollaborationError(
            "OPERATION_CONFLICT",
            409,
            "Operation id was already used for different input.",
          );
        }
        return prior as { body: PolicyUpdateResponse; status: 200 };
      }

      if (current.version !== input.expectedVersion) {
        throw new CollaborationError(
          "VERSION_CONFLICT",
          409,
          "Thread version has changed.",
          { currentVersion: current.version },
        );
      }

      const members = currentMembers(database, projectId, input.memberAgentIds);
      const timestamp = new Date().toISOString();
      const revisionId = randomUUID();
      const factId = randomUUID();
      const policyVersion = current.policyVersion + 1;
      const threadVersion = current.version + 1;

      const update = database
        .prepare(
          `UPDATE collaboration_threads
           SET active_policy_revision_id=?,policy_version=?,updated_at=?
           WHERE project_id=? AND id=? AND version=?`,
        )
        .run(
          revisionId,
          policyVersion,
          timestamp,
          projectId,
          threadId,
          input.expectedVersion,
        );
      if (update.changes !== 1) {
        const latest = database
          .prepare(
            "SELECT version FROM collaboration_threads WHERE project_id=? AND id=?",
          )
          .get(projectId, threadId) as { version: number } | undefined;
        throw new CollaborationError(
          latest ? "VERSION_CONFLICT" : "RESOURCE_NOT_FOUND",
          latest ? 409 : 404,
          latest ? "Thread version has changed." : "Thread was not found.",
          latest ? { currentVersion: latest.version } : {},
        );
      }

      database
        .prepare(
          `INSERT INTO collaboration_thread_policy_revisions(
             id,project_id,thread_id,version,created_operation_id,created_at
           ) VALUES (?,?,?,?,?,?)`,
        )
        .run(
          revisionId,
          projectId,
          threadId,
          policyVersion,
          input.operationId,
          timestamp,
        );
      const insertMember = database.prepare(
        `INSERT INTO collaboration_thread_policy_members(
           project_id,thread_id,revision_id,position,agent_id,agent_display_name
         ) VALUES (?,?,?,?,?,?)`,
      );
      members.forEach((member, position) => {
        insertMember.run(
          projectId,
          threadId,
          revisionId,
          position,
          member.agentId,
          member.displayName,
        );
      });
      const [storedFact] = appendBatchTx(database, [{
        actorId: null,
        actorType: "owner",
        factId,
        payload: { policyVersion },
        policyRevisionId: revisionId,
        projectId,
        threadId,
        timestamp,
        type: "policy_changed",
      }]);
      const activitySequence = storedFact.activitySequence;

      const policy: ThreadMemberPolicy = {
        availability: "ready",
        createdAt: timestamp,
        members: members.map((member, position) => ({
          agentId: member.agentId,
          displayNameSnapshot: member.displayName,
          live: "current",
          position,
        })),
        revisionId,
        unavailableMemberIds: [],
        version: policyVersion,
      };
      const thread: ThreadDetail = {
        availability: "ready",
        createdAt: current.createdAt,
        id: threadId,
        lastActivitySequence: activitySequence,
        policy,
        policyVersion,
        projectId,
        title: current.title,
        updatedAt: timestamp,
        version: threadVersion,
      };
      const fact: ThreadPolicyChangedFact = {
        activitySequence,
        actorId: null,
        actorType: "owner",
        createdAt: timestamp,
        id: factId,
        message: null,
        messageId: null,
        payload: { policyVersion },
        policyRevisionId: revisionId,
        projectId,
        runEventId: null,
        runId: null,
        sequence: current.nextFactSequence,
        threadId,
        type: "policy_changed",
      };
      const body: PolicyUpdateResponse = { fact, policy, thread };
      completeOperationReceipt(database, {
        body,
        kind: "policy_update",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId: null,
        status: 200,
        threadId,
        timestamp,
      });
      return { body, status: 200 as const };
    });
  } finally {
    database.close();
  }
}

export function writeOwnerThreadMessage(
  databasePath: string,
  projectId: string,
  threadId: string,
  rawInput: unknown,
  hooks: ThreadMessageWriteHooks = {},
): { body: ThreadMessageResponse; status: 201 } {
  const input = parseMessageInput(rawInput);
  hooks.credentialCheck?.(input.content);
  const requestHash = canonicalRequestHash({
    attachmentIds: input.attachmentIds,
    content: input.content,
    mentionAgentId: input.mentionAgentId,
    recordInputHistory: input.recordInputHistory,
    replyToMessageId: input.replyToMessageId,
  });
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      const thread = database
        .prepare(
          `SELECT next_fact_sequence AS nextFactSequence,deleted_at AS deletedAt
           FROM collaboration_threads
           WHERE project_id=? AND id=?`,
        )
        .get(projectId, threadId) as
        | { nextFactSequence: number; deletedAt: string | null }
        | undefined;
      if (!thread) resourceNotFound();
      if (thread.deletedAt !== null) threadDeletedNotFound();

      const prior = readOperationReceipt<ThreadMessageResponse>(
        database,
        projectId,
        input.operationId,
        "message",
        requestHash,
      );
      if (prior) {
        if (prior.body.message.threadId !== threadId) {
          throw new CollaborationError(
            "OPERATION_CONFLICT",
            409,
            "Operation id was already used for different input.",
          );
        }
        return prior as { body: ThreadMessageResponse; status: 201 };
      }

      const mentionDisplayName = resolveMessageMention(
        database,
        projectId,
        threadId,
        input.mentionAgentId,
      );
      const replyTo = resolveReplyToSnapshot(
        database,
        projectId,
        threadId,
        input.replyToMessageId,
      );
      const messageSequence = currentMessageSequence(database, projectId, threadId);
      const activitySequence = nextThreadActivitySequenceTx(database, projectId);
      const timestamp = new Date().toISOString();
      const messageId = randomUUID();
      const factId = randomUUID();
      // Attachments are claimed before the message row exists; the whole unit
      // commits or rolls back together, so a failure can never leave a
      // half-linked attachment or a message without its refs.
      if (input.attachmentIds.length > 0) {
        linkMessageAttachmentsTx(database, {
          attachmentIds: input.attachmentIds,
          messageId,
          projectId,
          threadId,
          timestamp,
        });
      }
      const attachments = readMessageAttachmentRefsTx(database, {
        messageId,
        projectId,
        threadId,
      });
      hooks.fault?.("after_attachment_link");
      const message: ThreadMessageDto = {
        attachments,
        authorAgentId: null,
        authorDisplayName: "Owner",
        authorType: "owner",
        content: input.content,
        createdAt: timestamp,
        id: messageId,
        mentionAgentId: input.mentionAgentId,
        mentionDisplayName,
        mentionMemberStatus: input.mentionAgentId === null ? null : "current",
        projectId,
        replyTo,
        runId: null,
        sequence: messageSequence,
        threadId,
      };
      const fact: OwnerMessageFact = {
        activitySequence,
        actorId: null,
        actorType: "owner",
        createdAt: timestamp,
        id: factId,
        message,
        messageId,
        payload: { messageId },
        policyRevisionId: null,
        projectId,
        runEventId: null,
        runId: null,
        sequence: thread.nextFactSequence,
        threadId,
        type: "owner_message",
      };
      const body: ThreadMessageResponse = { fact, message, run: null };

      completeOperationReceipt(database, {
        body,
        kind: "message",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId: null,
        status: 201,
        threadId,
        timestamp,
      });
      hooks.fault?.("after_receipt");

      database
        .prepare(
          `INSERT INTO collaboration_messages(
             id,project_id,thread_id,run_id,author_type,author_agent_id,
             author_display_name,content,mention_agent_id,mention_display_name,
             sequence,reply_to_message_id,reply_to_sequence,
             reply_to_author_display_name,reply_to_excerpt,consumed_at,created_at
           ) VALUES (?,?,?,NULL,'owner',NULL,?,?,?,?,?,?,?,?,?,NULL,?)`,
        )
        .run(
          messageId,
          projectId,
          threadId,
          message.authorDisplayName,
          message.content,
          message.mentionAgentId,
          message.mentionDisplayName,
          message.sequence,
          replyTo?.messageId ?? null,
          replyTo?.sequence ?? null,
          replyTo?.authorDisplayName ?? null,
          replyTo?.excerpt ?? null,
          timestamp,
        );
      hooks.fault?.("after_message");

      appendBatchTx(database, [{
        actorId: null,
        actorType: "owner",
        factId,
        messageId,
        payload: fact.payload,
        projectId,
        runId: null,
        threadId,
        timestamp,
        type: "owner_message",
      }]);
      hooks.fault?.("after_fact");
      database
        .prepare(
          `UPDATE collaboration_project_sequences
           SET next_message_sequence=next_message_sequence+1
           WHERE project_id=? AND thread_id=? AND next_message_sequence=?`,
        )
        .run(projectId, threadId, messageSequence);
      hooks.fault?.("after_thread_update");
      recordOwnerInputAndClearDraftTx(
        database,
        projectId,
        threadId,
        input.content,
        timestamp,
        input.recordInputHistory,
      );
      return { body, status: 201 as const };
    });
  } finally {
    database.close();
  }
}

export function startThreadRun(
  databasePath: string,
  projectId: string,
  threadId: string,
  rawInput: unknown,
  hooks: ThreadRunStartHooks = {},
): { body: RunStartResponse; status: 201 } {
  const input = parseRunStartInput(rawInput);
  hooks.credentialCheck?.(input.message);
  const requestHash = canonicalRequestHash({
    mentionAgentId: input.mentionAgentId,
    message: input.message,
    recordInputHistory: input.recordInputHistory,
  });
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      const thread = database
        .prepare(
          `SELECT next_fact_sequence AS nextFactSequence,deleted_at AS deletedAt
           FROM collaboration_threads WHERE project_id=? AND id=?`,
        )
        .get(projectId, threadId) as
        | { nextFactSequence: number; deletedAt: string | null }
        | undefined;
      if (!thread) resourceNotFound();
      if (thread.deletedAt !== null) threadDeletedNotFound();

      const prior = readOperationReceipt<RunStartResponse>(
        database,
        projectId,
        input.operationId,
        "start",
        requestHash,
      );
      if (prior) {
        const stored = prior.body as unknown as {
          error?: {
            code: CollaborationError["code"];
            fields?: Record<string, string>;
            message: string;
          };
        };
        if (stored.error) {
          throw new CollaborationError(
            stored.error.code,
            prior.status,
            stored.error.message,
            stored.error.fields ? { fields: stored.error.fields } : {},
          );
        }
        if (prior.body.run.threadId !== threadId || prior.body.created !== true) {
          throw new CollaborationError(
            "OPERATION_CONFLICT",
            409,
            "Operation id was already used for different input.",
          );
        }
        return prior as { body: RunStartResponse; status: 201 };
      }

      const active = database
        .prepare(
          `SELECT id AS runId,thread_id AS threadId
           FROM collaboration_runs
           WHERE project_id=?
             AND status IN ('running','waiting_owner','paused','failed')
           LIMIT 1`,
        )
        .get(projectId) as { runId: string; threadId: string } | undefined;
      const missingProjectFacts = missingProjectFactsFromDatabase(database, projectId);
      const dispatch = resolveThreadDispatchFromDatabase(
        database,
        projectId,
        threadId,
        { kind: "start", mentionAgentId: input.mentionAgentId },
        {
          missingProjectFacts,
          projectRunActive: Boolean(active),
        },
      );
      const failure = dispatchFailure(dispatch.dispatch);
      if (failure) {
        if (failure.code === "CONTEXT_NOT_READY") {
          throw new CollaborationError(
            failure.code,
            failure.httpStatus,
            failure.message,
            {
              fields: Object.fromEntries(
                missingProjectFacts.map((fact) => [fact, "required"]),
              ),
            },
          );
        }
        if (failure.code === "PROJECT_RUN_ACTIVE" && active) {
          throw new CollaborationError(
            failure.code,
            failure.httpStatus,
            failure.message,
            {
              activeRunId: active.runId,
              activeThreadId: active.threadId,
            },
          );
        }
        throw failure;
      }

      const currentAgentId = dispatch.selectedMemberId!;
      const messageSequence = currentMessageSequence(database, projectId, threadId);
      const firstActivity = nextThreadActivitySequenceTx(database, projectId);
      const timestamp = new Date().toISOString();
      const consumedQueueItem = consumePendingQueueHeadTx(
        database,
        projectId,
        threadId,
        timestamp,
      );
      const messageContent = consumedQueueItem?.content ?? input.message;
      if (consumedQueueItem) {
        hooks.credentialCheck?.(messageContent);
      }
      const mentionAgentId = consumedQueueItem ? null : input.mentionAgentId;
      const mentionDisplayName = resolveMessageMention(
        database,
        projectId,
        threadId,
        mentionAgentId,
      );
      const runId = randomUUID();
      const messageId = randomUUID();
      const eventId = randomUUID();
      const runLinkedFactId = randomUUID();
      const ownerMessageFactId = randomUUID();
      const runEventFactId = randomUUID();
      const run: RunStartResponse["run"] = {
        createdAt: timestamp,
        currentAgentId,
        id: runId,
        pauseCategory: null,
        projectId,
        roundCount: 0,
        status: "running",
        threadId,
        updatedAt: timestamp,
        version: 1,
      };
      const message: ThreadMessageDto = {
        attachments: [],
        authorAgentId: null,
        authorDisplayName: "Owner",
        authorType: "owner",
        content: messageContent,
        createdAt: timestamp,
        id: messageId,
        mentionAgentId,
        mentionDisplayName,
        mentionMemberStatus: mentionAgentId === null ? null : "current",
        projectId,
        replyTo: null,
        runId,
        sequence: messageSequence,
        threadId,
      };
      const runLinkedFact: RunStartResponse["facts"][0] = {
        activitySequence: firstActivity,
        actorId: null,
        actorType: "system",
        createdAt: timestamp,
        id: runLinkedFactId,
        message: null,
        messageId: null,
        payload: { runId },
        policyRevisionId: null,
        projectId,
        runEventId: null,
        runId,
        sequence: thread.nextFactSequence,
        threadId,
        type: "run_linked",
      };
      const ownerMessageFact: RunStartResponse["facts"][1] = {
        activitySequence: firstActivity + 1,
        actorId: null,
        actorType: "owner",
        createdAt: timestamp,
        id: ownerMessageFactId,
        message,
        messageId,
        payload: { messageId },
        policyRevisionId: null,
        projectId,
        runEventId: null,
        runId,
        sequence: thread.nextFactSequence + 1,
        threadId,
        type: "owner_message",
      };
      const runEventFact: RunStartResponse["facts"][2] = {
        activitySequence: firstActivity + 2,
        actorId: null,
        actorType: "owner",
        createdAt: timestamp,
        id: runEventFactId,
        message: null,
        messageId: null,
        payload: { eventType: "run_started" },
        policyRevisionId: null,
        projectId,
        runEventId: eventId,
        runId,
        sequence: thread.nextFactSequence + 2,
        threadId,
        type: "run_event",
      };
      const body: RunStartResponse = {
        created: true,
        facts: [runLinkedFact, ownerMessageFact, runEventFact],
        message,
        run,
      };

      completeOperationReceipt(database, {
        body,
        kind: "start",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId,
        status: 201,
        threadId,
        timestamp,
      });
      hooks.fault?.("after_receipt");
      database
        .prepare(
          `INSERT INTO collaboration_runs(
             id,project_id,thread_id,status,current_agent_id,round_count,
             next_event_sequence,version,execution_epoch,pause_reason,pause_category,
             created_at,updated_at
           ) VALUES (?,?,?,'running',?,0,2,1,1,NULL,NULL,?,?)`,
        )
        .run(runId, projectId, threadId, currentAgentId, timestamp, timestamp);
      hooks.fault?.("after_run");
      database
        .prepare(
          `INSERT INTO collaboration_messages(
             id,project_id,thread_id,run_id,author_type,author_agent_id,
             author_display_name,content,mention_agent_id,mention_display_name,
             sequence,consumed_at,created_at
           ) VALUES (?,?,?,?,'owner',NULL,?,?,?,?,?,NULL,?)`,
        )
        .run(
          messageId,
          projectId,
          threadId,
          runId,
          message.authorDisplayName,
          message.content,
          message.mentionAgentId,
          message.mentionDisplayName,
          message.sequence,
          timestamp,
        );
      hooks.fault?.("after_message");
      database
        .prepare(
          `INSERT INTO collaboration_events(
             id,project_id,thread_id,run_id,sequence,type,actor_type,actor_id,
             payload_json,created_at
           ) VALUES (?,?,?,?,1,'run_started','owner',NULL,?,?)`,
        )
      .run(
        eventId,
        projectId,
        threadId,
        runId,
        JSON.stringify({ currentAgentId, messageId, messageSequence }),
        timestamp,
      );
      appendCollaborationAuditOutboxRow(database, {
        actorId: null,
        actorType: "owner",
        eventId,
        eventType: "run_started",
        projectId,
        runId,
        sourcePayload: { currentAgentId, messageId, messageSequence },
        threadId,
      });
      hooks.fault?.("after_event");
      appendBatchTx(database, [
        {
          actorId: null,
          actorType: "system",
          factId: runLinkedFactId,
          payload: runLinkedFact.payload,
          projectId,
          runId,
          threadId,
          timestamp,
          type: "run_linked",
        },
        {
          actorId: null,
          actorType: "owner",
          factId: ownerMessageFactId,
          messageId,
          payload: ownerMessageFact.payload,
          projectId,
          runId,
          threadId,
          timestamp,
          type: "owner_message",
        },
        {
          actorId: null,
          actorType: "owner",
          factId: runEventFactId,
          payload: runEventFact.payload,
          projectId,
          runEventId: eventId,
          runId,
          threadId,
          timestamp,
          type: "run_event",
        },
      ]);
      hooks.fault?.("after_facts");
      const messageUpdate = database
        .prepare(
          `UPDATE collaboration_project_sequences
           SET next_message_sequence=next_message_sequence+1
           WHERE project_id=? AND thread_id=? AND next_message_sequence=?`,
        )
        .run(projectId, threadId, messageSequence);
      if (messageUpdate.changes !== 1) {
        throw new CollaborationError(
          "STORAGE_UNAVAILABLE",
          503,
          "Run storage is unavailable.",
        );
      }
      hooks.fault?.("after_sequences");
      recordOwnerInputAndClearDraftTx(
        database,
        projectId,
        threadId,
        messageContent,
        timestamp,
        input.recordInputHistory,
      );
      return { body, status: 201 as const };
    });
  } catch (error) {
    if (
      error instanceof CollaborationError
      && error.code === "CONTEXT_NOT_READY"
    ) {
      const existing = database.prepare(
        `SELECT status FROM collaboration_operations
         WHERE project_id=? AND thread_id=? AND id=?`,
      ).get(projectId, threadId, input.operationId) as
        | { status: "pending" | "completed" }
        | undefined;
      if (existing?.status !== "completed") {
        transaction(database, () => {
          completeOperationReceipt(database, {
            body: collaborationErrorBody(error),
            kind: "start",
            operationId: input.operationId,
            projectId,
            requestHash,
            runId: null,
            status: error.httpStatus,
            threadId,
            timestamp: new Date().toISOString(),
          });
        });
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

export function readThreadOperation(
  databasePath: string,
  projectId: string,
  threadId: string,
  operationId: string,
): { body: ThreadOperationLookupResponse; status: 200 } {
  const database = openDatabase(databasePath);
  try {
    ensureActiveThread(database, projectId, threadId);
    const row = database
      .prepare(
        `SELECT operations.id AS operationId,operations.kind,operations.status,
                operations.http_status AS httpStatus,
                operations.response_json AS responseJson
         FROM collaboration_threads AS threads
         JOIN collaboration_operations AS operations
           ON operations.project_id=threads.project_id
          AND operations.thread_id=threads.id
         WHERE threads.project_id=? AND threads.id=? AND operations.id=?`,
      )
      .get(projectId, threadId, operationId) as
      | {
          operationId: string;
          kind: ThreadOperationLookupResponse["kind"];
          status: "pending" | "completed";
          httpStatus: number | null;
          responseJson: string | null;
        }
      | undefined;
    if (!row) resourceNotFound();
    return {
      body: {
        httpStatus: row.httpStatus,
        kind: row.kind,
        operationId: row.operationId,
        response: row.responseJson === null ? null : JSON.parse(row.responseJson),
        status: row.status,
      },
      status: 200,
    };
  } finally {
    database.close();
  }
}

export function listThreads(
  databasePath: string,
  projectId: string,
  rawInput: unknown = {},
): { body: ThreadListResponse; status: 200 } {
  const input = parseListInput(rawInput);
  const database = openDatabase(databasePath);
  try {
    ensureProject(database, projectId);
    const cursorPredicate = input.cursor
      ? `AND (
           threads.last_activity_sequence < ?
           OR (threads.last_activity_sequence = ? AND threads.id > ?)
         )`
      : "";
    const values: Array<string | number> = [projectId];
    if (input.tagId !== null) values.push(input.tagId);
    if (input.cursor) {
      values.push(input.cursor.a, input.cursor.a, input.cursor.id);
    }
    values.push(input.limit + 1);
    const rows = database
      .prepare(
        `SELECT threads.id,threads.project_id AS projectId,threads.title,
                threads.policy_version AS policyVersion,
                threads.last_activity_sequence AS lastActivitySequence,
                threads.version,threads.created_at AS createdAt,
                threads.updated_at AS updatedAt,
                favorites.created_at AS favoritedAt
         FROM collaboration_threads AS threads
         LEFT JOIN thread_favorites AS favorites
           ON favorites.project_id=threads.project_id
          AND favorites.thread_id=threads.id
         WHERE threads.project_id=?
           AND threads.deleted_at IS NULL
           ${
             input.tagId !== null
               ? `AND EXISTS(
                   SELECT 1 FROM thread_tag_edges AS tag_edges
                   WHERE tag_edges.project_id=threads.project_id
                     AND tag_edges.thread_id=threads.id
                     AND tag_edges.tag_id=?
                 )`
               : ""
           }
           ${input.favoritesOnly ? "AND favorites.thread_id IS NOT NULL" : ""}
           ${cursorPredicate}
         ORDER BY ${
           input.favoritesOnly
             ? "favorites.created_at DESC,threads.id ASC"
             : "threads.last_activity_sequence DESC,threads.id ASC"
         }
         LIMIT ?`,
      )
      .all(...values) as Array<{
      id: string;
      projectId: string;
      title: string;
      policyVersion: number;
      lastActivitySequence: number;
      version: number;
      createdAt: string;
      updatedAt: string;
      favoritedAt: string | null;
    }>;
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    // Tags come from one batched second query over the page's thread ids (no
    // N+1), ordered by tag name so every item's projection is deterministic.
    const tagsByThread = new Map<string, ThreadTagRefDto[]>();
    if (pageRows.length > 0) {
      const placeholders = pageRows.map(() => "?").join(",");
      const tagRows = database
        .prepare(
          `SELECT edges.thread_id AS threadId,tags.id,tags.name
           FROM thread_tag_edges AS edges
           JOIN thread_tags AS tags
             ON tags.project_id=edges.project_id AND tags.id=edges.tag_id
           WHERE edges.project_id=? AND edges.thread_id IN (${placeholders})
           ORDER BY tags.name,tags.id`,
        )
        .all(projectId, ...pageRows.map((row) => row.id)) as Array<{
        id: string;
        name: string;
        threadId: string;
      }>;
      for (const row of tagRows) {
        const list = tagsByThread.get(row.threadId);
        if (list) list.push({ id: row.id, name: row.name });
        else tagsByThread.set(row.threadId, [{ id: row.id, name: row.name }]);
      }
    }
    const threads: ThreadListItemDto[] = pageRows.map((row) => ({
      ...row,
      availability: readThreadPolicyFromDatabase(database, projectId, row.id).availability,
      isFavorite: row.favoritedAt !== null,
      tags: tagsByThread.get(row.id) ?? [],
    }));
    const last = threads.at(-1);
    return {
      body: {
        nextCursor:
          !input.favoritesOnly && hasMore && last
            ? encodeThreadCursor({ a: last.lastActivitySequence, id: last.id })
            : null,
        threads,
      },
      status: 200,
    };
  } finally {
    database.close();
  }
}

type QueueThreadState = {
  deletedAt: string | null;
  version: number;
};

type QueueItemRow = {
  content: string;
  createdAt: string;
  id: string;
  position: number;
  projectId: string;
  status: ThreadQueueItemDto["status"];
  threadId: string;
  updatedAt: string;
};

function readQueueThreadState(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
): QueueThreadState {
  const row = database.prepare(
    `SELECT deleted_at AS deletedAt,version
     FROM collaboration_threads
     WHERE project_id=? AND id=?`,
  ).get(projectId, threadId) as QueueThreadState | undefined;
  if (!row) resourceNotFound();
  if (row.deletedAt !== null) threadDeletedNotFound();
  return row;
}

function readQueueItem(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
  queueItemId: string,
): QueueItemRow {
  const row = database.prepare(
    `SELECT id,project_id AS projectId,thread_id AS threadId,content,
            position,status,created_at AS createdAt,updated_at AS updatedAt
     FROM thread_message_queue
     WHERE project_id=? AND thread_id=? AND id=?`,
  ).get(projectId, threadId, queueItemId) as QueueItemRow | undefined;
  if (!row) resourceNotFound();
  return row;
}

function mapQueueItem(row: QueueItemRow): ThreadQueueItemDto {
  return {
    content: row.content,
    createdAt: row.createdAt,
    id: row.id,
    position: row.position,
    projectId: row.projectId,
    status: row.status,
    threadId: row.threadId,
    updatedAt: row.updatedAt,
  };
}

function consumePendingQueueHeadTx(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
  timestamp: string,
): QueueItemRow | null {
  const head = database.prepare(
    `SELECT id,project_id AS projectId,thread_id AS threadId,content,
            position,status,created_at AS createdAt,updated_at AS updatedAt
     FROM thread_message_queue
     WHERE project_id=? AND thread_id=? AND status='pending'
     ORDER BY position ASC,id ASC
     LIMIT 1`,
  ).get(projectId, threadId) as QueueItemRow | undefined;
  if (!head) return null;
  const consumed = database.prepare(
    `UPDATE thread_message_queue
     SET status='consumed',updated_at=?
     WHERE project_id=? AND thread_id=? AND id=? AND status='pending'`,
  ).run(timestamp, projectId, threadId, head.id);
  if (consumed.changes !== 1) return null;
  return {
    ...head,
    status: "consumed",
    updatedAt: timestamp,
  };
}

export function enqueueThreadMessage(
  databasePath: string,
  projectId: string,
  threadId: string,
  rawInput: unknown,
): { body: ThreadQueueEnqueueResponse; status: 201 } {
  const input = parseQueueEnqueueInput(rawInput);
  const requestHash = canonicalRequestHash({
    content: input.content,
    expectedVersion: input.expectedVersion,
  });
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      readQueueThreadState(database, projectId, threadId);
      const prior = readOperationReceipt<ThreadQueueEnqueueResponse>(
        database,
        projectId,
        input.operationId,
        "message",
        requestHash,
      );
      if (prior) {
        if (prior.body.item.threadId !== threadId) {
          throw new CollaborationError(
            "OPERATION_CONFLICT",
            409,
            "Operation id was already used for different input.",
          );
        }
        return prior as { body: ThreadQueueEnqueueResponse; status: 201 };
      }

      const current = readQueueThreadState(database, projectId, threadId);
      if (current.version !== input.expectedVersion) {
        throw new CollaborationError(
          "VERSION_CONFLICT",
          409,
          "Thread version has changed.",
          { currentVersion: current.version },
        );
      }
      const timestamp = new Date().toISOString();
      const queueItemId = randomUUID();
      const nextPosition = (
        database.prepare(
          `SELECT COALESCE(MAX(position),0)+1 AS nextPosition
           FROM thread_message_queue
           WHERE project_id=? AND thread_id=?`,
        ).get(projectId, threadId) as { nextPosition: number }
      ).nextPosition;
      database.prepare(
        `INSERT INTO thread_message_queue(
           id,project_id,thread_id,content,position,status,operation_id,created_at,updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(
        queueItemId,
        projectId,
        threadId,
        input.content,
        nextPosition,
        input.operationId,
        timestamp,
        timestamp,
      );
      database.prepare(
        `UPDATE collaboration_threads
         SET version=version+1,updated_at=?
         WHERE project_id=? AND id=? AND version=?`,
      ).run(timestamp, projectId, threadId, input.expectedVersion);
      const body: ThreadQueueEnqueueResponse = {
        created: true,
        item: {
          content: input.content,
          createdAt: timestamp,
          id: queueItemId,
          position: nextPosition,
          projectId,
          status: "pending",
          threadId,
          updatedAt: timestamp,
        },
        threadVersion: input.expectedVersion + 1,
      };
      completeOperationReceipt(database, {
        body,
        kind: "message",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId: null,
        status: 201,
        threadId,
        timestamp,
      });
      return { body, status: 201 as const };
    });
  } finally {
    database.close();
  }
}

export function cancelQueuedMessage(
  databasePath: string,
  projectId: string,
  threadId: string,
  queueItemId: string,
  rawInput: unknown,
): { body: ThreadQueueCancelResponse; status: 200 } {
  const input = parseQueueCancelInput(rawInput);
  const requestHash = canonicalRequestHash({
    expectedVersion: input.expectedVersion,
    queueItemId,
  });
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      readQueueThreadState(database, projectId, threadId);
      const prior = readOperationReceipt<ThreadQueueCancelResponse>(
        database,
        projectId,
        input.operationId,
        "control",
        requestHash,
      );
      if (prior) {
        if (prior.body.item.threadId !== threadId || prior.body.item.id !== queueItemId) {
          throw new CollaborationError(
            "OPERATION_CONFLICT",
            409,
            "Operation id was already used for different input.",
          );
        }
        return prior as { body: ThreadQueueCancelResponse; status: 200 };
      }

      const item = readQueueItem(database, projectId, threadId, queueItemId);
      if (item.status === "consumed") {
        throw new CollaborationError(
          "ACTION_CONFLICT",
          409,
          "Queued message is already consumed.",
        );
      }

      const current = readQueueThreadState(database, projectId, threadId);
      const timestamp = new Date().toISOString();
      if (item.status === "cancelled") {
        const body: ThreadQueueCancelResponse = {
          cancelled: false,
          item: mapQueueItem(item),
          threadVersion: current.version,
        };
        completeOperationReceipt(database, {
          body,
          kind: "control",
          operationId: input.operationId,
          projectId,
          requestHash,
          runId: null,
          status: 200,
          threadId,
          timestamp,
        });
        return { body, status: 200 as const };
      }
      if (current.version !== input.expectedVersion) {
        throw new CollaborationError(
          "VERSION_CONFLICT",
          409,
          "Thread version has changed.",
          { currentVersion: current.version },
        );
      }
      database.prepare(
        `UPDATE thread_message_queue
         SET status='cancelled',updated_at=?
         WHERE project_id=? AND thread_id=? AND id=? AND status='pending'`,
      ).run(timestamp, projectId, threadId, queueItemId);
      database.prepare(
        `UPDATE collaboration_threads
         SET version=version+1,updated_at=?
         WHERE project_id=? AND id=? AND version=?`,
      ).run(timestamp, projectId, threadId, input.expectedVersion);
      const body: ThreadQueueCancelResponse = {
        cancelled: true,
        item: {
          ...mapQueueItem(item),
          status: "cancelled",
          updatedAt: timestamp,
        },
        threadVersion: input.expectedVersion + 1,
      };
      completeOperationReceipt(database, {
        body,
        kind: "control",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId: null,
        status: 200,
        threadId,
        timestamp,
      });
      return { body, status: 200 as const };
    });
  } finally {
    database.close();
  }
}

export function reorderQueuedMessage(
  databasePath: string,
  projectId: string,
  threadId: string,
  queueItemId: string,
  rawInput: unknown,
): { body: ThreadQueueReorderResponse; status: 200 } {
  const input = parseQueueReorderInput(rawInput);
  const requestHash = canonicalRequestHash({
    expectedVersion: input.expectedVersion,
    position: input.position,
    queueItemId,
  });
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      readQueueThreadState(database, projectId, threadId);
      const prior = readOperationReceipt<ThreadQueueReorderResponse>(
        database,
        projectId,
        input.operationId,
        "control",
        requestHash,
      );
      if (prior) {
        if (prior.body.item.threadId !== threadId || prior.body.item.id !== queueItemId) {
          throw new CollaborationError(
            "OPERATION_CONFLICT",
            409,
            "Operation id was already used for different input.",
          );
        }
        return prior as { body: ThreadQueueReorderResponse; status: 200 };
      }

      const item = readQueueItem(database, projectId, threadId, queueItemId);
      if (item.status !== "pending") {
        throw new CollaborationError(
          "ACTION_CONFLICT",
          409,
          "Only pending queued message can be reordered.",
        );
      }

      const current = readQueueThreadState(database, projectId, threadId);
      if (current.version !== input.expectedVersion) {
        throw new CollaborationError(
          "VERSION_CONFLICT",
          409,
          "Thread version has changed.",
          { currentVersion: current.version },
        );
      }

      const pending = database.prepare(
        `SELECT id,position
         FROM thread_message_queue
         WHERE project_id=? AND thread_id=? AND status='pending'
         ORDER BY position ASC,id ASC`,
      ).all(projectId, threadId) as Array<{ id: string; position: number }>;
      const currentIndex = pending.findIndex(({ id }) => id === queueItemId);
      if (currentIndex < 0) {
        throw new CollaborationError(
          "ACTION_CONFLICT",
          409,
          "Only pending queued message can be reordered.",
        );
      }
      if (input.position > pending.length) {
        throw new CollaborationError(
          "INVALID_INPUT",
          400,
          "Queue reorder input is invalid.",
          { fields: { position: "invalid_range" } },
        );
      }
      const targetIndex = input.position - 1;
      const timestamp = new Date().toISOString();
      if (targetIndex === currentIndex) {
        const body: ThreadQueueReorderResponse = {
          item: mapQueueItem(item),
          reordered: false,
          threadVersion: current.version,
        };
        completeOperationReceipt(database, {
          body,
          kind: "control",
          operationId: input.operationId,
          projectId,
          requestHash,
          runId: null,
          status: 200,
          threadId,
          timestamp,
        });
        return { body, status: 200 as const };
      }

      const pendingIds = pending.map(({ id }) => id);
      const [movedId] = pendingIds.splice(currentIndex, 1);
      pendingIds.splice(targetIndex, 0, movedId);
      const stablePositions = pending.map(({ position }) => position);
      const finalPositionById = new Map<string, number>();
      pendingIds.forEach((id, index) => {
        finalPositionById.set(id, stablePositions[index]!);
      });
      const changedIds = pendingIds.filter(
        (id) => finalPositionById.get(id) !== pending.find((row) => row.id === id)?.position,
      );
      if (changedIds.length > 0) {
        const tempOffset = 1_000_000;
        const bumpPosition = database.prepare(
          `UPDATE thread_message_queue
           SET position=position+?,updated_at=?
           WHERE project_id=? AND thread_id=? AND id=? AND status='pending'`,
        );
        const setPosition = database.prepare(
          `UPDATE thread_message_queue
           SET position=?,updated_at=?
           WHERE project_id=? AND thread_id=? AND id=? AND status='pending'`,
        );
        for (const id of changedIds) {
          bumpPosition.run(tempOffset, timestamp, projectId, threadId, id);
        }
        for (const id of changedIds) {
          const nextPosition = finalPositionById.get(id);
          if (nextPosition === undefined) {
            throw new CollaborationError(
              "STORAGE_UNAVAILABLE",
              503,
              "Queue reorder storage is unavailable.",
            );
          }
          setPosition.run(nextPosition, timestamp, projectId, threadId, id);
        }
      }
      database.prepare(
        `UPDATE collaboration_threads
         SET version=version+1,updated_at=?
         WHERE project_id=? AND id=? AND version=?`,
      ).run(timestamp, projectId, threadId, input.expectedVersion);

      const nextPosition = finalPositionById.get(queueItemId) ?? item.position;
      const body: ThreadQueueReorderResponse = {
        item: {
          ...mapQueueItem(item),
          position: nextPosition,
          updatedAt: timestamp,
        },
        reordered: true,
        threadVersion: input.expectedVersion + 1,
      };
      completeOperationReceipt(database, {
        body,
        kind: "control",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId: null,
        status: 200,
        threadId,
        timestamp,
      });
      return { body, status: 200 as const };
    });
  } finally {
    database.close();
  }
}

export function steerQueuedMessage(
  databasePath: string,
  projectId: string,
  threadId: string,
  queueItemId: string,
  rawInput: unknown,
): { body: ThreadQueueSteerResponse; status: 200 } {
  const input = parseQueueSteerInput(rawInput);
  const requestHash = canonicalRequestHash({
    expectedVersion: input.expectedVersion,
    queueItemId,
  });
  const database = openDatabase(databasePath);
  database.exec("PRAGMA busy_timeout=5000");
  try {
    return transaction(database, () => {
      readQueueThreadState(database, projectId, threadId);
      const prior = readOperationReceipt<ThreadQueueSteerResponse>(
        database,
        projectId,
        input.operationId,
        "control",
        requestHash,
      );
      if (prior) {
        if (prior.body.item.threadId !== threadId || prior.body.item.id !== queueItemId) {
          throw new CollaborationError(
            "OPERATION_CONFLICT",
            409,
            "Operation id was already used for different input.",
          );
        }
        return prior as { body: ThreadQueueSteerResponse; status: 200 };
      }

      const item = readQueueItem(database, projectId, threadId, queueItemId);
      if (item.status !== "pending") {
        throw new CollaborationError(
          "ACTION_CONFLICT",
          409,
          "Only pending queued message can be steered.",
        );
      }
      const current = readQueueThreadState(database, projectId, threadId);
      if (current.version !== input.expectedVersion) {
        throw new CollaborationError(
          "VERSION_CONFLICT",
          409,
          "Thread version has changed.",
          { currentVersion: current.version },
        );
      }

      const active = database
        .prepare(
          `SELECT 1
           FROM collaboration_runs
           WHERE project_id=?
             AND status IN ('running','waiting_owner','paused','failed')
             AND thread_id<>?
           LIMIT 1`,
        )
        .get(projectId, threadId);
      const dispatch = resolveThreadDispatchFromDatabase(
        database,
        projectId,
        threadId,
        { kind: "start" },
        {
          missingProjectFacts: missingProjectFactsFromDatabase(database, projectId),
          projectRunActive: Boolean(active),
        },
      ).dispatch;
      if (dispatch !== "ready") {
        throw new CollaborationError(
          "ACTION_CONFLICT",
          409,
          `Queue steer is disabled when dispatch is ${dispatch}.`,
        );
      }

      const pending = database.prepare(
        `SELECT id,position
         FROM thread_message_queue
         WHERE project_id=? AND thread_id=? AND status='pending'
         ORDER BY position ASC,id ASC`,
      ).all(projectId, threadId) as Array<{ id: string; position: number }>;
      const currentIndex = pending.findIndex(({ id }) => id === queueItemId);
      if (currentIndex < 0) {
        throw new CollaborationError(
          "ACTION_CONFLICT",
          409,
          "Only pending queued message can be steered.",
        );
      }
      const timestamp = new Date().toISOString();
      if (currentIndex === 0) {
        const body: ThreadQueueSteerResponse = {
          item: mapQueueItem(item),
          steered: false,
          threadVersion: current.version,
        };
        completeOperationReceipt(database, {
          body,
          kind: "control",
          operationId: input.operationId,
          projectId,
          requestHash,
          runId: null,
          status: 200,
          threadId,
          timestamp,
        });
        return { body, status: 200 as const };
      }

      const pendingIds = pending.map(({ id }) => id);
      const [movedId] = pendingIds.splice(currentIndex, 1);
      pendingIds.unshift(movedId);
      const stablePositions = pending.map(({ position }) => position);
      const finalPositionById = new Map<string, number>();
      pendingIds.forEach((id, index) => {
        finalPositionById.set(id, stablePositions[index]!);
      });
      const changedIds = pendingIds.filter(
        (id) => finalPositionById.get(id) !== pending.find((row) => row.id === id)?.position,
      );
      if (changedIds.length > 0) {
        const tempOffset = 1_000_000;
        const bumpPosition = database.prepare(
          `UPDATE thread_message_queue
           SET position=position+?,updated_at=?
           WHERE project_id=? AND thread_id=? AND id=? AND status='pending'`,
        );
        const setPosition = database.prepare(
          `UPDATE thread_message_queue
           SET position=?,updated_at=?
           WHERE project_id=? AND thread_id=? AND id=? AND status='pending'`,
        );
        for (const id of changedIds) {
          bumpPosition.run(tempOffset, timestamp, projectId, threadId, id);
        }
        for (const id of changedIds) {
          const nextPosition = finalPositionById.get(id);
          if (nextPosition === undefined) {
            throw new CollaborationError(
              "STORAGE_UNAVAILABLE",
              503,
              "Queue steer storage is unavailable.",
            );
          }
          setPosition.run(nextPosition, timestamp, projectId, threadId, id);
        }
      }
      database.prepare(
        `UPDATE collaboration_threads
         SET version=version+1,updated_at=?
         WHERE project_id=? AND id=? AND version=?`,
      ).run(timestamp, projectId, threadId, input.expectedVersion);
      const body: ThreadQueueSteerResponse = {
        item: {
          ...mapQueueItem(item),
          position: finalPositionById.get(queueItemId) ?? item.position,
          updatedAt: timestamp,
        },
        steered: true,
        threadVersion: input.expectedVersion + 1,
      };
      completeOperationReceipt(database, {
        body,
        kind: "control",
        operationId: input.operationId,
        projectId,
        requestHash,
        runId: null,
        status: 200,
        threadId,
        timestamp,
      });
      return { body, status: 200 as const };
    });
  } finally {
    database.close();
  }
}

export function listThreadQueue(
  databasePath: string,
  projectId: string,
  threadId: string,
): { body: ThreadQueueListResponseDto; status: 200 } {
  const database = openDatabase(databasePath);
  try {
    ensureActiveThread(database, projectId, threadId);
    const items = database.prepare(
      `SELECT id,project_id AS projectId,thread_id AS threadId,content,
              position,status,created_at AS createdAt,updated_at AS updatedAt
       FROM thread_message_queue
       WHERE project_id=? AND thread_id=?
       ORDER BY position ASC,id ASC`,
    ).all(projectId, threadId) as ThreadQueueItemDto[];
    return { body: { items }, status: 200 };
  } finally {
    database.close();
  }
}

export function readThreadDetail(
  databasePath: string,
  projectId: string,
  threadId: string,
  selectedRunId: string | null,
): { body: ThreadDetailResponse; status: 200 } {
  const database = openDatabase(databasePath);
  try {
    ensureActiveThread(database, projectId, threadId);
    const row = database
      .prepare(
        `SELECT id,project_id AS projectId,title,policy_version AS policyVersion,
                last_activity_sequence AS lastActivitySequence,version,
                created_at AS createdAt,updated_at AS updatedAt
         FROM collaboration_threads
         WHERE project_id=? AND id=?`,
      )
      .get(projectId, threadId) as
      | Omit<ThreadSummary, "availability">
      | undefined;
    if (!row) {
      resourceNotFound();
    }

    const policy = readThreadPolicyFromDatabase(database, projectId, threadId);
    const thread: ThreadDetail = {
      ...row,
      availability: policy.availability,
      policy,
    };
    const runSelect = `SELECT id,project_id AS projectId,thread_id AS threadId,status,
                              current_agent_id AS currentAgentId,
                              round_count AS roundCount,pause_category AS pauseCategory,
                              version,created_at AS createdAt,updated_at AS updatedAt
                       FROM collaboration_runs`;
    const runs = database
      .prepare(
        `${runSelect}
         WHERE project_id=? AND thread_id=?
         ORDER BY created_at DESC,id ASC`,
      )
      .all(projectId, threadId) as ThreadRun[];
    let selectedRun: ThreadRun | null = null;
    if (selectedRunId !== null) {
      selectedRun = (database
        .prepare(
          `${runSelect}
           WHERE project_id=? AND thread_id=? AND id=?`,
        )
        .get(projectId, threadId, selectedRunId) as ThreadRun | undefined) ?? null;
      if (!selectedRun) {
        resourceNotFound();
      }
    }
    const activeRun = database
      .prepare(
        `SELECT thread_id AS threadId,id AS runId
         FROM collaboration_runs
         WHERE project_id=?
           AND status IN ('running','waiting_owner','paused','failed')
         LIMIT 1`,
      )
      .get(projectId) as { threadId: string; runId: string } | undefined;
    const missingProjectFacts = missingProjectFactsFromDatabase(database, projectId);
    const dispatch = resolveThreadDispatchFromDatabase(
      database,
      projectId,
      threadId,
      selectedRun
        ? { kind: "advance", currentAgentId: selectedRun.currentAgentId }
        : { kind: "start" },
      {
        missingProjectFacts,
        projectRunActive: Boolean(activeRun && activeRun.runId !== selectedRun?.id),
      },
    );
    return {
      body: {
        activeRun: activeRun ?? null,
        readiness: {
          dispatch: dispatch.dispatch,
          missingProjectFacts: dispatch.missingProjectFacts,
          selectedMemberId: dispatch.selectedMemberId,
        },
        runs,
        selectedRun,
        thread,
      },
      status: 200,
    };
  } finally {
    database.close();
  }
}

type MessageRow = Omit<
  ThreadMessageDto,
  "attachments" | "blocks" | "mentionMemberStatus" | "replyTo"
> & {
  mentionIsCurrent: number | null;
  replyToMessageId: string | null;
  replyToSequence: number | null;
  replyToAuthorDisplayName: string | null;
  replyToExcerpt: string | null;
};

type FactRow = {
  id: string;
  projectId: string;
  threadId: string;
  sequence: number;
  activitySequence: number;
  type: ThreadFactDto["type"];
  actorType: ThreadFactDto["actorType"];
  actorId: string | null;
  runId: string | null;
  messageId: string | null;
  runEventId: string | null;
  policyRevisionId: string | null;
  inlineDecisionId: string | null;
  businessReceiptId: string | null;
  payloadJson: string;
  createdAt: string;
  referencedRunId: string | null;
  referencedEventId: string | null;
  referencedEventType: string | null;
  referencedPolicyId: string | null;
  messageProjectId: string | null;
  messageThreadId: string | null;
  messageSequence: number | null;
  messageRunId: string | null;
  messageAuthorType: "owner" | "agent" | null;
  messageAuthorAgentId: string | null;
  messageAuthorDisplayName: string | null;
  messageContent: string | null;
  messageMentionAgentId: string | null;
  messageMentionDisplayName: string | null;
  messageMentionIsCurrent: number | null;
  messageCreatedAt: string | null;
  messageReplyToMessageId: string | null;
  messageReplyToSequence: number | null;
  messageReplyToAuthorDisplayName: string | null;
  messageReplyToExcerpt: string | null;
};

function decodeReplySnapshot(row: MessageRow): ThreadMessageReplySnapshot | null {
  const {
    replyToAuthorDisplayName,
    replyToExcerpt,
    replyToMessageId,
    replyToSequence,
  } = row;
  if (
    replyToMessageId === null
    && replyToSequence === null
    && replyToAuthorDisplayName === null
    && replyToExcerpt === null
  ) {
    return null;
  }
  if (
    replyToMessageId === null
    || replyToSequence === null
    || replyToAuthorDisplayName === null
    || replyToExcerpt === null
    || !RESOURCE_ID.test(replyToMessageId)
    || !Number.isSafeInteger(replyToSequence)
    || replyToSequence < 1
  ) {
    resourceNotFound();
  }
  return {
    authorDisplayName: replyToAuthorDisplayName,
    excerpt: replyToExcerpt,
    messageId: replyToMessageId,
    sequence: replyToSequence,
  };
}

function mapMessageRow(
  database: DatabaseSync,
  row: MessageRow,
): ThreadMessageDto {
  if (
    !RESOURCE_ID.test(row.id)
    || !RESOURCE_ID.test(row.projectId)
    || !RESOURCE_ID.test(row.threadId)
    || (row.runId !== null && !RESOURCE_ID.test(row.runId))
    || (row.authorAgentId !== null && !RESOURCE_ID.test(row.authorAgentId))
    || (row.mentionAgentId !== null && !RESOURCE_ID.test(row.mentionAgentId))
    || !Number.isSafeInteger(row.sequence)
    || row.sequence < 1
  ) {
    resourceNotFound();
  }
  return {
    attachments: readMessageAttachmentRefsTx(database, {
      messageId: row.id,
      projectId: row.projectId,
      threadId: row.threadId,
    }),
    authorAgentId: row.authorAgentId,
    authorDisplayName: row.authorDisplayName,
    authorType: row.authorType,
    content: row.content,
    createdAt: row.createdAt,
    id: row.id,
    mentionAgentId: row.mentionAgentId,
    mentionDisplayName: row.mentionDisplayName,
    mentionMemberStatus:
      row.mentionAgentId === null
        ? null
        : row.mentionIsCurrent === 1
          ? "current"
          : "left",
    projectId: row.projectId,
    replyTo: decodeReplySnapshot(row),
    runId: row.runId,
    sequence: row.sequence,
    threadId: row.threadId,
  };
}

function strictPayload(
  payloadJson: string,
  key: string,
): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    resourceNotFound();
  }
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || Object.keys(payload).length !== 1
    || !Object.hasOwn(payload, key)
  ) {
    resourceNotFound();
  }
  return payload as Record<string, unknown>;
}

function strictMessagePayload(payloadJson: string): {
  authorDisplayName?: string;
  authorType?: "owner" | "agent";
  messageId: string;
} {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    resourceNotFound();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    resourceNotFound();
  }
  const value = payload as Record<string, unknown>;
  const keys = Object.keys(value);
  const basic = keys.length === 1 && keys[0] === "messageId";
  const attributed = keys.length === 3
    && ["authorDisplayName", "authorType", "messageId"].every((key) => keys.includes(key))
    && typeof value.authorDisplayName === "string"
    && (value.authorType === "owner" || value.authorType === "agent");
  if (typeof value.messageId !== "string" || (!basic && !attributed)) resourceNotFound();
  return value as {
    authorDisplayName?: string;
    authorType?: "owner" | "agent";
    messageId: string;
  };
}

function mapNestedMessage(database: DatabaseSync, row: FactRow): ThreadMessageDto {
  if (
    row.messageId === null
    || row.messageProjectId !== row.projectId
    || row.messageThreadId !== row.threadId
    || row.messageSequence === null
    || row.messageAuthorType === null
    || row.messageAuthorDisplayName === null
    || row.messageContent === null
    || row.messageCreatedAt === null
    || row.messageRunId !== row.runId
    || row.messageAuthorType !== (row.type === "owner_message" ? "owner" : "agent")
  ) {
    resourceNotFound();
  }
  const message = mapMessageRow(database, {
    authorAgentId: row.messageAuthorAgentId,
    authorDisplayName: row.messageAuthorDisplayName,
    authorType: row.messageAuthorType,
    content: row.messageContent,
    createdAt: row.messageCreatedAt,
    id: row.messageId,
    mentionAgentId: row.messageMentionAgentId,
    mentionDisplayName: row.messageMentionDisplayName,
    mentionIsCurrent: row.messageMentionIsCurrent,
    projectId: row.messageProjectId,
    replyToAuthorDisplayName: row.messageReplyToAuthorDisplayName,
    replyToExcerpt: row.messageReplyToExcerpt,
    replyToMessageId: row.messageReplyToMessageId,
    replyToSequence: row.messageReplyToSequence,
    runId: row.messageRunId,
    sequence: row.messageSequence,
    threadId: row.messageThreadId,
  });
  const blocks = readPublicStructuredBlocksTx(database, {
    messageId: message.id,
    projectId: message.projectId,
    runId: message.runId,
    threadId: message.threadId,
  });
  return blocks.length > 0 ? { ...message, blocks } : message;
}

function factBase(row: FactRow) {
  if (
    !RESOURCE_ID.test(row.id)
    || !RESOURCE_ID.test(row.projectId)
    || !RESOURCE_ID.test(row.threadId)
    || (row.actorId !== null && !RESOURCE_ID.test(row.actorId))
    || !Number.isSafeInteger(row.sequence)
    || row.sequence < 1
    || !Number.isSafeInteger(row.activitySequence)
    || row.activitySequence < 1
  ) {
    resourceNotFound();
  }
  return {
    activitySequence: row.activitySequence,
    actorId: row.actorId,
    actorType: row.actorType,
    createdAt: row.createdAt,
    id: row.id,
    projectId: row.projectId,
    sequence: row.sequence,
    threadId: row.threadId,
  };
}

function mapFactRow(database: DatabaseSync, row: FactRow): ThreadFactDto {
  const base = factBase(row);
  if (row.type === "thread_created") {
    const payload = strictPayload(row.payloadJson, "title");
    if (
      typeof payload.title !== "string"
      || payload.title.length === 0
      || row.runId !== null
      || row.messageId !== null
      || row.runEventId !== null
      || row.policyRevisionId !== null
    ) {
      resourceNotFound();
    }
    return {
      ...base,
      message: null,
      messageId: null,
      payload: { title: payload.title },
      policyRevisionId: null,
      runEventId: null,
      runId: null,
      type: "thread_created",
    };
  }
  if (row.type === "policy_changed") {
    const payload = strictPayload(row.payloadJson, "policyVersion");
    if (
      !Number.isSafeInteger(payload.policyVersion)
      || Number(payload.policyVersion) < 1
      || row.runId !== null
      || row.messageId !== null
      || row.runEventId !== null
      || row.policyRevisionId === null
      || !RESOURCE_ID.test(row.policyRevisionId)
      || row.referencedPolicyId !== row.policyRevisionId
    ) {
      resourceNotFound();
    }
    return {
      ...base,
      message: null,
      messageId: null,
      payload: { policyVersion: Number(payload.policyVersion) },
      policyRevisionId: row.policyRevisionId,
      runEventId: null,
      runId: null,
      type: "policy_changed",
    };
  }
  if (row.type === "owner_message" || row.type === "agent_message") {
    const payload = strictMessagePayload(row.payloadJson);
    if (
      row.messageId === null
      || !RESOURCE_ID.test(row.messageId)
      || payload.messageId !== row.messageId
      || row.runEventId !== null
      || row.policyRevisionId !== null
      || (row.runId !== null && !RESOURCE_ID.test(row.runId))
      || (row.runId !== null && row.referencedRunId !== row.runId)
      || (payload.authorType !== undefined && payload.authorType !== row.messageAuthorType)
      || (
        payload.authorDisplayName !== undefined
        && payload.authorDisplayName !== row.messageAuthorDisplayName
      )
    ) {
      resourceNotFound();
    }
    return {
      ...base,
      message: mapNestedMessage(database, row),
      messageId: row.messageId,
      payload: { messageId: row.messageId },
      policyRevisionId: null,
      runEventId: null,
      runId: row.runId,
      type: row.type,
    };
  }
  if (row.type === "run_linked") {
    const payload = strictPayload(row.payloadJson, "runId");
    if (
      row.runId === null
      || !RESOURCE_ID.test(row.runId)
      || payload.runId !== row.runId
      || row.referencedRunId !== row.runId
      || row.messageId !== null
      || row.runEventId !== null
      || row.policyRevisionId !== null
    ) {
      resourceNotFound();
    }
    return {
      ...base,
      message: null,
      messageId: null,
      payload: { runId: row.runId },
      policyRevisionId: null,
      runEventId: null,
      runId: row.runId,
      type: "run_linked",
    };
  }
  if (row.type === "inline_decision") {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch {
      resourceNotFound();
    }
    if (
      !payload
      || typeof payload !== "object"
      || Array.isArray(payload)
      || Object.keys(payload).length !== 9
    ) resourceNotFound();
    const value = payload as Record<string, unknown>;
    if (
      row.runId === null
      || row.messageId !== null
      || row.runEventId !== null
      || row.policyRevisionId !== null
      || row.inlineDecisionId === null
      || row.businessReceiptId === null
      || !["accept", "reject", "check_item", "uncheck_item"].includes(String(value.action))
      || !RESOURCE_ID.test(String(value.blockId ?? ""))
      || !Number.isSafeInteger(value.blockRevision)
      || Number(value.blockRevision) < 1
      || value.decisionId !== row.inlineDecisionId
      || !Number.isSafeInteger(value.fromStateVersion)
      || Number(value.fromStateVersion) < 1
      || !(
        (["accept", "reject"].includes(String(value.action)) && value.itemId === null)
        || (
          ["check_item", "uncheck_item"].includes(String(value.action))
          && RESOURCE_ID.test(String(value.itemId ?? ""))
        )
      )
      || !RESOURCE_ID.test(String(value.operationId ?? ""))
      || value.receiptId !== row.businessReceiptId
      || value.toStateVersion !== Number(value.fromStateVersion) + 1
    ) resourceNotFound();
    return {
      ...base,
      message: null,
      messageId: null,
      payload: {
        action: value.action as "accept" | "reject" | "check_item" | "uncheck_item",
        blockId: String(value.blockId),
        blockRevision: Number(value.blockRevision),
        decisionId: row.inlineDecisionId,
        fromStateVersion: Number(value.fromStateVersion),
        operationId: String(value.operationId),
        receiptId: row.businessReceiptId,
        toStateVersion: Number(value.toStateVersion),
      },
      policyRevisionId: null,
      runEventId: null,
      runId: row.runId,
      type: "inline_decision",
    };
  }
  if (row.type === "run_event") {
    const payload = strictPayload(row.payloadJson, "eventType");
    if (
      row.runId === null
      || row.runEventId === null
      || !RESOURCE_ID.test(row.runId)
      || !RESOURCE_ID.test(row.runEventId)
      || row.referencedRunId !== row.runId
      || row.referencedEventId !== row.runEventId
      || row.referencedEventType !== payload.eventType
      || typeof payload.eventType !== "string"
      || !Object.hasOwn(timelinePayloadSchemas, payload.eventType)
      || row.messageId !== null
      || row.policyRevisionId !== null
    ) {
      resourceNotFound();
    }
    return {
      ...base,
      message: null,
      messageId: null,
      payload: {
        eventType: payload.eventType as keyof typeof timelinePayloadSchemas,
      },
      policyRevisionId: null,
      runEventId: row.runEventId,
      runId: row.runId,
      type: "run_event",
    };
  }
  return resourceNotFound();
}

function sequencePage<Row extends { sequence: number }, Item extends { sequence: number }>(
  rows: Row[],
  limit: number,
  map: (row: Row) => Item,
): CursorPage<Item> {
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(map);
  return {
    items,
    nextAfter: hasMore ? items.at(-1)?.sequence ?? null : null,
  };
}

export function readThreadMessages(
  databasePath: string,
  projectId: string,
  threadId: string,
  rawInput: unknown = {},
): { body: MessagePageResponse; status: 200 } {
  const input = parseSequencePageInput(rawInput);
  const database = openDatabase(databasePath);
  try {
    ensureActiveThread(database, projectId, threadId);
    const rows = database
      .prepare(
        `SELECT messages.id,messages.project_id AS projectId,
                messages.thread_id AS threadId,messages.sequence,
                messages.run_id AS runId,messages.author_type AS authorType,
                messages.author_agent_id AS authorAgentId,
                messages.author_display_name AS authorDisplayName,
                messages.content,messages.mention_agent_id AS mentionAgentId,
                messages.mention_display_name AS mentionDisplayName,
                CASE WHEN membership.agent_id IS NULL THEN 0 ELSE 1 END AS mentionIsCurrent,
                messages.reply_to_message_id AS replyToMessageId,
                messages.reply_to_sequence AS replyToSequence,
                messages.reply_to_author_display_name AS replyToAuthorDisplayName,
                messages.reply_to_excerpt AS replyToExcerpt,
                messages.created_at AS createdAt
         FROM collaboration_messages AS messages
         LEFT JOIN project_memberships AS membership
           ON membership.project_id=messages.project_id
          AND membership.agent_id=messages.mention_agent_id
         WHERE messages.project_id=? AND messages.thread_id=? AND messages.sequence>?
         ORDER BY messages.sequence ASC,messages.id ASC
         LIMIT ?`,
      )
      .all(projectId, threadId, input.after, input.limit + 1) as MessageRow[];
    return {
      body: sequencePage(rows, input.limit, (row) => {
        const message = mapMessageRow(database, row);
        const blocks = readPublicStructuredBlocksTx(database, {
          messageId: message.id,
          projectId: message.projectId,
          runId: message.runId,
          threadId: message.threadId,
        });
        return blocks.length > 0 ? { ...message, blocks } : message;
      }),
      status: 200,
    };
  } finally {
    database.close();
  }
}

export function readThreadFacts(
  databasePath: string,
  projectId: string,
  threadId: string,
  rawInput: unknown = {},
): { body: FactPageResponse; status: 200 } {
  const input = parseSequencePageInput(rawInput);
  const database = openDatabase(databasePath);
  try {
    ensureActiveThread(database, projectId, threadId);
    const rows = database
      .prepare(
        `SELECT facts.id,facts.project_id AS projectId,facts.thread_id AS threadId,
                facts.sequence,facts.activity_sequence AS activitySequence,
                facts.type,facts.actor_type AS actorType,facts.actor_id AS actorId,
                facts.run_id AS runId,facts.message_id AS messageId,
                facts.run_event_id AS runEventId,
                facts.policy_revision_id AS policyRevisionId,
                facts.inline_decision_id AS inlineDecisionId,
                facts.business_receipt_id AS businessReceiptId,
                facts.payload_json AS payloadJson,facts.created_at AS createdAt,
                runs.id AS referencedRunId,events.id AS referencedEventId,
                events.type AS referencedEventType,
                policy.id AS referencedPolicyId,
                messages.project_id AS messageProjectId,
                messages.thread_id AS messageThreadId,
                messages.sequence AS messageSequence,messages.run_id AS messageRunId,
                messages.author_type AS messageAuthorType,
                messages.author_agent_id AS messageAuthorAgentId,
                messages.author_display_name AS messageAuthorDisplayName,
                messages.content AS messageContent,
                messages.mention_agent_id AS messageMentionAgentId,
                messages.mention_display_name AS messageMentionDisplayName,
                CASE WHEN membership.agent_id IS NULL THEN 0 ELSE 1 END
                  AS messageMentionIsCurrent,
                messages.created_at AS messageCreatedAt,
                messages.reply_to_message_id AS messageReplyToMessageId,
                messages.reply_to_sequence AS messageReplyToSequence,
                messages.reply_to_author_display_name AS messageReplyToAuthorDisplayName,
                messages.reply_to_excerpt AS messageReplyToExcerpt
         FROM collaboration_thread_facts AS facts
         LEFT JOIN collaboration_runs AS runs
           ON runs.project_id=facts.project_id
          AND runs.thread_id=facts.thread_id
          AND runs.id=facts.run_id
         LEFT JOIN collaboration_events AS events
           ON events.project_id=facts.project_id
          AND events.thread_id=facts.thread_id
          AND events.run_id=facts.run_id
          AND events.id=facts.run_event_id
         LEFT JOIN collaboration_thread_policy_revisions AS policy
           ON policy.project_id=facts.project_id
          AND policy.thread_id=facts.thread_id
          AND policy.id=facts.policy_revision_id
         LEFT JOIN collaboration_messages AS messages
           ON messages.project_id=facts.project_id
          AND messages.thread_id=facts.thread_id
          AND messages.id=facts.message_id
         LEFT JOIN project_memberships AS membership
           ON membership.project_id=messages.project_id
          AND membership.agent_id=messages.mention_agent_id
         WHERE facts.project_id=? AND facts.thread_id=? AND facts.sequence>?
         ORDER BY facts.sequence ASC,facts.id ASC
         LIMIT ?`,
      )
      .all(projectId, threadId, input.after, input.limit + 1) as FactRow[];
    return {
      body: sequencePage(rows, input.limit, (row) => mapFactRow(database, row)),
      status: 200,
    };
  } finally {
    database.close();
  }
}
