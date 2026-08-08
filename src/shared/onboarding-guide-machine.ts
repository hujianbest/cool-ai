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
  "pendingDecision",
  "projectMessagesPage",
  "readiness",
  "run",
  "timelinePage",
  "usage",
]);
const RUN_KEYS = new Set([
  "createdAt",
  "currentAgentId",
  "id",
  "pauseCategory",
  "projectId",
  "roundCount",
  "status",
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
  "runId",
  "sequence",
]);
const TIMELINE_EVENT_KEYS = new Set([
  "actorId",
  "actorType",
  "createdAt",
  "id",
  "payload",
  "runId",
  "sequence",
  "type",
]);
const CURSOR_PAGE_KEYS = new Set(["items", "nextAfter"]);
const DECISION_KEYS = new Set([
  "answer",
  "answerMessageId",
  "answeredAt",
  "createdAt",
  "id",
  "options",
  "question",
  "requestingAgentId",
  "runId",
  "status",
  "turnId",
  "version",
]);
const USAGE_KEYS = new Set([
  "byAgent",
  "completionTokens",
  "promptTokens",
  "repairCalls",
  "totalTokens",
  "unreportedCalls",
]);
const AGENT_USAGE_KEYS = new Set([
  "agentId",
  "completionTokens",
  "handoffs",
  "promptTokens",
  "totalTokens",
]);
const READINESS_KEYS = new Set(["missing", "ready"]);

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
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\");
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
};

type ParsedProjectMessage = {
  authorAgentId: string | null;
  authorType: "owner" | "agent";
  id: string;
  mentionAgentId: string | null;
  mentionDisplayName: string | null;
  mentionMemberStatus: "current" | "left" | null;
  runId: string | null;
  sequence: number;
};

type ParsedTimelineEvent = {
  id: string;
  payload: Record<string, unknown>;
  runId: string;
  sequence: number;
  type: string;
};

function parseCollaborationRun(
  value: unknown,
  expectedProjectId: string,
): ParsedCollaborationRun | null {
  if (!isRecord(value) || !hasExactKeys(value, RUN_KEYS)) return null;
  if (
    !isNonEmptyString(value.id) ||
    value.projectId !== expectedProjectId ||
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
  return { id: value.id, projectId: value.projectId };
}

function parseProjectMessage(value: unknown): ParsedProjectMessage | null {
  if (!isRecord(value) || !hasExactKeys(value, MESSAGE_KEYS)) return null;
  if (
    !isNonEmptyString(value.id) ||
    !isSafeInteger(value.sequence) ||
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

function parseTimelineEvent(value: unknown): ParsedTimelineEvent | null {
  if (!isRecord(value) || !hasExactKeys(value, TIMELINE_EVENT_KEYS)) return null;
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.runId) ||
    !isSafeInteger(value.sequence) ||
    !isNonEmptyString(value.type) ||
    !["owner", "agent", "system"].includes(String(value.actorType)) ||
    !isNullableId(value.actorId) ||
    !isTimestamp(value.createdAt)
  ) {
    return null;
  }
  const schema = (
    timelinePayloadSchemas as Record<
      string,
      { safeParse: (candidate: unknown) => { success: boolean } }
    >
  )[value.type];
  if (!schema || !schema.safeParse(value.payload).success || !isRecord(value.payload)) {
    return null;
  }
  return value as ParsedTimelineEvent;
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

function validPendingDecision(value: unknown, runId: string | null): boolean {
  if (value === null) return true;
  if (!runId || !isRecord(value) || !hasExactKeys(value, DECISION_KEYS)) {
    return false;
  }
  return (
    isNonEmptyString(value.id) &&
    value.runId === runId &&
    isNonEmptyString(value.turnId) &&
    isNonEmptyString(value.requestingAgentId) &&
    isNonEmptyString(value.question) &&
    Array.isArray(value.options) &&
    value.options.length >= 2 &&
    value.options.every(isNonEmptyString) &&
    new Set(value.options).size === value.options.length &&
    value.status === "open" &&
    value.answer === null &&
    value.answerMessageId === null &&
    isSafeInteger(value.version, 1) &&
    isTimestamp(value.createdAt) &&
    value.answeredAt === null
  );
}

function validUsage(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, USAGE_KEYS)) return false;
  const numericKeys = [
    "completionTokens",
    "promptTokens",
    "repairCalls",
    "totalTokens",
    "unreportedCalls",
  ] as const;
  if (
    numericKeys.some((key) => !isSafeInteger(value[key])) ||
    !Array.isArray(value.byAgent)
  ) {
    return false;
  }
  const overallPromptTokens = value.promptTokens as number;
  const overallCompletionTokens = value.completionTokens as number;
  const overallTotalTokens = value.totalTokens as number;
  const agentIds = new Set<string>();
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  for (const candidate of value.byAgent) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, AGENT_USAGE_KEYS) ||
      !isNonEmptyString(candidate.agentId) ||
      agentIds.has(candidate.agentId) ||
      !isSafeInteger(candidate.promptTokens) ||
      !isSafeInteger(candidate.completionTokens) ||
      !isSafeInteger(candidate.totalTokens) ||
      !isSafeInteger(candidate.handoffs) ||
      candidate.totalTokens !== candidate.promptTokens + candidate.completionTokens
    ) {
      return false;
    }
    agentIds.add(candidate.agentId);
    promptTokens += candidate.promptTokens;
    completionTokens += candidate.completionTokens;
    totalTokens += candidate.totalTokens;
  }
  return (
    overallTotalTokens === overallPromptTokens + overallCompletionTokens &&
    overallPromptTokens === promptTokens &&
    overallCompletionTokens === completionTokens &&
    overallTotalTokens === totalTokens
  );
}

function validReadiness(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, READINESS_KEYS)) return false;
  return (
    typeof value.ready === "boolean" &&
    Array.isArray(value.missing) &&
    value.missing.every(isNonEmptyString) &&
    new Set(value.missing).size === value.missing.length &&
    value.ready === (value.missing.length === 0)
  );
}

export function parseCollaborationGuideEnvelope(
  value: unknown,
  expectedProjectId: string,
): CollaborationGuideEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, COLLABORATION_ENVELOPE_KEYS)) {
    return { kind: "invalid" };
  }
  const run =
    value.run === null
      ? null
      : parseCollaborationRun(value.run, expectedProjectId);
  if (value.run !== null && !run) return { kind: "invalid" };
  const messagesPage = parseCursorPage(value.projectMessagesPage, parseProjectMessage);
  const timelinePage = parseCursorPage(value.timelinePage, parseTimelineEvent);
  if (
    !messagesPage ||
    !timelinePage ||
    !validPendingDecision(value.pendingDecision, run?.id ?? null) ||
    !validUsage(value.usage) ||
    !validReadiness(value.readiness)
  ) {
    return { kind: "invalid" };
  }
  if (
    new Set(messagesPage.items.map((message) => message.id)).size !==
      messagesPage.items.length ||
    new Set(messagesPage.items.map((message) => message.sequence)).size !==
      messagesPage.items.length ||
    new Set(timelinePage.items.map((event) => event.id)).size !==
      timelinePage.items.length ||
    new Set(timelinePage.items.map((event) => event.sequence)).size !==
      timelinePage.items.length
  ) {
    return { kind: "invalid" };
  }
  if (!run) {
    return timelinePage.items.length === 0 &&
      messagesPage.items.every((message) => message.runId === null) &&
      value.pendingDecision === null
      ? { kind: "empty" }
      : { kind: "invalid" };
  }
  if (
    messagesPage.items.some(
      (message) => message.runId !== null && message.runId !== run.id,
    ) ||
    timelinePage.items.some((event) => event.runId !== run.id)
  ) {
    return { kind: "invalid" };
  }

  const messagesById = new Map(
    messagesPage.items.map((message) => [message.id, message]),
  );
  const linkedOwnerMessageIds = new Set<string>();
  let runStartedCount = 0;
  for (const event of timelinePage.items) {
    if (event.type !== "run_started" && event.type !== "owner_message") continue;
    const messageId = event.payload.messageId;
    const messageSequence = event.payload.messageSequence;
    if (!isNonEmptyString(messageId) || !isSafeInteger(messageSequence)) {
      return { kind: "invalid" };
    }
    const message = messagesById.get(messageId);
    if (
      !message ||
      message.authorType !== "owner" ||
      message.runId !== run.id ||
      message.sequence !== messageSequence
    ) {
      return { kind: "invalid" };
    }
    if (event.type === "run_started") runStartedCount += 1;
    if (event.type === "owner_message") linkedOwnerMessageIds.add(messageId);
  }
  if (runStartedCount > 1) return { kind: "invalid" };
  const runStarted = timelinePage.items.find((event) => event.type === "run_started");
  return {
    kind: "success",
    started:
      Boolean(runStarted) &&
      linkedOwnerMessageIds.has(String(runStarted?.payload.messageId)),
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

  const parameterError = exactParameters(url.searchParams, ["guide"]);
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
    route: { href: guideHref(step, projectId), projectId, step },
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
