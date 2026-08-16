// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import RootLayout from "@/app/layout";
import { ProjectPanel } from "@/components/project-panel";
import { cockpitFetch } from "@/tests/cockpit-test-fetch";

function renderCockpitWithProject() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: true,
      media: "(max-width: 56.25rem)",
      removeEventListener: vi.fn(),
    })),
  );
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
  return render(<ProjectPanel />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("narrow-screen and keyboard accessibility", () => {
  it("provides the document and landmark structure required by axe", () => {
    const layoutMarkup = renderToStaticMarkup(
      <RootLayout>
        <div />
      </RootLayout>,
    );
    expect(layoutMarkup).toContain("<title>Cool AI 协作驾驶舱</title>");

    renderCockpitWithProject();

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "协作工作台",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("toolbar", { name: "驾驶舱面板" }).closest("header"))
      .not.toBeNull();
  });

  it("labels both drawer controls and exposes their state", async () => {
    renderCockpitWithProject();

    const projects = screen.getByRole("button", { name: "打开项目导航" });

    expect(projects).toHaveAttribute("aria-controls", "project-navigation-drawer");
    expect(projects).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "打开当前任务上下文" })).toBeNull();
  });

  it("moves focus into each drawer and restores it to the opener", async () => {
    renderCockpitWithProject();
    const user = userEvent.setup();

    const projects = screen.getByRole("button", { name: "打开项目导航" });
    await user.click(projects);
    const closeProjects = screen.getByRole("button", { name: "关闭项目导航" });
    expect(projects).toHaveAttribute("aria-expanded", "true");
    expect(closeProjects).toHaveFocus();
    await user.click(closeProjects);
    expect(projects).toHaveFocus();
    expect(projects).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps closed surfaces out of the narrow keyboard order", async () => {
    renderCockpitWithProject();
    const user = userEvent.setup();

    await user.tab();
    expect(screen.getByRole("link", { name: "对话" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "任务" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "记忆" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "审批" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "审计" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "团队" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "设置" })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", {
        name: "当前为明色主题，切换到暗色主题",
      }),
    ).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "打开项目导航" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "打开编辑" })).toHaveFocus();
    await user.tab();
    expect(document.body).toHaveFocus();
  });

  it("keeps restored task status off the chat-first main path", async () => {
    window.history.replaceState(null, "", "/projects/project-1");
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
            events: [],
          }),
        ]),
    );

    render(<ProjectPanel />);

    const cockpit = await screen.findByTestId("collaboration-cockpit");
    expect(within(cockpit).queryByText("最新任务状态：已完成")).toBeNull();
    expect(within(cockpit).queryByRole("button", { name: "运行任务" })).toBeNull();
  });
});
