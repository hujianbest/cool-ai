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

// Readable copy for the safe-execution audit event types, centralized so any
// future type not yet mapped degrades to its raw contract value (never blank).
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
};

const ACTOR_TYPE_COPY: Record<string, string> = {
  agent: "Agent",
  owner: "Owner",
  system: "系统",
};

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
              const executionId = event.executionId;
              return (
                <li className="task-summary stack" key={event.id}>
                  <h3>{auditEventTypeCopy(event.eventType)}</h3>
                  <p>
                    {actorCopy(event.actorType)}
                    {" · "}
                    <time dateTime={event.occurredAt}>{event.occurredAt}</time>
                  </p>
                  {executionId ? (
                    <button
                      onClick={() => locateExecution(executionId)}
                      type="button"
                    >
                      定位来源执行
                    </button>
                  ) : null}
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
