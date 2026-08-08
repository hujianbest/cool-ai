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
import type {
  AnswerDecisionResponse,
  CollaborationApiError,
  CollaborationReadResponse,
  CollaborationRun,
  DecisionRequest,
  ProjectMessage,
  TimelineEvent,
  UsageTotals,
} from "@/src/shared/collaboration-contracts";
import { ApiDisplayError, apiErrorCopy, caughtApiErrorCopy } from "@/src/shared/api-error-copy";
import { parseCollaborationGuideEnvelope } from "@/src/shared/onboarding-guide-machine";
import type {
  MembershipState,
  ProjectMember,
} from "@/src/shared/project-context-contracts";

type CollaborationPanelProps = {
  projectId: string;
  surface?: "all" | "chat" | "run";
  modalBackgroundRef?: RefObject<HTMLElement | null>;
  onNestedModalChange?: (open: boolean) => void;
  onGoalFactChanged?: () => void;
  startOnly?: boolean;
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function readApiResponse<T>(response: Response, fallback: string): Promise<T> {
  const payload = await readJson<T & Partial<CollaborationApiError>>(response);
  if (!response.ok) {
    throw new ApiDisplayError(apiErrorCopy(payload, fallback));
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
  runId: string;
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
): { messageId: string; runId: string } | null {
  const keys = kind === "start" ? ["created", "message", "run"] : ["message", "run"];
  if (!exactKeys(value, keys)) return null;
  if (kind === "start" && typeof value.created !== "boolean") return null;
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
    "runId",
    "sequence",
  ])) return null;
  if (!exactKeys(value.run, [
    "createdAt",
    "currentAgentId",
    "id",
    "pauseCategory",
    "projectId",
    "roundCount",
    "status",
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
    value.message.runId === runId &&
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

function eventActor(event: TimelineEvent, members: ProjectMember[]): string {
  if (event.actorType === "owner") return "项目所有者";
  if (event.actorType === "system") return "系统";
  return members.find((member) => member.agentId === event.actorId)?.name
    ?? (event.type === "agent_message" ? event.payload.agentDisplayName : event.actorId)
    ?? "Agent";
}

function eventPresentation(
  event: TimelineEvent,
  messages: Map<string, ProjectMessage>,
): { detail: string | null; heading: string } {
  switch (event.type) {
    case "run_started":
      return { detail: null, heading: "协作已启动" };
    case "owner_message":
      return {
        detail: messages.get(event.payload.messageId)?.content ?? "所有者消息已记录",
        heading: "所有者发来消息",
      };
    case "agent_message":
      return {
        detail: messages.get(event.payload.messageId)?.content ?? "Agent 消息已记录",
        heading: "Agent 发来消息",
      };
    case "model_call_started":
      return { detail: null, heading: "正在调用模型" };
    case "model_call_succeeded":
      return { detail: null, heading: "模型调用已完成" };
    case "model_call_failed":
      return { detail: "可重试的调用状态已记录", heading: "模型调用失败" };
    case "usage_recorded":
      return { detail: null, heading: "模型用量已记录" };
    case "tasks_created":
      return { detail: null, heading: "任务已创建" };
    case "task_claimed":
      return { detail: null, heading: "任务已领取" };
    case "handoff":
      return { detail: event.payload.summary, heading: "协作棒已交接" };
    case "decision_requested":
      return { detail: null, heading: "等待所有者决策" };
    case "decision_answered":
      return { detail: null, heading: "所有者已回答决策" };
    case "boundary_paused":
      return { detail: null, heading: "协作已在边界暂停" };
    case "run_paused":
      return { detail: null, heading: "协作已暂停" };
    case "run_resumed":
      return { detail: null, heading: "协作已继续" };
    case "run_retried":
      return { detail: null, heading: "协作已重试" };
    case "run_planned":
      return { detail: null, heading: "协作计划已就绪" };
    case "run_stopped":
      return { detail: null, heading: "协作已停止" };
    case "attempt_interrupted":
      return { detail: null, heading: "本轮推进已中断" };
    case "action_rejected":
      return { detail: null, heading: "本轮动作未提交" };
    case "context_changed":
      return { detail: null, heading: "项目上下文已变化" };
  }
}

function readableTime(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

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
}: {
  decision: DecisionRequest;
  members: ProjectMember[];
  onAnswered: (result: AnswerDecisionResponse) => void;
}) {
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
    try {
      const response = await fetch(
        `/api/runs/${decision.runId}/decisions/${decision.id}/answer`,
        {
          body: JSON.stringify({
            answer,
            expectedVersion: decision.version,
            ...(mentionAgentId ? { mentionAgentId } : {}),
            operationId: operationId(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const result = await readApiResponse<AnswerDecisionResponse>(
        response,
        "无法提交回答，请稍后重试。",
      );
      onAnswered(result);
    } catch (cause) {
      setError(caughtApiErrorCopy(cause, "无法提交回答，请稍后重试。"));
    } finally {
      setSubmitting(false);
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
  run,
}: {
  modalBackgroundRef?: RefObject<HTMLElement | null>;
  onModalChange?: (open: boolean) => void;
  onRunChanged: (run: CollaborationRun) => void;
  run: CollaborationRun;
}) {
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
    try {
      const response = await fetch(`/api/runs/${run.id}/control`, {
        body: JSON.stringify({
          action,
          expectedVersion: run.version,
          operationId: operationId(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = await readApiResponse<{ run: CollaborationRun }>(
        response,
        "无法更新运行状态，请稍后重试。",
      );
      setConfirmStop(false);
      onRunChanged(result.run);
    } catch (cause) {
      setError(caughtApiErrorCopy(cause, "无法更新运行状态，请稍后重试。"));
    } finally {
      setPending(null);
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
  projectId,
  startOnly = false,
  surface = "all",
}: CollaborationPanelProps) {
  const [state, setState] = useState<CollaborationReadResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [activeMemberIndex, setActiveMemberIndex] = useState(0);
  const [selectedMember, setSelectedMember] = useState<ProjectMember | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [newEventCount, setNewEventCount] = useState(0);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [advanceCycle, setAdvanceCycle] = useState(0);
  const [decisionSuccess, setDecisionSuccess] = useState(false);
  const [startNotice, setStartNotice] = useState("");
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
  const atBottomRef = useRef(true);
  const scrollAfterRenderRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const messageAfterRef = useRef(0);
  const eventAfterRef = useRef(0);
  const advanceInFlightRef = useRef(false);
  const advanceOperationIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const listboxId = `collaboration-members-${projectId}`;
  const fieldErrorId = `collaboration-message-error-${projectId}`;

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

  const loadCollaboration = useCallback(async (showLoading = false) => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    if (showLoading) {
      setLoading(true);
      setLoadError(null);
      messageAfterRef.current = 0;
      eventAfterRef.current = 0;
    }
    try {
      let messageAfter = showLoading ? 0 : messageAfterRef.current;
      let eventAfter = showLoading ? 0 : eventAfterRef.current;
      let latest: CollaborationReadResponse | null = null;
      let messages: ProjectMessage[] = [];
      let events: TimelineEvent[] = [];
      let firstPage = true;
      while (firstPage || latest?.projectMessagesPage.nextAfter !== null
        || latest?.timelinePage.nextAfter !== null) {
        const query = new URLSearchParams();
        if (messageAfter > 0) query.set("messageAfter", String(messageAfter));
        if (eventAfter > 0) query.set("eventAfter", String(eventAfter));
        const suffix = query.size > 0 ? `?${query.toString()}` : "";
        const response = await fetch(
          `/api/projects/${projectId}/collaboration${suffix}`,
        );
        const payload = await readApiResponse<CollaborationReadResponse>(
          response,
          "无法加载项目群聊，请稍后重试。",
        );
        latest = payload;
        messages = mergeSequenced(messages, payload.projectMessagesPage.items);
        events = mergeSequenced(events, payload.timelinePage.items);
        messageAfter = Math.max(
          messageAfter,
          payload.projectMessagesPage.nextAfter ?? 0,
          ...payload.projectMessagesPage.items.map((item) => item.sequence),
        );
        eventAfter = Math.max(
          eventAfter,
          payload.timelinePage.nextAfter ?? 0,
          ...payload.timelinePage.items.map((item) => item.sequence),
        );
        firstPage = false;
      }
      if (latest && mountedRef.current) {
        messageAfterRef.current = messageAfter;
        eventAfterRef.current = eventAfter;
        applyRead(
          {
            ...latest,
            projectMessagesPage: { items: messages, nextAfter: null },
            timelinePage: { items: events, nextAfter: null },
          },
          showLoading,
        );
      }
    } catch (cause) {
      if (mountedRef.current && showLoading) {
        setLoadError(caughtApiErrorCopy(cause, "无法加载项目群聊，请稍后重试。"));
      }
    } finally {
      refreshInFlightRef.current = false;
      if (mountedRef.current && showLoading) setLoading(false);
    }
  }, [applyRead, projectId]);

  useEffect(() => {
    mountedRef.current = true;
    void loadCollaboration(true);
    return () => {
      mountedRef.current = false;
    };
  }, [loadCollaboration, reloadKey]);

  useEffect(() => {
    if (loading || loadError) return;
    const interval = window.setInterval(() => {
      void loadCollaboration();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadCollaboration, loadError, loading]);

  useEffect(() => {
    if (!scrollAfterRenderRef.current) return;
    scrollAfterRenderRef.current = false;
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state?.timelinePage.items.length]);

  useEffect(() => {
    if (!focusMessageId) return;
    messageRefs.current.get(focusMessageId)?.focus();
    setFocusMessageId(null);
  }, [focusMessageId, state]);

  useEffect(() => {
    if (decisionSuccess) decisionSuccessRef.current?.focus();
  }, [decisionSuccess]);

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
    advanceOperationIdRef.current = logicalOperationId;
    advanceInFlightRef.current = true;
    try {
      const response = await fetch(`/api/runs/${currentRun.id}/advance`, {
        body: JSON.stringify({ operationId: logicalOperationId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = await readApiResponse<{ run?: CollaborationReadResponse["run"] }>(
        response,
        "无法推进协作，请稍后重试。",
      );
      advanceOperationIdRef.current = null;
      if (result.run && mountedRef.current) {
        setState((current) => current ? { ...current, run: result.run ?? current.run } : current);
      }
      if (mountedRef.current) setAdvanceError(null);
      await loadCollaboration();
      if (mountedRef.current) setAdvanceCycle((cycle) => cycle + 1);
    } catch (cause) {
      if (mountedRef.current) {
        setAdvanceError(caughtApiErrorCopy(cause, "无法推进协作，请稍后重试。"));
      }
    } finally {
      advanceInFlightRef.current = false;
    }
  }, [loadCollaboration, state?.run]);

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
    try {
      const response = await fetch(`/api/projects/${projectId}/members`);
      const payload = await readApiResponse<MembershipState>(
        response,
        "无法加载项目成员，请稍后重试。",
      );
      setMembers(payload.members);
      setActiveMemberIndex(0);
    } catch (cause) {
      setMembersError(caughtApiErrorCopy(cause, "无法加载项目成员，请稍后重试。"));
    } finally {
      setMembersLoading(false);
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
    },
    expected?: { messageId?: string; runId?: string },
  ): Promise<boolean> {
    try {
      const response = await fetch(`/api/projects/${projectId}/collaboration`);
      const raw = await readApiResponse<unknown>(
        response,
        "无法核对协作事实，请稍后重试。",
      );
      if (parseCollaborationGuideEnvelope(raw, projectId).kind === "invalid") {
        return false;
      }
      const payload = raw as CollaborationReadResponse;
      const confirmed = confirmedStart(payload, receipt, expected);
      if (!confirmed) return false;
      applyRead(payload, true);
      setDraft("");
      setSelectedMember(null);
      setFocusMessageId(confirmed.message.id);
      setSendError(null);
      setStartReceipt(null);
      setStartNotice(
        "协作已启动；目标已受理，但尚未执行、复核或交付。",
      );
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
      const response = await fetch(`/api/projects/${projectId}/runs`, {
        body: JSON.stringify({
          message,
          ...(mentionAgentId ? { mentionAgentId } : {}),
          operationId: logicalOperationId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      responseReceived = true;
      const result = await readApiResponse<unknown>(
        response,
        "无法启动协作，请稍后重试。",
      );
      const ids = mutationIds(result, "start");
      const reconciled = await reconcileStart(
        receipt,
        ids
          ? { messageId: ids.messageId, runId: ids.runId }
          : undefined,
      );
      if (reconciled) return;
    } catch (cause) {
      if (responseReceived && cause instanceof ApiDisplayError) {
        setSendError(caughtApiErrorCopy(cause, "无法启动协作，请稍后重试。"));
        return;
      }
      if (await reconcileStart(receipt)) return;
    } finally {
      setSending(false);
    }
    setStartReceipt(receipt);
    setSendError(
      `无法唯一确认协作是否已启动。operation receipt：${logicalOperationId}。请仅重新核对，或明确选择使用同一 receipt 重试；不会自动重发。`,
    );
  }

  async function retryStartReconciliation() {
    if (!startReceipt || sending) return;
    setSending(true);
    setSendError(null);
    const reconciled = await reconcileStart(startReceipt);
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
    setFieldError(null);
    const hasActiveRun = Boolean(
      state?.run && activeRunStatuses.has(state.run.status),
    );
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
    try {
      const response = await fetch(`/api/projects/${projectId}/collaboration`);
      const raw = await readApiResponse<unknown>(
        response,
        "无法核对消息事实，请稍后重试。",
      );
      if (parseCollaborationGuideEnvelope(raw, projectId).kind === "invalid") {
        return false;
      }
      const payload = raw as CollaborationReadResponse;
      if (payload.run?.id !== receipt.runId) return false;
      const matches = payload.projectMessagesPage.items.filter(
        (candidate) =>
          candidate.authorType === "owner" &&
          candidate.runId === receipt.runId &&
          candidate.content === receipt.message &&
          candidate.mentionAgentId === (receipt.mentionAgentId ?? null) &&
          !receipt.baselineMessageIds.includes(candidate.id) &&
          (expectedMessageId === undefined ||
            candidate.id === expectedMessageId),
      );
      if (matches.length !== 1) return false;
      const linkedEvents = payload.timelinePage.items.filter(
        (event) =>
          event.type === "owner_message" &&
          event.runId === receipt.runId &&
          event.payload.messageId === matches[0].id,
      );
      if (linkedEvents.length !== 1) return false;
      applyRead(payload, true);
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
    setSendError(null);
    setStartNotice("");
    setMessageReceipt(null);
    setSending(true);
    let responseReceived = false;
    try {
      const response = await fetch(`/api/projects/${projectId}/messages`, {
        body: JSON.stringify({
          content: receipt.message,
          ...(receipt.mentionAgentId
            ? { mentionAgentId: receipt.mentionAgentId }
            : {}),
          operationId: receipt.operationId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      responseReceived = true;
      const result = await readApiResponse<unknown>(
        response,
        "无法发送消息，请稍后重试。",
      );
      const ids = mutationIds(result, "message");
      if (await reconcileActiveMessage(receipt, ids?.messageId)) return;
    } catch (cause) {
      if (responseReceived && cause instanceof ApiDisplayError) {
        setSendError(caughtApiErrorCopy(cause, "无法发送消息，请稍后重试。"));
        return;
      }
      if (await reconcileActiveMessage(receipt)) return;
    } finally {
      setSending(false);
    }
    setMessageReceipt(receipt);
    setSendError(
      `无法唯一确认消息是否已发送。operation receipt：${receipt.operationId}。请仅重新核对，或由用户明确重新提交；不会自动重发。`,
    );
  }

  async function retryMessageReconciliation() {
    if (!messageReceipt || sending) return;
    setSending(true);
    setSendError(null);
    const reconciled = await reconcileActiveMessage(messageReceipt);
    if (!reconciled) {
      setSendError(
        `仍无法唯一确认消息是否已发送。operation receipt：${messageReceipt.operationId}。不会自动重发。`,
      );
    }
    setSending(false);
  }

  const timelineMessages = new Map(
    state?.projectMessagesPage.items.map((message) => [message.id, message]) ?? [],
  );
  const referencedMessageIds = new Set(
    state?.timelinePage.items.flatMap((item) =>
      item.type === "owner_message" || item.type === "agent_message"
        ? [item.payload.messageId]
        : [],
    ) ?? [],
  );
  const standaloneMessages = state?.projectMessagesPage.items.filter(
    (message) => !referencedMessageIds.has(message.id),
  ) ?? [];
  const currentMember = members?.find(
    (member) => member.agentId === state?.run?.currentAgentId,
  );
  const showChat = surface === "all" || surface === "chat";
  const showRun = surface === "all" || surface === "run";

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
                modalBackgroundRef={modalBackgroundRef}
                onModalChange={onNestedModalChange}
                onRunChanged={(updatedRun) => {
                  setState((current) =>
                    current ? { ...current, run: updatedRun } : current,
                  );
                  setAdvanceError(null);
                  setAdvanceCycle((cycle) => cycle + 1);
                }}
                run={state.run}
              />
              <UsagePanel
                members={members ?? []}
                run={state.run}
                usage={state.usage}
              />
            </div>
          ) : null}
          {showChat && state && (state.timelinePage.items.length || standaloneMessages.length) ? (
            <>
            <div
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
            >
              <ol
                className="timeline"
              >
              {state.timelinePage.items.map((item) => {
                const presentation = eventPresentation(item, timelineMessages);
                const messageId =
                  item.type === "owner_message" || item.type === "agent_message"
                    ? item.payload.messageId
                    : null;
                return (
                  <li
                    className="timeline-item timeline-event"
                    key={item.id}
                    ref={(node) => {
                      if (!messageId) return;
                      if (node) messageRefs.current.set(messageId, node);
                      else messageRefs.current.delete(messageId);
                    }}
                    tabIndex={messageId ? -1 : undefined}
                  >
                    <div className="timeline-event-heading">
                      <h4>{presentation.heading}</h4>
                      <time dateTime={item.createdAt}>{readableTime(item.createdAt)}</time>
                    </div>
                    <p className="muted">{eventActor(item, members ?? [])}</p>
                    {presentation.detail ? <p>{presentation.detail}</p> : null}
                  </li>
                );
              })}
              {standaloneMessages.map((message) => (
                <li
                  className="timeline-item timeline-event"
                  key={message.id}
                  ref={(node) => {
                    if (node) messageRefs.current.set(message.id, node);
                    else messageRefs.current.delete(message.id);
                  }}
                  tabIndex={-1}
                >
                  <div className="timeline-event-heading">
                    <h4>{message.authorType === "owner" ? "所有者发来消息" : "Agent 发来消息"}</h4>
                    <time dateTime={message.createdAt}>{readableTime(message.createdAt)}</time>
                  </div>
                  <strong>{message.authorDisplayName}</strong>
                  {message.mentionAgentId && message.mentionDisplayName ? (
                    <span className="mention-chip">
                      @{message.mentionDisplayName}
                      {message.mentionMemberStatus === "left" ? (
                        <span className="status-label">已离组</span>
                      ) : null}
                    </span>
                  ) : null}
                  <span>{message.content}</span>
                </li>
              ))}
              </ol>
            </div>
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
            <p className="state-message">尚无协作消息。</p>
          ) : null}
          {showChat ? (
            <p
              aria-atomic="true"
              aria-label="时间线更新摘要"
              aria-live="polite"
              className="sr-only"
              role="region"
            >
              {newEventCount > 0 ? `有 ${newEventCount} 条新事件` : ""}
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
            <button disabled={!draft.trim() || sending} type="submit">
              {sending
                ? "正在发送…"
                : state?.run && activeRunStatuses.has(state.run.status)
                  ? "发送消息"
                  : "发送并启动协作"}
            </button>
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
