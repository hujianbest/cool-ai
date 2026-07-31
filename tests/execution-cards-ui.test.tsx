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

describe("T-45 merge wiring", () => {
  it("uses a dedicated merge operation and never sends staged merge through advance", async () => {
    const user = userEvent.setup();
    const current = execution("execution-a", "staged");
    const requests: Array<{ body: Record<string, unknown>; path: string }> = [];
    let manualRecovery = false;
    installFetch([current], (url, init) => {
      if (url.pathname === "/api/executions/execution-a") {
        const hash = "a".repeat(64);
        return Response.json({
          counts: {
            approvals: 0,
            artifacts: 0,
            events: 0,
            mergeFiles: 1,
            stagedBlockers: 0,
            stagedObservations: 1,
            validations: 1,
          },
          execution: manualRecovery
            ? execution("execution-a", "conflicted", {
                manualRecoveryRequired: true,
                reasonCode: "MANUAL_RECOVERY_REQUIRED",
                version: 4,
              })
            : current,
          frozen: {
            agentVersion: 1,
            baselineManifestHash: hash,
            contextHash: hash,
            memoryHash: hash,
            missionVersion: 1,
            permissionsHash: hash,
            policyHash: hash,
            policyRevisionId: "policy",
            policyVersion: 1,
            providerVersion: 1,
            rosterHash: hash,
            skillsHash: hash,
            taskVersion: 1,
          },
          recovery: manualRecovery
            ? {
                allowedResolutions: ["recovered_old", "recovered_new", "abandon"],
                journalStatus: "manual_recovery",
                mismatchPhase: "apply_or_rollback",
                observedManifestHash: "c".repeat(64),
                oldManifestHash: "d".repeat(64),
                postManifestHash: "e".repeat(64),
                required: true,
              }
            : {
                allowedResolutions: [],
                journalStatus: null,
                mismatchPhase: null,
                observedManifestHash: null,
                oldManifestHash: null,
                postManifestHash: null,
                required: false,
              },
          staged: {
            blockReasons: [],
            blockerCount: 0,
            blockerCounts: {},
            classification: "auto_eligible",
            id: "staged-a",
            mergeFileCount: 1,
            mergeFinalBytes: 6,
            observedFinalBytes: 6,
            observedPathCount: 1,
            stagedHash: "b".repeat(64),
          },
        });
      }
      if (
        url.pathname.endsWith("/events")
        || url.pathname.endsWith("/approvals")
        || url.pathname.endsWith("/artifacts")
        || url.pathname.endsWith("/observations")
        || url.pathname.endsWith("/blockers")
      ) {
        return Response.json({ items: [], nextCursor: null });
      }
      if (url.pathname.endsWith("/recovery/files")) {
        return Response.json({ items: [], nextCursor: null });
      }
      if (url.pathname.endsWith("/validations")) {
        const hash = "a".repeat(64);
        return Response.json({
          items: [{
            afterLastWrite: true,
            exitCode: 0,
            finishedAt: "2026-08-01T04:00:00.000Z",
            id: "validation-a",
            policyEntryId: "required-a",
            required: true,
            stderr: { bytes: 0, sha256: hash, truncated: false },
            stdout: { bytes: 0, sha256: hash, truncated: false },
            succeeded: true,
          }],
          nextCursor: null,
        });
      }
      if (init?.method === "POST") {
        requests.push({
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
          path: url.pathname,
        });
        manualRecovery = true;
        return Response.json(
          { error: { code: "MANUAL_RECOVERY_REQUIRED", message: "external writer" } },
          { status: 409 },
        );
      }
      return undefined;
    });

    render(createElement(ExecutionPanel, { projectId: PROJECT_ID }));
    const card = await screen.findByRole("region", { name: "Task A" });
    await user.click(await within(card).findByRole("tab", { name: "变更" }));
    await user.click(await within(card).findByRole("button", { name: "自动合入当前变更" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.path).toBe("/api/executions/execution-a/merge");
    expect(requests[0]?.body).toMatchObject({
      expectedVersion: 3,
      stagedHash: "b".repeat(64),
    });
    expect(requests[0]?.body.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(await within(card).findByRole("region", { name: "需要人工恢复" }))
      .toBeInTheDocument();
  });
});
