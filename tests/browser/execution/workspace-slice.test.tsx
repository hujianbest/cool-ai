// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getProjects } from "@/app/api/projects/route";
import { ProjectPanel } from "@/components/project-panel";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";

let rootDirectory: string;

beforeEach(() => {
  rootDirectory = mkdtempSync(join(tmpdir(), "cockpit-workspace-slice-"));
  process.env.COCKPIT_DB_PATH = join(rootDirectory, "cockpit.sqlite");
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.COCKPIT_DB_PATH;
  rmSync(rootDirectory, { force: true, recursive: true });
});

async function workspaceRoute() {
  const routeId = "@/app/api/projects/[projectId]/workspace/route";
  return import(/* @vite-ignore */ routeId) as Promise<{
    GET: (
      request: Request,
      context: { params: Promise<{ projectId: string }> },
    ) => Promise<Response>;
    PUT: (
      request: Request,
      context: { params: Promise<{ projectId: string }> },
    ) => Promise<Response>;
  }>;
}

function installAppFetch(projectId: string) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/projects") return getProjects();
    if (url.pathname === `/api/projects/${projectId}/tasks`) {
      return Response.json({ tasks: [], events: [] });
    }
    if (url.pathname === "/api/agents") {
      return Response.json({ agents: [] });
    }
    if (url.pathname === `/api/projects/${projectId}/members`) {
      return Response.json({ members: [], projectVersion: 1 });
    }
    if (url.pathname === `/api/projects/${projectId}/mission`) {
      return Response.json({ mission: null, workItems: [] });
    }
    if (url.pathname === `/api/projects/${projectId}/memories`) {
      return Response.json({ memories: [] });
    }
    if (url.pathname === `/api/projects/${projectId}/collaboration`) {
      return Response.json({
        pendingDecision: null,
        projectMessagesPage: { items: [], nextAfter: null },
        readiness: { missing: ["members", "mission"], ready: false },
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
      });
    }
    if (url.pathname === `/api/projects/${projectId}/workspace`) {
      const route = await workspaceRoute();
      const request = new Request(url, init);
      const context = { params: Promise.resolve({ projectId }) };
      return request.method === "PUT"
        ? route.PUT(request, context)
        : route.GET(request, context);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("workspace binding vertical slice", () => {
  it("validates a real directory, persists its canonical path, and reloads it", async () => {
    const databasePath = process.env.COCKPIT_DB_PATH!;
    const project = createProject("Workspace project", databasePath);
    window.history.replaceState(null, "", `/projects/${project.id}`);
    const workspacePath = mkdtempSync(join(rootDirectory, "bound-"));
    const canonicalPath = await realpath(workspacePath);
    const fetchMock = installAppFetch(project.id);
    const user = userEvent.setup();

    const firstRender = render(<ProjectPanel />);
    await screen.findByText("尚未绑定本地工作区。");

    await user.click(screen.getByRole("button", { name: "绑定工作区" }));
    await user.type(screen.getByLabelText("本地工作区路径"), "relative/path");
    await user.click(screen.getByRole("button", { name: "绑定工作区" }));
    const pathAlert = screen.getByText("请输入绝对目录路径。");
    expect(pathAlert.closest('[role="alert"]')).not.toBeNull();
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith(`/api/projects/${project.id}/workspace`) &&
          init?.method === "PUT",
      ),
    ).toHaveLength(0);

    await user.clear(screen.getByLabelText("本地工作区路径"));
    await user.type(screen.getByLabelText("本地工作区路径"), workspacePath);
    await user.click(screen.getByRole("button", { name: "绑定工作区" }));

    expect(await screen.findByText(canonicalPath)).toBeInTheDocument();
    firstRender.unmount();

    render(<ProjectPanel />);
    await screen.findByRole("heading", { name: "Workspace project" });
    expect(await screen.findByText(canonicalPath)).toBeInTheDocument();
  });
});
