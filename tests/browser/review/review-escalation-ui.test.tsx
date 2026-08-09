// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import * as reviewComponents from "@/components/review/review-slice";

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
    action: "continue_review" | "rework" | "terminate_mission";
    answer: string;
  }) => Promise<{ action: string; state: string }>;
};

function component() {
  const EscalationIssue = (
    reviewComponents as typeof reviewComponents & {
      EscalationIssue?: React.ComponentType<EscalationIssueProps>;
    }
  ).EscalationIssue;
  expect(EscalationIssue, "T-10 escalation UI must exist").toBeTypeOf("function");
  return EscalationIssue!;
}

const issue = {
  answer: null,
  id: "issue",
  options: ["继续检查", "要求补证"],
  question: "当前证据不足，应如何处理？",
};

describe("owner escalation answer UI", () => {
  it("renders loading and disabled states with semantic reasons and tokens", () => {
    const EscalationIssue = component();
    const { rerender } = render(
      <EscalationIssue issue={null} loading onAnswer={vi.fn()} />,
    );
    expect(screen.getByText("正在加载升级问题…")).toHaveAttribute("aria-busy", "true");

    rerender(
      <EscalationIssue
        disabledReason="使命已由 Owner 终止"
        issue={issue}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByRole("group", { name: "Owner 处理动作" })).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "提交 Owner 回答" });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-describedby");
    expect(screen.getByText("使命已由 Owner 终止")).toBeInTheDocument();
    expect(submit.getAttribute("style")).toContain("var(--control-min)");
  });

  it("preserves answer/action draft on error and exposes an alert", async () => {
    const EscalationIssue = component();
    const answer = vi.fn().mockRejectedValue(new Error("offline"));
    render(<EscalationIssue issue={issue} onAnswer={answer} />);

    const draft = screen.getByRole("textbox", { name: "Owner 回答" });
    await userEvent.type(draft, "请基于现有 result 继续，但不能直接通过。");
    await userEvent.click(screen.getByRole("radio", { name: "继续复核" }));
    await userEvent.click(screen.getByRole("button", { name: "提交 Owner 回答" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("提交失败");
    expect(draft).toHaveValue("请基于现有 result 继续，但不能直接通过。");
    expect(screen.getByRole("radio", { name: "继续复核" })).toBeChecked();
  });

  it("shows pending success, disables duplicate submit and focuses the new state", async () => {
    const EscalationIssue = component();
    let resolve!: (value: { action: string; state: string }) => void;
    const answer = vi.fn(() => new Promise<{ action: string; state: string }>((done) => {
      resolve = done;
    }));
    render(<EscalationIssue issue={issue} onAnswer={answer} />);

    await userEvent.type(screen.getByRole("textbox", { name: "Owner 回答" }), "请先返工补证。");
    await userEvent.click(screen.getByRole("radio", { name: "返工" }));
    const submit = screen.getByRole("button", { name: "提交 Owner 回答" });
    await userEvent.click(submit);
    expect(screen.getByRole("button", { name: "正在提交 Owner 回答…" })).toBeDisabled();

    resolve({ action: "rework", state: "rework" });
    const heading = await screen.findByRole("heading", { name: "已进入返工" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText("Owner 回答已保存。", { selector: "[aria-live='polite']" }))
      .toBeInTheDocument();
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("labels all three non-pass actions accessibly", () => {
    const EscalationIssue = component();
    render(<EscalationIssue issue={issue} onAnswer={vi.fn()} />);

    expect(screen.getByRole("radio", { name: "继续复核" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "返工" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "终止使命" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /通过/ })).not.toBeInTheDocument();
  });
});
