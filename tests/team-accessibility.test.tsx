import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamPanel } from "@/components/team-panel";

const emptyPayloads: Record<string, unknown> = {
  "/api/agent-templates": {
    templates: [
      {
        accentToken: "sage",
        avatarText: "规",
        id: "planner",
        name: "规划",
        role: "规划",
        systemPrompt: "规划任务",
      },
      {
        accentToken: "terracotta",
        avatarText: "实",
        id: "builder",
        name: "实施",
        role: "实施",
        systemPrompt: "实施任务",
      },
      {
        accentToken: "slate",
        avatarText: "复",
        id: "reviewer",
        name: "复核",
        role: "复核",
        systemPrompt: "复核任务",
      },
    ],
  },
  "/api/agents": { agents: [] },
  "/api/providers": {
    providers: [
      {
        defaultModel: "model-a",
        id: "provider-1",
        name: "Primary",
        status: "verified",
      },
    ],
  },
  "/api/skills": {
    skills: [
      {
        createdAt: "2026-07-29T00:00:00.000Z",
        description: "",
        id: "skill-1",
        instructions: "Plan",
        name: "规划技能",
        updatedAt: "2026-07-29T00:00:00.000Z",
        version: 1,
      },
    ],
  },
};

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const payload = emptyPayloads[input.toString()];
    if (!payload) throw new Error(`Unexpected request: ${input.toString()}`);
    return Response.json(payload);
  }));
}

function stubMobile(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation(() => ({
      addEventListener: vi.fn(),
      matches,
      media: "(max-width: 56.25rem)",
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Team accessibility contract", () => {
  it("implements a three-tab keyboard navigation model", async () => {
    stubFetch();
    stubMobile(false);
    const user = userEvent.setup();
    render(<TeamPanel />);

    const tablist = screen.getByRole("tablist", { name: "团队资源" });
    const tabs = within(tablist).getAllByRole("tab");
    const activityBar = screen.getByRole("navigation", { name: "主导航" });
    expect(
      screen.getByRole("heading", { level: 1, name: "团队管理" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(within(activityBar).getByRole("link", { name: "团队" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(activityBar).getByRole("link", { name: "工作" })).toHaveClass(
      "activity-bar-item",
    );
    const sidebar = screen.getByRole("complementary", { name: "团队导航" });
    expect(within(sidebar).queryByRole("link", { name: "工作" })).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "团队" })).toBeNull();
    expect(screen.getByText("Cool AI")).toHaveClass(
      "surface-heading",
    );
    expect(screen.getByRole("button", { name: "打开团队资源" })).toHaveClass(
      "button-secondary",
    );
    expect(screen.getByRole("button", { name: "关闭团队资源" })).toHaveClass(
      "button-ghost",
    );
    expect(tabs.map((tab) => tab.textContent)).toEqual(["技能", "模型服务", "Agent"]);
    for (const tab of tabs) expect(tab).toHaveClass("nav-item");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    tabs[0].focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "模型服务" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "技能" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "技能" })).toHaveFocus();
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  });

  it("uses labelled fieldsets and keyboard-operable controls", async () => {
    stubFetch();
    stubMobile(false);
    const user = userEvent.setup();
    render(<TeamPanel />);
    await user.click(screen.getByRole("tab", { name: "Agent" }));
    await screen.findByText("暂无 Agent。");

    expect(screen.getByRole("group", { name: "技能" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "工具权限" })).toBeInTheDocument();
    const skill = screen.getByRole("checkbox", { name: "规划技能" });
    skill.focus();
    await user.keyboard(" ");
    expect(skill).toBeChecked();
    expect(screen.getByLabelText("Token 预算")).toHaveAttribute(
      "aria-describedby",
      "agent-max-tokens-help",
    );
  });

  it("makes the mobile editor modal, inert and focus trapped with restoration", async () => {
    stubFetch();
    stubMobile(true);
    const user = userEvent.setup();
    render(<TeamPanel />);
    await user.click(screen.getByRole("tab", { name: "Agent" }));
    await screen.findByText("暂无 Agent。");
    const opener = screen.getByRole("button", { name: "创建 Agent" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "创建 Agent" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("团队导航")).toHaveAttribute("inert");
    expect(screen.getByRole("tabpanel", { hidden: true })).toHaveAttribute(
      "inert",
    );
    expect(document.body.style.overflow).toBe("hidden");
    const close = within(dialog).getByRole("button", { name: "关闭 Agent 编辑器" });
    expect(close).toHaveFocus();

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(within(dialog).getByLabelText("强调色")).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
  });
});
