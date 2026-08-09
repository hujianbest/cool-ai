export type TranscriptModelInput = {
  aborted?: boolean;
  currentTargetKey: string;
  pages: readonly unknown[];
  targetKey: string;
};

export type TranscriptSource = {
  entityVersion: string | null;
  id: string;
  kind: string;
  messageId: string;
  projectId: string;
  runId: string | null;
  threadId: string;
};

type TranscriptBlockBase = {
  actorLabel: string;
  blockRevision: number;
  blockSchemaVersion: number;
  executable: boolean;
  id: string;
  position: number;
  source: TranscriptSource;
  sourceLabel: string;
  stateVersion: number;
};

export type TranscriptKnownBlock = TranscriptBlockBase & {
  body?: string;
  fileName?: string;
  items?: Array<{ checked: boolean; id: string; text: string }>;
  kind: "proposal" | "checklist" | "diff_preview" | "file_reference" | "handoff_card";
  payload: Record<string, unknown>;
  state: Record<string, unknown>;
  title: string;
};

export type TranscriptUnknownBlock = TranscriptBlockBase & {
  executable: false;
  kind: "unknown";
};

export type TranscriptBlock = TranscriptKnownBlock | TranscriptUnknownBlock;

export type TranscriptReplyReference = {
  authorDisplayName: string;
  excerpt: string;
  messageId: string;
  sequence: number;
};

export type TranscriptEntry = {
  actorLabel: string;
  blocks: TranscriptBlock[];
  createdAt: string;
  factId: string;
  factSequence: number;
  heading: string;
  mention: {
    displayName: string;
    memberStatus: "current" | "left";
  } | null;
  messageId: string | null;
  replyTo: TranscriptReplyReference | null;
  runId: string | null;
  text: string | null;
};

export type TranscriptModel =
  | { kind: "invalid"; message: string; targetKey: string }
  | { kind: "ready"; entries: readonly TranscriptEntry[]; targetKey: string }
  | { kind: "stale"; targetKey: string };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function source(value: unknown, message: Record<string, unknown>): TranscriptSource | null {
  if (
    !record(value)
    || !string(value.id)
    || !string(value.kind)
    || !string(value.messageId)
    || !string(value.projectId)
    || !string(value.threadId)
    || !(value.runId === null || string(value.runId))
    || !(value.entityVersion === null || string(value.entityVersion))
    || value.messageId !== message.id
    || value.projectId !== message.projectId
    || value.threadId !== message.threadId
    || value.runId !== message.runId
  ) return null;
  return {
    entityVersion: value.entityVersion,
    id: value.id,
    kind: value.kind,
    messageId: value.messageId,
    projectId: value.projectId,
    runId: value.runId,
    threadId: value.threadId,
  };
}

function sourceLabel(value: TranscriptSource): string {
  return [value.kind, value.id, value.entityVersion].filter(Boolean).join(" · ");
}

function knownBlock(
  value: Record<string, unknown>,
  message: Record<string, unknown>,
): TranscriptKnownBlock | null {
  const payload = value.payload;
  const state = value.state;
  const blockSource = source(value.source, message);
  if (
    !record(payload)
    || !record(state)
    || !record(value.actor)
    || !string(value.actor.displayName)
    || !string(value.id)
    || !integer(value.position)
    || !integer(value.blockRevision, 1)
    || value.blockSchemaVersion !== 1
    || !integer(state.stateVersion, 1)
    || value.blockRevision !== payload.blockRevision
    || value.blockSchemaVersion !== payload.blockSchemaVersion
    || value.blockType !== payload.blockType
    || !string(payload.title)
    || !blockSource
  ) return null;
  const common = {
    actorLabel: value.actor.displayName,
    blockRevision: value.blockRevision,
    blockSchemaVersion: value.blockSchemaVersion,
    executable: true,
    id: value.id,
    payload,
    position: value.position,
    source: blockSource,
    sourceLabel: sourceLabel(blockSource),
    state,
    stateVersion: state.stateVersion,
    title: payload.title,
  };
  if (
    payload.blockType === "proposal"
    && string(payload.body)
    && Array.isArray(payload.actions)
    && same(payload.actions, ["accept", "reject"])
    && ["pending", "accepted", "rejected"].includes(String(state.status))
  ) {
    return { ...common, body: payload.body, kind: "proposal" };
  }
  if (
    payload.blockType === "checklist"
    && Array.isArray(payload.actions)
    && same(payload.actions, ["check_item", "uncheck_item"])
    && Array.isArray(payload.items)
    && Array.isArray(state.items)
  ) {
    const stateItems = new Map<string, boolean>();
    for (const item of state.items) {
      if (!record(item) || !string(item.id) || typeof item.checked !== "boolean") return null;
      stateItems.set(item.id, item.checked);
    }
    const items: Array<{ checked: boolean; id: string; text: string }> = [];
    for (const item of payload.items) {
      if (!record(item) || !string(item.id) || !string(item.text) || !stateItems.has(item.id)) {
        return null;
      }
      items.push({ checked: stateItems.get(item.id) ?? false, id: item.id, text: item.text });
    }
    if (items.length !== stateItems.size) return null;
    return { ...common, items, kind: "checklist" };
  }
  if (
    (payload.blockType === "diff_preview"
      || payload.blockType === "file_reference"
      || payload.blockType === "handoff_card")
    && state.status === "read_only"
  ) {
    if (payload.blockType === "file_reference") {
      if (!string(payload.publicName)) return null;
      return { ...common, executable: false, fileName: payload.publicName, kind: "file_reference" };
    }
    return { ...common, executable: false, kind: payload.blockType };
  }
  return null;
}

function unknownBlock(
  value: Record<string, unknown>,
  message: Record<string, unknown>,
): TranscriptUnknownBlock | null {
  const blockSource = source(value.source, message);
  const stateVersion = record(value.state)
    ? value.state.stateVersion
    : value.stateVersion;
  if (
    !record(value.actor)
    || !string(value.actor.displayName)
    || !string(value.id)
    || !integer(value.position)
    || !integer(value.blockRevision, 1)
    || !integer(value.blockSchemaVersion, 1)
    || !integer(stateVersion, 1)
    || !blockSource
  ) return null;
  return {
    actorLabel: value.actor.displayName,
    blockRevision: value.blockRevision,
    blockSchemaVersion: value.blockSchemaVersion,
    executable: false,
    id: value.id,
    kind: "unknown",
    position: value.position,
    source: blockSource,
    sourceLabel: sourceLabel(blockSource),
    stateVersion,
  };
}

const runEventHeadings: Record<string, string> = {
  action_rejected: "本轮动作未提交",
  attempt_interrupted: "本轮推进已中断",
  boundary_paused: "协作已在边界暂停",
  context_changed: "项目上下文已变化",
  decision_answered: "所有者已回答决策",
  decision_requested: "等待所有者决策",
  handoff: "协作棒已交接",
  model_call_failed: "模型调用失败",
  model_call_started: "正在调用模型",
  model_call_succeeded: "模型调用已完成",
  run_paused: "协作已暂停",
  run_planned: "协作计划已就绪",
  run_resumed: "协作已继续",
  run_retried: "协作已重试",
  run_started: "协作已启动",
  run_stopped: "协作已停止",
  task_claimed: "任务已领取",
  tasks_created: "任务已创建",
  usage_recorded: "模型用量已记录",
};

function heading(type: string, payload?: Record<string, unknown>): string {
  if (type === "owner_message") return "所有者发来消息";
  if (type === "agent_message") return "Agent 发来消息";
  if (type === "thread_created") return "线程已创建";
  if (type === "policy_changed") return "协作成员策略已更新";
  if (type === "run_linked") return "运行已关联";
  if (type === "run_event" && typeof payload?.eventType === "string") {
    return runEventHeadings[payload.eventType] ?? "运行事件已记录";
  }
  if (type === "inline_decision") return "就地决定已记录";
  return "线程事实已记录";
}

function replyReference(value: unknown): TranscriptReplyReference | null {
  if (
    !record(value)
    || Object.keys(value).length !== 4
    || !string(value.messageId)
    || !integer(value.sequence, 1)
    || !string(value.authorDisplayName)
    || !string(value.excerpt)
  ) return null;
  return {
    authorDisplayName: value.authorDisplayName,
    excerpt: value.excerpt,
    messageId: value.messageId,
    sequence: value.sequence,
  };
}

function entry(value: unknown): TranscriptEntry | null {
  if (
    !record(value)
    || !string(value.id)
    || !string(value.type)
    || !string(value.projectId)
    || !string(value.threadId)
    || !string(value.createdAt)
    || !integer(value.sequence, 1)
    || !(value.runId === null || string(value.runId))
  ) return null;
  if (value.type !== "owner_message" && value.type !== "agent_message") {
    return {
      actorLabel: value.actorType === "owner"
        ? "项目所有者"
        : value.actorType === "system"
          ? "系统"
          : string(value.actorId) ? value.actorId : "Agent",
      blocks: [],
      createdAt: value.createdAt,
      factId: value.id,
      factSequence: value.sequence,
      heading: heading(value.type, record(value.payload) ? value.payload : undefined),
      mention: null,
      messageId: null,
      replyTo: null,
      runId: value.runId,
      text: value.type === "thread_created" && record(value.payload) && string(value.payload.title)
        ? value.payload.title
        : null,
    };
  }
  const message = value.message;
  if (
    !record(message)
    || !string(message.id)
    || message.id !== value.messageId
    || message.projectId !== value.projectId
    || message.threadId !== value.threadId
    || message.runId !== value.runId
    || !string(message.authorDisplayName)
    || !string(message.content)
    || message.authorType !== (value.type === "owner_message" ? "owner" : "agent")
  ) return null;
  const rawBlocks = message.blocks === undefined ? [] : message.blocks;
  if (!Array.isArray(rawBlocks)) return null;
  const mention = message.mentionAgentId === null
    && message.mentionDisplayName === null
    && message.mentionMemberStatus === null
    ? null
    : string(message.mentionAgentId)
        && string(message.mentionDisplayName)
        && (message.mentionMemberStatus === "current" || message.mentionMemberStatus === "left")
      ? {
          displayName: message.mentionDisplayName,
          memberStatus: message.mentionMemberStatus === "current" ? "current" as const : "left" as const,
        }
      : undefined;
  if (mention === undefined) return null;
  const replyTo = message.replyTo === null
    ? null
    : replyReference(message.replyTo);
  if (replyTo === null && message.replyTo !== null) return null;
  const blocks: TranscriptBlock[] = [];
  for (const rawBlock of rawBlocks) {
    if (!record(rawBlock)) return null;
    const mapped = rawBlock.kind === "unknown-schema"
      ? unknownBlock(rawBlock, message)
      : rawBlock.kind === "known" || rawBlock.kind === undefined
        ? knownBlock(rawBlock, message)
        : null;
    if (!mapped) return null;
    blocks.push(mapped);
  }
  blocks.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  for (let index = 1; index < blocks.length; index += 1) {
    if (blocks[index - 1]?.position === blocks[index]?.position) return null;
  }
  return {
    actorLabel: message.authorDisplayName,
    blocks,
    createdAt: value.createdAt,
    factId: value.id,
    factSequence: value.sequence,
    heading: heading(value.type),
    mention,
    messageId: message.id,
    replyTo,
    runId: value.runId,
    text: message.content,
  };
}

export function reduceTranscript(input: TranscriptModelInput): TranscriptModel {
  if (input.aborted || input.targetKey !== input.currentTargetKey) {
    return { kind: "stale", targetKey: input.targetKey };
  }
  const facts = new Map<string, unknown>();
  const blocks = new Map<string, unknown>();
  for (const rawPage of input.pages) {
    if (!record(rawPage) || !Array.isArray(rawPage.items)) {
      return { kind: "invalid", message: "协作历史已损坏，无法安全读取。", targetKey: input.targetKey };
    }
    for (const fact of rawPage.items) {
      if (!record(fact) || !string(fact.id)) {
        return { kind: "invalid", message: "协作历史已损坏，无法安全读取。", targetKey: input.targetKey };
      }
      const priorFact = facts.get(fact.id);
      if (priorFact && !same(priorFact, fact)) {
        return { kind: "invalid", message: "协作历史已损坏，无法安全读取。", targetKey: input.targetKey };
      }
      facts.set(fact.id, fact);
      if (record(fact.message) && Array.isArray(fact.message.blocks)) {
        for (const rawBlock of fact.message.blocks) {
          if (!record(rawBlock) || !string(rawBlock.id)) {
            return { kind: "invalid", message: "协作历史已损坏，无法安全读取。", targetKey: input.targetKey };
          }
          const priorBlock = blocks.get(rawBlock.id);
          if (priorBlock && !same(priorBlock, rawBlock)) {
            return { kind: "invalid", message: "协作历史已损坏，无法安全读取。", targetKey: input.targetKey };
          }
          blocks.set(rawBlock.id, rawBlock);
        }
      }
    }
  }
  const entries: TranscriptEntry[] = [];
  for (const fact of facts.values()) {
    const mapped = entry(fact);
    if (!mapped) {
      return { kind: "invalid", message: "协作历史已损坏，无法安全读取。", targetKey: input.targetKey };
    }
    entries.push(mapped);
  }
  entries.sort(
    (left, right) => left.factSequence - right.factSequence || left.factId.localeCompare(right.factId),
  );
  return { entries, kind: "ready", targetKey: input.targetKey };
}
