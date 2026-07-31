import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import type {
  CollaborationReadResponse,
  CollaborationRun,
  TimelineEvent,
} from "@/src/shared/collaboration-contracts";
import type { MembershipState } from "@/src/shared/project-context-contracts";

const members: MembershipState = {
  members: [
    {
      accentToken: "sage",
      agentId: "agent-a",
      avatarText: "A",
      joinedAt: "2026-07-30T00:00:00.000Z",
      model: "test-model",
      name: "Alpha",
      permissions: { readFiles: true, runCommands: false, writeFiles: false },
      role: "Peer",
      skillNames: [],
    },
  ],
  projectVersion: 1,
};

function run(status: CollaborationRun["status"] = "paused"): CollaborationRun {
  return {
    createdAt: "2026-07-30T00:00:00.000Z",
    currentAgentId: "agent-a",
    id: "run-1",
    pauseCategory: status === "paused" ? "manual" : null,
    projectId: "project-1",
    roundCount: 1,
    status,
    updatedAt: "2026-07-30T00:00:00.000Z",
    version: 1,
  };
}

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    actorId: "agent-a",
    actorType: "agent",
    createdAt: "2026-07-30T00:01:00.000Z",
    id: "event-1",
    payload: { agentId: "agent-a", attemptId: "attempt-1", kind: "primary" },
    runId: "run-1",
    sequence: 1,
    type: "model_call_started",
    ...overrides,
  } as TimelineEvent;
}

function read(
  status: CollaborationRun["status"] = "paused",
  events: TimelineEvent[] = [],
): CollaborationReadResponse {
  return {
    pendingDecision: null,
    projectMessagesPage: {
      items: [
        {
          authorAgentId: "agent-a",
          authorDisplayName: "Alpha",
          authorType: "agent",
          content: "A real agent message",
          createdAt: "2026-07-30T00:00:30.000Z",
          id: "message-agent",
          mentionAgentId: null,
          mentionDisplayName: null,
          mentionMemberStatus: null,
          runId: "run-1",
          sequence: 1,
        },
      ],
      nextAfter: null,
    },
    readiness: { missing: [], ready: true },
    run: run(status),
    timelinePage: { items: events, nextAfter: null },
    usage: {
      byAgent: [],
      completionTokens: 0,
      promptTokens: 0,
      repairCalls: 0,
      totalTokens: 0,
      unreportedCalls: 0,
    },
  };
}

function response(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("collaboration timeline and auto-loop", () => {
  it("renders typed messages and model calls as statuses with actor, time, heading, and equal baton", async () => {
    const events: TimelineEvent[] = [
      event(),
      event({
        id: "event-2",
        payload: {
          agentDisplayName: "Alpha",
          agentId: "agent-a",
          messageId: "message-agent",
          messageSequence: 1,
          turnId: "turn-1",
        },
        sequence: 2,
        type: "agent_message",
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).endsWith("/members")
          ? Promise.resolve(response(members))
          : Promise.resolve(response(read("paused", events))),
      ),
    );

    render(createElement(CollaborationPanel, { projectId: "project-1" }));

    const log = await screen.findByRole("log", { name: "协作时间线" });
    expect(log).toHaveTextContent("正在调用模型");
    expect(log).toHaveTextContent("A real agent message");
    expect(log.querySelectorAll("time")).toHaveLength(2);
    expect(log.querySelectorAll("h4")).toHaveLength(2);
    expect(screen.getByText("当前持棒")).toBeInTheDocument();
    expect(await screen.findByLabelText("Alpha 的头像")).toHaveTextContent("A");
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.queryByText(/领导|leader/i)).not.toBeInTheDocument();
    expect(screen.getByText("正在调用模型").closest("li")).not.toHaveTextContent(
      "A real agent message",
    );
  });

  it("polls updates, preserves an above-bottom position, and announces a new-event affordance", async () => {
    const first = event();
    const second = event({
      id: "event-2",
      payload: { attemptId: "attempt-1", kind: "primary" },
      sequence: 2,
      type: "model_call_succeeded",
    });
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/members")) return Promise.resolve(response(members));
        reads += 1;
        return Promise.resolve(response(read("paused", reads === 1 ? [first] : [first, second])));
      }),
    );

    render(createElement(CollaborationPanel, { projectId: "project-1" }));
    const log = await screen.findByRole("log", { name: "协作时间线" });
    Object.defineProperties(log, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    log.scrollTop = 100;
    fireEvent.scroll(log);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });

    expect(await screen.findByRole("button", { name: "查看新事件" })).toBeInTheDocument();
    expect(log.scrollTop).toBe(100);
    expect(screen.getByLabelText("时间线更新摘要")).toHaveTextContent("有 1 条新事件");
    fireEvent.click(screen.getByRole("button", { name: "查看新事件" }));
    expect(log.scrollTop).toBe(500);
  });

  it("loads every initial page, then polls after the last sequences and deduplicates overlap", async () => {
    const first = event();
    const second = event({
      id: "event-2",
      payload: { attemptId: "attempt-1", kind: "primary" },
      sequence: 2,
      type: "model_call_succeeded",
    });
    const third = event({
      id: "event-3",
      payload: { attemptId: "attempt-2", kind: "primary" },
      sequence: 3,
    });
    const firstPage = read("paused", [first]);
    firstPage.timelinePage.nextAfter = 1;
    firstPage.projectMessagesPage.nextAfter = 1;
    const secondPage = read("paused", [second]);
    secondPage.projectMessagesPage.items = [{
      ...secondPage.projectMessagesPage.items[0],
      id: "message-agent-2",
      sequence: 2,
    }];
    const pollPage = read("paused", [second, third]);
    pollPage.projectMessagesPage.items = [
      secondPage.projectMessagesPage.items[0],
      {
        ...secondPage.projectMessagesPage.items[0],
        id: "message-agent-3",
        sequence: 3,
      },
    ];
    const collaborationUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/members")) return Promise.resolve(response(members));
        collaborationUrls.push(url);
        if (url.endsWith("/collaboration")) return Promise.resolve(response(firstPage));
        if (url.includes("messageAfter=1") && url.includes("eventAfter=1")) {
          return Promise.resolve(response(secondPage));
        }
        if (url.includes("messageAfter=2") && url.includes("eventAfter=2")) {
          return Promise.resolve(response(pollPage));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(createElement(CollaborationPanel, { projectId: "project-1" }));
    const log = await screen.findByRole("log", { name: "协作时间线" });
    await waitFor(() => expect(log.querySelectorAll("li:not([tabindex])")).toHaveLength(2));
    expect(collaborationUrls[1]).toContain("messageAfter=1");
    expect(collaborationUrls[1]).toContain("eventAfter=1");

    Object.defineProperties(log, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });

    await waitFor(() => expect(log.querySelectorAll("li:not([tabindex])")).toHaveLength(3));
    expect(collaborationUrls.at(-1)).toContain("messageAfter=2");
    expect(collaborationUrls.at(-1)).toContain("eventAfter=2");
    expect(screen.getByLabelText("时间线更新摘要")).toHaveTextContent("有 1 条新事件");
    expect(log.scrollTop).toBe(100);
  });

  it("keeps one advance in flight and creates a fresh operation id for the next turn", async () => {
    const advanceBodies: Array<{ operationId: string }> = [];
    let resolveFirst!: (value: Response) => void;
    const firstAdvance = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let advanceCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/members")) return Promise.resolve(response(members));
        if (url.endsWith("/advance")) {
          advanceBodies.push(JSON.parse(String(init?.body)) as { operationId: string });
          advanceCalls += 1;
          return advanceCalls === 1
            ? firstAdvance
            : new Promise<Response>(() => undefined);
        }
        return Promise.resolve(response(read("running")));
      }),
    );

    render(createElement(CollaborationPanel, { projectId: "project-1" }));
    await screen.findByRole("log", { name: "协作时间线" });
    await waitFor(() => expect(advanceBodies).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    expect(advanceBodies).toHaveLength(1);

    resolveFirst(response({ run: run("running") }));
    await waitFor(() => expect(advanceBodies).toHaveLength(2), { timeout: 2_500 });
    expect(advanceBodies[1].operationId).not.toBe(advanceBodies[0].operationId);
  });

  it("reuses the logical operation id on retry and stops for every non-running state and unmount", async () => {
    const user = userEvent.setup();
    const bodies: Array<{ operationId: string }> = [];
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/members")) return Promise.resolve(response(members));
        if (url.endsWith("/advance")) {
          bodies.push(JSON.parse(String(init?.body)) as { operationId: string });
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new TypeError("network detail"))
            : Promise.resolve(response({ run: run("paused") }));
        }
        const projectStatus = (
          ["waiting_owner", "paused", "failed", "planned", "stopped"] as const
        ).find((status) => url.includes(`project-${status}`));
        return Promise.resolve(
          response(read(projectStatus ?? (attempts ? "paused" : "running"))),
        );
      }),
    );

    const view = render(createElement(CollaborationPanel, { projectId: "project-1" }));
    expect(await screen.findByRole("button", { name: "重试推进" })).toBeInTheDocument();
    expect(screen.queryByText("network detail")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试推进" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].operationId).toBe(bodies[0].operationId);
    view.unmount();

    for (const status of [
      "waiting_owner",
      "paused",
      "failed",
      "planned",
      "stopped",
    ] as const) {
      const before = bodies.length;
      const stoppedView = render(
        createElement(CollaborationPanel, { projectId: `project-${status}` }),
      );
      await screen.findByRole("log", { name: "协作时间线" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(bodies).toHaveLength(before);
      stoppedView.unmount();
    }
  });
});
