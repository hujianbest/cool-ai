// @vitest-environment jsdom
import "./component-utils";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillList } from "../components/SkillList";
import type { SkillIndexDTO } from "../src/server/skillService";

const skills: SkillIndexDTO[] = [
  { id: 1, name: "需求整理", description: "d", category: "product", agentCount: 2 },
];

describe("SkillList (presentational)", () => {
  it("loading state", () => {
    render(<SkillList status="loading" skills={[]} onRetry={() => {}} />);
    expect(screen.getByText(/加载中/)).toBeInTheDocument();
  });

  it("empty state", () => {
    render(<SkillList status="empty" skills={[]} onRetry={() => {}} />);
    expect(screen.getByText(/暂无 skill/)).toBeInTheDocument();
  });

  it("error state with retry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<SkillList status="error" skills={[]} onRetry={onRetry} />);

    expect(screen.getByText(/加载失败/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("success state renders names and agentCount", () => {
    render(<SkillList status="success" skills={skills} onRetry={() => {}} />);
    expect(screen.getByText("需求整理")).toBeInTheDocument();
    expect(screen.getByText(/被 2 个 agent 关联/)).toBeInTheDocument();
  });
});
