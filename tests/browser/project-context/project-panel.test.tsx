// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
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

    expect(screen.getAllByText("正在加载项目…")).toHaveLength(2);
    expect(await screen.findByRole("button", { name: "Existing project" })).toBeInTheDocument();
  });

  it("opens and displays a folder project", async () => {
    const fetchMock = cockpitFetch([
      Response.json({ projects: [] }),
      Response.json({ kind: "needs_agent" }),
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
    await screen.findByText("暂无文件夹项目。");
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    await user.type(screen.getByLabelText("文件夹路径"), "D:\\work\\launch-plan");
    const projectForm = screen.getByLabelText("文件夹路径").closest("form");
    expect(projectForm).not.toBeNull();
    await user.click(within(projectForm!).getByRole("button", { name: "打开文件夹" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Launch plan" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        body: JSON.stringify({ path: "D:\\work\\launch-plan" }),
        method: "POST",
      }),
    );
  });

  it("shows validation and request errors while preserving input", async () => {
    const fetchMock = cockpitFetch([
      Response.json({ projects: [] }),
      Response.json({ kind: "needs_agent" }),
        Response.json(
          { error: { code: "WORKSPACE_NOT_FOUND", message: "Workspace directory was not found." } },
          { status: 400 },
        ),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ProjectPanel />);
    await screen.findByText("暂无文件夹项目。");
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    const projectForm = screen.getByLabelText("文件夹路径").closest("form");
    expect(projectForm).not.toBeNull();
    await user.click(within(projectForm!).getByRole("button", { name: "打开文件夹" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请输入本地文件夹路径。");

    await user.type(screen.getByLabelText("文件夹路径"), "D:\\missing\\launch-plan");
    await user.click(within(projectForm!).getByRole("button", { name: "打开文件夹" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("未找到该文件夹，请检查路径后重试。"),
    );
    expect(screen.getByLabelText("文件夹路径")).toHaveValue("D:\\missing\\launch-plan");
  });
});
