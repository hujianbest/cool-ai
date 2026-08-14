// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import RootLayout from "@/app/layout";
import { ProjectPanel } from "@/components/project-panel";
import { cockpitFetch } from "@/tests/cockpit-test-fetch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("code review fixes", () => {
  it("propagates project loading to the center and current context", async () => {
    const projects = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      cockpitFetch([
        projects.promise,
        Response.json({ kind: "needs_agent" }),
      ]),
    );

    render(<ProjectPanel />);

    const flow = screen.getByRole("region", { name: "任务事件流" });
    const context = screen.getByRole("complementary", { name: "当前任务上下文" });
    expect(within(flow).getByText("正在加载项目…")).toHaveAttribute("aria-busy", "true");
    expect(within(context).getByText("正在加载项目上下文…")).toHaveAttribute(
      "aria-busy",
      "true",
    );

    projects.resolve(Response.json({ projects: [] }));
    expect(
      await screen.findByText(
        "暂无文件夹项目。打开本地文件夹开始协作，也可直接在中间与 Agent 对话。",
      ),
    ).toBeInTheDocument();
  });

  it("retries a failed project load", async () => {
    const fetchMock = cockpitFetch([
        Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "项目加载失败。" } },
          { status: 503 },
        ),
      Response.json({ projects: [] }),
      Response.json({ kind: "needs_agent" }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ProjectPanel />);

    const retry = await screen.findByRole("button", { name: "重试加载项目" });
    const projectSurface = screen.getByRole("complementary", { name: "项目导航" });
    expect(within(projectSurface).getByRole("alert")).not.toHaveTextContent(/^\s*$/);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await user.click(retry);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      await screen.findByText(
        "暂无文件夹项目。打开本地文件夹开始协作，也可直接在中间与 Agent 对话。",
      ),
    ).toBeInTheDocument();
  });

  it("focuses the current project title after creation", async () => {
    vi.stubGlobal(
      "fetch",
      cockpitFetch([
        Response.json({ projects: [] }),
        Response.json({ kind: "needs_agent" }),
          Response.json(
            {
              project: {
                id: "project-1",
                name: "新项目",
                createdAt: "2026-07-29T00:00:00.000Z",
              },
            },
            { status: 201 },
          ),
        Response.json({ tasks: [], events: [] }),
      ]),
    );
    const user = userEvent.setup();

    render(<ProjectPanel />);
    await screen.findByText(
      "暂无文件夹项目。打开本地文件夹开始协作，也可直接在中间与 Agent 对话。",
    );
    await user.type(screen.getByLabelText("文件夹路径"), "D:\\work\\新项目");
    const projectForm = screen.getByLabelText("文件夹路径").closest("form");
    expect(projectForm).not.toBeNull();
    await user.click(within(projectForm!).getByRole("button", { name: "打开文件夹" }));

    const title = await screen.findByRole("heading", { level: 2, name: "新项目" });
    expect(title).toHaveAttribute("tabindex", "-1");
    expect(title).toHaveFocus();
  });

  it("declares Simplified Chinese and renders Chinese built-in copy", async () => {
    const layout = RootLayout({ children: null });
    expect(layout.props.lang).toBe("zh-CN");
    vi.stubGlobal(
      "fetch",
      cockpitFetch([
        Response.json({ projects: [] }),
        Response.json({ kind: "needs_agent" }),
      ]),
    );

    render(<ProjectPanel />);

    expect(screen.getByLabelText("文件夹路径")).toBeInTheDocument();
    const projectForm = screen.getByLabelText("文件夹路径").closest("form");
    expect(projectForm).not.toBeNull();
    expect(within(projectForm!).getByRole("button", { name: "打开文件夹" })).toBeInTheDocument();
    expect(
      await screen.findByText(
        "暂无文件夹项目。打开本地文件夹开始协作，也可直接在中间与 Agent 对话。",
      ),
    ).toBeInTheDocument();
  });
});
