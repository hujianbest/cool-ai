// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectPanel } from "@/components/project-panel";
import { cockpitFetch } from "@/tests/cockpit-test-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProjectPanel", () => {
  it("loads existing projects", async () => {
    vi.stubGlobal(
      "fetch",
      cockpitFetch([
          Response.json({
            projects: [{ id: "project-1", name: "Existing project", createdAt: "2026-07-29T00:00:00.000Z" }],
          }),
          Response.json({ kind: "needs_agent" }),
        ]),
    );

    render(<ProjectPanel />);

    expect(await screen.findByRole("button", { name: "打开文件夹" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("正在加载对话…")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Existing project" })).toBeNull();
    expect(screen.getByText("未选择项目 · 个人对话")).toBeInTheDocument();
  });

  it("opens a folder project from the system directory picker", async () => {
    const fetchMock = cockpitFetch([
      Response.json({ projects: [] }),
      Response.json({ kind: "needs_agent" }),
      Response.json({ path: "D:\\work\\launch-plan" }),
      Response.json(
        {
          project: { id: "project-1", name: "Launch plan", createdAt: "2026-07-29T00:00:00.000Z" },
        },
        { status: 201 },
      ),
      Response.json({ tasks: [], events: [] }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ProjectPanel />);
    expect(screen.queryByLabelText("文件夹路径")).toBeNull();
    expect(screen.queryByRole("button", { name: "如何打开项目" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "打开文件夹" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Launch plan" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/directory-picker",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        body: JSON.stringify({ path: "D:\\work\\launch-plan" }),
        method: "POST",
      }),
    );
  });

  it("shows picker and workspace errors without a path field", async () => {
    const fetchMock = cockpitFetch([
      Response.json({ projects: [] }),
      Response.json({ kind: "needs_agent" }),
      Response.json(
        { error: { code: "PICKER_UNAVAILABLE", message: "无法打开系统文件夹选择器" } },
        { status: 503 },
      ),
      Response.json({ path: "D:\\missing\\launch-plan" }),
      Response.json(
        { error: { code: "WORKSPACE_NOT_FOUND", message: "Workspace directory was not found." } },
        { status: 400 },
      ),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ProjectPanel />);
    await user.click(await screen.findByRole("button", { name: "打开文件夹" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("无法打开系统文件夹选择器"),
    );

    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("未找到该文件夹，请检查路径后重试。"),
    );
    expect(screen.queryByLabelText("文件夹路径")).toBeNull();
  });

  it("does nothing when the directory picker is cancelled", async () => {
    const fetchMock = cockpitFetch([
      Response.json({ projects: [] }),
      Response.json({ kind: "needs_agent" }),
      Response.json({ cancelled: true }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ProjectPanel />);
    await user.click(await screen.findByRole("button", { name: "打开文件夹" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/directory-picker",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
