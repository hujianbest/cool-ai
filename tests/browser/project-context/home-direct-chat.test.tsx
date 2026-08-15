// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectPanel } from "@/components/project-panel";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/components/collaboration/collaboration-panel", () => ({
  CollaborationPanel: ({ projectId }: { projectId: string }) => (
    <label>
      Home chat {projectId}
      <textarea />
    </label>
  ),
}));

vi.mock("@/components/project-thread-navigation", () => ({
  ProjectThreadNavigation: ({
    directMode,
    projectId,
  }: {
    directMode?: boolean;
    projectId: string;
  }) => (
    <div>Home threads {projectId} {directMode ? "direct" : "project"}</div>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("home direct chat", () => {
  it("guides the owner to configure an Agent when home has none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects") {
          return Response.json({ projects: [] });
        }
        if (url === "/api/home") {
          return Response.json({ kind: "needs_agent" });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<ProjectPanel />);

    expect(await screen.findByText("先配置一个 Agent，即可开始个人对话。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "配置 Agent" })).toHaveAttribute(
      "href",
      "/team?section=agents&returnTo=/",
    );
    expect(screen.queryByText("请先创建或选择项目，再运行任务。")).not.toBeInTheDocument();
  });

  it("renders the selected Agent chat without project-only surfaces", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects") {
          return Response.json({ projects: [] });
        }
        if (url === "/api/home") {
          return Response.json({
            agent: {
              accentToken: "sage",
              avatarText: "A",
              id: "agent-alpha",
              name: "Alpha",
              role: "Plans",
            },
            kind: "ready",
            project: {
              createdAt: "2026-08-14T00:00:00.000Z",
              id: "home-project",
              name: "个人对话",
            },
            threads: [],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<ProjectPanel />);

    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByLabelText("Home chat home-project")).toBeInTheDocument();
    expect(screen.queryByText("任务看板")).not.toBeInTheDocument();
    expect(screen.queryByText("运行详情")).not.toBeInTheDocument();
  });

  it("shows a retryable home load error", async () => {
    let homeAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects") {
          return Response.json({ projects: [] });
        }
        if (url === "/api/home") {
          homeAttempts += 1;
          if (homeAttempts === 1) {
            return Response.json(
              { error: { code: "STORAGE_UNAVAILABLE", message: "raw detail" } },
              { status: 503 },
            );
          }
          return Response.json({ kind: "needs_agent" });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<ProjectPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法加载个人对话，请稍后重试。",
    );
    await user.click(screen.getByRole("button", { name: "重试加载对话" }));
    expect(await screen.findByText("先配置一个 Agent，即可开始个人对话。")).toBeInTheDocument();
    expect(homeAttempts).toBe(2);
  });

  it("keeps the direct container out of projects and shows its threads on home", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects") {
          return Response.json({
            projects: [
              {
                createdAt: "2026-08-14T00:00:00.000Z",
                id: "home-project",
                name: "个人对话",
              },
              {
                createdAt: "2026-08-14T00:01:00.000Z",
                id: "folder-project",
                name: "Folder project",
              },
            ],
          });
        }
        if (url === "/api/home") {
          return Response.json({
            agent: {
              accentToken: "sage",
              avatarText: "A",
              id: "agent-alpha",
              name: "Alpha",
              role: "Plans",
            },
            kind: "ready",
            project: {
              createdAt: "2026-08-14T00:00:00.000Z",
              id: "home-project",
              name: "个人对话",
            },
            threads: [],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<ProjectPanel />);

    expect(await screen.findByText("Home threads home-project direct")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "个人对话" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Folder project" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.queryByText("A · Alpha")).toBeNull();
    expect(screen.queryByText("请先选择项目。")).not.toBeInTheDocument();
  });
});
