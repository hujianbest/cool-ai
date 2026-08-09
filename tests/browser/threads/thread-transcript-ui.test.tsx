// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import type {
  ThreadFactDto,
  ThreadMessageDto,
} from "@/src/shared/collaboration-contracts";
import {
  TEST_THREAD_ID,
  threadPolicy,
  threadRun,
  threadSummary,
} from "@/tests/cockpit-test-fetch";

const projectId = "project-1";

function message(
  id: string,
  sequence: number,
  authorType: "owner" | "agent",
  content: string,
  threadId = TEST_THREAD_ID,
): ThreadMessageDto {
  return {
    authorAgentId: authorType === "agent" ? "agent-a" : null,
    authorDisplayName: authorType === "agent" ? "Alpha" : "项目所有者",
    authorType,
    content,
    createdAt: `2026-08-08T00:00:0${sequence}.000Z`,
    id,
    mentionAgentId: null,
    mentionDisplayName: null,
    mentionMemberStatus: null,
    projectId,
    runId: "run-1",
    sequence,
    threadId,
  };
}

function messageFact(
  id: string,
  sequence: number,
  nestedMessage: ThreadMessageDto,
): ThreadFactDto {
  return {
    activitySequence: sequence,
    actorId: nestedMessage.authorAgentId,
    actorType: nestedMessage.authorType,
    createdAt: nestedMessage.createdAt,
    id,
    message: nestedMessage,
    messageId: nestedMessage.id,
    payload: { messageId: nestedMessage.id },
    policyRevisionId: null,
    projectId,
    runEventId: null,
    runId: nestedMessage.runId,
    sequence,
    threadId: nestedMessage.threadId,
    type: nestedMessage.authorType === "owner" ? "owner_message" : "agent_message",
  };
}

function runEventFact(
  id: string,
  sequence: number,
  eventType: "model_call_started" | "run_started",
  threadId = TEST_THREAD_ID,
): ThreadFactDto {
  return {
    activitySequence: sequence,
    actorId: eventType === "model_call_started" ? "agent-a" : null,
    actorType: eventType === "model_call_started" ? "agent" : "owner",
    createdAt: `2026-08-08T00:00:0${sequence}.000Z`,
    id,
    message: null,
    messageId: null,
    payload: { eventType },
    policyRevisionId: null,
    projectId,
    runEventId: `event-${id}`,
    runId: "run-1",
    sequence,
    threadId,
    type: "run_event",
  };
}

function detail(threadId = TEST_THREAD_ID) {
  const run = threadRun(projectId);
  const selectedRun = { ...run, threadId };
  const summary = { ...threadSummary(projectId), id: threadId };
  return {
    activeRun: { runId: selectedRun.id, threadId },
    readiness: {
      dispatch: "ready" as const,
      missingProjectFacts: [],
      selectedMemberId: "agent-a",
    },
    runs: [selectedRun],
    selectedRun: null,
    thread: { ...summary, policy: threadPolicy() },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("strict thread fact transcript", () => {
  it("loads the next fact page only when requested and disables the pending control", async () => {
    const owner = message("message-owner", 1, "owner", "Owner page");
    const agent = message("message-agent", 2, "agent", "Agent page");
    let resolveNext!: (response: Response) => void;
    const pendingNext = new Promise<Response>((resolve) => {
      resolveNext = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(Response.json({ items: [owner, agent], nextAfter: null }));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-owner", 1, owner)],
              nextAfter: 1,
            }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts?after=1`)) {
          return pendingNext;
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <CollaborationPanel
        projectId={projectId}
        threadId={TEST_THREAD_ID}
      />,
    );

    expect(await screen.findByText("Owner page")).toBeInTheDocument();
    expect(screen.queryByText("Agent page")).not.toBeInTheDocument();
    const loadMore = screen.getByRole("button", { name: "加载更多事实" });
    await user.click(loadMore);
    expect(loadMore).toBeDisabled();
    expect(loadMore).toHaveFocus();
    expect(screen.getByRole("log", { name: "协作时间线" })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    resolveNext(
      Response.json({
        items: [messageFact("fact-agent", 2, agent)],
        nextAfter: null,
      }),
    );
    expect(await screen.findByText("Agent page")).toBeInTheDocument();
    expect(screen.getByLabelText("时间线更新摘要")).toHaveTextContent(
      "已加载 1 条事实",
    );
    expect(loadMore).toHaveFocus();
    expect(screen.queryByRole("button", { name: "加载更多事实" })).toBeNull();
  });

  it("renders each nested owner or Agent message once and never maps the messages page", async () => {
    const owner = message("message-owner", 1, "owner", "Owner fact content");
    const agent = message("message-agent", 2, "agent", "Agent fact content");
    const messagesOnly = message("message-ghost", 3, "owner", "Messages page only");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(
            Response.json({ items: [owner, agent, messagesOnly], nextAfter: null }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [
                messageFact("fact-owner", 1, owner),
                messageFact("fact-agent", 2, agent),
                runEventFact("fact-call", 3, "model_call_started"),
              ],
              nextAfter: null,
            }),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <CollaborationPanel
        projectId={projectId}
        threadId={TEST_THREAD_ID}
      />,
    );

    expect(await screen.findAllByText("Owner fact content")).toHaveLength(1);
    expect(screen.getAllByText("Agent fact content")).toHaveLength(1);
    expect(screen.getByText("正在调用模型")).toBeInTheDocument();
    expect(screen.queryByText("Messages page only")).toBeNull();
    expect(screen.getByRole("log", { name: "协作时间线" }).querySelectorAll("li"))
      .toHaveLength(3);
  });

  it("covers loading, empty, failed fact retry, and fail-closed tuple validation", async () => {
    let resolveFacts!: (response: Response) => void;
    const pendingFacts = new Promise<Response>((resolve) => {
      resolveFacts = resolve;
    });
    const ghost = message("message-ghost", 1, "owner", "Not a fact");
    let factReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(Response.json({ items: [ghost], nextAfter: null }));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          factReads += 1;
          if (factReads === 1) return pendingFacts;
          if (factReads === 2) {
            return Promise.resolve(
              Response.json(
                { error: { code: "STORAGE_UNAVAILABLE", message: "private detail" } },
                { status: 503 },
              ),
            );
          }
          return Promise.resolve(Response.json({ items: [], nextAfter: null }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    const view = render(
      <CollaborationPanel
        projectId={projectId}
        threadId={TEST_THREAD_ID}
      />,
    );

    expect(screen.getByText("正在加载项目群聊…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    resolveFacts(
      Response.json({
        items: [{
          ...messageFact("fact-wrong", 1, ghost),
          projectId: "other-project",
        }],
        nextAfter: null,
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("无法加载项目群聊");
    expect(screen.queryByText("Not a fact")).toBeNull();

    await user.click(screen.getByRole("button", { name: "重试加载群聊" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用");
    expect(screen.queryByText("private detail")).toBeNull();
    await user.click(screen.getByRole("button", { name: "重试加载群聊" }));
    expect(await screen.findByText("尚无协作消息。请发送第一条消息。"))
      .toBeInTheDocument();
    expect(screen.getByLabelText("发送给项目群聊")).toBeEnabled();
    view.unmount();
  });

  it("deduplicates overlapping polls by fact id, orders by sequence, and preserves scroll", async () => {
    const first = message("message-1", 1, "owner", "First message");
    const second = message("message-2", 2, "agent", "Second message");
    let factReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(Response.json({ items: [first, second], nextAfter: null }));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          factReads += 1;
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-1", 1, first)],
              nextAfter: null,
            }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts?after=1`)) {
          return Promise.resolve(
            Response.json({
              items: [
                messageFact("fact-1", 1, first),
                messageFact("fact-2", 2, second),
              ],
              nextAfter: null,
            }),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <CollaborationPanel
        projectId={projectId}
        threadId={TEST_THREAD_ID}
      />,
    );
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

    expect(await screen.findAllByText("First message")).toHaveLength(1);
    expect(screen.getAllByText("Second message")).toHaveLength(1);
    expect(Array.from(log.querySelectorAll("li")).map((item) => item.textContent))
      .toEqual([
        expect.stringContaining("First message"),
        expect.stringContaining("Second message"),
      ]);
    expect(log.scrollTop).toBe(100);
    expect(screen.getByRole("button", { name: "查看新事件" })).toBeVisible();
    expect(screen.getByLabelText("时间线更新摘要")).toHaveTextContent(
      "有 1 条新事件",
    );
    expect(factReads).toBe(1);
  });

  it("clears the previous transcript on thread switch and ignores its delayed poll", async () => {
    const oldThread = TEST_THREAD_ID;
    const newThread = "thread-2";
    const oldMessage = message("message-old", 1, "owner", "Old transcript", oldThread);
    const newMessage = message("message-new", 1, "agent", "New transcript", newThread);
    let resolveOldPoll!: (response: Response) => void;
    const oldPoll = new Promise<Response>((resolve) => {
      resolveOldPoll = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const threadId = url.includes(`/threads/${newThread}`) ? newThread : oldThread;
        if (url.endsWith(`/threads/${threadId}`)) {
          return Promise.resolve(Response.json(detail(threadId)));
        }
        if (url.endsWith(`/threads/${threadId}/messages`)) {
          return Promise.resolve(
            Response.json({
              items: threadId === oldThread ? [oldMessage] : [newMessage],
              nextAfter: null,
            }),
          );
        }
        if (url.endsWith(`/threads/${oldThread}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-old", 1, oldMessage)],
              nextAfter: null,
            }),
          );
        }
        if (url.endsWith(`/threads/${oldThread}/facts?after=1`)) return oldPoll;
        if (url.endsWith(`/threads/${newThread}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-new", 1, newMessage)],
              nextAfter: null,
            }),
          );
        }
        if (url.endsWith(`/threads/${newThread}/facts?after=1`)) {
          return Promise.resolve(Response.json({ items: [], nextAfter: null }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const view = render(
      <CollaborationPanel projectId={projectId} threadId={oldThread} />,
    );
    expect(await screen.findByText("Old transcript")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_050));
    });

    view.rerender(
      <CollaborationPanel projectId={projectId} threadId={newThread} />,
    );
    expect(screen.queryByText("Old transcript")).toBeNull();
    expect(await screen.findByText("New transcript")).toBeInTheDocument();
    resolveOldPoll(
      Response.json({
        items: [messageFact("fact-old-late", 2, {
          ...oldMessage,
          content: "Late old response",
          id: "message-old-late",
          sequence: 2,
        })],
        nextAfter: null,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Late old response")).toBeNull()
    );
  });
});
