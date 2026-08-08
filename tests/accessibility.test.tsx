import { render, screen } from "@testing-library/react";
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
    const context = screen.getByRole("button", { name: "打开当前任务上下文" });

    expect(projects).toHaveAttribute("aria-controls", "project-navigation-drawer");
    expect(projects).toHaveAttribute("aria-expanded", "false");
    expect(context).toHaveAttribute("aria-controls", "task-context-drawer");
    expect(context).toHaveAttribute("aria-expanded", "false");
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

    const context = screen.getByRole("button", { name: "打开当前任务上下文" });
    await user.click(context);
    const closeContext = screen.getByRole("button", { name: "关闭当前任务上下文" });
    expect(context).toHaveAttribute("aria-expanded", "true");
    expect(closeContext).toHaveFocus();
    await user.click(closeContext);
    expect(context).toHaveFocus();
    expect(context).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps closed surfaces out of the narrow keyboard order", async () => {
    renderCockpitWithProject();
    const user = userEvent.setup();

    await user.tab();
    expect(screen.getByRole("link", { name: "工作" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "团队" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "首次使用引导" })).toHaveFocus();
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
    expect(screen.getByRole("button", { name: "打开当前任务上下文" })).toHaveFocus();
    await user.tab();
    expect(document.body).toHaveFocus();
  });

  it("announces the restored task status through a polite status region", async () => {
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

    await screen.findByText("最新任务状态：已完成");
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("最新任务状态：已完成");
  });
});
