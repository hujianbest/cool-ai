// @vitest-environment jsdom
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
import {
  TEST_THREAD_ID,
  threadPolicy,
  threadSummary,
} from "@/tests/cockpit-test-fetch";

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
      items: events.some((item) => item.type === "agent_message") ? [
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
      ] : [],
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

function strictThreadResponse(
  url: string,
  payload: CollaborationReadResponse,
): Response {
  const projectId = decodeURIComponent(
    url.match(/^\/api\/projects\/([^/]+)/)?.[1] ?? "project-1",
  );
  const messages = payload.projectMessagesPage.items.map((item) => ({
    ...item,
    projectId,
    threadId: TEST_THREAD_ID,
  }));
  const linkedMessageIds = new Set(
    payload.timelinePage.items.flatMap((item) =>
      item.type === "owner_message" || item.type === "agent_message"
        ? [item.payload.messageId]
        : []
    ),
  );
  const sources = [
    ...payload.timelinePage.items.map((item) => ({
      createdAt: item.createdAt,
      event: item,
      id: item.id,
      message: item.type === "owner_message" || item.type === "agent_message"
        ? messages.find((candidate) => candidate.id === item.payload.messageId) ?? null
        : null,
    })),
    ...messages
      .filter((item) => !linkedMessageIds.has(item.id))
      .map((item) => ({
        createdAt: item.createdAt,
        event: null,
        id: item.id,
        message: item,
      })),
  ].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
  const facts = sources.map((source, index) => {
    const sequence = source.event?.sequence ?? source.message?.sequence ?? index + 1;
    if (source.message) {
      return {
        activitySequence: sequence,
        actorId: source.message.authorAgentId,
        actorType: source.message.authorType,
        createdAt: source.createdAt,
        id: `fact-${source.message.id}`,
        message: source.message,
        messageId: source.message.id,
        payload: { messageId: source.message.id },
        policyRevisionId: null,
        projectId,
        runEventId: null,
        runId: source.message.runId,
        sequence,
        threadId: TEST_THREAD_ID,
        type: source.message.authorType === "owner" ? "owner_message" : "agent_message",
      };
    }
    const event = source.event!;
    return {
      activitySequence: sequence,
      actorId: event.actorId,
      actorType: event.actorType,
      createdAt: event.createdAt,
      id: `fact-${event.id}`,
      message: null,
      messageId: null,
      payload: { eventType: event.type },
      policyRevisionId: null,
      projectId,
      runEventId: event.id,
      runId: event.runId,
      sequence,
      threadId: TEST_THREAD_ID,
      type: "run_event",
    };
  });
  if (url.includes("/messages")) {
    return response({ items: messages, nextAfter: payload.projectMessagesPage.nextAfter });
  }
  if (url.includes("/facts")) {
    return response({
      items: facts,
      nextAfter: payload.timelinePage.nextAfter ?? payload.projectMessagesPage.nextAfter,
    });
  }
  if (url.includes("/timeline")) {
    return response({
      items: payload.timelinePage.items.map((item) => ({
        ...item,
        projectId,
        threadId: TEST_THREAD_ID,
      })),
      nextAfter: payload.timelinePage.nextAfter,
    });
  }
  const selectedRun = payload.run
    ? { ...payload.run, projectId, threadId: TEST_THREAD_ID }
    : null;
  return response({
    activeRun: selectedRun
      ? { runId: selectedRun.id, threadId: TEST_THREAD_ID }
      : null,
    readiness: {
      dispatch: "ready",
      missingProjectFacts: [],
      selectedMemberId: selectedRun?.currentAgentId ?? null,
    },
    runs: selectedRun ? [selectedRun] : [],
    selectedRun,
    thread: {
      ...threadSummary(projectId),
      policy: threadPolicy(),
    },
  });
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
          : Promise.resolve(
              strictThreadResponse(String(input), read("paused", events)),
            ),
      ),
    );

    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId: TEST_THREAD_ID,
    }));

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
        return Promise.resolve(
          strictThreadResponse(
            url,
            read("paused", reads <= 4 ? [first] : [first, second]),
          ),
        );
      }),
    );

    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId: TEST_THREAD_ID,
    }));
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
    const secondPage = read("paused", [second]);
    const pollPage = read("paused", [second, third]);
    const factUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/members")) return Promise.resolve(response(members));
        if (url.includes("/facts")) {
          factUrls.push(url);
          if (url.endsWith("/facts")) {
            return Promise.resolve(strictThreadResponse(url, firstPage));
          }
          if (url.endsWith("/facts?after=1")) {
            return Promise.resolve(strictThreadResponse(url, secondPage));
          }
          if (url.endsWith("/facts?after=2")) {
            return Promise.resolve(strictThreadResponse(url, pollPage));
          }
        }
        if (url.includes("?after=1")) {
          return Promise.resolve(strictThreadResponse(url, secondPage));
        }
        return Promise.resolve(strictThreadResponse(url, firstPage));
      }),
    );
    const user = userEvent.setup();

    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId: TEST_THREAD_ID,
    }));
    const log = await screen.findByRole("log", { name: "协作时间线" });
    expect(log.querySelectorAll("li:not([tabindex])")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "加载更多事实" }));
    await waitFor(() => expect(log.querySelectorAll("li:not([tabindex])")).toHaveLength(2));
    expect(factUrls).toContain(
      `/api/projects/project-1/threads/${TEST_THREAD_ID}/facts?after=1`,
    );

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
    expect(factUrls.at(-1)).toContain("/facts?after=2");
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
        return Promise.resolve(strictThreadResponse(url, read("running")));
      }),
    );

    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId: TEST_THREAD_ID,
    }));
    await screen.findByRole("region", { name: "运行控制" });
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
          strictThreadResponse(
            url,
            read(projectStatus ?? (attempts ? "paused" : "running")),
          ),
        );
      }),
    );

    const view = render(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId: TEST_THREAD_ID,
    }));
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
        createElement(CollaborationPanel, {
          projectId: `project-${status}`,
          selectedRunId: "run-1",
          threadId: TEST_THREAD_ID,
        }),
      );
      await screen.findByRole("region", { name: "运行控制" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(bodies).toHaveLength(before);
      stoppedView.unmount();
    }
  });
});
