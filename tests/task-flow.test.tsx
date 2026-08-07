import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectPanel } from "@/components/project-panel";
import type { TaskEvent, TaskRun } from "@/src/shared/contracts";
import { cockpitFetch } from "@/tests/cockpit-test-fetch";

const pushMock = vi.fn();
let pathnameValue: string | null = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameValue,
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
}));

const project = {
  id: "project-1",
  name: "Launch plan",
  createdAt: "2026-07-29T00:00:00.000Z",
};
const secondProject = {
  id: "project-2",
  name: "Release plan",
  createdAt: "2026-07-30T00:00:00.000Z",
};

function installRoutingFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/projects") {
      return Response.json({ projects: [project, secondProject] });
    }
    if (url.startsWith("/api/projects/") && url.endsWith("/tasks")) {
      return Response.json({ tasks: [], events: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function task(status: TaskRun["status"], overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: "task-1",
    projectId: project.id,
    goal: "Prepare launch notes",
    status,
    result: null,
    error: null,
    createdAt: "2026-07-29T00:01:00.000Z",
    updatedAt: "2026-07-29T00:01:00.000Z",
    ...overrides,
  };
}

function event(sequence: number, status: TaskEvent["status"], message: string): TaskEvent {
  return {
    id: `event-${sequence}`,
    taskId: "task-1",
    sequence,
    status,
    message,
    createdAt: `2026-07-29T00:0${sequence}:00.000Z`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

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

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  pushMock.mockClear();
  pathnameValue = "/";
});

describe("task event flow", () => {
  it("shows loading, then restores persisted task events and result", async () => {
    const loaded = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      cockpitFetch([
        Response.json({ projects: [project] }),
        loaded.promise,
      ]),
    );

    render(<ProjectPanel />);

    expect(await screen.findByText("正在加载任务历史…")).toBeInTheDocument();
    loaded.resolve(
      Response.json({
        tasks: [task("completed", { result: "Launch notes ready." })],
        events: [
          event(1, "queued", "Task queued."),
          event(2, "running", "Task started."),
          event(3, "completed", "Task completed."),
        ],
      }),
    );

    expect(await screen.findByText("任务已完成。")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("tab", { name: "骨架运行" }));
    expect(screen.getByText("Launch notes ready.")).toBeInTheDocument();
    expect(screen.getByLabelText("任务目标")).toHaveValue("");
  });

  it("shows an actionable empty state when the project has no tasks", async () => {
    vi.stubGlobal(
      "fetch",
      cockpitFetch([
        Response.json({ projects: [project] }),
        Response.json({ tasks: [], events: [] }),
      ]),
    );

    render(<ProjectPanel />);

    expect(await screen.findByText("暂无任务。输入目标即可运行示例 Agent。")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "开始创建任务" }));
    expect(screen.getByLabelText("任务目标")).toHaveFocus();
    expect(screen.getByLabelText("任务目标")).toBeEnabled();
    expect(screen.getByRole("button", { name: "运行任务" })).toBeDisabled();
  });

  it("guides an unselected project state back to project selection", async () => {
    vi.stubGlobal(
      "fetch",
      cockpitFetch([Response.json({ projects: [] })]),
    );
    const user = userEvent.setup();

    render(<ProjectPanel />);

    const projectRegion = await screen.findByRole("region", { name: "项目" });
    const createProjectActions = within(projectRegion).getAllByRole("button", {
      name: "创建项目",
    });
    await user.click(createProjectActions.at(-1)!);
    expect(screen.getByLabelText("项目名称")).toHaveFocus();

    expect(await screen.findByText("请先选择项目。")).toBeInTheDocument();
    const context = screen.getByRole("complementary", { name: "当前任务上下文" });
    await user.click(within(context).getByRole("button", { name: "选择项目" }));
    expect(screen.getByLabelText("项目名称")).toHaveFocus();
  });

  it("calls create, start, and execute in order while rendering each persisted state", async () => {
    const start = deferred<Response>();
    const execute = deferred<Response>();
    const queuedEvent = event(1, "queued", "Task queued.");
    const runningEvent = event(2, "running", "Task started.");
    const completedEvent = event(3, "completed", "Task completed.");
    const fetchMock = cockpitFetch([
      Response.json({ projects: [project] }),
      Response.json({ tasks: [], events: [] }),
      Response.json({ task: task("queued"), events: [queuedEvent] }, { status: 201 }),
      start.promise,
      execute.promise,
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ProjectPanel />);
    await screen.findByText("暂无任务。输入目标即可运行示例 Agent。");
    await user.type(screen.getByLabelText("任务目标"), "Prepare launch notes");
    await user.click(screen.getByRole("button", { name: "运行任务" }));

    expect(await screen.findByText("任务已排队。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "任务运行中…" })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/tasks/task-1/start")).toBe(true);

    await act(async () => {
      start.resolve(
        Response.json({
          task: task("running"),
          events: [queuedEvent, runningEvent],
        }),
      );
    });
    expect(await screen.findByText("任务已开始。")).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/tasks/task-1/execute")).toBe(
        true,
      ),
    );

    await act(async () => {
      execute.resolve(
        Response.json({
          task: task("completed", { result: "Launch notes ready." }),
          events: [queuedEvent, runningEvent, completedEvent],
        }),
      );
    });

    expect(await screen.findByText("任务已完成。")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "骨架运行" }));
    expect(screen.getByText("Launch notes ready.")).toBeInTheDocument();
    expect(screen.getByLabelText("任务目标")).toHaveValue("");
  });

  it("offers retry after a load error", async () => {
    const fetchMock = cockpitFetch([
      Response.json({ projects: [project] }),
        Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "Could not load tasks." } },
          { status: 503 },
        ),
      Response.json({ tasks: [], events: [] }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ProjectPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用，请稍后重试。");
    await user.click(screen.getByRole("button", { name: "重试任务历史" }));
    expect(await screen.findByText("暂无任务。输入目标即可运行示例 Agent。")).toBeInTheDocument();
  });

  it("renders a persisted failed event and preserves the goal after execution fails", async () => {
    const queuedEvent = event(1, "queued", "Task queued.");
    const runningEvent = event(2, "running", "Task started.");
    const failedEvent = event(3, "failed", "Task failed.");
    vi.stubGlobal(
      "fetch",
      cockpitFetch([
        Response.json({ projects: [project] }),
        Response.json({ tasks: [], events: [] }),
        Response.json({ task: task("queued"), events: [queuedEvent] }, { status: 201 }),
          Response.json({ task: task("running"), events: [queuedEvent, runningEvent] }),
        
          Response.json(
            {
              task: task("failed", { error: "provider offline" }),
              events: [queuedEvent, runningEvent, failedEvent],
              error: { code: "TASK_EXECUTION_FAILED", message: "provider offline" },
            },
            { status: 500 },
          ),
      ]),
    );
    const user = userEvent.setup();

    render(<ProjectPanel />);
    await screen.findByText("暂无任务。输入目标即可运行示例 Agent。");
    await user.type(screen.getByLabelText("任务目标"), "Prepare launch notes");
    await user.click(screen.getByRole("button", { name: "运行任务" }));

    expect(await screen.findByText("任务执行失败。")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("任务执行失败，请稍后重试。");
    expect(screen.getByLabelText("任务目标")).toHaveValue("Prepare launch notes");
  });
});

describe("project URL routing", () => {
  it("pushes the selected project URL", async () => {
    installRoutingFetch();
    const user = userEvent.setup();
    render(<ProjectPanel />);

    await user.click(await screen.findByRole("button", { name: secondProject.name }));

    expect(pushMock).toHaveBeenCalledWith("/projects/project-2");
  });

  it("selects a valid project from a direct URL instead of the first project", async () => {
    pathnameValue = "/projects/project-2";
    installRoutingFetch();
    render(<ProjectPanel />);

    expect(await screen.findByRole("button", { name: secondProject.name })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: project.name })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("synchronizes the selected project when browser history changes", async () => {
    pathnameValue = "/projects/project-2";
    installRoutingFetch();
    const view = render(<ProjectPanel />);
    expect(await screen.findByRole("button", { name: secondProject.name })).toHaveAttribute(
      "aria-current",
      "page",
    );

    pathnameValue = "/projects/project-1";
    view.rerender(<ProjectPanel />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: project.name })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
  });

  it("shows the project error state for an unknown URL project id", async () => {
    pathnameValue = "/projects/missing-project";
    installRoutingFetch();
    render(<ProjectPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("未找到该项目。");
    expect(screen.getByRole("button", { name: project.name })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("button", { name: secondProject.name })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("offers a reachable desktop recovery action for an unknown project", async () => {
    pathnameValue = "/projects/missing-project";
    stubViewport(false);
    installRoutingFetch();
    const user = userEvent.setup();
    render(<ProjectPanel />);

    const recovery = await screen.findByRole("button", { name: "返回项目列表" });
    expect(recovery).toBeVisible();
    await user.click(recovery);

    expect(pushMock).toHaveBeenCalledWith("/");
  });

  it("keeps unknown-project recovery reachable with narrow drawers closed", async () => {
    pathnameValue = "/projects/missing-project";
    stubViewport(true);
    installRoutingFetch();
    const user = userEvent.setup();
    render(<ProjectPanel />);

    const recovery = await screen.findByRole("button", { name: "返回项目列表" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(recovery).toBeVisible();
    await user.click(recovery);

    expect(pushMock).toHaveBeenCalledWith("/");
  });
});
