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
          Response.json({ tasks: [], events: [] }),
        ]),
    );

    render(<ProjectPanel />);

    expect(screen.getAllByText("正在加载项目…")).toHaveLength(2);
    expect(await screen.findByRole("button", { name: "Existing project" })).toBeInTheDocument();
  });

  it("creates and displays a project", async () => {
    const fetchMock = cockpitFetch([
      Response.json({ projects: [] }),
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
    await screen.findByText("暂无项目。创建项目开始使用协作驾驶舱。");
    await user.type(screen.getByLabelText("项目名称"), "Launch plan");
    const projectForm = screen.getByLabelText("项目名称").closest("form");
    expect(projectForm).not.toBeNull();
    await user.click(within(projectForm!).getByRole("button", { name: "创建项目" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Launch plan" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        body: JSON.stringify({ name: "Launch plan" }),
        method: "POST",
      }),
    );
  });

  it("shows validation and request errors while preserving input", async () => {
    const fetchMock = cockpitFetch([
      Response.json({ projects: [] }),
        Response.json(
          { error: { code: "UNEXPECTED_UPSTREAM", message: "Could not create project." } },
          { status: 500 },
        ),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ProjectPanel />);
    await screen.findByText("暂无项目。创建项目开始使用协作驾驶舱。");
    const projectForm = screen.getByLabelText("项目名称").closest("form");
    expect(projectForm).not.toBeNull();
    await user.click(within(projectForm!).getByRole("button", { name: "创建项目" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请输入项目名称。");

    await user.type(screen.getByLabelText("项目名称"), "Launch plan");
    await user.click(within(projectForm!).getByRole("button", { name: "创建项目" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("请求失败，请稍后重试。"),
    );
    expect(screen.getByLabelText("项目名称")).toHaveValue("Launch plan");
  });
});
