"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useModalSurface } from "@/components/mobile-dialog";
import { StructuredMessageBlock } from "@/components/collaboration/structured-message-block";
import { useTargetRequestGuard } from "@/components/collaboration/use-target-request-guard";
import type {
  AnswerDecisionResponse,
  CollaborationApiError,
  CollaborationReadResponse,
  CollaborationRun,
  DecisionRequest,
  FactPageResponse,
  MessagePageResponse,
  ProjectMessage,
  RunStartResponse,
  ThreadFactDto,
  ThreadMessageDto,
  ThreadRunDto,
  TimelineEvent,
  UsageTotals,
} from "@/src/shared/collaboration-contracts";
import { ApiDisplayError, apiErrorCopy, caughtApiErrorCopy } from "@/src/shared/api-error-copy";
import { parseCollaborationGuideEnvelope } from "@/src/shared/onboarding-guide-machine";
import type {
  MembershipState,
  ProjectMember,
} from "@/src/shared/project-context-contracts";
import { reduceTranscript, type TranscriptReplyReference } from "@/src/shared/transcript-model";

type CollaborationPanelProps = {
  projectId: string;
  selectedRunId?: string | null;
  surface?: "all" | "chat" | "run";
  threadId?: string | null;
  modalBackgroundRef?: RefObject<HTMLElement | null>;
  onNestedModalChange?: (open: boolean) => void;
  onGoalFactChanged?: () => void;
  onRequestChat?: () => void;
  startOnly?: boolean;
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

class CollaborationResponseError extends ApiDisplayError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

class InvalidThreadEnvelopeError extends Error {}

async function readApiResponse<T>(response: Response, fallback: string): Promise<T> {
  const payload = await readJson<T & Partial<CollaborationApiError>>(response);
  if (!response.ok) {
    throw new CollaborationResponseError(apiErrorCopy(payload, fallback), response.status);
  }
  return payload;
}

function operationId(): string {
  return crypto.randomUUID();
}

function graphemeLength(value: string): number {
  return typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter().segment(value)).length
    : Array.from(value).length;
}

const activeRunStatuses = new Set(["running", "waiting_owner", "paused", "failed"]);
const POLL_INTERVAL_MS = 1_000;

type CollaborationWriteReceipt = {
  baselineMessageIds: string[];
  mentionAgentId?: string;
  message: string;
  operationId: string;
  runId: string | null;
};

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      Object.keys(value).every((key) => keys.includes(key)),
  );
}

function mutationIds(
  value: unknown,
  kind: "message" | "start",
  projectId: string,
  threadId: string,
): { messageId: string; runId: string | null } | null {
  const keys = kind === "start"
    ? ["created", "facts", "message", "run"]
    : ["fact", "message", "run"];
  if (!exactKeys(value, keys)) return null;
  if (kind === "start" && value.created !== true) return null;
  if (!exactKeys(value.message, [
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
  ])) return null;
  if (kind === "message" && value.run === null) {
    return typeof value.message.id === "string" &&
      value.message.projectId === projectId &&
      value.message.threadId === threadId &&
      value.message.runId === null
      ? { messageId: value.message.id, runId: null }
      : null;
  }
  if (!exactKeys(value.run, [
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
  ])) return null;
  const messageId = value.message.id;
  const runId = value.run.id;
  const validMessage =
    typeof value.message.sequence === "number" &&
    Number.isSafeInteger(value.message.sequence) &&
    value.message.sequence >= 0 &&
    value.message.authorType === "owner" &&
    value.message.authorAgentId === null &&
    typeof value.message.authorDisplayName === "string" &&
    typeof value.message.content === "string" &&
    value.message.projectId === projectId &&
    value.message.threadId === threadId &&
    (value.message.runId === runId ||
      (kind === "message" && value.message.runId === null)) &&
    (value.message.mentionAgentId === null ||
      typeof value.message.mentionAgentId === "string") &&
    (value.message.mentionDisplayName === null ||
      typeof value.message.mentionDisplayName === "string") &&
    (value.message.mentionMemberStatus === null ||
      value.message.mentionMemberStatus === "current" ||
      value.message.mentionMemberStatus === "left") &&
    typeof value.message.createdAt === "string";
  const validRun =
    typeof value.run.projectId === "string" &&
    value.run.projectId === projectId &&
    value.run.threadId === threadId &&
    typeof value.run.currentAgentId === "string" &&
    typeof value.run.roundCount === "number" &&
    Number.isSafeInteger(value.run.roundCount) &&
    value.run.roundCount >= 0 &&
    typeof value.run.version === "number" &&
    Number.isSafeInteger(value.run.version) &&
    value.run.version >= 1 &&
    (value.run.pauseCategory === null ||
      typeof value.run.pauseCategory === "string") &&
    ["running", "waiting_owner", "paused", "failed", "planned", "stopped"].includes(
      String(value.run.status),
    ) &&
    typeof value.run.createdAt === "string" &&
    typeof value.run.updatedAt === "string";
  return typeof messageId === "string" &&
    messageId.length > 0 &&
    typeof runId === "string" &&
    runId.length > 0 &&
    validMessage &&
    validRun
    ? { messageId, runId }
    : null;
}

function mergeSequenced<T extends { id: string; sequence: number }>(
  current: T[],
  incoming: T[],
): T[] {
  return Array.from(
    new Map([...current, ...incoming].map((item) => [item.id, item])).values(),
  ).sort((left, right) => left.sequence - right.sequence);
}

function sameFact(left: ThreadFactDto, right: ThreadFactDto): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeThreadFacts(
  current: ThreadFactDto[],
  incoming: ThreadFactDto[],
): { added: number; items: ThreadFactDto[] } {
  const byId = new Map(current.map((fact) => [fact.id, fact]));
  let added = 0;
  for (const fact of incoming) {
    const existing = byId.get(fact.id);
    if (existing && !sameFact(existing, fact)) {
      throw new Error("Thread fact identity collision.");
    }
    if (!existing) added += 1;
    byId.set(fact.id, fact);
  }
  return {
    added,
    items: Array.from(byId.values()).sort(
      (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
    ),
  };
}

function validFactTuple(
  fact: ThreadFactDto,
  projectId: string,
  threadId: string,
): boolean {
  if (
    !fact
    || typeof fact !== "object"
    || fact.projectId !== projectId
    || fact.threadId !== threadId
    || typeof fact.id !== "string"
    || !Number.isSafeInteger(fact.sequence)
    || fact.sequence < 1
  ) return false;
  if (fact.type === "owner_message" || fact.type === "agent_message") {
    return fact.message !== null
      && fact.message.id === fact.messageId
      && fact.message.projectId === projectId
      && fact.message.threadId === threadId
      && fact.message.authorType === (fact.type === "owner_message" ? "owner" : "agent");
  }
  return fact.message === null;
}

function parseFactPage(
  value: unknown,
  projectId: string,
  threadId: string,
): FactPageResponse {
  if (
    !exactKeys(value, ["items", "nextAfter"])
    || !Array.isArray(value.items)
    || !value.items.every((fact) =>
      validFactTuple(fact as ThreadFactDto, projectId, threadId)
    )
    || !(
      value.nextAfter === null
      || (Number.isSafeInteger(value.nextAfter) && Number(value.nextAfter) >= 1)
    )
  ) {
    throw new Error("Invalid thread fact page.");
  }
  const page = value as FactPageResponse;
  for (let index = 1; index < page.items.length; index += 1) {
    if (page.items[index - 1]!.sequence >= page.items[index]!.sequence) {
      throw new Error("Invalid thread fact order.");
    }
  }
  return page;
}

type OnboardingThreadEnvelope = {
  activeRun: { runId: string; threadId: string } | null;
  factsPage: FactPageResponse;
  messagesPage: MessagePageResponse;
  readiness: unknown;
  runs: ThreadRunDto[];
  selectedRun: ThreadRunDto | null;
  thread: unknown;
};

async function readAllThreadPages<T>(
  url: string,
  fallback: string,
  signal: AbortSignal,
): Promise<{ items: T[]; nextAfter: null }> {
  const items: T[] = [];
  let after = 0;
  while (true) {
    const response = await fetch(after > 0 ? `${url}?after=${after}` : url, { signal });
    const page = await readApiResponse<unknown>(response, fallback);
    if (
      !exactKeys(page, ["items", "nextAfter"]) ||
      !Array.isArray(page.items) ||
      !(page.nextAfter === null ||
        (Number.isSafeInteger(page.nextAfter) && Number(page.nextAfter) >= 0))
    ) {
      return page as { items: T[]; nextAfter: null };
    }
    items.push(...page.items as T[]);
    if (page.nextAfter === null) break;
    if (Number(page.nextAfter) <= after) {
      throw new Error("Thread page cursor did not advance.");
    }
    after = Number(page.nextAfter);
  }
  return { items, nextAfter: null };
}

async function readOnboardingThread(
  projectId: string,
  threadId: string,
  selectedRunId: string | null,
  signal: AbortSignal,
  allFacts = false,
): Promise<{ envelope: OnboardingThreadEnvelope; state: CollaborationReadResponse }> {
  const base = `/api/projects/${projectId}/threads/${threadId}`;
  const detailUrl = selectedRunId
    ? `${base}?run=${encodeURIComponent(selectedRunId)}`
    : base;
  const [detail, messagesPage, factsPage, tupleTimelinePage] = await Promise.all([
    fetch(detailUrl, { signal }).then((response) =>
      readApiResponse<Record<string, unknown>>(
        response,
        "无法加载协作线程，请稍后重试。",
      )
    ),
    readAllThreadPages<ThreadMessageDto>(
      `${base}/messages`,
      "无法加载协作消息，请稍后重试。",
      signal,
    ),
    allFacts
      ? readAllThreadPages<ThreadFactDto>(
          `${base}/facts`,
          "无法加载协作事实，请稍后重试。",
          signal,
        )
      : fetch(`${base}/facts`, { signal })
          .then((response) =>
            readApiResponse<unknown>(
              response,
              "无法加载协作事实，请稍后重试。",
            )
          )
          .then((page) => parseFactPage(page, projectId, threadId)),
    selectedRunId
      ? readAllThreadPages<TimelineEvent>(
          `${base}/runs/${encodeURIComponent(selectedRunId)}/timeline`,
          "无法加载运行事件，请稍后重试。",
          signal,
        )
      : Promise.resolve({ items: [], nextAfter: null } as const),
  ]);
  const envelope = {
    ...detail,
    factsPage,
    messagesPage,
  } as OnboardingThreadEnvelope;
  const selectedRun = envelope.selectedRun;
  const selectedMessages = messagesPage.items.filter(
    (message) => message.runId === null || message.runId === selectedRun?.id,
  );
  const firstOwnerMessage = selectedMessages.find(
    (message) =>
      message.runId === selectedRun?.id && message.authorType === "owner",
  );
  const events = factsPage.items.flatMap((fact): TimelineEvent[] => {
    if (fact.runId !== selectedRun?.id) return [];
    if (
      (fact.type === "owner_message" || fact.type === "agent_message") &&
      fact.message
    ) {
      const message = fact.message;
      return [{
        actorId: fact.actorId,
        actorType: fact.actorType,
        createdAt: fact.createdAt,
        id: fact.id,
        payload: fact.type === "owner_message"
          ? {
              mentionAgentId: message.mentionAgentId,
              mentionDisplayName: message.mentionDisplayName,
              messageId: message.id,
              messageSequence: message.sequence,
            }
          : {
              agentDisplayName: message.authorDisplayName,
              agentId: message.authorAgentId!,
              messageId: message.id,
              messageSequence: message.sequence,
              turnId: fact.id,
            },
        runId: fact.runId!,
        sequence: fact.sequence,
        type: fact.type,
      } as TimelineEvent];
    }
    if (fact.type === "run_event" && fact.payload.eventType === "run_started") {
      return [{
        actorId: fact.actorId,
        actorType: fact.actorType,
        createdAt: fact.createdAt,
        id: fact.id,
        payload: {
          currentAgentId: selectedRun!.currentAgentId,
          messageId: firstOwnerMessage?.id ?? fact.id,
          messageSequence: firstOwnerMessage?.sequence ?? 1,
        },
        runId: fact.runId,
        sequence: fact.sequence,
        type: "run_started",
      }];
    }
    return [];
  });
  const answeredDecisionIds = new Set(
    tupleTimelinePage.items.flatMap((event) =>
      event.type === "decision_answered"
        ? [event.payload.decisionId]
        : [],
    ),
  );
  const pendingDecisionEvent = tupleTimelinePage.items.findLast(
    (event) =>
      event.type === "decision_requested"
      && !answeredDecisionIds.has(event.payload.decisionId),
  );
  const pendingDecision: DecisionRequest | null =
    pendingDecisionEvent?.type === "decision_requested"
      ? {
          answer: null,
          answerMessageId: null,
          answeredAt: null,
          createdAt: pendingDecisionEvent.createdAt,
          id: pendingDecisionEvent.payload.decisionId,
          options: pendingDecisionEvent.payload.options,
          question: pendingDecisionEvent.payload.question,
          requestingAgentId: pendingDecisionEvent.payload.agentId,
          runId: pendingDecisionEvent.runId,
          status: "open",
          turnId: pendingDecisionEvent.payload.turnId,
          version: 1,
        }
      : null;
  const usageByAgent = new Map<string, UsageTotals["byAgent"][number]>();
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let repairCalls = 0;
  let unreportedCalls = 0;
  for (const event of tupleTimelinePage.items) {
    if (event.type === "usage_recorded") {
      if (event.payload.kind === "repair") repairCalls += 1;
      if (!event.payload.reported) {
        unreportedCalls += 1;
        continue;
      }
      promptTokens += event.payload.promptTokens;
      completionTokens += event.payload.completionTokens;
      totalTokens += event.payload.totalTokens;
      if (event.actorId) {
        const current = usageByAgent.get(event.actorId) ?? {
          agentId: event.actorId,
          completionTokens: 0,
          handoffs: 0,
          promptTokens: 0,
          totalTokens: 0,
        };
        current.promptTokens += event.payload.promptTokens;
        current.completionTokens += event.payload.completionTokens;
        current.totalTokens += event.payload.totalTokens;
        usageByAgent.set(event.actorId, current);
      }
    }
    if (event.type === "handoff") {
      const current = usageByAgent.get(event.payload.fromAgentId) ?? {
        agentId: event.payload.fromAgentId,
        completionTokens: 0,
        handoffs: 0,
        promptTokens: 0,
        totalTokens: 0,
      };
      current.handoffs += 1;
      usageByAgent.set(event.payload.fromAgentId, current);
    }
  }
  return {
    envelope,
    state: {
      pendingDecision,
      projectMessagesPage: { items: selectedMessages, nextAfter: null },
      readiness: {
        missing: [],
        ready: envelope.readiness !== null,
      },
      run: selectedRun,
      timelinePage: { items: events, nextAfter: null },
      usage: {
        byAgent: Array.from(usageByAgent.values()),
        completionTokens,
        promptTokens,
        repairCalls,
        totalTokens,
        unreportedCalls,
      },
    },
  };
}

function eventActor(event: TimelineEvent, members: ProjectMember[]): string {
  if (event.actorType === "owner") return "项目所有者";
  if (event.actorType === "system") return "系统";
  return members.find((member) => member.agentId === event.actorId)?.name
    ?? (event.type === "agent_message" ? event.payload.agentDisplayName : event.actorId)
    ?? "Agent";
}

function readableTime(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(timestamp));
}

function canonicalRunHref(
  projectId: string,
  threadId: string,
  runId: string | null,
): string {
  const query = new URLSearchParams();
  query.set("thread", threadId);
  if (runId) query.set("run", runId);
  return `/projects/${encodeURIComponent(projectId)}?${query.toString()}`;
}

function runChoiceLabel(run: ThreadRunDto): string {
  return `${run.status} · ${readableTime(run.createdAt)} · ${run.id}`;
}

const terminalRunStatuses = new Set<CollaborationRun["status"]>([
  "planned",
  "stopped",
]);

type ControlAction = "pause" | "continue" | "retry" | "stop";

const pauseCategoryCopy: Record<string, string> = {
  action_conflict: "协作事实已变化，请刷新后重试。",
  action_invalid: "Agent 提交的协作动作无效，请修复后重试。",
  boundary_reached: "运行已达到配置边界，请调整限制后重试。",
  context_changed: "项目上下文已变化，请检查后重试。",
  credential_unavailable: "Provider 凭据不可用，请修复后重试。",
  internal_failure: "运行出现内部故障，请稍后重试。",
  interrupted: "上一轮推进已中断，可以重试。",
  provider_auth: "Provider 身份验证失败，请修复配置后重试。",
  provider_response_invalid: "Provider 响应无效，请重试。",
  provider_timeout: "Provider 请求超时，可以重试。",
  provider_unreachable: "当前无法连接 Provider，可以重试。",
  provider_upstream: "Provider 服务暂时异常，可以重试。",
  rate_limited: "Provider 请求过于频繁，请稍后重试。",
  structured_output_invalid: "Provider 返回的结构化内容无效，请重试。",
  usage_invalid: "Provider 用量数据无效，请检查后重试。",
};

function enabledControlActions(run: CollaborationRun): Set<ControlAction> {
  if (run.status === "running") return new Set(["pause", "stop"]);
  if (run.status === "waiting_owner") return new Set(["stop"]);
  if (run.status === "failed") return new Set(["retry", "stop"]);
  if (run.status === "paused") {
    return new Set(run.pauseCategory === "manual" ? ["continue", "stop"] : ["retry", "stop"]);
  }
  return new Set();
}

function controlReason(run: CollaborationRun): string {
  if (run.status === "planned" || run.status === "stopped") {
    return "运行已结束，不能再执行控制操作。";
  }
  if (run.status === "waiting_owner") return "等待决策时只能回答或停止运行。";
  if (run.status === "failed") return "失败状态只能在修复后重试。";
  if (run.status === "paused" && run.pauseCategory === "manual") {
    return "手动暂停请使用继续。";
  }
  if (run.status === "paused") return "当前暂停原因需要修复后重试。";
  return "仅手动暂停后可继续。";
}

function UsagePanel({
  members,
  run,
  usage,
}: {
  members: ProjectMember[];
  run: CollaborationRun;
  usage: UsageTotals;
}) {
  const handoffs = usage.byAgent.reduce((total, agent) => total + agent.handoffs, 0);
  const hasUsage = usage.totalTokens > 0 || usage.unreportedCalls > 0;
  return (
    <section aria-label="运行用量" className="run-detail" role="region">
      <div className="panel-heading">
        <h3>运行用量</h3>
        <span className="status-label">轮次 {run.roundCount}</span>
      </div>
      {!hasUsage ? <p className="muted">尚无已报告的模型用量。</p> : null}
      <dl className="metric-grid">
        <div><dt>Prompt </dt><dd>{usage.promptTokens}</dd></div>
        <div><dt>Completion </dt><dd>{usage.completionTokens}</dd></div>
        <div><dt>总计 </dt><dd>{usage.totalTokens}</dd></div>
        <div><dt>交棒 </dt><dd>{handoffs}</dd></div>
        <div><dt>修复调用 </dt><dd>{usage.repairCalls}</dd></div>
        <div><dt>未报告 </dt><dd>{usage.unreportedCalls}</dd></div>
      </dl>
      {usage.byAgent.length ? (
        <ul aria-label="按 Agent 用量" className="usage-agents">
          {usage.byAgent.map((agent) => (
            <li key={agent.agentId}>
              <strong>
                {members.find((member) => member.agentId === agent.agentId)?.name
                  ?? agent.agentId}
              </strong>
              <span>Prompt {agent.promptTokens}</span>
              <span>Completion {agent.completionTokens}</span>
              <span>总计 {agent.totalTokens}</span>
              <span>交棒 {agent.handoffs}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function DecisionPanel({
  decision,
  members,
  onAnswered,
  projectId,
  threadId,
}: {
  decision: DecisionRequest;
  members: ProjectMember[];
  onAnswered: (result: AnswerDecisionResponse) => void;
  projectId: string;
  threadId: string;
}) {
  const targetGuard = useTargetRequestGuard(
    `${projectId}|${threadId}|${decision.runId}`,
  );
  const [selectedOption, setSelectedOption] = useState("");
  const [freeText, setFreeText] = useState("");
  const [mentionAgentId, setMentionAgentId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = freeText.trim() || selectedOption;
  const nextMembers = members.filter(
    (member) => member.agentId !== decision.requestingAgentId,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!answer || submitting) return;
    if (graphemeLength(answer) > 5_000) {
      setError("请输入 1 至 5000 个字符。");
      return;
    }
    setSubmitting(true);
    setError(null);
    const request = targetGuard.capture();
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(
          threadId,
        )}/runs/${encodeURIComponent(decision.runId)}/decisions/${encodeURIComponent(
          decision.id,
        )}/answer`,
        {
          body: JSON.stringify({
            answer,
            expectedVersion: decision.version,
            ...(mentionAgentId ? { mentionAgentId } : {}),
            operationId: operationId(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: request.signal,
        },
      );
      const result = await readApiResponse<AnswerDecisionResponse>(
        response,
        "无法提交回答，请稍后重试。",
      );
      if (
        result.run.projectId !== projectId
        || result.run.id !== decision.runId
        || result.decision.runId !== decision.runId
        || result.decision.id !== decision.id
      ) throw new Error("Invalid decision answer tuple.");
      if (request.isCurrent()) onAnswered(result);
    } catch (cause) {
      if (request.isCurrent()) {
        setError(caughtApiErrorCopy(cause, "无法提交回答，请稍后重试。"));
      }
    } finally {
      if (request.isCurrent()) setSubmitting(false);
    }
  }

  return (
    <form className="decision-panel" onSubmit={submit}>
      <div>
        <p className="eyebrow">需要所有者输入</p>
        <h3>等待你的决策</h3>
      </div>
      <p>{decision.question}</p>
      <fieldset disabled={submitting}>
        <legend>选择一个回答</legend>
        {decision.options.map((option) => (
          <label className="radio-row" key={option}>
            <input
              checked={selectedOption === option}
              name={`decision-${decision.id}`}
              onChange={() => {
                setSelectedOption(option);
                setFreeText("");
              }}
              type="radio"
              value={option}
            />
            <span>{option}</span>
          </label>
        ))}
      </fieldset>
      <div className="form-field">
        <label htmlFor={`decision-answer-${decision.id}`}>其他回答</label>
        <textarea
          disabled={submitting}
          id={`decision-answer-${decision.id}`}
          maxLength={5_000}
          onChange={(event) => {
            setFreeText(event.target.value);
            if (event.target.value) setSelectedOption("");
          }}
          value={freeText}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`decision-mention-${decision.id}`}>回答后交给成员</label>
        <select
          disabled={submitting || !nextMembers.length}
          id={`decision-mention-${decision.id}`}
          onChange={(event) => setMentionAgentId(event.target.value)}
          value={mentionAgentId}
        >
          <option value="">不指定</option>
          {nextMembers.map((member) => (
            <option key={member.agentId} value={member.agentId}>{member.name}</option>
          ))}
        </select>
      </div>
      {!answer ? <p className="muted">请选择一个选项或填写其他回答。</p> : null}
      <button disabled={!answer || submitting} type="submit">
        {submitting ? "正在提交…" : "提交回答"}
      </button>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </form>
  );
}

function RunControls({
  modalBackgroundRef,
  onModalChange,
  onRunChanged,
  projectId,
  run,
  threadId,
}: {
  modalBackgroundRef?: RefObject<HTMLElement | null>;
  onModalChange?: (open: boolean) => void;
  onRunChanged: (run: CollaborationRun) => void;
  projectId: string;
  run: CollaborationRun;
  threadId: string;
}) {
  const targetGuard = useTargetRequestGuard(`${projectId}|${threadId}|${run.id}`);
  const [pending, setPending] = useState<ControlAction | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stopButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const enabled = enabledControlActions(run);
  const closeStopConfirmation = useCallback(() => {
    setConfirmStop(false);
  }, []);
  const modalOptions = useMemo(
    () => ({
      active: confirmStop,
      dialogRef,
      hideBackground: true,
      inertRootRefs: [modalBackgroundRef ?? sectionRef],
      initialFocusRef: cancelButtonRef,
      restoreFocusRef: stopButtonRef,
      onClose: closeStopConfirmation,
    }),
    [closeStopConfirmation, confirmStop, modalBackgroundRef],
  );
  useModalSurface(modalOptions);

  useEffect(() => {
    onModalChange?.(confirmStop);
    return () => {
      if (confirmStop) onModalChange?.(false);
    };
  }, [confirmStop, onModalChange]);

  async function control(action: ControlAction) {
    if (!enabled.has(action) || pending) return;
    setPending(action);
    setError(null);
    const request = targetGuard.capture();
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(
          threadId,
        )}/runs/${encodeURIComponent(run.id)}/control`,
        {
        body: JSON.stringify({
          action,
          expectedVersion: run.version,
          operationId: operationId(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: request.signal,
        },
      );
      const result = await readApiResponse<{ run: CollaborationRun }>(
        response,
        "无法更新运行状态，请稍后重试。",
      );
      if (
        result.run.projectId !== projectId
        || result.run.id !== run.id
        || ("threadId" in result.run && result.run.threadId !== threadId)
      ) throw new Error("Invalid run control tuple.");
      if (!request.isCurrent()) return;
      setConfirmStop(false);
      onRunChanged(result.run);
    } catch (cause) {
      if (request.isCurrent()) {
        setError(caughtApiErrorCopy(cause, "无法更新运行状态，请稍后重试。"));
      }
    } finally {
      if (request.isCurrent()) setPending(null);
    }
  }

  return (
    <section
      aria-label="运行控制"
      className="run-detail"
      ref={sectionRef}
      role="region"
    >
      <div className="panel-heading">
        <h3>运行控制</h3>
        <span className="status-label">{run.status}</span>
      </div>
      {run.pauseCategory ? (
        <p>{pauseCategoryCopy[run.pauseCategory] ?? "运行已暂停，请检查后重试。"}</p>
      ) : null}
      <div className="control-actions">
        {([
          ["pause", "暂停"],
          ["continue", "继续"],
          ["retry", "重试"],
        ] as const).map(([action, label]) => (
          <button
            disabled={!enabled.has(action) || pending !== null}
            key={action}
            onClick={() => void control(action)}
            type="button"
          >
            {pending === action ? "处理中…" : label}
          </button>
        ))}
        <button
          disabled={!enabled.has("stop") || pending !== null}
          onClick={() => setConfirmStop(true)}
          ref={stopButtonRef}
          type="button"
        >
          停止
        </button>
      </div>
      <p className="muted">{controlReason(run)}</p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {confirmStop
        ? createPortal(
            <div
              aria-describedby={`stop-description-${run.id}`}
              aria-labelledby={`stop-title-${run.id}`}
              aria-modal="true"
              className="modal-surface stop-confirm"
              ref={dialogRef}
              role="dialog"
            >
              <h3 id={`stop-title-${run.id}`}>确认停止协作</h3>
              <p id={`stop-description-${run.id}`}>停止后不能继续或重试。</p>
              <div className="control-actions">
                <button
                  onClick={closeStopConfirmation}
                  ref={cancelButtonRef}
                  type="button"
                >
                  取消停止
                </button>
                <button onClick={() => void control("stop")} type="button">
                  确认停止
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

export function CollaborationPanel({
  modalBackgroundRef,
  onGoalFactChanged,
  onNestedModalChange,
  onRequestChat,
  projectId,
  selectedRunId = null,
  startOnly = false,
  surface = "all",
  threadId = null,
}: CollaborationPanelProps) {
  const [state, setState] = useState<CollaborationReadResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [factsPage, setFactsPage] = useState<FactPageResponse | null>(null);
  const [factsTargetKey, setFactsTargetKey] = useState("");
  const [factsError, setFactsError] = useState<string | null>(null);
  const [factsPending, setFactsPending] = useState(false);
  const [factsStatus, setFactsStatus] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [activeMemberIndex, setActiveMemberIndex] = useState(0);
  const [selectedMember, setSelectedMember] = useState<ProjectMember | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [replyJumpMessageId, setReplyJumpMessageId] = useState<string | null>(null);
  const [locateMessageId, setLocateMessageId] = useState<string | null>(null);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [newEventCount, setNewEventCount] = useState(0);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [advanceCycle, setAdvanceCycle] = useState(0);
  const [decisionSuccess, setDecisionSuccess] = useState(false);
  const [startNotice, setStartNotice] = useState("");
  const [runSelection, setRunSelection] = useState<Pick<
    OnboardingThreadEnvelope,
    "activeRun" | "runs" | "selectedRun"
  > | null>(null);
  const [runSelectionNotice, setRunSelectionNotice] = useState("");
  const [runNavigationPending, setRunNavigationPending] = useState(false);
  const [focusRunId, setFocusRunId] = useState<string | null>(null);
  const onboardingSelectedRunIdRef = useRef<string | null>(selectedRunId);
  const [startReceipt, setStartReceipt] = useState<{
    baselineMessageIds: string[];
    message: string;
    mentionAgentId?: string;
    operationId: string;
  } | null>(null);
  const [messageReceipt, setMessageReceipt] =
    useState<CollaborationWriteReceipt | null>(null);
  const messageRefs = useRef(new Map<string, HTMLLIElement>());
  const mentionButtonRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const decisionSuccessRef = useRef<HTMLParagraphElement>(null);
  const runHeadingRef = useRef<HTMLHeadingElement>(null);
  const atBottomRef = useRef(true);
  const scrollAfterRenderRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const messageAfterRef = useRef(0);
  const eventAfterRef = useRef(0);
  const advanceInFlightRef = useRef(false);
  const advanceOperationIdRef = useRef<string | null>(null);
  const startNoticeAfterNavigationRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const targetEpochRef = useRef(0);
  const factRequestRef = useRef(0);
  const factRequestInFlightRef = useRef(false);
  const listboxId = `collaboration-members-${projectId}`;
  const fieldErrorId = `collaboration-message-error-${projectId}`;
  const targetKey = `${projectId}|${threadId ?? ""}|${selectedRunId ?? ""}`;
  const targetGuard = useTargetRequestGuard(targetKey);

  useEffect(() => {
    onboardingSelectedRunIdRef.current = selectedRunId;
  }, [selectedRunId, threadId]);

  const applyRead = useCallback((payload: CollaborationReadResponse, replace: boolean) => {
    setState((current) => {
      if (!current || replace) return payload;
      const currentEventIds = new Set(current.timelinePage.items.map((item) => item.id));
      const added = payload.timelinePage.items.filter(
        (item) => !currentEventIds.has(item.id),
      ).length;
      if (added > 0) {
        if (atBottomRef.current) scrollAfterRenderRef.current = true;
        else setNewEventCount((count) => count + added);
      }
      return {
        ...payload,
        projectMessagesPage: {
          items: mergeSequenced(
            current.projectMessagesPage.items,
            payload.projectMessagesPage.items,
          ),
          nextAfter: null,
        },
        timelinePage: {
          items: mergeSequenced(current.timelinePage.items, payload.timelinePage.items),
          nextAfter: null,
        },
      };
    });
  }, []);

  const loadCollaboration = useCallback(async (
    showLoading = false,
    expectedEpoch = targetEpochRef.current,
  ) => {
    const request = targetGuard.capture();
    if (refreshInFlightRef.current && expectedEpoch === targetEpochRef.current) return;
    refreshInFlightRef.current = true;
    if (showLoading) {
      setLoading(true);
      setLoadError(null);
      messageAfterRef.current = 0;
      eventAfterRef.current = 0;
    }
    try {
      if (threadId) {
        const result = await readOnboardingThread(
          projectId,
          threadId,
          onboardingSelectedRunIdRef.current,
          request.signal,
        );
        const parsed = parseCollaborationGuideEnvelope(
          result.envelope,
          projectId,
          threadId,
          onboardingSelectedRunIdRef.current,
        );
        if (parsed.kind === "invalid") throw new InvalidThreadEnvelopeError();
        if (
          mountedRef.current
          && expectedEpoch === targetEpochRef.current
          && request.isCurrent()
        ) {
          applyRead(result.state, true);
          setRunSelection({
            activeRun: result.envelope.activeRun,
            runs: result.envelope.runs,
            selectedRun: result.envelope.selectedRun,
          });
          setRunNavigationPending(false);
          if (result.envelope.selectedRun) {
            setRunSelectionNotice(
              `已选择运行 ${result.envelope.selectedRun.id}`,
            );
          } else {
            setRunSelectionNotice((current) =>
              current === "所选运行无效或已失效，已清除选择。"
                ? current
                : "尚未选择运行"
            );
          }
          if (showLoading) {
            setFactsPage(result.envelope.factsPage);
            setFactsTargetKey(targetKey);
            setFactsError(null);
          }
        }
        return;
      }
      throw new Error("thread tuple required");
    } catch (cause) {
      if (
        selectedRunId
        && (
          cause instanceof InvalidThreadEnvelopeError
          || (cause instanceof CollaborationResponseError && cause.status === 404)
        )
        && threadId
        && expectedEpoch === targetEpochRef.current
        && request.isCurrent()
      ) {
        const href = canonicalRunHref(projectId, threadId, null);
        onboardingSelectedRunIdRef.current = null;
        setRunSelectionNotice("所选运行无效或已失效，已清除选择。");
        setRunNavigationPending(false);
        window.history.replaceState(window.history.state, "", href);
        window.dispatchEvent(new PopStateEvent("popstate"));
        return;
      }
      if (
        mountedRef.current
        && showLoading
        && expectedEpoch === targetEpochRef.current
        && request.isCurrent()
      ) {
        setLoadError(caughtApiErrorCopy(cause, "无法加载项目群聊，请稍后重试。"));
      }
    } finally {
      if (request.isCurrent()) refreshInFlightRef.current = false;
      if (
        mountedRef.current
        && showLoading
        && expectedEpoch === targetEpochRef.current
        && request.isCurrent()
      ) setLoading(false);
    }
  }, [
    applyRead,
    projectId,
    targetKey,
    threadId,
    selectedRunId,
    targetGuard,
  ]);

  useEffect(() => {
    const epoch = targetEpochRef.current + 1;
    targetEpochRef.current = epoch;
    refreshInFlightRef.current = false;
    factRequestRef.current += 1;
    factRequestInFlightRef.current = false;
    setState(null);
    setRunSelection(null);
    setFactsPage(null);
    setFactsTargetKey("");
    setFactsError(null);
    setFactsPending(false);
    setFactsStatus("");
    setNewEventCount(0);
    setLoading(true);
    setLoadError(null);
    setDraft("");
    setMentionOpen(false);
    setMembers(null);
    setMembersError(null);
    setMembersLoading(false);
    setSelectedMember(null);
    setStartReceipt(null);
    setMessageReceipt(null);
    setSendError(null);
    setFieldError(null);
    setStartNotice(startNoticeAfterNavigationRef.current ?? "");
    startNoticeAfterNavigationRef.current = null;
    setDecisionSuccess(false);
    setAdvanceError(null);
    setAdvanceCycle(0);
    setSending(false);
    advanceInFlightRef.current = false;
    advanceOperationIdRef.current = null;
    setFocusMessageId(null);
    setReplyJumpMessageId(null);
    setLocateMessageId(null);
    setHighlightMessageId(null);
    messageRefs.current.clear();
    void loadCollaboration(true, epoch);
  }, [loadCollaboration, reloadKey, targetKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      targetEpochRef.current += 1;
    };
  }, []);

  const readNextFacts = useCallback(async (mode: "page" | "poll") => {
    if (!threadId || factRequestInFlightRef.current) return;
    const visiblePage = factsTargetKey === targetKey ? factsPage : null;
    const after = mode === "page"
      ? visiblePage?.nextAfter
      : visiblePage?.items.at(-1)?.sequence ?? 0;
    if (after === null || (mode === "page" && after === undefined)) return;
    const epoch = targetEpochRef.current;
    const targetRequest = targetGuard.capture();
    const request = factRequestRef.current + 1;
    factRequestRef.current = request;
    factRequestInFlightRef.current = true;
    if (mode === "page") setFactsPending(true);
    setFactsError(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(
          threadId,
        )}/facts?after=${after}`,
        { signal: targetRequest.signal },
      );
      const payload = await readApiResponse<unknown>(
        response,
        "无法加载协作事实，请稍后重试。",
      );
      const nextPage = parseFactPage(payload, projectId, threadId);
      if (
        !mountedRef.current
        || epoch !== targetEpochRef.current
        || request !== factRequestRef.current
        || !targetRequest.isCurrent()
      ) return;
      setFactsPage((current) => {
        if (!current || factsTargetKey !== targetKey) return current;
        const merged = mergeThreadFacts(current.items, nextPage.items);
        if (merged.added > 0) {
          if (mode === "poll") {
            if (atBottomRef.current) scrollAfterRenderRef.current = true;
            else setNewEventCount((count) => count + merged.added);
          } else {
            setFactsStatus(`已加载 ${merged.added} 条事实`);
          }
        } else if (mode === "page") {
          setFactsStatus("没有更多事实");
        }
        return { items: merged.items, nextAfter: nextPage.nextAfter };
      });
    } catch (cause) {
      if (
        mountedRef.current
        && epoch === targetEpochRef.current
        && request === factRequestRef.current
        && targetRequest.isCurrent()
      ) {
        setFactsError(caughtApiErrorCopy(cause, "无法加载协作事实，请稍后重试。"));
      }
    } finally {
      if (request === factRequestRef.current) {
        factRequestInFlightRef.current = false;
        if (
          mountedRef.current
          && epoch === targetEpochRef.current
          && targetRequest.isCurrent()
        ) {
          setFactsPending(false);
        }
      }
    }
  }, [factsPage, factsTargetKey, projectId, targetGuard, targetKey, threadId]);

  const jumpToReplyTarget = useCallback(async (target: TranscriptReplyReference) => {
    if (!threadId) return;
    if (messageRefs.current.has(target.messageId)) {
      setLocateMessageId(target.messageId);
      return;
    }
    if (factRequestInFlightRef.current) return;
    const visiblePage = factsTargetKey === targetKey ? factsPage : null;
    let cursor = visiblePage?.nextAfter ?? null;
    if (cursor === null) return;
    const epoch = targetEpochRef.current;
    const request = targetGuard.capture();
    const requestId = factRequestRef.current + 1;
    factRequestRef.current = requestId;
    factRequestInFlightRef.current = true;
    setFactsPending(true);
    setFactsError(null);
    setReplyJumpMessageId(target.messageId);
    let merged = visiblePage?.items ?? [];
    let found = false;
    try {
      while (cursor !== null) {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(
            threadId,
          )}/facts?after=${cursor}`,
          { signal: request.signal },
        );
        const payload = await readApiResponse<unknown>(
          response,
          "无法加载协作事实，请稍后重试。",
        );
        const nextPage = parseFactPage(payload, projectId, threadId);
        if (
          !mountedRef.current
          || epoch !== targetEpochRef.current
          || requestId !== factRequestRef.current
          || !request.isCurrent()
        ) return;
        const result = mergeThreadFacts(merged, nextPage.items);
        merged = result.items;
        cursor = nextPage.nextAfter;
        if (result.added > 0) setFactsStatus(`已加载 ${result.added} 条事实`);
        setFactsPage({ items: merged, nextAfter: cursor });
        if (
          merged.some(
            (fact) => fact.messageId === target.messageId && fact.message !== null,
          )
        ) {
          found = true;
          break;
        }
      }
      setReplyJumpMessageId(null);
      if (found) setLocateMessageId(target.messageId);
    } catch (cause) {
      if (
        mountedRef.current
        && epoch === targetEpochRef.current
        && requestId === factRequestRef.current
        && request.isCurrent()
      ) {
        setReplyJumpMessageId(null);
        setFactsError(caughtApiErrorCopy(cause, "无法加载协作事实，请稍后重试。"));
      }
    } finally {
      if (requestId === factRequestRef.current) {
        factRequestInFlightRef.current = false;
        if (
          mountedRef.current
          && epoch === targetEpochRef.current
          && request.isCurrent()
        ) {
          setFactsPending(false);
        }
      }
    }
  }, [factsPage, factsTargetKey, projectId, targetGuard, targetKey, threadId]);

  useEffect(() => {
    if (!locateMessageId) return;
    const node = messageRefs.current.get(locateMessageId);
    if (!node) return;
    node.scrollIntoView({ block: "nearest" });
    node.focus();
    setHighlightMessageId(locateMessageId);
    setLocateMessageId(null);
  }, [locateMessageId, factsPage]);

  useEffect(() => {
    if (!highlightMessageId) return;
    const timer = window.setTimeout(() => setHighlightMessageId(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [highlightMessageId]);

  useEffect(() => {
    if (loading || loadError) return;
    const interval = window.setInterval(() => {
      if (
        factsTargetKey === targetKey
        && factsPage?.nextAfter === null
      ) {
        void readNextFacts("poll");
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [
    factsPage?.nextAfter,
    factsTargetKey,
    loadError,
    loading,
    readNextFacts,
    targetKey,
  ]);

  useEffect(() => {
    if (!scrollAfterRenderRef.current) return;
    scrollAfterRenderRef.current = false;
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [factsPage?.items.length, state?.timelinePage.items.length]);

  useEffect(() => {
    if (!focusMessageId) return;
    messageRefs.current.get(focusMessageId)?.focus();
    setFocusMessageId(null);
  }, [focusMessageId, state]);

  useEffect(() => {
    if (decisionSuccess) decisionSuccessRef.current?.focus();
  }, [decisionSuccess]);

  useEffect(() => {
    if (
      focusRunId
      && runSelection?.selectedRun?.id === focusRunId
      && !loading
    ) {
      runHeadingRef.current?.focus();
      setFocusRunId(null);
    }
  }, [focusRunId, loading, runSelection?.selectedRun?.id]);

  useEffect(() => {
    if (state?.run && !members && !membersLoading) void loadMembers();
  }, [members, membersLoading, state?.run]);

  const advance = useCallback(async (retryOperationId?: string) => {
    const currentRun = state?.run;
    if (
      !currentRun
      || currentRun.status !== "running"
      || advanceInFlightRef.current
      || !mountedRef.current
    ) return;
    const logicalOperationId = retryOperationId ?? operationId();
    const request = targetGuard.capture();
    advanceOperationIdRef.current = logicalOperationId;
    advanceInFlightRef.current = true;
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(
          threadId!,
        )}/runs/${encodeURIComponent(currentRun.id)}/advance`,
        {
        body: JSON.stringify({ operationId: logicalOperationId }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: request.signal,
        },
      );
      const result = await readApiResponse<{ run?: CollaborationReadResponse["run"] }>(
        response,
        "无法推进协作，请稍后重试。",
      );
      if (
        result.run
        && (
          result.run.projectId !== projectId
          || result.run.id !== currentRun.id
          || ("threadId" in result.run && result.run.threadId !== threadId)
        )
      ) throw new Error("Invalid run advance tuple.");
      if (!request.isCurrent()) return;
      advanceOperationIdRef.current = null;
      if (result.run) {
        setState((current) => current ? { ...current, run: result.run ?? current.run } : current);
      }
      setAdvanceError(null);
      await loadCollaboration();
      if (request.isCurrent()) setAdvanceCycle((cycle) => cycle + 1);
    } catch (cause) {
      if (request.isCurrent()) {
        setAdvanceError(caughtApiErrorCopy(cause, "无法推进协作，请稍后重试。"));
      }
    } finally {
      if (request.isCurrent()) advanceInFlightRef.current = false;
    }
  }, [loadCollaboration, projectId, state?.run, targetGuard, threadId]);

  useEffect(() => {
    if (startOnly || state?.run?.status !== "running" || advanceError) return;
    const timer = window.setTimeout(() => {
      void advance();
    }, advanceCycle === 0 ? 0 : POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [advance, advanceCycle, advanceError, startOnly, state?.run?.status]);

  async function loadMembers() {
    if (members || membersLoading) return;
    setMembersLoading(true);
    setMembersError(null);
    const request = targetGuard.capture();
    try {
      const response = await fetch(`/api/projects/${projectId}/members`, {
        signal: request.signal,
      });
      const payload = await readApiResponse<MembershipState>(
        response,
        "无法加载项目成员，请稍后重试。",
      );
      if (request.isCurrent()) {
        setMembers(payload.members);
        setActiveMemberIndex(0);
      }
    } catch (cause) {
      if (request.isCurrent()) {
        setMembersError(caughtApiErrorCopy(cause, "无法加载项目成员，请稍后重试。"));
      }
    } finally {
      if (request.isCurrent()) setMembersLoading(false);
    }
  }

  function openMentionPicker() {
    setMentionOpen(true);
    setActiveMemberIndex(0);
    void loadMembers();
  }

  function selectMember(member: ProjectMember) {
    setSelectedMember(member);
    setMentionOpen(false);
    setMembersError(null);
    mentionButtonRef.current?.focus();
  }

  function handleMentionKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setMentionOpen(false);
      mentionButtonRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setMentionOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!mentionOpen) {
        openMentionPicker();
        return;
      }
      if (!members?.length) return;
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setActiveMemberIndex((current) => (current + offset + members.length) % members.length);
      return;
    }
    if (event.key === "Enter" && mentionOpen && members?.length) {
      event.preventDefault();
      selectMember(members[activeMemberIndex] ?? members[0]);
    }
  }

  function confirmedStart(
    payload: CollaborationReadResponse,
    receipt: {
      baselineMessageIds: string[];
      message: string;
      mentionAgentId?: string;
      operationId: string;
    },
    expected?: { messageId?: string; runId?: string },
  ): { message: ProjectMessage; run: CollaborationRun } | null {
    const run = payload.run;
    if (
      !run ||
      run.projectId !== projectId ||
      (expected?.runId !== undefined && run.id !== expected.runId)
    ) {
      return null;
    }
    const ownerMessages = payload.projectMessagesPage.items.filter(
      (message) =>
        message.authorType === "owner" &&
        message.runId === run.id &&
        (expected?.messageId !== undefined ||
          (message.content === receipt.message &&
            message.mentionAgentId === (receipt.mentionAgentId ?? null))) &&
        !receipt.baselineMessageIds.includes(message.id) &&
        (expected?.messageId === undefined || message.id === expected.messageId),
    );
    if (ownerMessages.length !== 1) return null;
    const ownerMessage = ownerMessages[0];
    const hasRunStarted = payload.timelinePage.items.some(
      (event) =>
        event.type === "run_started" &&
        event.runId === run.id &&
        event.payload.messageId === ownerMessage.id,
    );
    const hasOwnerMessage = payload.timelinePage.items.some(
      (event) =>
        event.type === "owner_message" &&
        event.runId === run.id &&
        event.payload.messageId === ownerMessage.id,
    );
    return hasRunStarted && hasOwnerMessage
      ? { message: ownerMessage, run }
      : null;
  }

  async function reconcileStart(
    receipt: {
      baselineMessageIds: string[];
      message: string;
      mentionAgentId?: string;
      operationId: string;
    },
    expected?: { messageId?: string; runId?: string },
  ): Promise<boolean> {
    const request = targetGuard.capture();
    try {
      if (!threadId) return false;
      let resolvedExpected = expected;
      if (!resolvedExpected?.runId) {
        const lookupResponse = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(
            threadId,
          )}/operations/${encodeURIComponent(receipt.operationId)}`,
          { signal: request.signal },
        );
        if (!lookupResponse.ok) return false;
        const lookup = await readJson<unknown>(lookupResponse);
        if (
          !exactKeys(lookup, [
            "httpStatus",
            "kind",
            "operationId",
            "response",
            "status",
          ]) ||
          lookup.operationId !== receipt.operationId ||
          lookup.kind !== "start" ||
          lookup.status !== "completed" ||
          lookup.httpStatus !== 201
        ) {
          return false;
        }
        const ids = mutationIds(lookup.response, "start", projectId, threadId);
        if (!ids?.runId) return false;
        resolvedExpected = { messageId: ids.messageId, runId: ids.runId };
      }
      const targetRunId =
        resolvedExpected.runId ?? onboardingSelectedRunIdRef.current;
      const result = await readOnboardingThread(
        projectId,
        threadId,
        targetRunId,
        request.signal,
        true,
      );
      if (!request.isCurrent()) return false;
      if (
        parseCollaborationGuideEnvelope(
          result.envelope,
          projectId,
          threadId,
          targetRunId,
        ).kind === "invalid"
      ) {
        return false;
      }
      const payload = result.state;
      const confirmed = confirmedStart(payload, receipt, resolvedExpected);
      if (!confirmed) return false;
      onboardingSelectedRunIdRef.current = confirmed.run.id;
      applyRead(payload, true);
      setFactsPage(result.envelope.factsPage);
      setFactsTargetKey(targetKey);
      setDraft("");
      setSelectedMember(null);
      setFocusMessageId(confirmed.message.id);
      setSendError(null);
      setStartReceipt(null);
      const notice = "协作已启动；目标已受理，但尚未执行、复核或交付。";
      setStartNotice(notice);
      startNoticeAfterNavigationRef.current = notice;
      const url = new URL(window.location.href);
      url.searchParams.set("thread", threadId);
      url.searchParams.set("run", confirmed.run.id);
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}?${url.searchParams.toString()}`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
      onGoalFactChanged?.();
      return true;
    } catch {
      return false;
    }
  }

  async function startCollaboration(
    message: string,
    logicalOperationId: string,
    mentionAgentId?: string,
    existingReceipt?: {
      baselineMessageIds: string[];
      message: string;
      mentionAgentId?: string;
      operationId: string;
    },
  ) {
    const request = targetGuard.capture();
    const receipt = existingReceipt ?? {
      baselineMessageIds:
        state?.projectMessagesPage.items.map((item) => item.id) ?? [],
      message,
      mentionAgentId,
      operationId: logicalOperationId,
    };
    setSending(true);
    setSendError(null);
    setStartNotice("");
    setStartReceipt(null);
    let responseReceived = false;
    try {
      if (!threadId) throw new Error("thread tuple required");
      const response = await fetch(
        `/api/projects/${projectId}/threads/${threadId}/runs`,
        {
        body: JSON.stringify({
          message,
          ...(mentionAgentId ? { mentionAgentId } : {}),
          operationId: logicalOperationId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: request.signal,
        },
      );
      responseReceived = true;
      const result = await readApiResponse<unknown>(
        response,
        "无法启动协作，请稍后重试。",
      );
      const ids = mutationIds(result, "start", projectId, threadId);
      if (!request.isCurrent()) return;
      const reconciled = await reconcileStart(
        receipt,
        ids?.runId
          ? { messageId: ids.messageId, runId: ids.runId }
          : undefined,
      );
      if (reconciled) return;
    } catch (cause) {
      if (!request.isCurrent()) return;
      if (responseReceived && cause instanceof ApiDisplayError) {
        setSendError(caughtApiErrorCopy(cause, "无法启动协作，请稍后重试。"));
        return;
      }
      if (await reconcileStart(receipt)) return;
    } finally {
      if (request.isCurrent()) setSending(false);
    }
    if (!request.isCurrent()) return;
    setStartReceipt(receipt);
    setSendError(
      `无法唯一确认协作是否已启动。operation receipt：${logicalOperationId}。请仅重新核对，或明确选择使用同一 receipt 重试；不会自动重发。`,
    );
  }

  async function retryStartReconciliation() {
    if (!startReceipt || sending) return;
    const request = targetGuard.capture();
    setSending(true);
    setSendError(null);
    const reconciled = await reconcileStart(startReceipt);
    if (!request.isCurrent()) return;
    if (!reconciled) {
      setSendError(
        `仍无法唯一确认协作是否已启动。operation receipt：${startReceipt.operationId}。不会自动重发。`,
      );
    }
    setSending(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    const length = Array.from(message).length;
    if (length < 1 || length > 10_000) {
      setFieldError("请输入 1 至 10000 个字符。");
      return;
    }
    if (sending) return;
    const selectedTerminalRun = Boolean(
      runSelection?.selectedRun
      && terminalRunStatuses.has(runSelection.selectedRun.status),
    );
    const firstRunAvailable = Boolean(
      runSelection
      && runSelection.runs.length === 0
      && !runSelection.activeRun,
    );
    if (
      !state?.run
      && !selectedTerminalRun
      && !firstRunAvailable
      && !activeRunInOtherThread
    ) return;
    setFieldError(null);
    const hasActiveRun = Boolean(
      state?.run && activeRunStatuses.has(state.run.status),
    );
    if (activeRunInOtherThread) {
      await submitActiveMessage({
        baselineMessageIds:
          state?.projectMessagesPage.items.map((item) => item.id) ?? [],
        mentionAgentId: selectedMember?.agentId,
        message,
        operationId: operationId(),
        runId: null,
      });
      return;
    }
    if (!hasActiveRun) {
      await startCollaboration(
        message,
        operationId(),
        selectedMember?.agentId,
      );
      return;
    }
    const receipt: CollaborationWriteReceipt = {
      baselineMessageIds:
        state?.projectMessagesPage.items.map((item) => item.id) ?? [],
      mentionAgentId: selectedMember?.agentId,
      message,
      operationId: operationId(),
      runId: state!.run!.id,
    };
    await submitActiveMessage(receipt);
  }

  async function reconcileActiveMessage(
    receipt: CollaborationWriteReceipt,
    expectedMessageId?: string,
  ): Promise<boolean> {
    const request = targetGuard.capture();
    try {
      if (!threadId) return false;
      let resolvedMessageId = expectedMessageId;
      if (!resolvedMessageId) {
        const lookupResponse = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(
            threadId,
          )}/operations/${encodeURIComponent(receipt.operationId)}`,
          { signal: request.signal },
        );
        if (!lookupResponse.ok) return false;
        const lookup = await readJson<unknown>(lookupResponse);
        if (
          !exactKeys(lookup, [
            "httpStatus",
            "kind",
            "operationId",
            "response",
            "status",
          ]) ||
          lookup.operationId !== receipt.operationId ||
          lookup.kind !== "message" ||
          lookup.status !== "completed" ||
          lookup.httpStatus !== 201
        ) {
          return false;
        }
        const ids = mutationIds(lookup.response, "message", projectId, threadId);
        if (!ids) return false;
        resolvedMessageId = ids.messageId;
      }
      const result = await readOnboardingThread(
        projectId,
        threadId,
        receipt.runId,
        request.signal,
        true,
      );
      if (!request.isCurrent()) return false;
      if (
        parseCollaborationGuideEnvelope(
          result.envelope,
          projectId,
          threadId,
          receipt.runId,
        ).kind === "invalid"
      ) {
        return false;
      }
      const payload = result.state;
      if ((payload.run?.id ?? null) !== receipt.runId) return false;
      const matches = result.envelope.messagesPage.items.filter(
        (candidate) =>
          candidate.authorType === "owner" &&
          (candidate.runId === null || candidate.runId === receipt.runId) &&
          candidate.content === receipt.message &&
          candidate.mentionAgentId === (receipt.mentionAgentId ?? null) &&
          !receipt.baselineMessageIds.includes(candidate.id) &&
          candidate.id === resolvedMessageId,
      );
      if (matches.length !== 1) return false;
      const linkedFacts = result.envelope.factsPage.items.filter(
        (fact) =>
          fact.type === "owner_message" &&
          fact.messageId === matches[0].id &&
          fact.runId === matches[0].runId,
      );
      if (linkedFacts.length !== 1) return false;
      applyRead(payload, true);
      setFactsPage(result.envelope.factsPage);
      setFactsTargetKey(targetKey);
      setDraft("");
      setSelectedMember(null);
      setFocusMessageId(matches[0].id);
      setMessageReceipt(null);
      setSendError(null);
      setStartNotice("已通过事实核对确认消息已发送。");
      setAdvanceError(null);
      setAdvanceCycle((cycle) => cycle + 1);
      return true;
    } catch {
      return false;
    }
  }

  async function submitActiveMessage(receipt: CollaborationWriteReceipt) {
    const request = targetGuard.capture();
    setSendError(null);
    setStartNotice("");
    setMessageReceipt(null);
    setSending(true);
    let responseReceived = false;
    try {
      if (!threadId) throw new Error("thread tuple required");
      const response = await fetch(
        `/api/projects/${projectId}/threads/${threadId}/messages`,
        {
        body: JSON.stringify({
          content: receipt.message,
          ...(receipt.mentionAgentId
            ? { mentionAgentId: receipt.mentionAgentId }
            : {}),
          operationId: receipt.operationId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: request.signal,
        },
      );
      responseReceived = true;
      const result = await readApiResponse<unknown>(
        response,
        "无法发送消息，请稍后重试。",
      );
      const ids = mutationIds(result, "message", projectId, threadId);
      if (!request.isCurrent()) return;
      if (await reconcileActiveMessage(receipt, ids?.messageId)) return;
    } catch (cause) {
      if (!request.isCurrent()) return;
      if (responseReceived && cause instanceof ApiDisplayError) {
        setSendError(caughtApiErrorCopy(cause, "无法发送消息，请稍后重试。"));
        return;
      }
      if (await reconcileActiveMessage(receipt)) return;
    } finally {
      if (request.isCurrent()) setSending(false);
    }
    if (!request.isCurrent()) return;
    setMessageReceipt(receipt);
    setSendError(
      `无法唯一确认消息是否已发送。operation receipt：${receipt.operationId}。请仅重新核对，或由用户明确重新提交；不会自动重发。`,
    );
  }

  async function retryMessageReconciliation() {
    if (!messageReceipt || sending) return;
    const request = targetGuard.capture();
    setSending(true);
    setSendError(null);
    const reconciled = await reconcileActiveMessage(messageReceipt);
    if (!request.isCurrent()) return;
    if (!reconciled) {
      setSendError(
        `仍无法唯一确认消息是否已发送。operation receipt：${messageReceipt.operationId}。不会自动重发。`,
      );
    }
    setSending(false);
  }

  const visibleFacts = factsTargetKey === targetKey ? factsPage?.items ?? [] : [];
  const renderedFacts = visibleFacts.filter(
    (fact) =>
      fact.type !== "run_event"
      || (fact.payload.eventType !== "owner_message"
        && fact.payload.eventType !== "agent_message"),
  );
  const transcript = reduceTranscript({
    currentTargetKey: targetKey,
    pages: [{ items: renderedFacts }],
    targetKey,
  });
  const loadedMessageIds = new Set(
    transcript.kind === "ready"
      ? transcript.entries.flatMap((entry) => entry.messageId ? [entry.messageId] : [])
      : [],
  );
  const factsExhausted = factsTargetKey === targetKey && factsPage?.nextAfter === null;
  const currentMember = members?.find(
    (member) => member.agentId === state?.run?.currentAgentId,
  );
  const showChat = surface === "all" || surface === "chat";
  const showRun = surface === "all" || surface === "run";
  const activeRunInOtherThread = Boolean(
    runSelection?.activeRun
    && runSelection.activeRun.threadId !== threadId,
  );
  const selectedTerminalRun = Boolean(
    runSelection?.selectedRun
    && terminalRunStatuses.has(runSelection.selectedRun.status),
  );
  const canStartFirstRun = Boolean(
    runSelection
    && runSelection.runs.length === 0
    && !runSelection.activeRun,
  );
  const canSubmitMessage = Boolean(
    state?.run || selectedTerminalRun || canStartFirstRun || activeRunInOtherThread,
  );

  function navigateToRun(nextThreadId: string, nextRunId: string | null) {
    const href = canonicalRunHref(projectId, nextThreadId, nextRunId);
    setRunNavigationPending(true);
    setRunSelectionNotice("正在切换运行…");
    if (nextRunId) setFocusRunId(nextRunId);
    window.history.pushState(window.history.state, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  return (
    <section aria-labelledby="collaboration-title" className="stack">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">平等协作</p>
          <h3 id="collaboration-title">项目群聊</h3>
        </div>
        {state?.run ? (
          <div
            className="baton"
            data-accent={currentMember?.accentToken}
          >
            <span
              aria-label={`${currentMember?.name ?? state.run.currentAgentId} 的头像`}
              className="agent-avatar"
            >
              {currentMember?.avatarText ?? "A"}
            </span>
            <span>
              <span className="eyebrow">当前持棒</span>
              <strong>{currentMember?.name ?? state.run.currentAgentId}</strong>
            </span>
          </div>
        ) : null}
      </div>

      {showRun ? (
        <section
          aria-labelledby={`run-selection-title-${projectId}`}
          className="run-detail"
        >
          <div className="panel-heading">
            <h3 id={`run-selection-title-${projectId}`}>运行选择</h3>
            {runSelection?.selectedRun ? (
              <span className="status-label">{runSelection.selectedRun.status}</span>
            ) : null}
          </div>
          {loading ? (
            <p aria-busy="true" className="muted">正在加载运行列表…</p>
          ) : loadError ? (
            <div
              aria-label="运行加载失败"
              className="stack"
              role="region"
            >
              <p className="error-text">{loadError}</p>
              <button
                onClick={() => setReloadKey((value) => value + 1)}
                type="button"
              >
                重试加载运行
              </button>
            </div>
          ) : runSelection ? (
            <>
              <div className="form-field">
                <label htmlFor={`thread-run-selection-${projectId}`}>
                  选择线程运行
                </label>
                <select
                  disabled={runNavigationPending || runSelection.runs.length === 0}
                  id={`thread-run-selection-${projectId}`}
                  onChange={(event) => {
                    if (!threadId) return;
                    navigateToRun(threadId, event.target.value || null);
                  }}
                  value={selectedRunId ?? ""}
                >
                  <option value="">不选择运行</option>
                  {runSelection.runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {runChoiceLabel(run)}
                    </option>
                  ))}
                </select>
              </div>
              {runNavigationPending ? (
                <p aria-busy="true" className="muted">正在切换运行…</p>
              ) : null}
              {runSelection.runs.length === 0 ? (
                <div className="empty-guide">
                  <p>尚无运行。发送首条消息以开始首次运行。</p>
                  <button
                    onClick={() => {
                      const composer = document.getElementById(
                        `collaboration-message-${projectId}`,
                      );
                      if (composer instanceof HTMLElement) composer.focus();
                      else onRequestChat?.();
                    }}
                    type="button"
                  >
                    撰写首条消息
                  </button>
                </div>
              ) : null}
              {runSelection.selectedRun ? (
                <div className="stack">
                  <h4 ref={runHeadingRef} tabIndex={-1}>
                    运行 {runSelection.selectedRun.id}
                  </h4>
                  <p>
                    {runChoiceLabel(runSelection.selectedRun)}
                  </p>
                  {terminalRunStatuses.has(runSelection.selectedRun.status) ? (
                    <p className="muted">
                      本轮已结束。发送新目标将开始新一轮，不会改变历史运行。
                    </p>
                  ) : (
                    <p className="muted">本轮仍可继续，不会自动开始新一轮。</p>
                  )}
                </div>
              ) : null}
              {activeRunInOtherThread && runSelection.activeRun ? (
                <div className="state-message">
                  <p>
                    项目活动运行属于另一线程；切换只查看该运行，不会暂停、停止或修改它。
                  </p>
                  <a
                    aria-label={`返回活动线程 ${runSelection.activeRun.runId}`}
                    href={canonicalRunHref(
                      projectId,
                      runSelection.activeRun.threadId,
                      runSelection.activeRun.runId,
                    )}
                    onClick={(event) => {
                      event.preventDefault();
                      navigateToRun(
                        runSelection.activeRun!.threadId,
                        runSelection.activeRun!.runId,
                      );
                    }}
                  >
                    返回活动线程
                  </a>
                </div>
              ) : null}
            </>
          ) : null}
          <p
            aria-atomic="true"
            aria-label="运行选择状态"
            aria-live="polite"
            className="sr-only"
            role="status"
          >
            {runSelectionNotice}
          </p>
        </section>
      ) : null}

      {loading ? (
        <p aria-busy="true" className="state-message">
          正在加载项目群聊…
        </p>
      ) : loadError ? (
        <div className="state-message">
          <p className="error-text" role="alert">
            {loadError}
          </p>
          <button onClick={() => setReloadKey((value) => value + 1)} type="button">
            重试加载群聊
          </button>
        </div>
      ) : (
        <>
          {showRun && state?.pendingDecision ? (
            <DecisionPanel
              key={`${targetKey}|decision|${state.pendingDecision.id}`}
              decision={state.pendingDecision}
              members={members ?? []}
              onAnswered={(result) => {
                setState((current) =>
                  current
                    ? {
                        ...current,
                        pendingDecision: null,
                        run: result.run,
                      }
                    : current,
                );
                setDecisionSuccess(true);
                setAdvanceError(null);
                setAdvanceCycle((cycle) => cycle + 1);
              }}
              projectId={projectId}
              threadId={threadId!}
            />
          ) : null}
          {showRun && decisionSuccess ? (
            <p
              className="state-message"
              ref={decisionSuccessRef}
              tabIndex={-1}
            >
              回答已提交，协作将继续。
            </p>
          ) : null}
          {showRun && state?.run ? (
            <div className="run-details">
              <p className="state-message" role="status">
                运行状态：{state.run.status}
              </p>
              <RunControls
                key={`${targetKey}|controls`}
                modalBackgroundRef={modalBackgroundRef}
                onModalChange={onNestedModalChange}
                onRunChanged={(updatedRun) => {
                  setState((current) =>
                    current ? { ...current, run: updatedRun } : current,
                  );
                  setAdvanceError(null);
                  setAdvanceCycle((cycle) => cycle + 1);
                }}
                projectId={projectId}
                run={state.run}
                threadId={threadId!}
              />
              <UsagePanel
                members={members ?? []}
                run={state.run}
                usage={state.usage}
              />
            </div>
          ) : showRun ? (
            <section aria-label="运行控制" className="run-detail" role="region">
              <div className="panel-heading">
                <h3>运行控制</h3>
                <span className="status-label">未选择</span>
              </div>
              <div className="control-actions">
                {["暂停", "继续", "重试", "停止"].map((label) => (
                  <button disabled key={label} type="button">{label}</button>
                ))}
              </div>
              <p className="muted">
                请先明确选择此线程的一次运行；不会自动使用项目最新运行。
              </p>
            </section>
          ) : null}
          {showChat && state && transcript.kind === "invalid" ? (
            <p className="error-text state-message" role="alert">
              {transcript.message}
            </p>
          ) : showChat && state && transcript.kind === "ready" && transcript.entries.length ? (
            <>
            <div
              aria-busy={factsPending}
              aria-label="协作时间线"
              className="collaboration-timeline"
              onScroll={(event) => {
                const log = event.currentTarget;
                atBottomRef.current =
                  log.scrollHeight - log.scrollTop - log.clientHeight <= 24;
                if (atBottomRef.current) setNewEventCount(0);
              }}
              ref={logRef}
              role="log"
              tabIndex={0}
            >
              <ol
                className="timeline"
              >
              {transcript.entries.map((entry) => {
                const replyTo = entry.replyTo;
                return (
                  <li
                    className={
                      entry.messageId && entry.messageId === highlightMessageId
                        ? "timeline-item timeline-event reply-target-highlight"
                        : "timeline-item timeline-event"
                    }
                    key={entry.factId}
                    ref={(node) => {
                      if (!entry.messageId) return;
                      if (node) messageRefs.current.set(entry.messageId, node);
                      else messageRefs.current.delete(entry.messageId);
                    }}
                    tabIndex={entry.messageId ? -1 : undefined}
                  >
                    <div className="timeline-event-heading">
                      <h4>{entry.heading}</h4>
                      <time dateTime={entry.createdAt}>{readableTime(entry.createdAt)}</time>
                    </div>
                    <p className="muted">{entry.actorLabel}</p>
                    {entry.mention ? (
                      <span className="mention-chip">
                        @{entry.mention.displayName}
                        {entry.mention.memberStatus === "left" ? (
                          <span className="status-label">已离组</span>
                        ) : null}
                      </span>
                    ) : null}
                    {replyTo ? (
                      !loadedMessageIds.has(replyTo.messageId) && factsExhausted ? (
                        <button
                          aria-disabled="true"
                          aria-label="来源消息不可用，无法跳转：目标消息不在当前可读取的协作历史中。"
                          className="reply-chip reply-chip-unavailable"
                          onClick={(event) => event.preventDefault()}
                          type="button"
                        >
                          来源消息不可用
                        </button>
                      ) : (
                        <button
                          aria-disabled={replyJumpMessageId !== null || undefined}
                          aria-label={
                            replyJumpMessageId === replyTo.messageId
                              ? "正在定位来源消息…"
                              : `跳转到来源消息：#${replyTo.sequence} · ${replyTo.authorDisplayName} · ${replyTo.excerpt}`
                          }
                          className="reply-chip"
                          onClick={() => void jumpToReplyTarget(replyTo)}
                          type="button"
                        >
                          {replyJumpMessageId === replyTo.messageId
                            ? "正在定位来源消息…"
                            : `#${replyTo.sequence} · ${replyTo.authorDisplayName} · ${replyTo.excerpt}`}
                        </button>
                      )
                    ) : null}
                    {entry.text ? <p>{entry.text}</p> : null}
                    {entry.blocks.map((block) => (
                      <StructuredMessageBlock
                        block={block}
                        key={block.id}
                        targetKey={targetKey}
                      />
                    ))}
                  </li>
                );
              })}
              </ol>
            </div>
            {visibleFacts.length ? (
              <button
                disabled={factsPending || factsPage?.nextAfter === null}
                onClick={() => void readNextFacts("page")}
                type="button"
              >
                {factsPending
                  ? "正在加载更多事实…"
                  : factsPage?.nextAfter === null
                    ? "已加载全部事实"
                    : "加载更多事实"}
              </button>
            ) : null}
            {newEventCount > 0 ? (
              <button
                onClick={() => {
                  const log = logRef.current;
                  if (log) log.scrollTop = log.scrollHeight;
                  atBottomRef.current = true;
                  setNewEventCount(0);
                }}
                type="button"
              >
                查看新事件
              </button>
            ) : null}
            </>
          ) : showChat ? (
            <p className="state-message">尚无协作消息。请发送第一条消息。</p>
          ) : null}
          {showChat && factsError ? (
            <div className="state-message">
              <p className="error-text" role="alert">{factsError}</p>
              <button
                disabled={factsPending}
                onClick={() =>
                  void readNextFacts(factsPage?.nextAfter === null ? "poll" : "page")
                }
                type="button"
              >
                重试加载事实
              </button>
            </div>
          ) : null}
          {showChat ? (
            <p
              aria-atomic="true"
              aria-label="时间线更新摘要"
              aria-live="polite"
              className="sr-only"
              role="region"
            >
              {newEventCount > 0
                ? `有 ${newEventCount} 条新事件`
                : factsStatus}
            </p>
          ) : null}
          {showChat && advanceError ? (
            <div className="state-message">
              <p className="error-text" role="alert">{advanceError}</p>
              <button
                onClick={() => {
                  const retryId = advanceOperationIdRef.current;
                  if (retryId) void advance(retryId);
                }}
                type="button"
              >
                重试推进
              </button>
            </div>
          ) : null}
          {showChat ? (
          <form className="composer" onSubmit={handleSubmit}>
            <div className="form-field">
              <label htmlFor={`collaboration-message-${projectId}`}>发送给项目群聊</label>
              <textarea
                aria-describedby={fieldError ? fieldErrorId : undefined}
                aria-invalid={fieldError ? "true" : undefined}
                disabled={sending}
                id={`collaboration-message-${projectId}`}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (fieldError) setFieldError(null);
                }}
                value={draft}
              />
              {fieldError ? (
                <p className="error-text" id={fieldErrorId}>
                  {fieldError}
                </p>
              ) : null}
            </div>
            <div className="mention-picker">
              {selectedMember ? (
                <span className="mention-chip">
                  @{selectedMember.name}
                  <button
                    aria-label={`移除 @${selectedMember.name}`}
                    disabled={sending}
                    onClick={() => setSelectedMember(null)}
                    type="button"
                  >
                    移除
                  </button>
                </span>
              ) : null}
              <button
                aria-activedescendant={
                  mentionOpen && members?.[activeMemberIndex]
                    ? `${listboxId}-${members[activeMemberIndex].agentId}`
                    : undefined
                }
                aria-controls={listboxId}
                aria-expanded={mentionOpen}
                aria-haspopup="listbox"
                aria-label="@成员"
                disabled={sending}
                onClick={() => {
                  if (mentionOpen) setMentionOpen(false);
                  else openMentionPicker();
                }}
                onKeyDown={handleMentionKeyDown}
                ref={mentionButtonRef}
                role="combobox"
                type="button"
              >
                @成员
              </button>
              {mentionOpen ? (
                <div className="mention-options">
                  {membersLoading ? (
                    <p aria-busy="true" className="muted">
                      正在加载项目成员…
                    </p>
                  ) : membersError ? (
                    <div className="stack">
                      <p className="error-text" role="alert">
                        {membersError}
                      </p>
                      <button
                        onClick={() => {
                          setMembers(null);
                          void loadMembers();
                        }}
                        type="button"
                      >
                        重试加载成员
                      </button>
                    </div>
                  ) : members?.length ? (
                    <div aria-label="项目成员" id={listboxId} role="listbox">
                      {members.map((member, index) => (
                        <button
                          aria-selected={index === activeMemberIndex}
                          id={`${listboxId}-${member.agentId}`}
                          key={member.agentId}
                          onClick={() => selectMember(member)}
                          role="option"
                          type="button"
                        >
                          {member.avatarText} · {member.name} · {member.role}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">尚无可提及的项目成员。</p>
                  )}
                </div>
              ) : null}
            </div>
            <button
              disabled={!draft.trim() || sending || !canSubmitMessage}
              type="submit"
            >
              {sending
                ? "正在发送…"
                : activeRunInOtherThread
                  ? "发送消息"
                  : state?.run && activeRunStatuses.has(state.run.status)
                  ? "发送消息"
                  : selectedTerminalRun
                    ? "发送并开始新一轮"
                    : "发送并开始首次运行"}
            </button>
            {!canSubmitMessage || activeRunInOtherThread ? (
              <p className="muted">
                {activeRunInOtherThread
                  ? "另一线程有活动运行；可发送线程消息，但不能在此启动新一轮。"
                  : "请先选择历史运行，以继续查看或从已结束运行开始新一轮。"}
              </p>
            ) : null}
          </form>
          ) : null}
          {showChat && startNotice ? (
            <p className="onboarding-guide-success" role="status">
              {startNotice}
            </p>
          ) : null}
          {showChat && sendError ? (
            <div className="state-message stack">
              <p className="error-text" role="alert">
                {sendError}
              </p>
              {startReceipt ? (
                <div className="form-row">
                  <button
                    disabled={sending}
                    onClick={() => void retryStartReconciliation()}
                    type="button"
                  >
                    仅重新核对协作事实
                  </button>
                  <button
                    disabled={sending}
                    onClick={() =>
                      void startCollaboration(
                        startReceipt.message,
                        startReceipt.operationId,
                        startReceipt.mentionAgentId,
                        startReceipt,
                      )
                    }
                    type="button"
                  >
                    使用同一 operation receipt 明确重试启动
                  </button>
                </div>
              ) : null}
              {messageReceipt ? (
                <div className="form-row">
                  <button
                    disabled={sending}
                    onClick={() => void retryMessageReconciliation()}
                    type="button"
                  >
                    仅重新核对消息事实
                  </button>
                  <button
                    disabled={sending}
                    onClick={() => {
                      void submitActiveMessage(messageReceipt);
                    }}
                    type="button"
                  >
                    明确重新提交消息
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
