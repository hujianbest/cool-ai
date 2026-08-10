"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import {
  ApiDisplayError,
  apiErrorCopy,
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";
import {
  approvalCenterItemDtoSchema,
  type ApprovalCenterDecisionHint,
  type ApprovalCenterDomain,
  type ApprovalCenterItemDto,
  type ApprovalCenterItemKind,
  type ApprovalCenterItemStatus,
  type ApprovalCenterSourceRef,
} from "@/src/shared/approval-center-contracts";
import type { ApiError } from "@/src/shared/contracts";

const DOMAIN_COPY: Record<ApprovalCenterDomain, string> = {
  execution: "执行",
  inline_decision: "内联决策",
};

const DOMAIN_VARIANT: Record<ApprovalCenterDomain, string> = {
  execution: "status-running",
  inline_decision: "status-queued",
};

const KIND_COPY: Record<ApprovalCenterItemKind, string> = {
  command: "命令",
  proposal: "Proposal",
  staged_merge: "Staged 合入",
};

const STATUS_COPY: Record<ApprovalCenterItemStatus, string> = {
  expired: "已过期",
  pending: "待裁决",
  replaced: "已被取代",
  revoked: "已撤销",
};

const STATUS_VARIANT: Record<ApprovalCenterItemStatus, string> = {
  expired: "status-failed",
  pending: "status-queued",
  replaced: "status-failed",
  revoked: "status-failed",
};

const HINT_COPY: Record<ApprovalCenterDecisionHint, string> = {
  expired: "请求已过期",
  replaced: "请求已被新请求取代",
  revoked: "请求已被撤销",
};

const LOAD_ERROR = "无法加载待裁决请求，请稍后重试。";
const INVALID_PAGE = "待裁决请求响应无效，请刷新后重试。";
const DECIDE_ERROR = "裁决未完成，请刷新后重试。";
const DECIDE_INVALID = "裁决所需的服务端数据无效，请刷新后重试。";

const pageSchema = z.object({
  approvals: z.array(approvalCenterItemDtoSchema),
}).strict();

type DecideAction = "approve" | "reject";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePage(payload: unknown): ApprovalCenterItemDto[] {
  const parsed = pageSchema.safeParse(payload);
  if (!parsed.success) throw new ApiDisplayError(INVALID_PAGE);
  return parsed.data.approvals;
}

function parseExecutionVersion(payload: unknown): number {
  if (!isRecord(payload) || !isRecord(payload.execution)) {
    throw new ApiDisplayError(DECIDE_INVALID);
  }
  const version = payload.execution.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new ApiDisplayError(DECIDE_INVALID);
  }
  return version;
}

function parseBlockStateVersion(payload: unknown): number {
  if (!isRecord(payload) || !isRecord(payload.block)) {
    throw new ApiDisplayError(DECIDE_INVALID);
  }
  const stateVersion = payload.block.stateVersion;
  if (
    typeof stateVersion !== "number"
    || !Number.isSafeInteger(stateVersion)
    || stateVersion < 1
  ) {
    throw new ApiDisplayError(DECIDE_INVALID);
  }
  return stateVersion;
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new ApiDisplayError(apiErrorCopy(payload as Partial<ApiError>, DECIDE_ERROR));
  }
  return payload;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new ApiDisplayError(apiErrorCopy(payload as Partial<ApiError>, DECIDE_ERROR));
  }
  return payload;
}

// 内联决策的来源定位没有跨面板消息焦点缝（018 的 messageRefs 是面板内部机制），
// 采用规范目标身份链接（canonicalRunHref 先例），runId 缺省时省略 run 参数。
function sourceThreadHref(projectId: string, sourceRef: ApprovalCenterSourceRef): string {
  const query = new URLSearchParams();
  query.set("thread", sourceRef.threadId ?? "");
  if (sourceRef.runId) query.set("run", sourceRef.runId);
  return `/projects/${encodeURIComponent(projectId)}?${query.toString()}`;
}

export function ApprovalCenterPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ApprovalCenterItemDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decisionErrors, setDecisionErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const epochRef = useRef(0);
  const silentRefreshRef = useRef(false);

  useEffect(() => {
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    const silent = silentRefreshRef.current;
    silentRefreshRef.current = false;
    if (!silent) {
      setIsLoading(true);
      setNotice(null);
      setDecisionErrors({});
    }
    setError(null);
    void fetch(`/api/projects/${projectId}/approvals/pending`, {
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
      .then((approvals) => {
        if (epochRef.current !== epoch) return;
        setItems(approvals);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || epochRef.current !== epoch) return;
        setItems([]);
        setError(caughtApiErrorCopy(cause, LOAD_ERROR));
      })
      .finally(() => {
        if (epochRef.current === epoch) setIsLoading(false);
      });
    return () => controller.abort();
  }, [projectId, reloadKey]);

  function refresh() {
    silentRefreshRef.current = true;
    setReloadKey((current) => current + 1);
  }

  // 裁决分派零新写路由：先经既有只读路由取当前版本（执行 detail 的
  // execution.version / 块路由的 block.stateVersion），再以乐观并发语义 POST
  // 既有裁决路由；GET→POST 间的漂移由既有 409 冲突语义兜底为脱敏错误。
  async function decide(item: ApprovalCenterItemDto, action: DecideAction) {
    if (decidingId !== null) return;
    const epoch = epochRef.current;
    setDecidingId(item.approvalId);
    setNotice(null);
    setDecisionErrors((current) => {
      const next = { ...current };
      delete next[item.approvalId];
      return next;
    });
    try {
      if (item.domain === "execution") {
        const executionId = item.sourceRef.executionId;
        if (!executionId) throw new ApiDisplayError(DECIDE_INVALID);
        const detail = await readJson(
          `/api/executions/${encodeURIComponent(executionId)}`,
        );
        const expectedVersion = parseExecutionVersion(detail);
        if (epochRef.current !== epoch) return;
        await postJson(
          `/api/executions/${encodeURIComponent(executionId)}/approvals/${encodeURIComponent(item.approvalId)}`,
          {
            action,
            expectedVersion,
            operationId: globalThis.crypto.randomUUID(),
          },
        );
      } else {
        const { messageId, runId, threadId } = item.sourceRef;
        if (!messageId || !threadId) throw new ApiDisplayError(DECIDE_INVALID);
        const blockUrl = `/api/projects/${encodeURIComponent(projectId)}`
          + `/threads/${encodeURIComponent(threadId)}`
          + `/runs/${encodeURIComponent(runId ?? "")}`
          + `/messages/${encodeURIComponent(messageId)}`
          + `/blocks/${encodeURIComponent(item.approvalId)}`;
        const block = await readJson(blockUrl);
        const expectedStateVersion = parseBlockStateVersion(block);
        if (epochRef.current !== epoch) return;
        await postJson(`${blockUrl}/decision`, {
          action: action === "approve" ? "accept" : "reject",
          expectedStateVersion,
          operationId: globalThis.crypto.randomUUID(),
        });
      }
      if (epochRef.current !== epoch) return;
      setNotice(action === "approve" ? "已批准，列表已刷新。" : "已拒绝，列表已刷新。");
      refresh();
    } catch (cause) {
      if (epochRef.current !== epoch) return;
      setDecisionErrors((current) => ({
        ...current,
        [item.approvalId]: caughtApiErrorCopy(cause, DECIDE_ERROR),
      }));
    } finally {
      if (epochRef.current === epoch) setDecidingId(null);
    }
  }

  // 与审计面板共用执行卡标题 id 焦点缝；目标卡超出渲染窗口或位于已关闭
  // 窄屏抽屉时焦点不生效，如实提示而不伪造跳转。
  function locateExecution(executionId: string) {
    const target = document.getElementById(`execution-${executionId}-title`);
    if (target) {
      target.scrollIntoView?.({ block: "nearest" });
      target.focus();
    }
    setNotice(
      target && document.activeElement === target
        ? "已定位到来源执行。"
        : "该执行未显示在运行详情列表中（仅展示最近的执行）。",
    );
  }

  return (
    <section
      aria-labelledby={`approval-center-title-${projectId}`}
      className="stack approval-center-panel"
    >
      <h2 id={`approval-center-title-${projectId}`}>审批</h2>
      {isLoading ? (
        <p aria-busy="true" className="state-message">
          正在加载待裁决请求…
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
            重试加载待裁决请求
          </button>
        </div>
      ) : (
        <>
          <div>
            <button onClick={refresh} type="button">
              刷新列表
            </button>
          </div>
          {items.length === 0 ? (
            <p className="state-message">没有待裁决的请求。</p>
          ) : (
            <ol
              aria-label="待裁决请求"
              className="stack approval-center-list"
            >
              {items.map((item) => {
                const displayTitle = item.title ?? KIND_COPY[item.kind];
                const decisionError = decisionErrors[item.approvalId];
                return (
                  <li className="task-summary stack" key={item.approvalId}>
                    <h3>{displayTitle}</h3>
                    <p>
                      <span className={`status-label ${DOMAIN_VARIANT[item.domain]}`}>
                        {DOMAIN_COPY[item.domain]}
                      </span>
                      {" "}
                      <span className={`status-label ${STATUS_VARIANT[item.status]}`}>
                        {STATUS_COPY[item.status]}
                      </span>
                    </p>
                    <p>
                      <span>{KIND_COPY[item.kind]}</span>
                      {" · "}
                      <time dateTime={item.createdAt}>{item.createdAt}</time>
                    </p>
                    {item.impactSummary ? <p>{item.impactSummary}</p> : null}
                    {item.decisionHint !== null ? (
                      <p className="error-text">
                        无法裁决：{HINT_COPY[item.decisionHint]}。
                      </p>
                    ) : (
                      <div className="approval-center-actions">
                        <button
                          aria-label={`批准 ${displayTitle}`}
                          disabled={decidingId === item.approvalId}
                          onClick={() => void decide(item, "approve")}
                          type="button"
                        >
                          批准
                        </button>
                        <button
                          aria-label={`拒绝 ${displayTitle}`}
                          disabled={decidingId === item.approvalId}
                          onClick={() => void decide(item, "reject")}
                          type="button"
                        >
                          拒绝
                        </button>
                      </div>
                    )}
                    {decisionError ? (
                      <p className="error-text" role="alert">
                        {decisionError}
                      </p>
                    ) : null}
                    <div className="approval-center-actions">
                      {item.sourceRef.executionId ? (
                        <button
                          onClick={() => locateExecution(item.sourceRef.executionId!)}
                          type="button"
                        >
                          定位来源执行
                        </button>
                      ) : null}
                      {item.sourceRef.threadId ? (
                        <a href={sourceThreadHref(projectId, item.sourceRef)}>
                          查看来源消息
                        </a>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
      {notice ? (
        <p aria-live="polite" className="muted" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
