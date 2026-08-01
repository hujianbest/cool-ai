"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ReviewWorkspaceDto } from "@/src/shared/review-contracts";

export {
  DeliveryPanel,
  type DeliveryPanelProps,
  type DeliveryVersionDto,
  type MissionCompletionDto,
} from "@/components/review/delivery-panel";
export {
  ReviewAttemptPanel,
  type ReviewAttemptPanelProps,
} from "@/components/review/review-attempt-panel";
export {
  ReviewAccessSurface,
  type ReviewAccessSurfaceKey,
  type ReviewAccessSurfaceProps,
  type ReviewAccessSurfaceState,
} from "@/components/review/review-access-surface";
export {
  ReviewMaterialPanel,
  type ReviewMaterialView,
  type ReviewPublicContent,
} from "@/components/review/review-material-panel";
export {
  ReviewMemoryAssociations,
  type ReviewMemoryAssociation,
  type ReviewMemoryAssociationsProps,
} from "@/components/review/review-memory-associations";
export {
  ReviewOutcomesPanel,
  type ReviewOutcomeAction,
  type ReviewOutcomesPanelProps,
} from "@/components/review/review-outcomes-panel";
export {
  ReviewWorkspace,
  type ReviewWorkspaceProps,
} from "@/components/review/review-workspace";

type EscalationAction = "continue_review" | "rework" | "terminate_mission";

type EscalationIssueProps = {
  disabledReason?: string | null;
  issue: null | {
    answer: null | { action: string; answer: string };
    id: string;
    options: string[];
    question: string;
  };
  loading?: boolean;
  onAnswer: (input: {
    action: EscalationAction;
    answer: string;
  }) => Promise<{ action: string; state: string }>;
};

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

const escalationSuccessTitle: Record<EscalationAction, string> = {
  continue_review: "已等待新复核",
  rework: "已进入返工",
  terminate_mission: "使命已终止",
};

export function EscalationIssue({
  disabledReason = null,
  issue,
  loading = false,
  onAnswer,
}: EscalationIssueProps) {
  const [answer, setAnswer] = useState("");
  const [action, setAction] = useState<EscalationAction | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedAction, setCompletedAction] = useState<EscalationAction | null>(
    issue?.answer?.action as EscalationAction | null ?? null,
  );
  const completedHeading = useRef<HTMLHeadingElement>(null);

  if (loading) return <p aria-busy="true">正在加载升级问题…</p>;
  if (!issue) return <p>尚无待 Owner 回答的升级问题。</p>;

  const formReason = disabledReason
    ?? (answer.trim().length === 0
      ? "请填写 Owner 回答"
      : action === ""
      ? "请选择继续复核、返工或终止使命"
      : null);

  async function submitAnswer() {
    if (!action || formReason) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onAnswer({ action, answer: answer.trim() });
      const nextAction = result.action as EscalationAction;
      setCompletedAction(nextAction);
      requestAnimationFrame(() => completedHeading.current?.focus());
    } catch {
      setError("提交失败；已保留 Owner 回答与处理动作，请重试。");
    } finally {
      setSubmitting(false);
    }
  }

  if (completedAction) {
    return (
      <section aria-labelledby={`escalation-${issue.id}-complete`} className="stack">
        <h4
          id={`escalation-${issue.id}-complete`}
          ref={completedHeading}
          tabIndex={-1}
        >
          {escalationSuccessTitle[completedAction]}
        </h4>
        <p aria-live="polite">Owner 回答已保存。</p>
        <p>原复核 attempt 与裁决保持只读；后续动作会创建新的链路事实。</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={`escalation-${issue.id}-title`} className="stack">
      <h4 id={`escalation-${issue.id}-title`}>等待 Owner 回答</h4>
      <p>{issue.question}</p>
      <ul>
        {issue.options.map((option) => <li key={option}>{option}</li>)}
      </ul>
      <label htmlFor={`escalation-${issue.id}-answer`}>Owner 回答</label>
      <textarea
        aria-describedby={`escalation-${issue.id}-reason`}
        disabled={Boolean(disabledReason) || submitting}
        id={`escalation-${issue.id}-answer`}
        onChange={(event) => setAnswer(event.target.value)}
        value={answer}
      />
      <fieldset disabled={Boolean(disabledReason) || submitting}>
        <legend>Owner 处理动作</legend>
        <label>
          <input
            checked={action === "continue_review"}
            name={`escalation-${issue.id}-action`}
            onChange={() => setAction("continue_review")}
            type="radio"
          />
          继续复核
        </label>
        <label>
          <input
            checked={action === "rework"}
            name={`escalation-${issue.id}-action`}
            onChange={() => setAction("rework")}
            type="radio"
          />
          返工
        </label>
        <label>
          <input
            checked={action === "terminate_mission"}
            name={`escalation-${issue.id}-action`}
            onChange={() => setAction("terminate_mission")}
            type="radio"
          />
          终止使命
        </label>
      </fieldset>
      <p id={`escalation-${issue.id}-reason`}>{formReason}</p>
      <button
        aria-describedby={`escalation-${issue.id}-reason`}
        disabled={formReason !== null || submitting}
        onClick={() => void submitAnswer()}
        style={{ minHeight: "var(--control-min)" }}
        type="button"
      >
        {submitting ? "正在提交 Owner 回答…" : "提交 Owner 回答"}
      </button>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </section>
  );
}
