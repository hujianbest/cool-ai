"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ReviewAttemptPanel,
} from "@/components/review/review-attempt-panel";
import {
  ReviewMaterialPanel,
  type ReviewMaterialView,
} from "@/components/review/review-material-panel";
import type {
  ReviewAttemptDto,
  ReviewWorkspaceDto,
} from "@/src/shared/review-contracts";

export type ReviewWorkspaceProps = {
  detail?: { attempt: ReviewAttemptDto; material: ReviewMaterialView };
  history?: ReviewAttemptDto[];
  load: () => Promise<ReviewWorkspaceDto>;
  onLocalFinalize: (
    attemptId: string,
    checkpointHash: string,
  ) => Promise<ReviewWorkspaceDto>;
  onNewProviderAttempt?: (attemptId: string) => Promise<ReviewWorkspaceDto>;
  operationDisabledReason?: string | null;
  workItemId: string;
};

export function ReviewWorkspace({
  detail,
  history = [],
  load,
  onLocalFinalize,
  onNewProviderAttempt,
  operationDisabledReason = null,
  workItemId,
}: ReviewWorkspaceProps) {
  const [workspace, setWorkspace] = useState<ReviewWorkspaceDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const decisionHeading = useRef<HTMLElement | null>(null);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setWorkspace(await load());
    } catch {
      setError("无法加载复核工作区，请重试。");
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  async function localFinalize(attemptId: string, checkpointHash: string) {
    setError(null);
    setSuccess(null);
    try {
      const next = await onLocalFinalize(attemptId, checkpointHash);
      setWorkspace(next);
      setSuccess("本地裁决提交成功；未再次调用模型。");
      requestAnimationFrame(() => {
        const heading = document.getElementById(
          `review-${attemptId}-workspace-title`,
        );
        decisionHeading.current = heading;
        heading?.focus();
      });
    } catch (caught) {
      setError("本地裁决提交失败；checkpoint 已保留，可继续本地提交。");
      throw caught;
    }
  }

  async function newProviderAttempt(attemptId: string) {
    if (!onNewProviderAttempt) return;
    setError(null);
    setSuccess(null);
    try {
      setWorkspace(await onNewProviderAttempt(attemptId));
      setSuccess("已创建新的复核 attempt，并发起模型调用。");
    } catch (caught) {
      setError("新复核发起失败，请确认状态后重试。");
      throw caught;
    }
  }

  if (loading && !workspace) {
    return <p aria-busy="true">正在加载复核工作区…</p>;
  }

  if (error && !workspace) {
    return (
      <section aria-label="复核工作区" className="stack">
        <p className="error-text" role="alert">{error}</p>
        <button
          onClick={() => void loadWorkspace()}
          style={{ minHeight: "var(--control-min)" }}
          type="button"
        >
          重试加载复核工作区
        </button>
      </section>
    );
  }

  if (!workspace) return <p>还没有复核 attempt。</p>;
  const currentAttempt = workspace.currentAttempt;
  const disabledReason = operationDisabledReason
    ?? (loading ? "正在刷新复核工作区" : null)
    ?? (error ? "请先恢复复核工作区读取" : null);

  return (
    <section aria-labelledby={`review-workspace-${workItemId}`} className="stack">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">桌面复核工作区</p>
          <h3 id={`review-workspace-${workItemId}`}>{workspace.workItem.title}</h3>
        </div>
        <span className="status-label">{workspace.effectiveStatus}</span>
      </div>
      <p>
        Result {workspace.result?.id ?? "尚无"} · v{workspace.result?.version ?? "—"}
        {" · 历史 "}{workspace.historyCount ?? history.length} 次
      </p>
      <button
        aria-busy={loading}
        onClick={() => void loadWorkspace()}
        style={{ minHeight: "var(--control-min)" }}
        type="button"
      >
        {loading ? "正在刷新复核工作区…" : "刷新复核工作区"}
      </button>

      {error ? (
        <div className="stack">
          <p className="error-text" role="alert">{error}</p>
          <button
            onClick={() => void loadWorkspace()}
            style={{ minHeight: "var(--control-min)" }}
            type="button"
          >
            重试加载复核工作区
          </button>
        </div>
      ) : null}
      {success ? <p aria-live="polite" role="status">{success}</p> : null}

      {currentAttempt ? (
        <ReviewAttemptPanel
          attempt={currentAttempt}
          onLocalFinalize={localFinalize}
          onNewProviderAttempt={onNewProviderAttempt ? newProviderAttempt : undefined}
          operationDisabledReason={disabledReason}
          surface="workspace"
        />
      ) : <p>还没有复核 attempt。</p>}

      {detail && detail.attempt.id === currentAttempt?.id ? (
        <section aria-labelledby={`review-${detail.attempt.id}-material`} className="stack">
          <h4 id={`review-${detail.attempt.id}-material`}>Attempt 详情材料</h4>
          <ReviewMaterialPanel material={detail.material} />
        </section>
      ) : null}

      {history.length > 0 ? (
        <section aria-labelledby={`review-${workItemId}-history`} className="stack">
          <h4 id={`review-${workItemId}-history`}>复核历史</h4>
          <ol>
            {history.map((attempt) => (
              <li key={attempt.id}>
                {attempt.id} · {attempt.status} · material {attempt.material.hash.slice(0, 12)}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </section>
  );
}
