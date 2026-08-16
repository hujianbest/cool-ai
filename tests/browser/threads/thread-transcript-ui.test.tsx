// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  replyTo: ThreadMessageDto["replyTo"] = null,
): ThreadMessageDto {
  return {
    attachments: [],
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
    replyTo,
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
    expect(screen.getByRole("button", { name: "已加载全部事实" })).toHaveClass(
      "sr-only",
    );
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

  it("renders owner and Agent facts as avatar message rows", async () => {
    const owner = message("message-owner", 1, "owner", "Owner fact content");
    const agent = message("message-agent", 2, "agent", "Agent fact content");
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
              items: [
                messageFact("fact-owner", 1, owner),
                messageFact("fact-agent", 2, agent),
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

    expect(await screen.findByLabelText("项目所有者 的消息头像")).toHaveTextContent("项");
    expect(screen.getByLabelText("Alpha 的消息头像")).toHaveTextContent("A");
    const ownerRow = screen.getByText("Owner fact content").closest("li");
    const agentRow = screen.getByText("Agent fact content").closest("li");
    expect(ownerRow).toHaveClass("message-row");
    expect(agentRow).toHaveClass("message-row");
    expect(ownerRow?.querySelector(".msg-avatar")).toHaveClass("owner");
    expect(ownerRow).toHaveTextContent("项目所有者 (Owner)");
    expect(agentRow).toHaveTextContent("Alpha");
  });

  it("keeps message reply actions in the accessibility tree with an idle class", async () => {
    const owner = message("message-owner", 1, "owner", "Owner fact content");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(Response.json({ items: [owner], nextAfter: null }));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-owner", 1, owner)],
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

    const reply = await screen.findByRole("button", {
      name: /回复 项目所有者 的消息/,
    });
    expect(reply).toHaveClass("msg-reply");
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

    expect(screen.getByText("正在加载项目对话…")).toHaveAttribute(
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
    expect(await screen.findByRole("alert")).toHaveTextContent("无法加载项目对话");
    expect(screen.queryByText("Not a fact")).toBeNull();

    await user.click(screen.getByRole("button", { name: "重试加载对话" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用");
    expect(screen.queryByText("private detail")).toBeNull();
    await user.click(screen.getByRole("button", { name: "重试加载对话" }));
    expect(await screen.findByText("尚无协作消息。请发送第一条消息。"))
      .toBeInTheDocument();
    expect(screen.getByLabelText("发送给项目对话")).toBeEnabled();
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

describe("reply reference chip and source jump", () => {
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  );

  beforeEach(() => {
    scrollIntoView.mockClear();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
    } else {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  function replyToTarget(target: ThreadMessageDto): ThreadMessageDto["replyTo"] {
    return {
      authorDisplayName: target.authorDisplayName,
      excerpt: target.content,
      messageId: target.id,
      sequence: target.sequence,
    };
  }

  it("renders the frozen reply chip and jumps to the loaded source with highlight and focus", async () => {
    const target = message("message-target", 1, "owner", "Origin message");
    const reply: ThreadMessageDto = {
      ...message("message-reply", 2, "agent", "Reply content"),
      replyTo: replyToTarget(target),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(Response.json({ items: [target, reply], nextAfter: null }));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [
                messageFact("fact-target", 1, target),
                messageFact("fact-reply", 2, reply),
              ],
              nextAfter: null,
            }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts?after=2`)) {
          return Promise.resolve(Response.json({ items: [], nextAfter: null }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<CollaborationPanel projectId={projectId} threadId={TEST_THREAD_ID} />);

    const chip = await screen.findByRole("button", {
      name: "跳转到来源消息：#1 · 项目所有者 · Origin message",
    });
    expect(chip).toHaveTextContent("#1 · 项目所有者 · Origin message");
    chip.focus();
    expect(chip).toHaveFocus();
    await user.keyboard("{Enter}");

    const list = screen.getByRole("log", { name: "协作时间线" });
    const targetItem = Array.from(list.querySelectorAll("li")).find(
      (item) => Array.from(item.querySelectorAll("p")).some(
        (paragraph) => paragraph.textContent === "Origin message",
      ),
    );
    expect(targetItem).toBeDefined();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView.mock.instances[0]).toBe(targetItem);
    expect(targetItem).toHaveClass("reply-target-highlight");
    await waitFor(() => expect(targetItem).toHaveFocus());
    await waitFor(
      () => expect(targetItem).not.toHaveClass("reply-target-highlight"),
      { timeout: 3_000 },
    );
  });

  it("jumps to the loaded source even while another facts request is in flight", async () => {
    const target = message("message-target", 1, "owner", "Origin message");
    const reply: ThreadMessageDto = {
      ...message("message-reply", 2, "agent", "Reply content"),
      replyTo: replyToTarget(target),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(Response.json({ items: [target, reply], nextAfter: null }));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [
                messageFact("fact-target", 1, target),
                messageFact("fact-reply", 2, reply),
              ],
              nextAfter: 2,
            }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts?after=2`)) {
          return new Promise<Response>(() => {});
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<CollaborationPanel projectId={projectId} threadId={TEST_THREAD_ID} />);

    const chip = await screen.findByRole("button", {
      name: "跳转到来源消息：#1 · 项目所有者 · Origin message",
    });
    const loadMore = await screen.findByRole("button", { name: "加载更多事实" });
    await user.click(loadMore);
    await user.click(chip);

    const list = screen.getByRole("log", { name: "协作时间线" });
    const targetItem = Array.from(list.querySelectorAll("li")).find(
      (item) => Array.from(item.querySelectorAll("p")).some(
        (paragraph) => paragraph.textContent === "Origin message",
      ),
    );
    expect(targetItem).toBeDefined();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.instances[0]).toBe(targetItem);
    expect(targetItem).toHaveClass("reply-target-highlight");
    await waitFor(() => expect(targetItem).toHaveFocus());
  });

  it("loads the source page on demand and locates the target after it arrives", async () => {
    const target = message("message-target", 1, "owner", "Late origin");
    const reply: ThreadMessageDto = {
      ...message("message-reply", 2, "agent", "Reply to late origin"),
      replyTo: replyToTarget(target),
    };
    let resolvePage!: (response: Response) => void;
    const pendingPage = new Promise<Response>((resolve) => {
      resolvePage = resolve;
    });
    let pageRequested = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(Response.json({ items: [target, reply], nextAfter: null }));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-reply", 5, reply)],
              nextAfter: 5,
            }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts?after=5`)) {
          pageRequested = true;
          return pendingPage;
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<CollaborationPanel projectId={projectId} threadId={TEST_THREAD_ID} />);

    const chip = await screen.findByRole("button", {
      name: "跳转到来源消息：#1 · 项目所有者 · Late origin",
    });
    await user.click(chip);
    await waitFor(() => expect(pageRequested).toBe(true));
    expect(chip).toHaveTextContent("正在定位来源消息…");
    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("log", { name: "协作时间线" })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    resolvePage(
      Response.json({
        items: [messageFact("fact-target", 6, target)],
        nextAfter: null,
      }),
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    const list = screen.getByRole("log", { name: "协作时间线" });
    const targetItem = Array.from(list.querySelectorAll("li")).find(
      (item) => Array.from(item.querySelectorAll("p")).some(
        (paragraph) => paragraph.textContent === "Late origin",
      ),
    );
    expect(targetItem).toBeDefined();
    expect(scrollIntoView.mock.instances[0]).toBe(targetItem);
    expect(targetItem).toHaveClass("reply-target-highlight");
  });

  it("shows a neutral disabled placeholder when the source is absent from the readable history", async () => {
    const reply: ThreadMessageDto = {
      ...message("message-reply", 2, "agent", "Reply to missing"),
      replyTo: {
        authorDisplayName: "项目所有者",
        excerpt: "Missing origin",
        messageId: "message-missing",
        sequence: 1,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(Response.json({ items: [reply], nextAfter: null }));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-reply", 1, reply)],
              nextAfter: null,
            }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts?after=1`)) {
          return Promise.resolve(Response.json({ items: [], nextAfter: null }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<CollaborationPanel projectId={projectId} threadId={TEST_THREAD_ID} />);

    const placeholder = await screen.findByRole("button", {
      name: "来源消息不可用，无法跳转：目标消息不在当前可读取的协作历史中。",
    });
    expect(placeholder).toHaveAttribute("aria-disabled", "true");
    expect(placeholder).toHaveTextContent("来源消息不可用");
    expect(placeholder).not.toHaveTextContent("项目所有者");
    expect(placeholder).not.toHaveTextContent("Missing origin");
    await user.click(placeholder);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps loading pages until exhaustion before showing the unavailable placeholder", async () => {
    const reply: ThreadMessageDto = {
      ...message("message-reply", 2, "agent", "Reply to exhausted"),
      replyTo: {
        authorDisplayName: "项目所有者",
        excerpt: "Exhausted origin",
        messageId: "message-missing",
        sequence: 1,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(Response.json({ items: [reply], nextAfter: null }));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-reply", 5, reply)],
              nextAfter: 5,
            }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts?after=5`)) {
          return Promise.resolve(
            Response.json({
              items: [runEventFact("fact-call", 6, "model_call_started")],
              nextAfter: null,
            }),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<CollaborationPanel projectId={projectId} threadId={TEST_THREAD_ID} />);

    const chip = await screen.findByRole("button", {
      name: "跳转到来源消息：#1 · 项目所有者 · Exhausted origin",
    });
    await user.click(chip);
    expect(
      await screen.findByRole("button", {
        name: "来源消息不可用，无法跳转：目标消息不在当前可读取的协作历史中。",
      }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("drops an in-flight source jump when the thread target switches", async () => {
    const oldThread = TEST_THREAD_ID;
    const newThread = "thread-2";
    const oldTarget = message("message-old-target", 1, "owner", "Late old target", oldThread);
    const oldReply: ThreadMessageDto = {
      ...message("message-old-reply", 2, "agent", "Old reply", oldThread),
      replyTo: replyToTarget(oldTarget),
    };
    const newMessage = message("message-new", 1, "agent", "New transcript", newThread);
    let resolvePage!: (response: Response) => void;
    const pendingPage = new Promise<Response>((resolve) => {
      resolvePage = resolve;
    });
    let pageRequested = false;
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
              items: threadId === oldThread ? [oldTarget, oldReply] : [newMessage],
              nextAfter: null,
            }),
          );
        }
        if (url.endsWith(`/threads/${oldThread}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-old-reply", 5, oldReply)],
              nextAfter: 5,
            }),
          );
        }
        if (url.endsWith(`/threads/${oldThread}/facts?after=5`)) {
          pageRequested = true;
          return pendingPage;
        }
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
    const user = userEvent.setup();
    const view = render(
      <CollaborationPanel projectId={projectId} threadId={oldThread} />,
    );
    const chip = await screen.findByRole("button", {
      name: "跳转到来源消息：#1 · 项目所有者 · Late old target",
    });
    await user.click(chip);
    await waitFor(() => expect(pageRequested).toBe(true));

    view.rerender(<CollaborationPanel projectId={projectId} threadId={newThread} />);
    expect(await screen.findByText("New transcript")).toBeInTheDocument();

    resolvePage(
      Response.json({
        items: [messageFact("fact-late-target", 6, oldTarget)],
        nextAfter: null,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Late old target")).toBeNull()
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".reply-target-highlight")).toHaveLength(0);
  });

  it("surfaces a perceivable error and re-enables the chip when the source page load fails", async () => {
    const reply: ThreadMessageDto = {
      ...message("message-reply", 2, "agent", "Reply to failing"),
      replyTo: {
        authorDisplayName: "项目所有者",
        excerpt: "Failing origin",
        messageId: "message-missing",
        sequence: 1,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(Response.json({ items: [reply], nextAfter: null }));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-reply", 5, reply)],
              nextAfter: 5,
            }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts?after=5`)) {
          return Promise.resolve(
            Response.json(
              { error: { code: "STORAGE_UNAVAILABLE", message: "private detail" } },
              { status: 503 },
            ),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<CollaborationPanel projectId={projectId} threadId={TEST_THREAD_ID} />);

    const chip = await screen.findByRole("button", {
      name: "跳转到来源消息：#1 · 项目所有者 · Failing origin",
    });
    await user.click(chip);
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用");
    expect(screen.queryByText("private detail")).toBeNull();
    const retryable = screen.getByRole("button", {
      name: "跳转到来源消息：#1 · 项目所有者 · Failing origin",
    });
    expect(retryable).not.toHaveAttribute("aria-disabled");
    expect(retryable).toHaveTextContent("#1 · 项目所有者 · Failing origin");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
