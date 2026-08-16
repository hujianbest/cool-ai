// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectPanel } from "@/components/project-panel";
import { cockpitFetch } from "@/tests/cockpit-test-fetch";

let pathnameValue = "/projects/project-1";

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameValue,
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/components/project-thread-navigation", () => ({
  ProjectThreadNavigation: () => null,
}));

beforeEach(() => {
  pathnameValue = "/projects/project-1";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop collaboration cockpit", () => {
  it("presents project navigation and task flow from real data", async () => {
    vi.stubGlobal(
      "fetch",
      cockpitFetch([
          Response.json({
            projects: [
              {
                id: "project-1",
                name: "Launch plan",
                createdAt: "2026-07-29T00:00:00.000Z",
              },
            ],
          }),
          Response.json({
            tasks: [
              {
                id: "task-1",
                projectId: "project-1",
                goal: "Prepare launch notes",
                status: "completed",
                result: "Launch notes ready.",
                error: null,
                createdAt: "2026-07-29T00:01:00.000Z",
                updatedAt: "2026-07-29T00:03:00.000Z",
              },
            ],
            events: [
              {
                id: "event-1",
                taskId: "task-1",
                sequence: 1,
                status: "queued",
                message: "Task queued.",
                createdAt: "2026-07-29T00:01:00.000Z",
              },
              {
                id: "event-2",
                taskId: "task-1",
                sequence: 2,
                status: "running",
                message: "Task started.",
                createdAt: "2026-07-29T00:02:00.000Z",
              },
              {
                id: "event-3",
                taskId: "task-1",
                sequence: 3,
                status: "completed",
                message: "Task completed.",
                createdAt: "2026-07-29T00:03:00.000Z",
              },
            ],
          }),
        ]),
    );

    render(<ProjectPanel />);

    const cockpit = await screen.findByTestId("collaboration-cockpit");
    const toolbar = within(cockpit).getByRole("toolbar", { name: "驾驶舱面板" });
    const navigation = within(cockpit).getByRole("complementary", {
      name: "项目导航",
    });
    const flow = within(cockpit).getByRole("region", { name: "任务事件流" });

    for (const action of within(toolbar).getAllByRole("button")) {
      expect(action).toHaveClass("button-secondary");
    }
    expect(within(navigation).getByText("Cool AI")).toHaveClass("sr-only");
    expect(within(navigation).getByRole("heading", { name: "项目" })).toHaveClass(
      "surface-heading",
    );
    expect(within(navigation).getByRole("button", { name: "打开文件夹" })).toHaveClass(
      "icon-button",
    );
    expect(within(navigation).getByRole("button", { name: "关闭项目导航" })).toHaveClass(
      "button-ghost",
    );
    const currentProject = within(navigation).getByRole("button", { name: "Launch plan" });
    expect(currentProject).toHaveClass("nav-item");
    expect(currentProject).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(flow).queryByText("确定性示例 Agent")).toBeNull();
    expect(within(flow).queryByRole("button", { name: "运行任务" })).toBeNull();
    expect(
      within(flow).queryByRole("button", { name: "展开待处理消息队列" }),
    ).toBeNull();
    expect(within(flow).getByRole("heading", { name: "项目对话" })).toHaveClass(
      "sr-only",
    );
    expect(within(flow).getByRole("button", { name: "关闭任务编辑" })).toHaveClass(
      "button-ghost",
    );
    expect(within(cockpit).queryByRole("complementary", { name: "当前任务上下文" })).toBeNull();
    expect(
      within(navigation).queryByRole("heading", { name: "项目设置" }),
    ).toBeNull();
    expect(
      within(navigation).queryByRole("heading", { name: "工作区文件" }),
    ).toBeNull();
    expect(
      within(navigation).queryByRole("button", { name: "保存成员" }),
    ).toBeNull();
  });

  it("renders the ActivityBar navigation rail and drops the in-sidebar text nav", async () => {
    pathnameValue = "/";
    vi.stubGlobal(
      "fetch",
      cockpitFetch([
        Response.json({ projects: [] }),
        Response.json({ kind: "needs_agent" }),
      ]),
    );
    render(<ProjectPanel />);

    const cockpit = await screen.findByTestId("collaboration-cockpit");
    const activityBar = within(cockpit).getByRole("navigation", {
      name: "主导航",
    });
    expect(activityBar).toHaveClass("activity-bar");
    const workLink = within(activityBar).getByRole("link", { name: "对话" });
    expect(workLink).toHaveAttribute("aria-current", "page");
    expect(within(activityBar).getByRole("link", { name: "团队" })).toBeInTheDocument();
    expect(within(activityBar).getByRole("link", { name: "设置" })).toBeInTheDocument();

    const sidebar = within(cockpit).getByRole("complementary", {
      name: "项目导航",
    });
    expect(within(sidebar).queryByRole("link", { name: "对话" })).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "团队" })).toBeNull();
  });

  it("keeps 对话 on the current project and returns from governance with Escape or Cmd+1", async () => {
    const user = userEvent.setup();
    pathnameValue = "/projects/project-1";
    vi.stubGlobal(
      "fetch",
      cockpitFetch([
        Response.json({
          projects: [
            {
              id: "project-1",
              name: "Launch plan",
              createdAt: "2026-07-29T00:00:00.000Z",
            },
          ],
        }),
        Response.json({ tasks: [], events: [] }),
      ]),
    );
    render(<ProjectPanel />);

    const cockpit = await screen.findByTestId("collaboration-cockpit");
    const activityBar = within(cockpit).getByRole("navigation", {
      name: "主导航",
    });
    expect(within(activityBar).getByRole("link", { name: "对话" })).toHaveAttribute(
      "href",
      "/projects/project-1",
    );

    await user.click(within(activityBar).getByRole("button", { name: "任务" }));
    expect(
      await within(cockpit).findByRole("button", { name: "返回对话" }),
    ).toBeInTheDocument();
    expect(within(activityBar).getByRole("button", { name: "任务" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.keyboard("{Escape}");
    expect(within(cockpit).queryByRole("button", { name: "返回对话" })).toBeNull();

    await user.keyboard("{Control>}3{/Control}");
    expect(
      await within(cockpit).findByRole("button", { name: "返回对话" }),
    ).toBeInTheDocument();
    expect(within(activityBar).getByRole("button", { name: "记忆" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.keyboard("{Control>}1{/Control}");
    expect(within(cockpit).queryByRole("button", { name: "返回对话" })).toBeNull();
  });

  it("lights Needs Me on the header and 审批 rail when approvals are pending", async () => {
    const user = userEvent.setup();
    pathnameValue = "/projects/project-1";
    const pending = {
      approvalId: "approval-1",
      createdAt: "2026-08-10T04:00:00.005Z",
      decisionHint: null,
      domain: "execution",
      impactSummary: "Run the build",
      kind: "command",
      sourceRef: {
        executionId: "exec-1",
        messageId: null,
        runId: null,
        threadId: null,
      },
      status: "pending",
      title: "node -v",
    };
    const fetchMock = cockpitFetch([
      Response.json({
        projects: [
          {
            id: "project-1",
            name: "Launch plan",
            createdAt: "2026-07-29T00:00:00.000Z",
          },
        ],
      }),
      Response.json({ tasks: [], events: [] }),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/project-1/approvals/pending") {
          return Promise.resolve(Response.json({ approvals: [pending] }));
        }
        return fetchMock(input);
      }),
    );
    render(<ProjectPanel />);

    const cockpit = await screen.findByTestId("collaboration-cockpit");
    const needsMe = await within(cockpit).findByRole("button", {
      name: "Needs Me，1 项待处理",
    });
    const activityBar = within(cockpit).getByRole("navigation", {
      name: "主导航",
    });
    expect(within(activityBar).getByRole("button", { name: "审批，有待处理项" })).toBeInTheDocument();

    await user.click(needsMe);
    expect(
      await within(cockpit).findByRole("button", { name: "返回对话" }),
    ).toBeInTheDocument();
    expect(
      within(activityBar).getByRole("button", { name: "审批，有待处理项" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps home as a single chat pane with the lobby header", async () => {
    pathnameValue = "/";
    vi.stubGlobal(
      "fetch",
      cockpitFetch([
        Response.json({ projects: [] }),
        Response.json({ kind: "needs_agent" }),
      ]),
    );
    render(<ProjectPanel />);

    const cockpit = await screen.findByTestId("collaboration-cockpit");
    const flow = within(cockpit).getByRole("region", { name: "任务事件流" });
    expect(within(cockpit).getByText("大厅")).toBeInTheDocument();
    expect(await within(flow).findByText("欢迎来到 Cool AI")).toBeInTheDocument();
    expect(within(flow).getByText("先配置一个 Agent，即可开始个人对话。")).toBeInTheDocument();
    expect(within(flow).getByRole("link", { name: "配置 Agent" })).toBeInTheDocument();
    expect(within(flow).getByRole("link", { name: "首次使用引导" })).toHaveAttribute(
      "href",
      "/team?section=providers&guide=provider&returnTo=/",
    );
    expect(within(flow).queryByRole("button", { name: "运行任务" })).toBeNull();
    expect(within(flow).queryByText("正在加载项目…")).toBeNull();
  });
});

describe("desktop warm-terracotta shell grid", () => {
  it("uses case column tracks 56 / 236 / flexible flow / 304 via named tokens", () => {
    const cockpit = readFileSync("app/cockpit.css", "utf8");

    expect(cockpit).toMatch(
      /\.collaboration-cockpit\s*\{[^}]*grid-template-columns:\s*var\(--activity-bar-width\)\s+var\(--sidebar-width\)\s+minmax\(0,\s*1fr\)/s,
    );
    expect(cockpit).toMatch(
      /\.cockpit-sidebar,\s*\.cockpit-context\s*\{[^}]*background:\s*var\(--surface-panel\)/s,
    );
    expect(cockpit).toMatch(
      /\.cockpit-flow\s*\{[^}]*background:\s*var\(--surface-main\)/s,
    );
    expect(cockpit).toMatch(
      /\.chat-body\s*\{[^}]*overflow-y:\s*auto/s,
    );
    expect(cockpit).toMatch(
      /\.cockpit-flow \.composer\s*\{[^}]*flex-shrink:\s*0/s,
    );
  });

  it("styles the sidebar project switcher like a card-strong row", () => {
    const cockpit = readFileSync("app/cockpit.css", "utf8");

    expect(cockpit).toMatch(
      /\.cockpit-sidebar \.project-list \.nav-item\s*\{[^}]*background:\s*var\(--color-card-strong\)[^}]*min-height:\s*var\(--control-min\)[^}]*border-radius:\s*var\(--rounded-md\)/s,
    );
  });
});

describe("warm-gold 240px sidebar does not crush CJK chrome", () => {
  it("keeps compact labels on one line, scrolls the sidebar, and stops nested headings from pulling out of their cards", () => {
    const cockpit = readFileSync("app/cockpit.css", "utf8");

    expect(cockpit).toMatch(
      /\.cockpit-sidebar,\s*\.cockpit-context\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s,
    );
    expect(cockpit).toMatch(
      /\.section-heading-row\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s,
    );
    expect(cockpit).toMatch(
      /\.thread-view-tabs\s*\{[^}]*flex-wrap:\s*wrap/s,
    );
    expect(cockpit).toMatch(
      /\.thread-view-tabs \[role="tab"\]\s*\{[^}]*white-space:\s*nowrap[^}]*flex-shrink:\s*0/s,
    );
    expect(cockpit).toMatch(
      /\.thread-list-item \.thread-list-entry\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
    );
    expect(cockpit).toMatch(
      /\.activity-bar \.activity-bar-item\s*\{[^}]*padding:\s*0/s,
    );
    expect(cockpit).not.toMatch(
      /\.cockpit-flow \.panel-heading\s*\{[^}]*margin:\s*calc\(var\(--space-8\)\s*\*\s*-1\)/s,
    );
    expect(cockpit).toMatch(
      /\.mission-summary,\s*\.mission-board \.task-summary\s*\{[^}]*align-items:\s*start/s,
    );
    expect(cockpit).toMatch(
      /\.drawer-close\.icon-button\s*\{[^}]*display:\s*none/s,
    );
  });
});
