import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectPanel } from "@/components/project-panel";
import { cockpitFetch } from "@/tests/cockpit-test-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop collaboration cockpit", () => {
  it("presents project navigation, task flow, and current context from real data", async () => {
    const user = userEvent.setup();
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
            events: [
              {
                id: "event-1",
                taskId: "task-1",
                sequence: 1,
                status: "queued",
                message: "Task queued.",
                createdAt: "2026-07-29T00:01:00.000Z",
              },
              {
                id: "event-2",
                taskId: "task-1",
                sequence: 2,
                status: "running",
                message: "Task started.",
                createdAt: "2026-07-29T00:02:00.000Z",
              },
              {
                id: "event-3",
                taskId: "task-1",
                sequence: 3,
                status: "completed",
                message: "Task completed.",
                createdAt: "2026-07-29T00:03:00.000Z",
              },
            ],
          }),
        ]),
    );

    render(<ProjectPanel />);

    const cockpit = await screen.findByTestId("collaboration-cockpit");
    const navigation = within(cockpit).getByRole("complementary", {
      name: "项目导航",
    });
    const flow = within(cockpit).getByRole("main", { name: "任务事件流" });
    const context = within(cockpit).getByRole("complementary", {
      name: "当前任务上下文",
    });

    expect(within(navigation).getByRole("button", { name: "Launch plan" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await within(flow).findByText("任务已完成。")).toBeInTheDocument();
    expect(within(flow).getByText("已完成", { selector: ".status-label" })).toBeInTheDocument();
    await user.click(within(context).getByRole("tab", { name: "骨架运行" }));
    expect(within(context).getByText("Prepare launch notes")).toBeInTheDocument();
    expect(within(context).getByText("Launch notes ready.")).toBeInTheDocument();
    expect(within(context).getByText("状态：已完成")).toBeInTheDocument();
  });
});
