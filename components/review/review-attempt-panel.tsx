"use client";

import { useState } from "react";

import type { ReviewAttemptDto } from "@/src/shared/review-contracts";

export type ReviewAttemptPanelProps = {
  attempt: ReviewAttemptDto;
  onLocalFinalize?: (attemptId: string, checkpointHash: string) => Promise<unknown>;
  onNewProviderAttempt?: (attemptId: string) => Promise<unknown>;
  operationDisabledReason?: string | null;
  surface: "workspace" | "history" | "detail";
};

const surfaceCopy: Record<ReviewAttemptPanelProps["surface"], string> = {
  detail: "Attempt 详情",
  history: "历史 Attempt",
  workspace: "当前 Attempt",
};

function callUsage(call: ReviewAttemptDto["calls"][number]): string {
  return call.usage.reported
    ? `${call.usage.promptTokens} + ${call.usage.completionTokens} = ${call.usage.totalTokens} tokens`
    : "usage · 未报告";
}

export function ReviewAttemptPanel({
  attempt,
  onLocalFinalize,
  onNewProviderAttempt,
  operationDisabledReason = null,
  surface,
}: ReviewAttemptPanelProps) {
  const [submitting, setSubmitting] = useState<"local" | "provider" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finalize = attempt.finalize;
  const reasonId = `review-${attempt.id}-${surface}-operation-reason`;
  const checkpoint = finalize?.checkpoint;

  async function perform(
    kind: "local" | "provider",
    operation: (() => Promise<unknown>) | undefined,
  ) {
    if (!operation || operationDisabledReason) return;
    setSubmitting(kind);
    setError(null);
    try {
      await operation();
    } catch {
      setError(kind === "local"
        ? "本地裁决提交失败；checkpoint 已保留，可再次继续提交。"
        : "新复核发起失败；尚未形成新的裁决。");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <section aria-labelledby={`review-${attempt.id}-${surface}-title`} className="stack">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{surfaceCopy[surface]}</p>
          <h4 id={`review-${attempt.id}-${surface}-title`} tabIndex={-1}>
            {attempt.decision
              ? `唯一裁决：${attempt.decision.choice}`
              : attempt.status === "finalizing"
              ? "公开输出已保存，待提交"
              : "尚无裁决"}
          </h4>
        </div>
        <span className="status-label">{attempt.status}</span>
      </div>

      <dl className="execution-review-facts">
        <div><dt>复核者</dt><dd>{attempt.reviewer.name}</dd></div>
        <div>
          <dt>Provider / Model</dt>
          <dd>
            {attempt.provider.name} v{attempt.provider.version ?? "?"}
            {" / "}{attempt.provider.model}
          </dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd>{attempt.result?.id ?? "unknown"} · v{attempt.result?.version ?? attempt.material.resultVersion}</dd>
        </div>
        <div>
          <dt>冻结材料</dt>
          <dd><code>{attempt.material.hash.slice(0, 12)}</code> · {attempt.material.sourceCount} refs</dd>
        </div>
        {checkpoint ? (
          <div>
            <dt>Checkpoint</dt>
            <dd><code>{checkpoint.publicOutputHash.slice(0, 12)}</code> · {checkpoint.checkpointedAt}</dd>
          </div>
        ) : null}
      </dl>

      <section aria-labelledby={`review-${attempt.id}-${surface}-calls`} className="stack">
        <h5 id={`review-${attempt.id}-${surface}-calls`}>逐 call 记录</h5>
        {attempt.calls.length === 0 ? <p>调用记录尚未生成。</p> : (
          <ol>
            {attempt.calls.map((call, index) => (
              <li
                aria-label={`${call.kind ?? (index === 0 ? "primary" : "repair")} call ${call.callIndex ?? index + 1}`}
                className="stack"
                key={call.id}
              >
                <div className="panel-heading">
                  <strong>
                    {call.kind ?? (index === 0 ? "primary" : "repair")} · call {call.callIndex ?? index + 1}
                  </strong>
                  <span className="status-label">{call.status}</span>
                </div>
                <p>{callUsage(call)}</p>
                {call.failure ? (
                  <p>
                    failure · {call.failure.category} · {call.failure.apiErrorCode ?? "无公开错误码"}
                  </p>
                ) : (
                  <p>{call.status === "calling" ? "正在调用" : "failure · 无"}</p>
                )}
              </li>
            ))}
          </ol>
        )}
        <p>
          {attempt.usageTotal.reportedCalls} 次已报告 · {attempt.usageTotal.unreportedCalls ?? 0}
          {" 次未报告 · 合计 "}{attempt.usageTotal.totalTokens} tokens
        </p>
      </section>

      {attempt.decision ? <p>{attempt.decision.publicSummary}</p> : null}
      <p id={reasonId}>
        {operationDisabledReason
          ?? (finalize?.mode === "local-finalize-only"
            ? "仅继续本地提交、不调用模型"
            : finalize?.mode === "new-provider-attempt"
            ? "将创建新 attempt，并再次调用模型"
            : "当前状态没有可重试操作")}
      </p>
      {finalize?.mode === "local-finalize-only" ? (
        <button
          aria-describedby={reasonId}
          disabled={Boolean(operationDisabledReason) || submitting !== null || !onLocalFinalize}
          onClick={() => void perform(
            "local",
            checkpoint && onLocalFinalize
              ? () => onLocalFinalize(attempt.id, checkpoint.publicOutputHash)
              : undefined,
          )}
          style={{ minHeight: "var(--control-min)" }}
          type="button"
        >
          {submitting === "local" ? "正在继续本地提交…" : "继续提交裁决"}
        </button>
      ) : null}
      {finalize?.mode === "new-provider-attempt" ? (
        <button
          aria-describedby={reasonId}
          disabled={Boolean(operationDisabledReason) || submitting !== null || !onNewProviderAttempt}
          onClick={() => void perform(
            "provider",
            onNewProviderAttempt ? () => onNewProviderAttempt(attempt.id) : undefined,
          )}
          style={{ minHeight: "var(--control-min)" }}
          type="button"
        >
          {submitting === "provider" ? "正在发起新的模型调用…" : "重新发起复核"}
        </button>
      ) : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </section>
  );
}
