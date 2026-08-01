"use client";

import { useRef, useState } from "react";

import type { ReviewAttemptDto } from "@/src/shared/review-contracts";

export type ReviewOutcomeAction =
  | "continue_review"
  | "rework"
  | "terminate_mission";

export type ReviewOutcomesPanelProps = {
  attempts: ReviewAttemptDto[];
  currentResult: { id: string; version: number };
  disabledReason?: string | null;
  error?: string | null;
  escalation?: null | {
    answer: null | { action: string; answer: string };
    id: string;
    options: string[];
    question: string;
  };
  loading?: boolean;
  onAnswerEscalation: (input: {
    action: ReviewOutcomeAction;
    answer: string;
  }) => Promise<{
    action: ReviewOutcomeAction;
    attemptId?: string;
    state: string;
  }>;
  onReload?: () => void;
  onStartExecution?: (input: {
    resultId: string;
    sourceAttemptId: string;
  }) => Promise<{ executionId: string }>;
  workItemId: string;
};

const terminalStatuses = new Set<ReviewAttemptDto["status"]>([
  "discarded",
  "escalated",
  "failed",
  "interrupted",
  "passed",
  "rejected",
]);

function findingRequirement(finding: unknown): string | null {
  if (!finding || typeof finding !== "object") return null;
  const requirement = (finding as { requirement?: unknown }).requirement;
  return typeof requirement === "string" ? requirement : null;
}

function attemptState(
  attempt: ReviewAttemptDto,
  currentResult: ReviewOutcomesPanelProps["currentResult"],
): string {
  if (attempt.status === "finalizing") {
    return "finalizing · 公开输出已保存，尚未形成裁决";
  }
  if (attempt.status === "calling") {
    return "calling · 模型调用进行中，尚未形成裁决";
  }
  const terminal = terminalStatuses.has(attempt.status) ? "终态 · " : "";
  const decision = attempt.decision
    ? `唯一裁决：${attempt.decision.choice}`
    : "无裁决";
  const isCurrent = attempt.result?.id === currentResult.id
    && attempt.result.version === currentResult.version;
  return `${terminal}${attempt.status} · ${decision} · ${
    isCurrent ? "当前 result" : "历史 result（stale）"
  }`;
}

function escalationMessage(
  result: Awaited<ReturnType<ReviewOutcomesPanelProps["onAnswerEscalation"]>>,
): string {
  if (result.action === "continue_review") {
    return result.attemptId
      ? `已创建新复核 attempt ${result.attemptId}`
      : "已创建新复核 attempt";
  }
  if (result.action === "rework") {
    return "已进入返工；新 result 提交后会创建新 attempt";
  }
  return "使命已终止";
}

export function ReviewOutcomesPanel({
  attempts,
  currentResult,
  disabledReason = null,
  error = null,
  escalation = null,
  loading = false,
  onAnswerEscalation,
  onReload,
  onStartExecution,
  workItemId,
}: ReviewOutcomesPanelProps) {
  const [answer, setAnswer] = useState(escalation?.answer?.answer ?? "");
  const [action, setAction] = useState<ReviewOutcomeAction | "">(
    (escalation?.answer?.action as ReviewOutcomeAction | undefined) ?? "",
  );
  const [pending, setPending] = useState<"answer" | string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [executionCreated, setExecutionCreated] = useState(false);
  const outcomeHeading = useRef<HTMLHeadingElement>(null);

  if (loading) {
    return <p aria-busy="true">正在加载复核结果与历史…</p>;
  }

  if (error && attempts.length === 0 && !escalation) {
    return (
      <section aria-label="复核结果与历史加载失败" className="stack">
        <p className="error-text" role="alert">{error}</p>
        {onReload ? (
          <button
            onClick={onReload}
            style={{ minHeight: "var(--control-min)" }}
            type="button"
          >
            重试加载复核历史
          </button>
        ) : null}
      </section>
    );
  }

  const answerReason = disabledReason
    ?? (answer.trim().length === 0
      ? "请填写 Owner 回答"
      : action === ""
      ? "请选择继续复核、返工或终止使命"
      : null);

  async function submitEscalation() {
    if (!action || answerReason || pending) return;
    setPending("answer");
    setOperationError(null);
    setAnnouncement(null);
    try {
      const result = await onAnswerEscalation({
        action,
        answer: answer.trim(),
      });
      setAnnouncement(escalationMessage(result));
      requestAnimationFrame(() => outcomeHeading.current?.focus());
    } catch {
      setOperationError("提交失败；Owner 回答草稿与处理动作已保留，请重试。");
    } finally {
      setPending(null);
    }
  }

  async function startExecution(attempt: ReviewAttemptDto) {
    if (!attempt.result || !onStartExecution || disabledReason || pending) return;
    setPending(attempt.id);
    setOperationError(null);
    setAnnouncement(null);
    try {
      const result = await onStartExecution({
        resultId: attempt.result.id,
        sourceAttemptId: attempt.id,
      });
      setExecutionCreated(true);
      setAnnouncement(
        `已创建 execution ${result.executionId}；新 result 提交后将进入新 attempt。`,
      );
      requestAnimationFrame(() => outcomeHeading.current?.focus());
    } catch {
      setOperationError("新 execution 创建失败；退回要求仍保留，请重试。");
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby={`review-${workItemId}-outcomes`} className="stack">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">裁决与返工</p>
          <h4 id={`review-${workItemId}-outcomes`}>复核结果与逐 attempt 历史</h4>
        </div>
        <span className="status-label">{attempts.length} attempts</span>
      </div>

      {escalation && !escalation.answer ? (
        <section aria-labelledby={`escalation-${escalation.id}-title`} className="stack">
          <h5 id={`escalation-${escalation.id}-title`}>等待 Owner 回答</h5>
          <p>{escalation.question}</p>
          <ul>
            {escalation.options.map((option) => <li key={option}>{option}</li>)}
          </ul>
          <label htmlFor={`escalation-${escalation.id}-answer`}>Owner 回答</label>
          <textarea
            aria-describedby={`escalation-${escalation.id}-reason`}
            disabled={Boolean(disabledReason) || pending !== null}
            id={`escalation-${escalation.id}-answer`}
            onChange={(event) => setAnswer(event.target.value)}
            value={answer}
          />
          <fieldset disabled={Boolean(disabledReason) || pending !== null}>
            <legend>Owner 处理动作</legend>
            <label>
              <input
                checked={action === "continue_review"}
                name={`escalation-${escalation.id}-action`}
                onChange={() => setAction("continue_review")}
                type="radio"
              />
              继续复核
            </label>
            <label>
              <input
                checked={action === "rework"}
                name={`escalation-${escalation.id}-action`}
                onChange={() => setAction("rework")}
                type="radio"
              />
              返工
            </label>
            <label>
              <input
                checked={action === "terminate_mission"}
                name={`escalation-${escalation.id}-action`}
                onChange={() => setAction("terminate_mission")}
                type="radio"
              />
              终止使命
            </label>
          </fieldset>
          <p id={`escalation-${escalation.id}-reason`}>{answerReason}</p>
          <button
            aria-describedby={`escalation-${escalation.id}-reason`}
            disabled={answerReason !== null || pending !== null}
            onClick={() => void submitEscalation()}
            style={{ minHeight: "var(--control-min)" }}
            type="button"
          >
            {pending === "answer" ? "正在提交 Owner 回答…" : "提交 Owner 回答"}
          </button>
        </section>
      ) : escalation?.answer ? (
        <p>
          Owner 已回答：{escalation.answer.answer} · action {escalation.answer.action}
        </p>
      ) : null}

      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {operationError ? <p className="error-text" role="alert">{operationError}</p> : null}
      {announcement ? (
        <section className="stack">
          <h5 ref={outcomeHeading} tabIndex={-1}>
            {executionCreated ? "返工 execution 已创建" : "Owner 动作已保存"}
          </h5>
          <p aria-live="polite" role="status">{announcement}</p>
        </section>
      ) : null}

      {attempts.length === 0 ? <p>还没有复核 attempt 历史。</p> : (
        <ol>
          {attempts.map((attempt) => {
            const result = attempt.result;
            const requirements = (attempt.decision?.findings ?? [])
              .map(findingRequirement)
              .filter((value): value is string => value !== null);
            return (
              <li
                aria-label={`attempt ${attempt.id}`}
                className="stack"
                key={attempt.id}
              >
                <div className="panel-heading">
                  <strong>{attemptState(attempt, currentResult)}</strong>
                  <span className="status-label">{attempt.status}</span>
                </div>
                <div>
                  <a href={`/work-items/${workItemId}/reviews/${attempt.id}`}>
                    Attempt {attempt.id}
                  </a>
                  {result ? (
                    <>
                      {" · "}
                      <a href={`/work-items/${workItemId}/results/${result.id}?version=${result.version}`}>
                        Result {result.id} · v{result.version}
                      </a>
                    </>
                  ) : null}
                </div>
                {attempt.decision?.publicSummary ? (
                  <p>{attempt.decision.publicSummary}</p>
                ) : null}
                {requirements.length > 0 ? (
                  <section aria-label={`Attempt ${attempt.id} 退回要求`}>
                    <h6>退回要求</h6>
                    <ul>
                      {requirements.map((requirement) => (
                        <li key={requirement}>{requirement}</li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {attempt.decision?.choice === "reject" && result ? (
                  <>
                    <button
                      aria-describedby={!onStartExecution
                        ? `review-${attempt.id}-execution-reason`
                        : undefined}
                      disabled={
                        !onStartExecution
                        || Boolean(disabledReason)
                        || pending !== null
                      }
                      onClick={() => void startExecution(attempt)}
                      style={{ minHeight: "var(--control-min)" }}
                      type="button"
                    >
                      {pending === attempt.id
                        ? "正在创建新 execution…"
                        : "按退回要求开始新 execution"}
                    </button>
                    {!onStartExecution ? (
                      <p id={`review-${attempt.id}-execution-reason`}>
                        请从项目执行区开始返工 execution。
                      </p>
                    ) : null}
                  </>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
