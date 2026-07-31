import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectPanel } from "@/components/project-panel";

const project = {
  id: "project-1",
  name: "Launch plan",
  createdAt: "2026-07-29T00:00:00.000Z",
};

function stubViewport(narrow: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: narrow,
      media: "(max-width: 56.25rem)",
      removeEventListener: vi.fn(),
    })),
  );
}

function stubCockpitRequests(workspacePath?: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payloads: Record<string, unknown> = {
        "/api/projects": { projects: [project] },
        "/api/projects/project-1/collaboration": {
          pendingDecision: null,
          projectMessagesPage: { items: [], nextAfter: null },
          readiness: { missing: [], ready: true },
          run: null,
          timelinePage: { items: [], nextAfter: null },
          usage: {
            byAgent: [],
            completionTokens: 0,
            promptTokens: 0,
            repairCalls: 0,
            totalTokens: 0,
            unreportedCalls: 0,
          },
        },
        "/api/projects/project-1/tasks": { tasks: [], events: [] },
        "/api/projects/project-1/workspace": {
          workspace: workspacePath
            ? { path: workspacePath, status: "ready" }
            : null,
          projectVersion: 1,
        },
        "/api/projects/project-1/members": {
          members: [],
          projectVersion: 1,
        },
        "/api/agents": { agents: [] },
      };
      const payload = payloads[url];
      if (!payload) throw new Error(`Unexpected request: ${url}`);
      return Response.json(payload);
    }),
  );
}

afterEach(() => {
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("owner-controlled cockpit mobile surfaces", () => {
  it("pauses the project modal while rebind confirmation owns focus", async () => {
    stubViewport(true);
    stubCockpitRequests("D:\\old");
    const user = userEvent.setup();
    render(<ProjectPanel />);
    const projectOpener = screen.getByRole("button", {
      name: "打开项目导航",
    });
    await user.click(projectOpener);
    const projects = screen.getByRole("dialog", { name: "项目导航" });
    const path = await within(projects).findByLabelText("本地工作区路径");
    await user.clear(path);
    await user.type(path, "D:\\new");
    const rebindOpener = within(projects).getByRole("button", {
      name: "保存工作区",
    });
    await user.click(rebindOpener);

    const confirmation = screen.getByRole("dialog", {
      name: "确认改绑工作区",
    });
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    expect(confirmation).toHaveAttribute("aria-modal", "true");
    expect(projects).not.toHaveAttribute("aria-modal");
    expect(
      within(confirmation).getByRole("button", { name: "确认改绑" }),
    ).toHaveFocus();

    await user.click(
      within(confirmation).getByRole("button", { name: "取消" }),
    );
    expect(screen.getByRole("dialog", { name: "项目导航" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    expect(rebindOpener).toHaveFocus();
  });

  it("allows one trapped inert modal at a time and preserves the collaboration draft", async () => {
    stubViewport(true);
    stubCockpitRequests();
    const user = userEvent.setup();
    render(<ProjectPanel />);
    await screen.findByRole("button", { name: "打开编辑" });

    const editorOpener = screen.getByRole("button", { name: "打开编辑" });
    await user.click(editorOpener);
    const editor = screen.getByRole("dialog", { name: "任务编辑" });
    expect(editor).toHaveAttribute("aria-modal", "true");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("project-surface")).toHaveAttribute("inert");
    expect(screen.getByTestId("context-surface")).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");
    expect(
      within(editor).getByRole("button", { name: "关闭任务编辑" }),
    ).toHaveFocus();

    await user.type(
      within(editor).getByLabelText("发送给项目群聊"),
      "Keep this draft",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(editorOpener).toHaveFocus();
    expect(document.body.style.overflow).toBe("");

    const projectOpener = screen.getByRole("button", { name: "打开项目导航" });
    await user.click(projectOpener);
    const projects = screen.getByRole("dialog", { name: "项目导航" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("editor-surface")).toHaveAttribute("inert");
    const projectClose = within(projects).getByRole("button", {
      name: "关闭项目导航",
    });
    expect(projectClose).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(projectClose).not.toHaveFocus();
    await user.keyboard("{Tab}");
    expect(projectClose).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(projectOpener).toHaveFocus();

    const contextOpener = screen.getByRole("button", { name: "打开当前任务上下文" });
    await user.click(contextOpener);
    const context = screen.getByRole("dialog", { name: "当前任务上下文" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("editor-surface")).toHaveAttribute("inert");
    await user.keyboard("{Escape}");
    expect(contextOpener).toHaveFocus();

    await user.click(editorOpener);
    expect(
      within(screen.getByRole("dialog", { name: "任务编辑" })).getByLabelText(
        "发送给项目群聊",
      ),
    ).toHaveValue("Keep this draft");
  });

  it("keeps all desktop regions non-modal and non-inert", async () => {
    stubViewport(false);
    stubCockpitRequests();
    render(<ProjectPanel />);

    await screen.findByRole("heading", { name: "Launch plan" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector("[aria-modal]")).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
    expect(screen.getByRole("complementary", { name: "项目导航" })).toBeVisible();
    expect(
      screen.getByRole("complementary", { name: "当前任务上下文" }),
    ).toBeVisible();
    expect(screen.getByRole("main", { name: "任务事件流" })).toBeVisible();
  });
});
