// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionPanel } from "@/components/execution/execution-panel";

const PROJECT_ID = "project-execution-cards";
const RUN_ID = "run-execution-cards";

function execution(
  id: string,
  status: "queued" | "running" | "waiting_approval" | "paused" | "staged"
    | "stale" | "conflicted" | "failed" | "stopped" | "merged" = "running",
  overrides: Record<string, unknown> = {},
) {
  return {
    agent: {
      accentToken: id === "execution-b" ? "clay" : "sage",
      avatarText: id === "execution-b" ? "B" : "A",
      id: `agent-${id}`,
      name: id === "execution-b" ? "Beta" : "Alpha",
    },
    attemptNo: 1,
    businessDeadlineAt: "2026-07-30T08:15:00.000Z",
    businessRounds: 4,
    createdAt: "2026-07-30T08:00:00.000Z",
    currentAction: {
      actionIndex: null,
      kind: null,
      lastHeartbeatAt: null,
      overallDeadlineAt: null,
      startedAt: null,
    },
    firstRunningAt: "2026-07-30T08:00:00.000Z",
    id,
    limits: {
      businessClockStarts: "first_running",
      businessRounds: 20,
      businessWallClockSeconds: 900,
      commandSeconds: 120,
      sandboxBuildSeconds: 900,
      toolCalls: 40,
    },
    manualRecoveryRequired: false,
    mergedAt: status === "merged" ? "2026-07-30T08:05:00.000Z" : null,
    projectId: PROJECT_ID,
    reasonCode: status === "paused" ? "PROVIDER_TIMEOUT" : null,
    resumeTarget: status === "paused" ? "running" : null,
    sourceCollaborationRunId: RUN_ID,
    status,
    toolCalls: 7,
    updatedAt: "2026-07-30T08:05:00.000Z",
    usage: {
      completionTokens: 300,
      maxTokens: 2_000,
      promptTokens: 600,
      totalTokens: 900,
    },
    version: 3,
    workItem: { id: `task-${id}`, title: `Task ${id.slice(-1).toUpperCase()}` },
    ...overrides,
  };
}

function installFetch(
  executions: ReturnType<typeof execution>[],
  handler?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const handled = await handler?.(url, init);
    if (handled) return handled;
    if (url.pathname.endsWith("/mission")) {
      return Response.json({ mission: null, workItems: [] });
    }
    if (url.pathname.endsWith("/collaboration")) {
      return Response.json({ run: { id: RUN_ID, status: "planned" } });
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/executions`) {
      return Response.json({ executions });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("T-28 desktop ExecutionCards", () => {
  it("renders at most two independent cards with action, progress, blocker, controls, and token-backed accessibility", async () => {
    const first = execution("execution-a", "paused", {
      currentAction: {
        actionIndex: 2,
        kind: "command",
        lastHeartbeatAt: "2026-07-30T08:04:00.000Z",
        overallDeadlineAt: "2026-07-30T08:06:00.000Z",
        startedAt: "2026-07-30T08:04:00.000Z",
      },
    });
    installFetch([first, execution("execution-b", "staged"), execution("execution-c", "failed")]);

    render(createElement(ExecutionPanel, { projectId: PROJECT_ID }));

    const cards = await screen.findAllByRole("region", { name: /Task [AB]/ });
    expect(cards).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Task C" })).not.toBeInTheDocument();
    const card = cards[0]!;
    expect(within(card).getByText("Alpha")).toBeInTheDocument();
    expect(within(card).getByText("已暂停")).toBeInTheDocument();
    expect(within(card).getByText("正在运行命令")).toBeInTheDocument();
    expect(within(card).getByText(/PROVIDER_TIMEOUT/)).toBeInTheDocument();
    expect(within(card).getByRole("progressbar", { name: "业务回合进度" })).toHaveAttribute("aria-valuenow", "4");
    expect(within(card).getByRole("progressbar", { name: "工具调用进度" })).toHaveAttribute("aria-valuenow", "7");
    expect(within(card).getByRole("progressbar", { name: "Token 进度" })).toHaveAttribute("aria-valuenow", "900");
    expect(within(card).getByRole("button", { name: "继续 Task A" })).toHaveStyle({
      minHeight: "var(--control-min)",
    });
  });

  it("advances two runnable cards independently with one request per card and two globally", async () => {
    const pending: Array<{ body: { operationId: string }; id: string; resolve: (response: Response) => void }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    installFetch(
      [execution("execution-a"), execution("execution-b"), execution("execution-c")],
      (url, init) => {
        if (!url.pathname.endsWith("/advance")) return undefined;
        const id = url.pathname.split("/")[3]!;
        const body = JSON.parse(String(init?.body)) as { operationId: string };
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<Response>((resolve) => {
          pending.push({
            body,
            id,
            resolve: (response) => {
              inFlight -= 1;
              resolve(response);
            },
          });
        });
      },
    );

    render(createElement(ExecutionPanel, { projectId: PROJECT_ID }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(new Set(pending.map(({ id }) => id))).toEqual(new Set(["execution-a", "execution-b"]));
    expect(maxInFlight).toBe(2);
    expect(pending.filter(({ id }) => id === "execution-a")).toHaveLength(1);
    expect(pending.filter(({ id }) => id === "execution-b")).toHaveLength(1);
  });

  it("reuses a failed logical operation on retry, creates a fresh next step, and isolates another card", async () => {
    const user = userEvent.setup();
    const operationIds: string[] = [];
    let firstFails = true;
    installFetch(
      [execution("execution-a"), execution("execution-b", "waiting_approval")],
      (url, init) => {
        if (url.pathname.endsWith("/control")) {
          return Response.json({
            execution: execution("execution-a", "running", { version: 5 }),
          });
        }
        if (!url.pathname.endsWith("/advance")) return undefined;
        const body = JSON.parse(String(init?.body)) as { operationId: string };
        operationIds.push(body.operationId);
        if (firstFails) {
          firstFails = false;
          return Promise.reject(new TypeError("network down"));
        }
        return Response.json({
          actionResult: { kind: "model", status: "succeeded", summary: "step complete" },
          attempt: { attemptNo: 1, id: "attempt-a", status: "ready" },
          execution: execution("execution-a", "paused", { version: 4 }),
          newEvents: [],
        });
      },
    );

    render(createElement(ExecutionPanel, { projectId: PROJECT_ID }));
    const retry = await screen.findByRole("button", { name: "重试推进 Task A" });
    expect(screen.getByRole("heading", { name: "Task B" })).toBeInTheDocument();
    await user.click(retry);
    await waitFor(() => expect(operationIds).toHaveLength(2));
    expect(operationIds[1]).toBe(operationIds[0]);

    await user.click(screen.getByRole("button", { name: "继续 Task A" }));
    await waitFor(() => expect(operationIds).toHaveLength(3));
    expect(operationIds[2]).not.toBe(operationIds[1]);
  });

  it("never advances preparing or terminal cards and does not auto-select a replacement task", async () => {
    const fetchMock = installFetch([
      execution("execution-a", "queued", {
        currentAction: {
          actionIndex: 0,
          kind: "sandbox_build",
          lastHeartbeatAt: null,
          overallDeadlineAt: "2026-07-30T08:15:00.000Z",
          startedAt: "2026-07-30T08:00:00.000Z",
        },
      }),
      execution("execution-b", "stopped"),
    ]);

    render(createElement(ExecutionPanel, { projectId: PROJECT_ID }));
    await screen.findByText("正在准备隔离区");
    await Promise.resolve();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/advance"))).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("keeps one card usable when the other card control and refresh fail", async () => {
    const user = userEvent.setup();
    installFetch(
      [execution("execution-a", "paused"), execution("execution-b", "paused")],
      (url) => {
        if (url.pathname === "/api/executions/execution-a/control") {
          return Response.json(
            { error: { code: "EXECUTION_STATE_CONFLICT", message: "changed" } },
            { status: 409 },
          );
        }
        if (url.pathname === "/api/executions/execution-a") {
          return Response.json(
            { error: { code: "STORAGE_UNAVAILABLE", message: "down" } },
            { status: 503 },
          );
        }
        return undefined;
      },
    );

    render(createElement(ExecutionPanel, { projectId: PROJECT_ID }));
    const second = await screen.findByRole("region", { name: "Task B" });
    await user.click(screen.getByRole("button", { name: "继续 Task A" }));
    expect(await screen.findByText("无法执行控制操作，请重试。")).toBeInTheDocument();
    expect(within(second).getByText("已暂停")).toBeInTheDocument();
    expect(within(second).getByRole("button", { name: "继续 Task B" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "刷新 Task A" }));
    expect(await screen.findByText("服务暂时不可用，请稍后重试。")).toBeInTheDocument();
    expect(within(second).getByRole("button", { name: "刷新 Task B" })).toBeEnabled();
  });
});
