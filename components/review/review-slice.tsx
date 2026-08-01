"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ReviewWorkspaceDto } from "@/src/shared/review-contracts";

type ReviewSliceProps = {
  load?: () => Promise<ReviewWorkspaceDto>;
  start?: (input: {
    expectedHeadVersion: number;
    operationId: string;
    resultId: string;
    reviewerAgentId: string;
  }) => Promise<ReviewWorkspaceDto>;
  workItemId: string;
};

async function readJson(response: Response): Promise<ReviewWorkspaceDto> {
  if (!response.ok) throw new Error("复核工作区暂时不可用");
  return response.json() as Promise<ReviewWorkspaceDto>;
}

export function ReviewSlice({ load, start, workItemId }: ReviewSliceProps) {
  const [workspace, setWorkspace] = useState<ReviewWorkspaceDto | null>(null);
  const [selectedReviewerId, setSelectedReviewerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const decisionHeading = useRef<HTMLHeadingElement>(null);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = load
        ? await load()
        : await readJson(await fetch(`/api/work-items/${workItemId}/review`));
      setWorkspace(next);
    } catch {
      setError("无法加载复核工作区，请重试。");
    } finally {
      setLoading(false);
    }
  }, [load, workItemId]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  async function startSelectedReview() {
    if (!workspace || !selectedReviewerId) return;
    setSubmitting(true);
    setError(null);
    try {
      const input = {
        expectedHeadVersion: workspace.headVersion,
        operationId: crypto.randomUUID(),
        resultId: workspace.result.id,
        reviewerAgentId: selectedReviewerId,
      };
      const next = start
        ? await start(input)
        : await readJson(await fetch(`/api/work-items/${workItemId}/reviews`, {
          body: JSON.stringify(input),
          headers: { "content-type": "application/json" },
          method: "POST",
        }));
      setWorkspace(next);
      const reviewer = next.currentAttempt?.reviewer.name ?? "所选 Agent";
      setSuccess(`已由 ${reviewer} 完成独立复核。`);
      requestAnimationFrame(() => decisionHeading.current?.focus());
    } catch {
      setError("发起复核失败；已保留所选复核者，请重试。");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <p aria-busy="true">正在加载复核候选与材料…</p>;
  if (error && !workspace) {
    return (
      <section aria-label="复核工作区">
        <p className="error-text" role="alert">{error}</p>
        <button onClick={() => void loadWorkspace()} type="button">重试加载复核工作区</button>
      </section>
    );
  }
  if (!workspace) return <p>任务仍在执行或尚无已合入结果。</p>;

  const attempt = workspace.currentAttempt;
  const disabledReason = selectedReviewerId
    ? workspace.effectiveStatus !== "pending_review"
      ? "当前结果不处于待复核状态"
      : null
    : "请先明确选择一名复核者";

  return (
    <section aria-labelledby={`review-${workItemId}-title`} className="stack">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">独立复核</p>
          <h3 id={`review-${workItemId}-title`}>{workspace.workItem.title}</h3>
        </div>
        <span className="status-label">{workspace.effectiveStatus}</span>
      </div>

      <p>Result v{workspace.result.version} · 执行者 {workspace.result.executorAgentId}</p>
      {workspace.candidates.length === 0 ? (
        <p>缺少独立复核者。请为非执行者 Agent 开启复核能力。</p>
      ) : (
        <fieldset>
          <legend>选择具备复核能力的非执行者 Agent</legend>
          {workspace.candidates.map((candidate) => (
            <label key={candidate.agent.id}>
              <input
                checked={selectedReviewerId === candidate.agent.id}
                disabled={workspace.effectiveStatus !== "pending_review" || submitting}
                name={`reviewer-${workItemId}`}
                onChange={() => setSelectedReviewerId(candidate.agent.id)}
                type="radio"
                value={candidate.agent.id}
              />
              {candidate.agent.name} · {candidate.agent.role}
              <small> 当前成员 · 可复核 · 非执行者</small>
            </label>
          ))}
        </fieldset>
      )}

      <p id={`review-${workItemId}-disabled`}>{disabledReason}</p>
      <button
        aria-describedby={`review-${workItemId}-disabled`}
        disabled={disabledReason !== null || submitting}
        onClick={() => void startSelectedReview()}
        style={{ minHeight: "var(--control-min)" }}
        type="button"
      >
        {submitting ? "正在调用复核 Agent…" : "确认并发起真实复核"}
      </button>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {success ? <p aria-live="polite">{success}</p> : null}

      {attempt ? (
        <section aria-labelledby={`review-${attempt.id}-decision`} className="stack">
          <h4
            id={`review-${attempt.id}-decision`}
            ref={decisionHeading}
            tabIndex={-1}
          >
            {attempt.decision ? `唯一裁决：${attempt.decision.choice}` : "正在校验公开输出"}
          </h4>
          <dl className="execution-review-facts">
            <div><dt>复核者</dt><dd>{attempt.reviewer.name}</dd></div>
            <div><dt>Provider / Model</dt><dd>{attempt.provider.name} / {attempt.provider.model}</dd></div>
            <div><dt>冻结材料</dt><dd><code>{attempt.material.hash.slice(0, 12)}</code> · {attempt.material.sourceCount} refs</dd></div>
            <div><dt>调用</dt><dd>{attempt.calls[0]?.status ?? "calling"}</dd></div>
            <div><dt>Usage</dt><dd>{attempt.usageTotal.promptTokens} + {attempt.usageTotal.completionTokens} = {attempt.usageTotal.totalTokens}</dd></div>
            <div><dt>Choice</dt><dd>{attempt.decision?.choice ?? "尚无裁决"}</dd></div>
          </dl>
          {attempt.decision ? <p>{attempt.decision.publicSummary}</p> : null}
        </section>
      ) : null}
    </section>
  );
}
