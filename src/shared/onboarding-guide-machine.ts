import { timelinePayloadSchemas } from "@/src/shared/collaboration-contracts";

export const GUIDE_STEPS = [
  "provider",
  "agent",
  "project-select",
  "workspace",
  "members",
  "goal",
] as const;

export type GuideStep = (typeof GUIDE_STEPS)[number];

export type GuideRoute = {
  href: string;
  projectId: string | null;
  step: GuideStep;
};

export type GuideUrlErrorCode =
  | "duplicate_parameter"
  | "invalid_path"
  | "invalid_project_id"
  | "invalid_return_to"
  | "invalid_section"
  | "missing_parameter"
  | "unknown_parameter"
  | "unknown_project"
  | "unknown_step";

export type GuideUrlResult =
  | { kind: "guide"; route: GuideRoute }
  | { kind: "none" }
  | { code: GuideUrlErrorCode; kind: "error"; parameter?: string };

export type GuideProject = {
  createdAt: string;
  id: string;
  name: string;
};

export type ProjectGuideEnvelope =
  | { kind: "invalid"; projects: [] }
  | { kind: "success"; projects: GuideProject[] };

export type WorkspaceGuideEnvelope =
  | { kind: "invalid" }
  | { kind: "empty"; projectVersion: number; workspace: null }
  | {
      kind: "success";
      projectVersion: number;
      workspace: { path: string; status: "ready" };
    };

export type MembershipGuideMember = {
  accentToken: string;
  agentId: string;
  avatarText: string;
  joinedAt: string;
  model: string;
  name: string;
  permissions: {
    readFiles: boolean;
    runCommands: boolean;
    writeFiles: boolean;
  };
  role: string;
  skillNames: string[];
};

export type MembershipGuideEnvelope =
  | { kind: "invalid" }
  | {
      kind: "success";
      members: MembershipGuideMember[];
      projectVersion: number;
    };

export type MissionGuideEnvelope =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "success" };

export type CollaborationGuideEnvelope =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "success"; started: boolean };

const STEP_SET = new Set<string>(GUIDE_STEPS);
const PROJECT_STEPS = new Set<GuideStep>(["workspace", "members", "goal"]);
const PROJECT_KEYS = new Set(["createdAt", "id", "name"]);
const WORKSPACE_KEYS = new Set(["path", "status"]);
const MEMBER_KEYS = new Set([
  "accentToken",
  "agentId",
  "avatarText",
  "joinedAt",
  "model",
  "name",
  "permissions",
  "role",
  "skillNames",
]);
const MEMBER_PERMISSION_KEYS = new Set([
  "readFiles",
  "runCommands",
  "writeFiles",
]);
const MISSION_ENVELOPE_KEYS = new Set(["mission", "workItems"]);
const MISSION_KEYS = new Set([
  "createdAt",
  "goal",
  "id",
  "projectId",
  "title",
  "updatedAt",
  "version",
]);
const WORK_ITEM_KEYS = new Set([
  "assigneeAgentId",
  "createdAt",
  "dependencyIds",
  "description",
  "id",
  "missionId",
  "status",
  "title",
  "updatedAt",
  "version",
]);
const WORK_ITEM_STATUSES = new Set(["todo", "in_progress", "blocked", "done"]);
const COLLABORATION_ENVELOPE_KEYS = new Set([
  "activeRun",
  "factsPage",
  "messagesPage",
  "readiness",
  "runs",
  "selectedRun",
  "thread",
]);
const RUN_KEYS = new Set([
  "createdAt",
  "currentAgentId",
  "id",
  "pauseCategory",
  "projectId",
  "roundCount",
  "status",
  "threadId",
  "updatedAt",
  "version",
]);
const RUN_STATUSES = new Set([
  "running",
  "waiting_owner",
  "paused",
  "failed",
  "planned",
  "stopped",
]);
const MESSAGE_KEYS = new Set([
  "authorAgentId",
  "authorDisplayName",
  "authorType",
  "content",
  "createdAt",
  "id",
  "mentionAgentId",
  "mentionDisplayName",
  "mentionMemberStatus",
  "projectId",
  "replyTo",
  "runId",
  "sequence",
  "threadId",
]);
const MESSAGE_WITH_BLOCKS_KEYS = new Set([...MESSAGE_KEYS, "blocks"]);
const REPLY_SNAPSHOT_KEYS = new Set([
  "authorDisplayName",
  "excerpt",
  "messageId",
  "sequence",
]);
const THREAD_KEYS = new Set([
  "availability",
  "createdAt",
  "id",
  "lastActivitySequence",
  "policy",
  "policyVersion",
  "projectId",
  "title",
  "updatedAt",
  "version",
]);
const POLICY_KEYS = new Set([
  "availability",
  "createdAt",
  "members",
  "revisionId",
  "unavailableMemberIds",
  "version",
]);
const POLICY_MEMBER_KEYS = new Set([
  "agentId",
  "displayNameSnapshot",
  "live",
  "position",
]);
const ACTIVE_RUN_KEYS = new Set(["runId", "threadId"]);
const THREAD_READINESS_KEYS = new Set([
  "dispatch",
  "missingProjectFacts",
  "selectedMemberId",
]);
const FACT_KEYS = new Set([
  "activitySequence",
  "actorId",
  "actorType",
  "createdAt",
  "id",
  "message",
  "messageId",
  "payload",
  "policyRevisionId",
  "projectId",
  "runEventId",
  "runId",
  "sequence",
  "threadId",
  "type",
]);
const CURSOR_PAGE_KEYS = new Set(["items", "nextAfter"]);
const FACT_TYPES = new Set([
  "thread_created",
  "policy_changed",
  "owner_message",
  "agent_message",
  "run_linked",
  "run_event",
  "inline_decision",
]);
const DISPATCH_READINESS = new Set([
  "ready",
  "project_context_not_ready",
  "policy_repair_required",
  "selected_member_provider_unavailable",
  "project_run_active",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
  );
}

function isNullableId(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isProjectId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(value);
}

function parseProject(value: unknown): GuideProject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== PROJECT_KEYS.size ||
    Object.keys(record).some((key) => !PROJECT_KEYS.has(key)) ||
    !isProjectId(record.id) ||
    typeof record.name !== "string" ||
    record.name.length === 0 ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    return null;
  }
  return {
    createdAt: record.createdAt,
    id: record.id,
    name: record.name,
  };
}

export function parseProjectGuideEnvelope(value: unknown): ProjectGuideEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid", projects: [] };
  }
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 1 ||
    !Array.isArray(envelope.projects)
  ) {
    return { kind: "invalid", projects: [] };
  }
  const projects = envelope.projects.map(parseProject);
  if (
    projects.some((project) => project === null) ||
    new Set(projects.map((project) => project?.id)).size !== projects.length
  ) {
    return { kind: "invalid", projects: [] };
  }
  return { kind: "success", projects: projects as GuideProject[] };
}

export function parseProjectCreateEnvelope(value: unknown): GuideProject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).length !== 1) return null;
  return parseProject(envelope.project);
}

export function parseWorkspaceGuideEnvelope(
  value: unknown,
): WorkspaceGuideEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid" };
  }
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 2 ||
    !Object.hasOwn(envelope, "workspace") ||
    !Number.isInteger(envelope.projectVersion) ||
    (envelope.projectVersion as number) < 1
  ) {
    return { kind: "invalid" };
  }
  const projectVersion = envelope.projectVersion as number;
  if (envelope.workspace === null) {
    return { kind: "empty", projectVersion, workspace: null };
  }
  if (
    !envelope.workspace ||
    typeof envelope.workspace !== "object" ||
    Array.isArray(envelope.workspace)
  ) {
    return { kind: "invalid" };
  }
  const workspace = envelope.workspace as Record<string, unknown>;
  if (
    Object.keys(workspace).length !== WORKSPACE_KEYS.size ||
    Object.keys(workspace).some((key) => !WORKSPACE_KEYS.has(key)) ||
    typeof workspace.path !== "string" ||
    workspace.path.length === 0 ||
    !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(workspace.path) ||
    workspace.status !== "ready"
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "success",
    projectVersion,
    workspace: { path: workspace.path, status: "ready" },
  };
}

function parseMembershipGuideMember(
  value: unknown,
): MembershipGuideMember | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const member = value as Record<string, unknown>;
  if (
    Object.keys(member).length !== MEMBER_KEYS.size ||
    Object.keys(member).some((key) => !MEMBER_KEYS.has(key)) ||
    typeof member.agentId !== "string" ||
    member.agentId.length === 0 ||
    typeof member.joinedAt !== "string" ||
    !Number.isFinite(Date.parse(member.joinedAt)) ||
    typeof member.name !== "string" ||
    member.name.length === 0 ||
    typeof member.role !== "string" ||
    member.role.length === 0 ||
    typeof member.model !== "string" ||
    member.model.length === 0 ||
    typeof member.avatarText !== "string" ||
    member.avatarText.length === 0 ||
    typeof member.accentToken !== "string" ||
    member.accentToken.length === 0 ||
    !Array.isArray(member.skillNames) ||
    !member.skillNames.every(
      (skillName) => typeof skillName === "string" && skillName.length > 0,
    ) ||
    !member.permissions ||
    typeof member.permissions !== "object" ||
    Array.isArray(member.permissions)
  ) {
    return null;
  }
  const permissions = member.permissions as Record<string, unknown>;
  if (
    Object.keys(permissions).length !== MEMBER_PERMISSION_KEYS.size ||
    Object.keys(permissions).some(
      (key) => !MEMBER_PERMISSION_KEYS.has(key),
    ) ||
    typeof permissions.readFiles !== "boolean" ||
    typeof permissions.runCommands !== "boolean" ||
    typeof permissions.writeFiles !== "boolean"
  ) {
    return null;
  }
  return member as MembershipGuideMember;
}

export function parseMembershipGuideEnvelope(
  value: unknown,
): MembershipGuideEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid" };
  }
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 2 ||
    !Array.isArray(envelope.members) ||
    !Number.isInteger(envelope.projectVersion) ||
    (envelope.projectVersion as number) < 1
  ) {
    return { kind: "invalid" };
  }
  const members = envelope.members.map(parseMembershipGuideMember);
  if (
    members.some((member) => member === null) ||
    new Set(members.map((member) => member?.agentId)).size !== members.length
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "success",
    members: members as MembershipGuideMember[],
    projectVersion: envelope.projectVersion as number,
  };
}

export function parseMissionGuideEnvelope(
  value: unknown,
  expectedProjectId: string,
): MissionGuideEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, MISSION_ENVELOPE_KEYS)) {
    return { kind: "invalid" };
  }
  if (!Array.isArray(value.workItems)) return { kind: "invalid" };
  if (value.mission === null) {
    return value.workItems.length === 0 ? { kind: "empty" } : { kind: "invalid" };
  }
  if (!isRecord(value.mission) || !hasExactKeys(value.mission, MISSION_KEYS)) {
    return { kind: "invalid" };
  }
  const mission = value.mission;
  if (
    !isNonEmptyString(mission.id) ||
    mission.projectId !== expectedProjectId ||
    !isNonEmptyString(mission.title) ||
    !isNonEmptyString(mission.goal) ||
    !isSafeInteger(mission.version, 1) ||
    !isTimestamp(mission.createdAt) ||
    !isTimestamp(mission.updatedAt)
  ) {
    return { kind: "invalid" };
  }

  const ids = new Set<string>();
  for (const candidate of value.workItems) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, WORK_ITEM_KEYS)) {
      return { kind: "invalid" };
    }
    if (
      !isNonEmptyString(candidate.id) ||
      ids.has(candidate.id) ||
      candidate.missionId !== mission.id ||
      !isNonEmptyString(candidate.title) ||
      typeof candidate.description !== "string" ||
      !WORK_ITEM_STATUSES.has(String(candidate.status)) ||
      !isNullableId(candidate.assigneeAgentId) ||
      !Array.isArray(candidate.dependencyIds) ||
      !candidate.dependencyIds.every(isNonEmptyString) ||
      new Set(candidate.dependencyIds).size !== candidate.dependencyIds.length ||
      !isSafeInteger(candidate.version, 1) ||
      !isTimestamp(candidate.createdAt) ||
      !isTimestamp(candidate.updatedAt)
    ) {
      return { kind: "invalid" };
    }
    ids.add(candidate.id);
  }
  for (const candidate of value.workItems as Array<Record<string, unknown>>) {
    if (
      (candidate.dependencyIds as string[]).some(
        (dependencyId) => dependencyId === candidate.id || !ids.has(dependencyId),
      )
    ) {
      return { kind: "invalid" };
    }
  }
  return { kind: "success" };
}

type ParsedCollaborationRun = {
  id: string;
  projectId: string;
  threadId: string;
};

type ParsedProjectMessage = {
  authorAgentId: string | null;
  authorType: "owner" | "agent";
  content: string;
  id: string;
  mentionAgentId: string | null;
  mentionDisplayName: string | null;
  mentionMemberStatus: "current" | "left" | null;
  projectId: string;
  runId: string | null;
  sequence: number;
  threadId: string;
};

type ParsedThreadFact = {
  eventType: string | null;
  id: string;
  message: ParsedProjectMessage | null;
  messageId: string | null;
  runEventId: string | null;
  runId: string | null;
  sequence: number;
  type: string;
};

function parseCollaborationRun(
  value: unknown,
  expectedProjectId: string,
  expectedThreadId: string,
): ParsedCollaborationRun | null {
  if (!isRecord(value) || !hasExactKeys(value, RUN_KEYS)) return null;
  if (
    !isNonEmptyString(value.id) ||
    value.projectId !== expectedProjectId ||
    value.threadId !== expectedThreadId ||
    !RUN_STATUSES.has(String(value.status)) ||
    !isNonEmptyString(value.currentAgentId) ||
    !isSafeInteger(value.roundCount) ||
    !(value.pauseCategory === null || isNonEmptyString(value.pauseCategory)) ||
    !isSafeInteger(value.version, 1) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    projectId: value.projectId,
    threadId: value.threadId,
  };
}

function isReplySnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, REPLY_SNAPSHOT_KEYS) &&
    isNonEmptyString(value.messageId) &&
    isSafeInteger(value.sequence, 1) &&
    isNonEmptyString(value.authorDisplayName) &&
    isNonEmptyString(value.excerpt)
  );
}

function parseProjectMessage(
  value: unknown,
  expectedProjectId: string,
  expectedThreadId: string,
): ParsedProjectMessage | null {
  if (
    !isRecord(value)
    || (!hasExactKeys(value, MESSAGE_KEYS) && !hasExactKeys(value, MESSAGE_WITH_BLOCKS_KEYS))
    || ("blocks" in value && !Array.isArray(value.blocks))
  ) return null;
  if (
    !isNonEmptyString(value.id) ||
    value.projectId !== expectedProjectId ||
    value.threadId !== expectedThreadId ||
    !isSafeInteger(value.sequence, 1) ||
    !isNullableId(value.runId) ||
    (value.authorType !== "owner" && value.authorType !== "agent") ||
    !isNullableId(value.authorAgentId) ||
    !isNonEmptyString(value.authorDisplayName) ||
    typeof value.content !== "string" ||
    !isNullableId(value.mentionAgentId) ||
    !(value.mentionDisplayName === null || isNonEmptyString(value.mentionDisplayName)) ||
    !(
      value.mentionMemberStatus === null ||
      value.mentionMemberStatus === "current" ||
      value.mentionMemberStatus === "left"
    ) ||
    !(value.replyTo === null || isReplySnapshot(value.replyTo)) ||
    !isTimestamp(value.createdAt)
  ) {
    return null;
  }
  if (
    (value.authorType === "owner" && value.authorAgentId !== null) ||
    (value.authorType === "agent" && value.authorAgentId === null)
  ) {
    return null;
  }
  const mentionValues = [
    value.mentionAgentId,
    value.mentionDisplayName,
    value.mentionMemberStatus,
  ];
  if (
    (value.mentionAgentId === null && mentionValues.some((item) => item !== null)) ||
    (value.mentionAgentId !== null && mentionValues.some((item) => item === null))
  ) {
    return null;
  }
  return value as ParsedProjectMessage;
}

function validPolicy(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, POLICY_KEYS)) return false;
  if (
    !isNonEmptyString(value.revisionId) ||
    !isSafeInteger(value.version, 1) ||
    (value.availability !== "ready" && value.availability !== "repair_required") ||
    !Array.isArray(value.members) ||
    !Array.isArray(value.unavailableMemberIds) ||
    !value.unavailableMemberIds.every(isNonEmptyString) ||
    new Set(value.unavailableMemberIds).size !== value.unavailableMemberIds.length ||
    !isTimestamp(value.createdAt)
  ) {
    return false;
  }
  const agentIds = new Set<string>();
  const positions = new Set<number>();
  for (const member of value.members) {
    if (
      !isRecord(member) ||
      !hasExactKeys(member, POLICY_MEMBER_KEYS) ||
      !isNonEmptyString(member.agentId) ||
      agentIds.has(member.agentId) ||
      !isNonEmptyString(member.displayNameSnapshot) ||
      !isSafeInteger(member.position) ||
      positions.has(member.position) ||
      (member.live !== "current" && member.live !== "removed")
    ) {
      return false;
    }
    agentIds.add(member.agentId);
    positions.add(member.position);
  }
  return [...positions].sort((left, right) => left - right)
    .every((position, index) => position === index) &&
    value.unavailableMemberIds.every((id) => agentIds.has(id));
}

function validThread(
  value: unknown,
  expectedProjectId: string,
  expectedThreadId: string,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, THREAD_KEYS)) return false;
  return (
    value.id === expectedThreadId &&
    value.projectId === expectedProjectId &&
    isNonEmptyString(value.title) &&
    isSafeInteger(value.policyVersion, 1) &&
    (value.availability === "ready" || value.availability === "repair_required") &&
    isSafeInteger(value.lastActivitySequence, 1) &&
    isSafeInteger(value.version, 1) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    validPolicy(value.policy) &&
    isRecord(value.policy) &&
    value.policy.version === value.policyVersion &&
    value.policy.availability === value.availability
  );
}

function parseThreadFact(
  value: unknown,
  expectedProjectId: string,
  expectedThreadId: string,
): ParsedThreadFact | null {
  if (!isRecord(value) || !hasExactKeys(value, FACT_KEYS)) return null;
  if (
    !isNonEmptyString(value.id) ||
    value.projectId !== expectedProjectId ||
    value.threadId !== expectedThreadId ||
    !isSafeInteger(value.sequence, 1) ||
    !isSafeInteger(value.activitySequence, 1) ||
    !FACT_TYPES.has(String(value.type)) ||
    !["owner", "agent", "system"].includes(String(value.actorType)) ||
    !isNullableId(value.actorId) ||
    !isNullableId(value.runId) ||
    !isNullableId(value.messageId) ||
    !isNullableId(value.runEventId) ||
    !isNullableId(value.policyRevisionId) ||
    !isTimestamp(value.createdAt)
  ) {
    return null;
  }
  if (!isRecord(value.payload)) return null;
  const type = String(value.type);
  let message: ParsedProjectMessage | null = null;
  if (type === "thread_created") {
    if (
      value.runId !== null ||
      value.messageId !== null ||
      value.runEventId !== null ||
      value.policyRevisionId !== null ||
      value.message !== null ||
      !hasExactKeys(value.payload, new Set(["title"])) ||
      !isNonEmptyString(value.payload.title)
    ) return null;
  } else if (type === "policy_changed") {
    if (
      value.runId !== null ||
      value.messageId !== null ||
      value.runEventId !== null ||
      !isNonEmptyString(value.policyRevisionId) ||
      value.message !== null ||
      !hasExactKeys(value.payload, new Set(["policyVersion"])) ||
      !isSafeInteger(value.payload.policyVersion, 1)
    ) return null;
  } else if (type === "owner_message" || type === "agent_message") {
    message = parseProjectMessage(
      value.message,
      expectedProjectId,
      expectedThreadId,
    );
    if (
      !message ||
      !isNonEmptyString(value.messageId) ||
      value.runEventId !== null ||
      value.policyRevisionId !== null ||
      !hasExactKeys(value.payload, new Set(["messageId"])) ||
      value.payload.messageId !== value.messageId ||
      message.id !== value.messageId ||
      message.runId !== value.runId ||
      message.authorType !== (type === "owner_message" ? "owner" : "agent")
    ) return null;
  } else if (type === "run_linked") {
    if (
      !isNonEmptyString(value.runId) ||
      value.messageId !== null ||
      value.runEventId !== null ||
      value.policyRevisionId !== null ||
      value.message !== null ||
      !hasExactKeys(value.payload, new Set(["runId"])) ||
      value.payload.runId !== value.runId
    ) return null;
  } else if (type === "inline_decision") {
    if (
      !isNonEmptyString(value.runId) ||
      value.messageId !== null ||
      value.runEventId !== null ||
      value.policyRevisionId !== null ||
      value.message !== null ||
      !hasExactKeys(value.payload, new Set([
        "action",
        "blockId",
        "blockRevision",
        "decisionId",
        "fromStateVersion",
        "operationId",
        "receiptId",
        "toStateVersion",
      ])) ||
      !["accept", "reject", "check_item", "uncheck_item"].includes(
        String(value.payload.action),
      ) ||
      !isNonEmptyString(value.payload.blockId) ||
      !isSafeInteger(value.payload.blockRevision, 1) ||
      !isNonEmptyString(value.payload.decisionId) ||
      !isSafeInteger(value.payload.fromStateVersion, 1) ||
      !isNonEmptyString(value.payload.operationId) ||
      !isNonEmptyString(value.payload.receiptId) ||
      value.payload.toStateVersion !== Number(value.payload.fromStateVersion) + 1
    ) return null;
  } else {
    if (
      !isNonEmptyString(value.runId) ||
      value.messageId !== null ||
      !isNonEmptyString(value.runEventId) ||
      value.policyRevisionId !== null ||
      value.message !== null ||
      !hasExactKeys(value.payload, new Set(["eventType"])) ||
      !isNonEmptyString(value.payload.eventType) ||
      !Object.hasOwn(timelinePayloadSchemas, value.payload.eventType)
    ) return null;
  }
  return {
    eventType: type === "run_event" ? String(value.payload.eventType) : null,
    id: value.id,
    message,
    messageId: value.messageId,
    runEventId: value.runEventId,
    runId: value.runId,
    sequence: value.sequence,
    type,
  };
}

function parseCursorPage<T>(
  value: unknown,
  parser: (item: unknown) => T | null,
): { items: T[]; nextAfter: number | null } | null {
  if (!isRecord(value) || !hasExactKeys(value, CURSOR_PAGE_KEYS)) return null;
  if (
    !Array.isArray(value.items) ||
    !(value.nextAfter === null || isSafeInteger(value.nextAfter))
  ) {
    return null;
  }
  const items = value.items.map(parser);
  if (items.some((item) => item === null)) return null;
  return { items: items as T[], nextAfter: value.nextAfter as number | null };
}

function validReadiness(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, THREAD_READINESS_KEYS)) return false;
  return (
    DISPATCH_READINESS.has(String(value.dispatch)) &&
    Array.isArray(value.missingProjectFacts) &&
    value.missingProjectFacts.every(isNonEmptyString) &&
    new Set(value.missingProjectFacts).size === value.missingProjectFacts.length &&
    isNullableId(value.selectedMemberId)
  );
}

export function parseCollaborationGuideEnvelope(
  value: unknown,
  expectedProjectId: string,
  expectedThreadId: string,
  expectedRunId: string | null,
): CollaborationGuideEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, COLLABORATION_ENVELOPE_KEYS)) {
    return { kind: "invalid" };
  }
  if (
    !validThread(value.thread, expectedProjectId, expectedThreadId) ||
    !Array.isArray(value.runs) ||
    !validReadiness(value.readiness)
  ) return { kind: "invalid" };
  const runs = value.runs.map((run) =>
    parseCollaborationRun(run, expectedProjectId, expectedThreadId)
  );
  if (
    runs.some((run) => run === null) ||
    new Set(runs.map((run) => run?.id)).size !== runs.length
  ) return { kind: "invalid" };
  const runIds = new Set((runs as ParsedCollaborationRun[]).map((run) => run.id));
  const selectedRun = value.selectedRun === null
    ? null
    : parseCollaborationRun(value.selectedRun, expectedProjectId, expectedThreadId);
  if (
    (value.selectedRun !== null && !selectedRun) ||
    (selectedRun?.id ?? null) !== expectedRunId ||
    (selectedRun && !runIds.has(selectedRun.id))
  ) return { kind: "invalid" };
  if (selectedRun) {
    const rawRun = (value.runs as unknown[]).find(
      (candidate) => isRecord(candidate) && candidate.id === selectedRun.id,
    );
    if (JSON.stringify(rawRun) !== JSON.stringify(value.selectedRun)) {
      return { kind: "invalid" };
    }
  }
  if (value.activeRun !== null) {
    if (
      !isRecord(value.activeRun) ||
      !hasExactKeys(value.activeRun, ACTIVE_RUN_KEYS) ||
      !isNonEmptyString(value.activeRun.threadId) ||
      !isNonEmptyString(value.activeRun.runId) ||
      (value.activeRun.threadId === expectedThreadId &&
        !runIds.has(value.activeRun.runId))
    ) return { kind: "invalid" };
  }
  const messagesPage = parseCursorPage(value.messagesPage, (message) =>
    parseProjectMessage(message, expectedProjectId, expectedThreadId)
  );
  const factsPage = parseCursorPage(value.factsPage, (fact) =>
    parseThreadFact(fact, expectedProjectId, expectedThreadId)
  );
  if (
    !messagesPage ||
    !factsPage
  ) {
    return { kind: "invalid" };
  }
  if (
    new Set(messagesPage.items.map((message) => message.id)).size !==
      messagesPage.items.length ||
    new Set(messagesPage.items.map((message) => message.sequence)).size !==
      messagesPage.items.length ||
    new Set(factsPage.items.map((fact) => fact.id)).size !== factsPage.items.length ||
    new Set(factsPage.items.map((fact) => fact.sequence)).size !== factsPage.items.length
  ) {
    return { kind: "invalid" };
  }
  if (
    messagesPage.items.some(
      (message) => message.runId !== null && !runIds.has(message.runId),
    ) ||
    factsPage.items.some(
      (fact) => fact.runId !== null && !runIds.has(fact.runId),
    )
  ) {
    return { kind: "invalid" };
  }
  const messagesById = new Map(messagesPage.items.map((message) => [message.id, message]));
  for (const fact of factsPage.items) {
    if (
      fact.message &&
      JSON.stringify(messagesById.get(fact.message.id)) !== JSON.stringify(fact.message)
    ) return { kind: "invalid" };
  }
  const selectedRunId = selectedRun?.id;
  return {
    kind: "success",
    started: Boolean(
      selectedRunId &&
      factsPage.items.some(
        (fact) => fact.type === "run_linked" && fact.runId === selectedRunId,
      ) &&
      factsPage.items.some(
        (fact) =>
          fact.type === "run_event" &&
          fact.runId === selectedRunId &&
          fact.eventType === "run_started",
      ) &&
      factsPage.items.some(
        (fact) =>
          fact.type === "owner_message" &&
          fact.runId === selectedRunId &&
          fact.message?.authorType === "owner",
      ),
    ),
  };
}

export function uniquelyReconciledProject(
  previousProjectIds: ReadonlySet<string>,
  value: unknown,
): GuideProject | null {
  const envelope = parseProjectGuideEnvelope(value);
  if (envelope.kind !== "success") return null;
  const added = envelope.projects.filter(
    (project) => !previousProjectIds.has(project.id),
  );
  return added.length === 1 ? added[0] : null;
}

function error(
  code: GuideUrlErrorCode,
  parameter?: string,
): GuideUrlResult {
  return parameter
    ? { code, kind: "error", parameter }
    : { code, kind: "error" };
}

function exactParameters(
  searchParams: URLSearchParams,
  expected: readonly string[],
): GuideUrlResult | null {
  const expectedSet = new Set(expected);
  for (const key of searchParams.keys()) {
    if (!expectedSet.has(key)) return error("unknown_parameter", key);
    if (searchParams.getAll(key).length !== 1) {
      return error("duplicate_parameter", key);
    }
  }
  for (const key of expected) {
    if (searchParams.getAll(key).length !== 1) {
      return error("missing_parameter", key);
    }
  }
  return null;
}

function relativeUrl(input: string): URL | null {
  if (!input.startsWith("/") || input.startsWith("//")) return null;
  try {
    return new URL(input, "http://guide.local");
  } catch {
    return null;
  }
}

export function guideHref(step: "provider" | "agent"): string;
export function guideHref(step: "project-select"): string;
export function guideHref(
  step: "workspace" | "members" | "goal",
  projectId: string,
): string;
export function guideHref(step: GuideStep, projectId?: string): string {
  if (step === "provider" || step === "agent") {
    const section = step === "provider" ? "providers" : "agents";
    return `/team?section=${section}&guide=${step}&returnTo=/`;
  }
  if (step === "project-select") return "/?guide=project-select";
  if (!projectId || projectId.includes("/") || projectId.includes("\\")) {
    throw new Error("A non-empty path-safe project ID is required.");
  }
  return `/projects/${encodeURIComponent(projectId)}?guide=${step}`;
}

export function parseGuideUrl(
  input: string,
  knownProjectIds: readonly string[] | null = null,
): GuideUrlResult {
  const url = relativeUrl(input);
  if (!url || url.hash) return error("invalid_path");

  for (const parameter of ["guide", "project", "returnTo"] as const) {
    if (url.searchParams.getAll(parameter).length > 1) {
      return error("duplicate_parameter", parameter);
    }
  }

  const guideValues = url.searchParams.getAll("guide");
  if (guideValues.length === 0) {
    return url.searchParams.has("project") || url.searchParams.has("returnTo")
      ? error(
          "unknown_parameter",
          url.searchParams.has("project") ? "project" : "returnTo",
        )
      : { kind: "none" };
  }
  const stepValue = guideValues[0];
  if (!STEP_SET.has(stepValue)) return error("unknown_step", "guide");
  const step = stepValue as GuideStep;

  if (step === "provider" || step === "agent") {
    if (url.pathname !== "/team") return error("invalid_path");
    const parameterError = exactParameters(url.searchParams, [
      "section",
      "guide",
      "returnTo",
    ]);
    if (parameterError) return parameterError;
    const expectedSection = step === "provider" ? "providers" : "agents";
    if (url.searchParams.get("section") !== expectedSection) {
      return error("invalid_section", "section");
    }
    if (url.searchParams.get("returnTo") !== "/") {
      return error("invalid_return_to", "returnTo");
    }
    return { kind: "guide", route: { href: guideHref(step), projectId: null, step } };
  }

  let parameterError: GuideUrlResult | null;
  if (step === "goal") {
    parameterError = null;
    for (const key of url.searchParams.keys()) {
      if (key !== "guide" && key !== "thread" && key !== "run") {
        parameterError = error("unknown_parameter", key);
        break;
      }
      if (url.searchParams.getAll(key).length !== 1) {
        parameterError = error("duplicate_parameter", key);
        break;
      }
    }
    const threadId = url.searchParams.get("thread");
    const runId = url.searchParams.get("run");
    if (
      !parameterError &&
      ((runId !== null && threadId === null) ||
        (threadId !== null && !isProjectId(threadId)) ||
        (runId !== null && !isProjectId(runId)))
    ) {
      parameterError = error("invalid_path");
    }
  } else {
    parameterError = exactParameters(url.searchParams, ["guide"]);
  }
  if (parameterError) return parameterError;

  if (step === "project-select") {
    if (url.pathname !== "/") return error("invalid_path");
    return {
      kind: "guide",
      route: { href: guideHref(step), projectId: null, step },
    };
  }

  if (!PROJECT_STEPS.has(step)) return error("invalid_path");
  const match = /^\/projects\/([^/]+)$/.exec(url.pathname);
  if (!match) return error("invalid_path");

  let projectId: string;
  try {
    projectId = decodeURIComponent(match[1]);
  } catch {
    return error("invalid_project_id");
  }
  if (
    !projectId ||
    projectId === "." ||
    projectId === ".." ||
    projectId.includes("/") ||
    projectId.includes("\\")
  ) {
    return error("invalid_project_id");
  }
  if (knownProjectIds && !knownProjectIds.includes(projectId)) {
    return error("unknown_project");
  }
  return {
    kind: "guide",
    route: {
      href: step === "goal" ? `${url.pathname}${url.search}` : guideHref(step, projectId),
      projectId,
      step,
    },
  };
}

export type GuideMachinePhase =
  | "BOOT"
  | "loading"
  | "active"
  | "blocked"
  | "error";

export type GuideMachineState = {
  error: string | null;
  phase: GuideMachinePhase;
  route: GuideRoute | null;
};

export type GuideFactsOutcome =
  | { status: "active" }
  | { reason: string; status: "blocked" | "error" };

export type GuideMachineEvent =
  | { result: GuideUrlResult; type: "route_changed" }
  | {
      facts: GuideFactsOutcome;
      href: string;
      type: "facts_changed";
    }
  | { type: "retry" };

export const INITIAL_GUIDE_STATE: GuideMachineState = {
  error: null,
  phase: "BOOT",
  route: null,
};

export function reduceGuideMachine(
  state: GuideMachineState,
  event: GuideMachineEvent,
): GuideMachineState {
  if (event.type === "route_changed") {
    if (event.result.kind === "none") return INITIAL_GUIDE_STATE;
    if (event.result.kind === "error") {
      return {
        error: event.result.code,
        phase: "error",
        route: null,
      };
    }
    return {
      error: null,
      phase: "loading",
      route: event.result.route,
    };
  }

  if (event.type === "retry") {
    if (!state.route || state.phase === "BOOT") return state;
    return { ...state, error: null, phase: "loading" };
  }

  if (!state.route || event.href !== state.route.href) return state;
  if (event.facts.status === "active") {
    return { ...state, error: null, phase: "active" };
  }
  return {
    ...state,
    error: event.facts.reason,
    phase: event.facts.status,
  };
}
