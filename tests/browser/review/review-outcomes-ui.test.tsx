import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import * as reviewComponents from "@/components/review/review-slice";
import type { ReviewAttemptDto } from "@/src/shared/review-contracts";

type OutcomeAction = "continue_review" | "rework" | "terminate_mission";
type ReviewOutcomesPanelProps = {
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
    action: OutcomeAction;
    answer: string;
  }) => Promise<{ action: OutcomeAction; attemptId?: string; state: string }>;
  onReload?: () => void;
  onStartExecution: (input: {
    resultId: string;
    sourceAttemptId: string;
  }) => Promise<{ executionId: string }>;
  workItemId: string;
};

const optionalComponents = reviewComponents as typeof reviewComponents & {
  ReviewOutcomesPanel?: React.ComponentType<ReviewOutcomesPanelProps>;
};

function ReviewOutcomesPanel(props: ReviewOutcomesPanelProps) {
  const Component = optionalComponents.ReviewOutcomesPanel;
  expect(Component, "T-20 outcomes panel must exist").toBeTypeOf("function");
  return <Component {...props} />;
}

const NOW = "2026-08-01T08:00:00.000Z";
const HASH = "a".repeat(64);

function attempt(
  id: string,
  status: ReviewAttemptDto["status"],
  resultId: string,
  version: number,
  choice: "reject" | "escalate" | "pass" | null,
): ReviewAttemptDto {
  const finalize: ReviewAttemptDto["finalize"] = status === "failed"
    || status === "interrupted"
    ? {
        checkpoint: null,
        lastErrorCode: "PROVIDER_TIMEOUT",
        mode: "new-provider-attempt",
        retryRequiresProvider: true,
      }
    : {
        checkpoint: {
          checkpointedAt: NOW,
          publicOutputHash: HASH,
        },
        lastErrorCode: null,
        mode: "none",
        retryRequiresProvider: false,
      };
  return {
    calls: [],
    decision: choice ? {
      choice,
      findings: choice === "reject"
        ? [{ requirement: "补齐失败路径测试", severity: "blocking" }]
        : [],
      id: `decision-${id}`,
      publicSummary: choice === "reject"
        ? "需要补齐失败路径后重新执行。"
        : choice === "escalate"
        ? "需要 Owner 决定后续动作。"
        : "结果满足要求。",
    } : null,
    errorCategory: status === "failed" ? "provider" : null,
    finalize,
    finishedAt: ["calling", "finalizing"].includes(status) ? null : NOW,
    id,
    material: { hash: HASH, resultVersion: version, sourceCount: 3 },
    provider: { id: "provider", model: "review-model", name: "Local", version: 2 },
    result: { id: resultId, version },
    reviewer: {
      accentToken: "slate",
      avatarText: "R",
      id: "reviewer",
      name: "Reviewer",
    },
    startedAt: NOW,
    status,
    usageTotal: {
      completionTokens: 0,
      promptTokens: 0,
      reportedCalls: 0,
      totalTokens: 0,
      unreportedCalls: 0,
    },
  };
}

const rejected = attempt("attempt-reject", "rejected", "result-1", 1, "reject");
const escalated = attempt("attempt-escalate", "escalated", "result-1", 1, "escalate");
const failed = attempt("attempt-failed", "failed", "result-2", 2, null);
const finalizing = attempt("attempt-finalizing", "finalizing", "result-3", 3, null);
const passed = attempt("attempt-pass", "passed", "result-4", 4, "pass");
const escalation = {
  answer: null,
  id: "escalation-1",
  options: ["继续复核", "返工补证", "终止使命"],
  question: "证据冲突，应如何继续？",
};

function props(overrides: Partial<ReviewOutcomesPanelProps> = {}): ReviewOutcomesPanelProps {
  return {
    attempts: [passed, finalizing, failed, escalated, rejected],
    currentResult: { id: "result-4", version: 4 },
    escalation,
    onAnswerEscalation: vi.fn().mockResolvedValue({
      action: "continue_review",
      attemptId: "attempt-new",
      state: "reviewing",
    }),
    onStartExecution: vi.fn().mockResolvedValue({ executionId: "execution-new" }),
    workItemId: "work-1",
    ...overrides,
  };
}

describe("review outcomes and attempt history", () => {
  it("turns reject requirements into a new execution entry and keeps exact navigation", async () => {
    const onStartExecution = vi.fn().mockResolvedValue({ executionId: "execution-new" });
    render(<ReviewOutcomesPanel {...props({ onStartExecution })} />);

    const rejectedItem = screen.getByRole("listitem", { name: /attempt attempt-reject/ });
    expect(within(rejectedItem).getByText("补齐失败路径测试")).toBeInTheDocument();
    expect(within(rejectedItem).getByRole("link", { name: "Result result-1 · v1" }))
      .toHaveAttribute("href", "/work-items/work-1/results/result-1?version=1");
    expect(within(rejectedItem).getByRole("link", { name: "Attempt attempt-reject" }))
      .toHaveAttribute("href", "/work-items/work-1/reviews/attempt-reject");

    await userEvent.click(within(rejectedItem).getByRole("button", {
      name: "按退回要求开始新 execution",
    }));
    expect(onStartExecution).toHaveBeenCalledWith({
      resultId: "result-1",
      sourceAttemptId: "attempt-reject",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已创建 execution execution-new；新 result 提交后将进入新 attempt。",
    );
    await waitFor(() => expect(screen.getByRole("heading", {
      name: "返工 execution 已创建",
    })).toHaveFocus());
  });

  it.each([
    ["continue_review", "继续复核", "已创建新复核 attempt attempt-new"],
    ["rework", "返工", "已进入返工；新 result 提交后会创建新 attempt"],
    ["terminate_mission", "终止使命", "使命已终止"],
  ] as const)("submits %s with owner draft and announces its outcome", async (
    action,
    label,
    message,
  ) => {
    const onAnswerEscalation = vi.fn().mockResolvedValue({
      action,
      attemptId: action === "continue_review" ? "attempt-new" : undefined,
      state: action === "rework" ? "rework" : action === "terminate_mission"
        ? "terminated"
        : "reviewing",
    });
    render(<ReviewOutcomesPanel {...props({ onAnswerEscalation })} />);

    const draft = screen.getByRole("textbox", { name: "Owner 回答" });
    await userEvent.type(draft, "保留这个回答草稿并执行所选动作。");
    await userEvent.click(screen.getByRole("radio", { name: label }));
    await userEvent.click(screen.getByRole("button", { name: "提交 Owner 回答" }));

    expect(onAnswerEscalation).toHaveBeenCalledWith({
      action,
      answer: "保留这个回答草稿并执行所选动作。",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(message);
  });

  it("preserves the owner draft on error and explains disabled operations", async () => {
    const onAnswerEscalation = vi.fn().mockRejectedValue(new Error("offline"));
    const { rerender } = render(
      <ReviewOutcomesPanel {...props({ onAnswerEscalation })} />,
    );
    const draft = screen.getByRole("textbox", { name: "Owner 回答" });
    await userEvent.type(draft, "不能丢失的草稿");
    await userEvent.click(screen.getByRole("radio", { name: "返工" }));
    await userEvent.click(screen.getByRole("button", { name: "提交 Owner 回答" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("提交失败");
    expect(draft).toHaveValue("不能丢失的草稿");
    expect(screen.getByRole("radio", { name: "返工" })).toBeChecked();

    rerender(<ReviewOutcomesPanel {...props({ disabledReason: "结果版本已变化" })} />);
    const submit = screen.getByRole("button", { name: "提交 Owner 回答" });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-describedby");
    expect(screen.getByText("结果版本已变化")).toBeInTheDocument();
  });

  it("makes terminal, no-decision, stale and finalizing history unambiguous", () => {
    render(<ReviewOutcomesPanel {...props()} />);

    expect(screen.getByRole("listitem", { name: /attempt attempt-pass/ }))
      .toHaveTextContent("终态 · passed · 唯一裁决：pass · 当前 result");
    expect(screen.getByRole("listitem", { name: /attempt attempt-failed/ }))
      .toHaveTextContent("终态 · failed · 无裁决 · 历史 result（stale）");
    expect(screen.getByRole("listitem", { name: /attempt attempt-finalizing/ }))
      .toHaveTextContent("finalizing · 公开输出已保存，尚未形成裁决");
    expect(screen.getByRole("listitem", { name: /attempt attempt-escalate/ }))
      .toHaveTextContent("终态 · escalated · 唯一裁决：escalate");
  });

  it("covers loading, empty, error and keyboard tab order", async () => {
    const { rerender } = render(
      <ReviewOutcomesPanel {...props({ attempts: [], escalation: null, loading: true })} />,
    );
    expect(screen.getByText("正在加载复核结果与历史…")).toHaveAttribute("aria-busy", "true");

    rerender(<ReviewOutcomesPanel {...props({ attempts: [], escalation: null })} />);
    expect(screen.getByText("还没有复核 attempt 历史。")).toBeInTheDocument();

    const onReload = vi.fn();
    rerender(
      <ReviewOutcomesPanel
        {...props({ attempts: [], error: "历史加载失败", escalation: null, onReload })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("历史加载失败");
    await userEvent.click(screen.getByRole("button", { name: "重试加载复核历史" }));
    expect(onReload).toHaveBeenCalledTimes(1);

    rerender(<ReviewOutcomesPanel {...props()} />);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Owner 回答" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("radio", { name: "继续复核" })).toHaveFocus();
  });
});
