// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionPanel } from "@/components/execution/execution-panel";

const PROJECT_ID = "project-rescue-ui";
const EXECUTION_ID = "execution-rescue";

function execution(overrides: Record<string, unknown> = {}) {
  return {
    agent: { accentToken: "sage", avatarText: "A", id: "agent-a", name: "Alpha" },
    attemptNo: 1,
    businessDeadlineAt: "2026-08-21T08:15:00.000Z",
    businessRounds: 2,
    createdAt: "2026-08-21T08:00:00.000Z",
    currentAction: {
      actionIndex: null,
      kind: null,
      lastHeartbeatAt: null,
      overallDeadlineAt: null,
      startedAt: null,
    },
    firstRunningAt: "2026-08-21T08:00:00.000Z",
    id: EXECUTION_ID,
    limits: {
      businessClockStarts: "first_running",
      businessRounds: 20,
      businessWallClockSeconds: 900,
      commandSeconds: 120,
      sandboxBuildSeconds: 900,
      toolCalls: 40,
    },
    manualRecoveryRequired: false,
    mergedAt: null,
    projectId: PROJECT_ID,
    reasonCode: "STALE_EXECUTION",
    resumeTarget: null,
    sourceCollaborationRunId: "run-rescue",
    sourceCollaborationThreadId: "thread-rescue",
    status: "stale",
    toolCalls: 3,
    updatedAt: "2026-08-21T08:05:00.000Z",
    usage: { completionTokens: 100, maxTokens: 2_000, promptTokens: 200, totalTokens: 300 },
    version: 4,
    workItem: { id: "task-rescue", title: "重构 auth.ts" },
    ...overrides,
  };
}

function installFetch() {
  const calls: Array<{ body: Record<string, unknown>; path: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/mission")) return Response.json({ mission: null, workItems: [] });
    if (url.pathname === `/api/projects/${PROJECT_ID}/executions`) {
      return Response.json({ executions: [execution()] });
    }
    if (url.pathname === `/api/executions/${EXECUTION_ID}`) {
      return Response.json({
        counts: {
          approvals: 0,
          artifacts: 0,
          events: 0,
          mergeFiles: 0,
          stagedBlockers: 0,
          stagedObservations: 0,
          validations: 0,
        },
        execution: execution(),
        frozen: {
          policyHash: "a".repeat(64),
          policyRevisionId: "policy-1",
          policyVersion: 1,
        },
        staged: null,
      });
    }
    if (
      url.pathname.endsWith("/events")
      || url.pathname.endsWith("/approvals")
      || url.pathname.endsWith("/validations")
      || url.pathname.endsWith("/artifacts")
    ) {
      return Response.json({ items: [], nextCursor: null });
    }
    if (
      url.pathname.endsWith("/recovery-actions/resume_queued/execute")
      && init?.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ body, path: url.pathname });
      return Response.json({
        actionId: "resume_queued",
        executionId: EXECUTION_ID,
        fromStatus: "stale",
        toStatus: "queued",
        version: 5,
        writesFiles: false,
      });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("S-44 recovery operations UI", () => {
  it("opens rescue from the execution card, previews, executes, and hides free command input", async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    render(<ExecutionPanel projectId={PROJECT_ID} />);

    const card = await screen.findByRole("region", { name: "重构 auth.ts" });
    await user.click(within(card).getByRole("button", { name: "救援" }));

    const dialog = await screen.findByRole("dialog", { name: /救援 · 任务「重构 auth.ts」/u });
    expect(dialog).toHaveTextContent("STALE_EXECUTION");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).getByRole("combobox", { name: "可选动作" })).toHaveDisplayValue(
      "恢复到可运行队列",
    );

    const execute = within(dialog).getByRole("button", { name: "执行救援" });
    expect(execute).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "预览" }));
    expect(dialog).toHaveTextContent("不改工作区文件");
    expect(dialog).toHaveTextContent("Execution 回到 queued");
    expect(within(dialog).getByRole("button", { name: "撤销" })).toBeDisabled();

    await user.click(execute);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({
      confirmation: "执行救援",
      expectedVersion: 4,
    });
    expect(calls[0]?.body).not.toHaveProperty("command");
  });

  it("does not offer rescue for an unknown fault", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/mission")) return Response.json({ mission: null, workItems: [] });
      if (url.pathname === `/api/projects/${PROJECT_ID}/executions`) {
        return Response.json({
          executions: [execution({ reasonCode: "PROVIDER_TIMEOUT", status: "paused" })],
        });
      }
      if (url.pathname === `/api/executions/${EXECUTION_ID}`) {
        return Response.json({
          counts: {
            approvals: 0,
            artifacts: 0,
            events: 0,
            mergeFiles: 0,
            stagedBlockers: 0,
            stagedObservations: 0,
            validations: 0,
          },
          execution: execution({ reasonCode: "PROVIDER_TIMEOUT", status: "paused" }),
          frozen: {
            policyHash: "a".repeat(64),
            policyRevisionId: "policy-1",
            policyVersion: 1,
          },
          staged: null,
        });
      }
      return Response.json({ items: [], nextCursor: null });
    }));
    render(<ExecutionPanel projectId={PROJECT_ID} />);
    const card = await screen.findByRole("region", { name: "重构 auth.ts" });
    expect(within(card).queryByRole("button", { name: "救援" })).toBeNull();
    expect(within(card).queryByRole("textbox")).toBeNull();
  });
});
