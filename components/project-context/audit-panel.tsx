"use client";

import { useEffect, useRef, useState } from "react";

import {
  ApiDisplayError,
  apiErrorCopy,
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";
import type {
  AuditEventListItemDto,
  AuditProjectionFreshness,
  AuditProjectionFreshnessStatus,
  ProjectAuditEventsPageDto,
} from "@/src/shared/audit-contracts";
import type { ApiError } from "@/src/shared/contracts";

// Readable copy for the collaboration audit event types (feature 030
// selection, mirroring AUDITABLE_COLLABORATION_EVENT_TYPES server-side). The
// map doubles as the domain classifier: a type listed here renders the
// collaboration domain badge; anything else is a safe-execution event.
const COLLABORATION_EVENT_TYPE_COPY: Record<string, string> = {
  action_rejected: "动作已被拒绝",
  agent_message: "Agent 消息",
  boundary_paused: "运行已在边界暂停",
  context_changed: "上下文已变更",
  decision_answered: "决策已答复",
  decision_requested: "决策已请求",
  handoff: "已交棒",
  owner_message: "Owner 消息",
  run_paused: "运行已暂停",
  run_planned: "运行已规划",
  run_resumed: "运行已恢复",
  run_retried: "运行已重试",
  run_started: "运行已开始",
  run_stopped: "运行已停止",
  task_claimed: "任务已认领",
  tasks_created: "任务已创建",
  thread_deleted: "线程已移入回收站",
  thread_purged: "线程已永久删除",
  thread_restored: "线程已恢复",
};

// Readable copy for the mission-work audit event types (feature 035
// selection, mirroring AUDITABLE_MISSION_WORK_EVENT_TYPES server-side). The
// map doubles as the mission-domain classifier: the outbox sources write
// disjoint event-type sets, so a type listed here renders the task domain
// badge. 看板任务 names work items (the mission-board vocabulary) to keep
// them distinct from task-run 任务活动 events.
const MISSION_WORK_EVENT_TYPE_COPY: Record<string, string> = {
  mission_created: "使命已创建",
  task_completed: "任务已完成",
  task_created: "任务已创建",
  task_failed: "任务已失败",
  task_started: "任务已开始",
  work_item_created: "看板任务已创建",
  work_item_status_changed: "看板任务状态已变更",
};

// Readable copy for the project-workspace audit event types (feature 036
// selection, mirroring AUDITABLE_PROJECT_WORKSPACE_EVENT_TYPES server-side).
// The map doubles as the project-domain classifier. 验证政策 follows the
// validation-policy-panel vocabulary (修订/项).
const PROJECT_WORKSPACE_EVENT_TYPE_COPY: Record<string, string> = {
  member_joined: "成员已加入",
  member_removed: "成员已移除",
  project_created: "项目已创建",
  validation_policy_changed: "验证政策已变更",
  workspace_bound: "工作区已绑定",
  workspace_rebound: "工作区已改绑",
};

// Governance and safe-execution both emit approval_requested. Execution
// payloads always carry attemptNo while governance payloads never do, so that
// one collision is classified by payload shape; the remaining types are
// governance-only.
const GOVERNANCE_EVENT_TYPE_COPY: Record<string, string> = {
  approval_approved: "审批已批准",
  approval_consumed: "审批已消费",
  approval_expired: "审批已过期",
  approval_rejected: "审批已驳回",
  approval_requested: "审批已请求",
};

// Readable copy for the audit event types, centralized so any future type not
// yet mapped degrades to its raw contract value (never blank).
const EVENT_TYPE_COPY: Record<string, string> = {
  action_finished: "动作已完成",
  action_queued: "动作已排队",
  approval_decided: "审批已决定",
  approval_requested: "审批已请求",
  attempt_started: "尝试已开始",
  conflict_detected: "检测到冲突",
  control_applied: "控制操作已应用",
  execution_created: "执行已创建",
  merged: "执行已合入",
  stale_detected: "检测到上下文过期",
  status_changed: "状态已变更",
  tool_failed: "工具调用失败",
  tool_requested: "工具已请求",
  tool_succeeded: "工具调用成功",
  usage_recorded: "用量已记录",
  ...COLLABORATION_EVENT_TYPE_COPY,
  ...GOVERNANCE_EVENT_TYPE_COPY,
  ...MISSION_WORK_EVENT_TYPE_COPY,
  ...PROJECT_WORKSPACE_EVENT_TYPE_COPY,
};

const ACTOR_TYPE_COPY: Record<string, string> = {
  agent: "Agent",
  owner: "Owner",
  system: "系统",
};

type AuditEventDomain =
  | "collaboration"
  | "execution"
  | "governance"
  | "mission"
  | "project";

const DOMAIN_COPY: Record<AuditEventDomain, string> = {
  collaboration: "协作",
  execution: "执行",
  governance: "治理",
  mission: "任务",
  project: "项目",
};

// All variants are existing .status-label colors (approval-center precedent):
// no new visual language for the domain badge. 030 took queued (协作),
// running (执行), and 035 took completed (任务); the only remaining modifier
// status-failed is danger semantics and wrong for a neutral domain badge, so
// 项目 reuses the bare .status-label base ("" below — review-material /
// thread-policy panels already use the unmodified neutral label).
const DOMAIN_VARIANT: Record<AuditEventDomain, string> = {
  collaboration: "status-queued",
  execution: "status-running",
  governance: "",
  mission: "status-completed",
  project: "",
};

// Most outbox sources write disjoint closed event-type sets. The sole
// collision is approval_requested: safe-execution always includes attemptNo,
// while governance never does. Unlisted future types conservatively show 执行.
function eventDomain(event: AuditEventListItemDto): AuditEventDomain {
  const { eventType, payload } = event;
  if (eventType in COLLABORATION_EVENT_TYPE_COPY) return "collaboration";
  if (eventType in PROJECT_WORKSPACE_EVENT_TYPE_COPY) return "project";
  if (eventType in MISSION_WORK_EVENT_TYPE_COPY) return "mission";
  if (eventType === "approval_requested") {
    return Object.hasOwn(payload, "attemptNo") ? "execution" : "governance";
  }
  return eventType in GOVERNANCE_EVENT_TYPE_COPY ? "governance" : "execution";
}

const MESSAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent_message",
  "owner_message",
]);

// The server whitelist attaches messageExcerpt (already grapheme-truncated
// and credential-screened) only to message events; anything malformed or
// empty simply renders no excerpt.
function messageExcerpt(event: AuditEventListItemDto): string | null {
  if (!MESSAGE_EVENT_TYPES.has(event.eventType)) return null;
  const excerpt = event.payload.messageExcerpt;
  return typeof excerpt === "string" && excerpt !== "" ? excerpt : null;
}

// Collaboration locate uses the canonical target identity link
// (canonicalRunHref / approval-center precedent): the 018/022 message focus
// seam (messageRefs/jumpToReplyTarget) is panel-internal state with no URL
// entry, and the project selection route accepts only thread/run params, so
// message-level precision is not reachable from here — the link lands on the
// thread/run instead of faking a message jump. Malformed references render
// no link at all.
function collaborationSourceHref(
  projectId: string,
  payload: Record<string, unknown>,
): string | null {
  const threadId = payload.threadId;
  if (typeof threadId !== "string" || threadId === "") return null;
  const runId = payload.runId;
  const query = new URLSearchParams();
  query.set("thread", threadId);
  if (typeof runId === "string" && runId !== "") query.set("run", runId);
  return `/projects/${encodeURIComponent(projectId)}?${query.toString()}`;
}

// The server whitelist attaches the public title (already grapheme-truncated
// and credential-screened) to mission-work events; anything malformed or
// empty simply renders no excerpt, per the 030 excerpt precedent.
function missionWorkExcerpt(event: AuditEventListItemDto): string | null {
  const title = event.payload.title;
  return typeof title === "string" && title !== "" ? title : null;
}

// Mission-work locate uses the canonical resource identity route
// (/projects/{id}/{resource...}, the memory-source href precedent): the
// mission-board focus seam is panel-internal state with no URL entry (the 026
// focusWorkItemId mechanism), so the link lands on the honest
// source-reference page instead of faking an in-page jump. Work items resolve
// to the established tasks/{id} shape; missions and task runs follow the same
// catch-all convention. References are validated one by one in specificity
// order — the first strictly valid one wins, malformed entries are skipped,
// and a payload with no valid reference renders no link at all.
function missionWorkSourceHref(
  projectId: string,
  payload: Record<string, unknown>,
): { href: string; label: string } | null {
  const project = encodeURIComponent(projectId);
  const workItemId = payload.workItemId;
  if (typeof workItemId === "string" && workItemId !== "") {
    return {
      href: `/projects/${project}/tasks/${encodeURIComponent(workItemId)}`,
      label: "定位来源任务",
    };
  }
  const missionId = payload.missionId;
  if (typeof missionId === "string" && missionId !== "") {
    return {
      href: `/projects/${project}/missions/${encodeURIComponent(missionId)}`,
      label: "定位来源使命",
    };
  }
  const taskId = payload.taskId;
  if (typeof taskId === "string" && taskId !== "") {
    return {
      href: `/projects/${project}/task-runs/${encodeURIComponent(taskId)}`,
      label: "定位来源任务",
    };
  }
  return null;
}

function publicText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// The server whitelist attaches public, already grapheme-truncated and
// credential-screened fields to project-workspace events (030 excerpt
// precedent): project/workspace names, member display names, and the policy
// revision counters. Anything malformed or empty simply renders no excerpt.
function projectWorkspaceSummary(event: AuditEventListItemDto): string | null {
  const payload = event.payload;
  switch (event.eventType) {
    case "project_created":
      return publicText(payload.projectName);
    case "workspace_bound":
      return publicText(payload.workspaceName);
    case "workspace_rebound": {
      const workspaceName = publicText(payload.workspaceName);
      if (workspaceName === null) return null;
      const previous = publicText(payload.previousWorkspaceName);
      return previous === null ? workspaceName : `${previous} → ${workspaceName}`;
    }
    case "member_joined":
    case "member_removed":
      return publicText(payload.agentDisplayName);
    case "validation_policy_changed": {
      const { entryCount, revisionNo } = payload;
      if (
        typeof revisionNo !== "number"
        || !Number.isSafeInteger(revisionNo)
        || revisionNo < 1
        || typeof entryCount !== "number"
        || !Number.isSafeInteger(entryCount)
        || entryCount < 0
      ) {
        return null;
      }
      return `修订 #${revisionNo} · ${entryCount} 项`;
    }
    default:
      return null;
  }
}

const GOVERNANCE_KIND_COPY: Record<string, string> = {
  command: "命令",
  staged_merge: "Staged 合入",
};

const GOVERNANCE_DECISION_COPY: Record<string, string> = {
  approved: "已批准",
  rejected: "已驳回",
};

const GOVERNANCE_SCOPE_COPY: Record<string, string> = {
  execution: "执行",
  project: "项目",
  single: "单项",
};

// Governance summaries expose only validated enum values. Missing fields are
// skipped, while a present malformed/unknown field fails the whole summary
// closed so it cannot be mistaken for a complete approval description.
function governanceSummary(event: AuditEventListItemDto): string | null {
  const parts: string[] = [];
  for (const [key, copy] of [
    ["kind", GOVERNANCE_KIND_COPY],
    ["decision", GOVERNANCE_DECISION_COPY],
    ["scope", GOVERNANCE_SCOPE_COPY],
  ] as const) {
    if (!Object.hasOwn(event.payload, key)) continue;
    const value = event.payload[key];
    if (typeof value !== "string") return null;
    const label = copy[value];
    if (typeof label !== "string") return null;
    parts.push(label);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Project-workspace locate lands on the canonical project identity route
// (/projects/{projectId} renders the real ProjectPanel): the workspace,
// member, and policy surfaces are project-panel internal seams with no URL
// entry (018 message-focus precedent), and the audit API is already
// project-scoped, so the panel's own projectId prop is the canonical identity
// — no payload key is involved. A malformed identity renders no link at all.
function projectSourceHref(projectId: string): string | null {
  if (projectId === "") return null;
  return `/projects/${encodeURIComponent(projectId)}`;
}

// Governance locate lands on canonical execution/approval identity routes.
// References are validated independently so the most specific valid shape
// wins, with malformed values skipped rather than coerced.
function governanceSourceHref(
  projectId: string,
  payload: Record<string, unknown>,
): string | null {
  if (projectId === "") return null;
  const project = encodeURIComponent(projectId);
  const executionId = publicText(payload.executionId);
  const approvalId = publicText(payload.approvalId);
  if (executionId !== null && approvalId !== null) {
    return `/projects/${project}/executions/${encodeURIComponent(executionId)}/approvals/${encodeURIComponent(approvalId)}`;
  }
  if (executionId !== null) {
    return `/projects/${project}/executions/${encodeURIComponent(executionId)}`;
  }
  if (approvalId !== null) {
    return `/projects/${project}/approvals/${encodeURIComponent(approvalId)}`;
  }
  return null;
}

const FRESHNESS_COPY: Record<AuditProjectionFreshnessStatus, string> = {
  behind: "落后",
  caught_up: "已追平",
  rebuilding: "重建中",
};

const FRESHNESS_VARIANT: Record<AuditProjectionFreshnessStatus, string> = {
  behind: "status-queued",
  caught_up: "status-completed",
  rebuilding: "status-running",
};

const LOAD_ERROR = "无法加载审计事件，请稍后重试。";
const LOAD_MORE_ERROR = "无法加载更多审计事件，请稍后重试。";
const INVALID_PAGE = "审计事件响应无效，请刷新后重试。";

export function auditEventTypeCopy(eventType: string): string {
  return EVENT_TYPE_COPY[eventType] ?? eventType;
}

function actorCopy(actorType: string | null): string {
  if (actorType === null) return "未知";
  return ACTOR_TYPE_COPY[actorType] ?? actorType;
}

function freshnessCopy(freshness: AuditProjectionFreshness): string {
  return freshness.status === "behind"
    ? `${FRESHNESS_COPY.behind} ${freshness.lag} 条`
    : FRESHNESS_COPY[freshness.status];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuditEvent(value: unknown): AuditEventListItemDto {
  if (!isRecord(value)) throw new ApiDisplayError(INVALID_PAGE);
  const { actorType, eventType, executionId, id, occurredAt, outboxSeq, payload } =
    value;
  if (
    typeof id !== "string"
    || typeof eventType !== "string"
    || typeof occurredAt !== "string"
    || typeof outboxSeq !== "number"
    || !Number.isSafeInteger(outboxSeq)
    || (actorType !== null && typeof actorType !== "string")
    || (executionId !== null && typeof executionId !== "string")
    || !isRecord(payload)
  ) {
    throw new ApiDisplayError(INVALID_PAGE);
  }
  return {
    actorType: actorType as string | null,
    eventType,
    executionId: executionId as string | null,
    id,
    occurredAt,
    outboxSeq,
    payload,
  };
}

function parseFreshness(value: unknown): AuditProjectionFreshness {
  if (
    !isRecord(value)
    || (value.status !== "caught_up"
      && value.status !== "behind"
      && value.status !== "rebuilding")
    || typeof value.lag !== "number"
    || !Number.isSafeInteger(value.lag)
    || value.lag < 0
  ) {
    throw new ApiDisplayError(INVALID_PAGE);
  }
  return { lag: value.lag, status: value.status };
}

function parsePage(payload: unknown): ProjectAuditEventsPageDto {
  if (
    !isRecord(payload)
    || !Array.isArray(payload.events)
    || (payload.nextBeforeSeq !== null
      && (typeof payload.nextBeforeSeq !== "number"
        || !Number.isSafeInteger(payload.nextBeforeSeq)))
  ) {
    throw new ApiDisplayError(INVALID_PAGE);
  }
  return {
    events: payload.events.map(parseAuditEvent),
    freshness: parseFreshness(payload.freshness),
    nextBeforeSeq: payload.nextBeforeSeq,
  };
}

export function AuditPanel({ projectId }: { projectId: string }) {
  const [events, setEvents] = useState<AuditEventListItemDto[]>([]);
  const [freshness, setFreshness] = useState<AuditProjectionFreshness | null>(null);
  const [nextBeforeSeq, setNextBeforeSeq] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [locateMessage, setLocateMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const epochRef = useRef(0);

  useEffect(() => {
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    setLocateMessage(null);
    void fetch(`/api/projects/${projectId}/audit-events`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) {
          throw new ApiDisplayError(
            apiErrorCopy(payload as Partial<ApiError>, LOAD_ERROR),
          );
        }
        return parsePage(payload);
      })
      .then((page) => {
        if (epochRef.current !== epoch) return;
        setEvents(page.events);
        setFreshness(page.freshness);
        setNextBeforeSeq(page.nextBeforeSeq);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || epochRef.current !== epoch) return;
        setEvents([]);
        setFreshness(null);
        setNextBeforeSeq(null);
        setError(caughtApiErrorCopy(cause, LOAD_ERROR));
      })
      .finally(() => {
        if (epochRef.current === epoch) setIsLoading(false);
      });
    return () => controller.abort();
  }, [projectId, reloadKey]);

  async function loadMore() {
    if (nextBeforeSeq === null || isLoadingMore) return;
    const epoch = epochRef.current;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/audit-events?before=${nextBeforeSeq}`,
      );
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new ApiDisplayError(
          apiErrorCopy(payload as Partial<ApiError>, LOAD_MORE_ERROR),
        );
      }
      const page = parsePage(payload);
      if (epochRef.current !== epoch) return;
      setEvents((current) => [...current, ...page.events]);
      setFreshness(page.freshness);
      setNextBeforeSeq(page.nextBeforeSeq);
    } catch (cause: unknown) {
      if (epochRef.current === epoch) {
        setLoadMoreError(caughtApiErrorCopy(cause, LOAD_MORE_ERROR));
      }
    } finally {
      if (epochRef.current === epoch) setIsLoadingMore(false);
    }
  }

  // The execution detail card heading id seam is shared with the manual
  // recovery surface. A hidden card (outside the rendered window, or inside a
  // closed narrow drawer) cannot receive focus, so the panel verifies the
  // focus landing and reports honestly instead of faking a jump.
  function locateExecution(executionId: string) {
    const target = document.getElementById(`execution-${executionId}-title`);
    if (target) {
      target.scrollIntoView?.({ block: "nearest" });
      target.focus();
    }
    setLocateMessage(
      target && document.activeElement === target
        ? "已定位到来源执行。"
        : "该执行未显示在运行详情列表中（仅展示最近的执行）。",
    );
  }

  return (
    <section
      aria-labelledby={`audit-title-${projectId}`}
      className="stack audit-panel"
    >
      <h2 id={`audit-title-${projectId}`}>审计</h2>
      {freshness && !isLoading && !error ? (
        <p className="audit-freshness">
          <span
            className={`status-label ${FRESHNESS_VARIANT[freshness.status]}`}
          >
            {freshnessCopy(freshness)}
          </span>
        </p>
      ) : null}
      {isLoading ? (
        <p aria-busy="true" className="state-message">
          正在加载审计事件…
        </p>
      ) : error ? (
        <div className="state-message stack">
          <p className="error-text" role="alert">
            {error}
          </p>
          <button
            onClick={() => setReloadKey((current) => current + 1)}
            type="button"
          >
            重试加载审计事件
          </button>
        </div>
      ) : events.length === 0 ? (
        <p className="state-message">尚无审计事件。</p>
      ) : (
        <>
          <ol
            aria-busy={isLoadingMore || undefined}
            aria-label="审计事件"
            className="stack audit-event-list"
          >
            {events.map((event) => {
              const domain = eventDomain(event);
              const executionId = event.executionId;
              const excerpt = domain === "mission"
                ? missionWorkExcerpt(event)
                : domain === "project"
                  ? projectWorkspaceSummary(event)
                  : domain === "governance"
                    ? governanceSummary(event)
                    : messageExcerpt(event);
              const sourceHref = domain === "collaboration"
                ? collaborationSourceHref(projectId, event.payload)
                : null;
              const missionSource = domain === "mission"
                ? missionWorkSourceHref(projectId, event.payload)
                : null;
              const projectSource = domain === "project"
                ? projectSourceHref(projectId)
                : null;
              const governanceSource = domain === "governance"
                ? governanceSourceHref(projectId, event.payload)
                : null;
              const domainVariant = DOMAIN_VARIANT[domain];
              return (
                <li className="task-summary stack" key={event.id}>
                  <h3>{auditEventTypeCopy(event.eventType)}</h3>
                  <p>
                    <span
                      className={domainVariant
                        ? `status-label ${domainVariant}`
                        : "status-label"}
                    >
                      {DOMAIN_COPY[domain]}
                    </span>
                    {" "}
                    {actorCopy(event.actorType)}
                    {" · "}
                    <time dateTime={event.occurredAt}>{event.occurredAt}</time>
                  </p>
                  {excerpt ? (
                    <p className="audit-event-excerpt">{excerpt}</p>
                  ) : null}
                  {domain === "execution" && executionId ? (
                    <button
                      onClick={() => locateExecution(executionId)}
                      type="button"
                    >
                      定位来源执行
                    </button>
                  ) : null}
                  {sourceHref ? <a href={sourceHref}>定位来源线程</a> : null}
                  {missionSource
                    ? <a href={missionSource.href}>{missionSource.label}</a>
                    : null}
                  {projectSource
                    ? <a href={projectSource}>定位来源项目</a>
                    : null}
                  {governanceSource
                    ? <a href={governanceSource}>定位来源审批</a>
                    : null}
                </li>
              );
            })}
          </ol>
          {loadMoreError ? (
            <p className="error-text" role="alert">
              {loadMoreError}
            </p>
          ) : null}
          {nextBeforeSeq !== null ? (
            <button
              disabled={isLoadingMore}
              onClick={() => void loadMore()}
              type="button"
            >
              {isLoadingMore ? "正在加载更多审计事件…" : "加载更多审计事件"}
            </button>
          ) : null}
        </>
      )}
      {locateMessage ? (
        <p aria-live="polite" className="muted" role="status">
          {locateMessage}
        </p>
      ) : null}
    </section>
  );
}
