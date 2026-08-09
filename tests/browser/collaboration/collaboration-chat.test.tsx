// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import type {
  CollaborationReadResponse,
  ProjectMessage,
} from "@/src/shared/collaboration-contracts";
import type { MembershipState } from "@/src/shared/project-context-contracts";
import {
  TEST_THREAD_ID,
  threadPolicy,
  threadSummary,
} from "@/tests/cockpit-test-fetch";

const emptyRead: CollaborationReadResponse = {
  pendingDecision: null,
  projectMessagesPage: { items: [], nextAfter: null },
  readiness: { missing: [], ready: true },
  run: null,
  timelinePage: { items: [], nextAfter: null },
  usage: {
    byAgent: [],
    completionTokens: 0,
    promptTokens: 0,
    repairCalls: 0,
    totalTokens: 0,
    unreportedCalls: 0,
  },
};

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
    {
      accentToken: "terracotta",
      agentId: "agent-b",
      avatarText: "B",
      joinedAt: "2026-07-30T00:00:00.000Z",
      model: "test-model",
      name: "Beta",
      permissions: { readFiles: true, runCommands: false, writeFiles: false },
      role: "Peer",
      skillNames: [],
    },
  ],
  projectVersion: 1,
};

function ownerMessage(overrides: Partial<ProjectMessage> = {}): ProjectMessage {
  return {
    authorAgentId: null,
    authorDisplayName: "项目所有者",
    authorType: "owner",
    content: "Plan the release",
    createdAt: "2026-07-30T00:00:00.000Z",
    id: "message-1",
    mentionAgentId: null,
    mentionDisplayName: null,
    mentionMemberStatus: null,
    runId: "run-1",
    sequence: 1,
    ...overrides,
  };
}

function installFetch(
  handler?: (url: string, init?: RequestInit) => Promise<Response> | Response,
) {
  async function strictRead(url: string, init?: RequestInit): Promise<Response> {
    const legacyResponse = handler
      ? await handler("/api/projects/project-1/collaboration", init)
      : Response.json(emptyRead);
    if (!legacyResponse.ok) return legacyResponse;
    const read = await legacyResponse.json() as CollaborationReadResponse;
    const messages = read.projectMessagesPage.items.map((item) => ({
      ...item,
      projectId: "project-1",
      replyTo: null,
      threadId: TEST_THREAD_ID,
    }));
    const facts = [
      ...messages.map((item, index) => ({
        activitySequence: index + 1,
        actorId: item.authorAgentId,
        actorType: item.authorType,
        createdAt: item.createdAt,
        id: `fact-${item.id}`,
        message: item,
        messageId: item.id,
        payload: { messageId: item.id },
        policyRevisionId: null,
        projectId: "project-1",
        runEventId: null,
        runId: item.runId,
        sequence: index + 1,
        threadId: TEST_THREAD_ID,
        type: item.authorType === "owner" ? "owner_message" : "agent_message",
      })),
      ...read.timelinePage.items
        .filter((item) => item.type !== "owner_message" && item.type !== "agent_message")
        .map((item, index) => ({
          activitySequence: messages.length + index + 1,
          actorId: item.actorId,
          actorType: item.actorType,
          createdAt: item.createdAt,
          id: `fact-${item.id}`,
          message: null,
          messageId: null,
          payload: { eventType: item.type },
          policyRevisionId: null,
          projectId: "project-1",
          runEventId: item.id,
          runId: item.runId,
          sequence: messages.length + index + 1,
          threadId: TEST_THREAD_ID,
          type: "run_event",
        })),
    ];
    if (url.endsWith("/messages")) {
      return Response.json({ items: messages, nextAfter: null });
    }
    if (url.endsWith("/facts")) {
      return Response.json({ items: facts, nextAfter: null });
    }
    if (url.includes("/timeline")) {
      return Response.json({
        items: read.timelinePage.items.map((item) => ({
          ...item,
          projectId: "project-1",
          threadId: TEST_THREAD_ID,
        })),
        nextAfter: null,
      });
    }
    const run = read.run ? { ...read.run, threadId: TEST_THREAD_ID } : null;
    return Response.json({
      activeRun: run ? { runId: run.id, threadId: TEST_THREAD_ID } : null,
      readiness: {
        dispatch: "ready",
        missingProjectFacts: [],
        selectedMemberId: run?.currentAgentId ?? null,
      },
      runs: run ? [run] : [],
      selectedRun: url.includes("?run=") ? run : null,
      thread: {
        ...threadSummary("project-1"),
        policy: threadPolicy(),
      },
    });
  }
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes(`/threads/${TEST_THREAD_ID}`) && init?.method !== "POST") {
        return strictRead(url, init);
      }
      if (handler) {
        const response = await handler(url, init);
        if (response) return response;
      }
      if (url.endsWith("/collaboration")) return Response.json(emptyRead);
      if (url.endsWith("/members")) return Response.json(members);
      throw new Error(`Unexpected request: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collaboration chat composer", () => {
  it("shows loading, empty, and collaboration API error copy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installFetch(async (url) => {
      if (url.endsWith("/collaboration")) {
        await gate;
        return Response.json(emptyRead);
      }
      return Response.json(members);
    });

    const view = render(createElement(CollaborationPanel, {
      projectId: "project-1",
      threadId: TEST_THREAD_ID,
    }));
    expect(screen.getByText("正在加载项目群聊…")).toHaveAttribute("aria-busy", "true");
    release();
    expect(await screen.findByText(/尚无协作消息。/)).toBeInTheDocument();
    view.unmount();

    installFetch((url) =>
      url.endsWith("/collaboration")
        ? Response.json(
            { error: { code: "STORAGE_UNAVAILABLE", message: "raw storage detail" } },
            { status: 503 },
          )
        : Response.json(members),
    );
    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      threadId: TEST_THREAD_ID,
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "服务暂时不可用，请稍后重试。",
    );
    expect(screen.queryByText("raw storage detail")).not.toBeInTheDocument();
  });

  it("validates 1..10000 characters with a field-linked error", async () => {
    installFetch();
    const user = userEvent.setup();
    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      threadId: TEST_THREAD_ID,
    }));
    const composer = await screen.findByLabelText("发送给项目群聊");
    const send = screen.getByRole("button", { name: "发送并开始首次运行" });

    fireEvent.change(composer, { target: { value: "   " } });
    fireEvent.submit(send.closest("form")!);
    expect(screen.getByText("请输入 1 至 10000 个字符。")).toHaveAttribute(
      "id",
      composer.getAttribute("aria-describedby"),
    );
    expect(composer).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(composer, { target: { value: "x".repeat(10_001) } });
    fireEvent.submit(send.closest("form")!);
    expect(screen.getByText("请输入 1 至 10000 个字符。")).toBeInTheDocument();
  });

  it("preserves the draft while sending and on sanitized API failure", async () => {
    let finishSend!: (response: Response) => void;
    const pendingSend = new Promise<Response>((resolve) => {
      finishSend = resolve;
    });
    installFetch((url) => {
      if (url.endsWith("/runs")) return pendingSend;
      if (url.endsWith("/collaboration")) return Response.json(emptyRead);
      return Response.json(members);
    });
    const user = userEvent.setup();
    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      threadId: TEST_THREAD_ID,
    }));
    const composer = await screen.findByLabelText("发送给项目群聊");
    await user.type(composer, "Keep this draft");
    await user.click(screen.getByRole("button", { name: "发送并开始首次运行" }));

    expect(composer).toBeDisabled();
    expect(composer).toHaveValue("Keep this draft");
    finishSend(
      Response.json(
        { error: { code: "AGENT_NOT_MEMBER", message: "raw membership detail" } },
        { status: 409 },
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "所选 Agent 不是项目成员。",
    );
    expect(composer).toBeEnabled();
    expect(composer).toHaveValue("Keep this draft");
    expect(screen.queryByText("raw membership detail")).not.toBeInTheDocument();
  });

  it("uses one keyboard-operable member combobox and sends the stable agent id", async () => {
    const sentBodies: Array<Record<string, unknown>> = [];
    installFetch((url, init) => {
      if (url.endsWith("/runs")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentBodies.push(body);
        return Response.json(
          {
            created: true,
            message: ownerMessage({
              content: String(body.message),
              mentionAgentId: "agent-b",
              mentionDisplayName: "Beta",
              mentionMemberStatus: "current",
            }),
            run: {
              createdAt: "2026-07-30T00:00:00.000Z",
              currentAgentId: "agent-b",
              id: "run-1",
              pauseCategory: null,
              projectId: "project-1",
              roundCount: 0,
              status: "running",
              updatedAt: "2026-07-30T00:00:00.000Z",
              version: 1,
            },
          },
          { status: 201 },
        );
      }
      if (url.endsWith("/collaboration")) return Response.json(emptyRead);
      return Response.json(members);
    });
    const user = userEvent.setup();
    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      threadId: TEST_THREAD_ID,
    }));
    await screen.findByText(/尚无协作消息。/);

    const combo = screen.getByRole("combobox", { name: "@成员" });
    expect(combo).toHaveAttribute("aria-controls");
    await user.click(combo);
    expect(await screen.findByRole("listbox", { name: "项目成员" })).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByText("@Beta")).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "项目成员" })).not.toBeInTheDocument();

    await user.click(combo);
    await user.keyboard("{Escape}");
    expect(combo).toHaveFocus();
    await user.click(combo);
    await user.tab();
    expect(screen.queryByRole("listbox", { name: "项目成员" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("发送给项目群聊"), "Ask @Alpha plainly");
    await user.click(screen.getByRole("button", { name: "发送并开始首次运行" }));
    await screen.findByText("Ask @Alpha plainly");
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toMatchObject({
      mentionAgentId: "agent-b",
      message: "Ask @Alpha plainly",
    });
  });

  it("uses message or start APIs by run state and focuses the successful owner message", async () => {
    const activeRead = {
      ...emptyRead,
      run: {
        createdAt: "2026-07-30T00:00:00.000Z",
        currentAgentId: "agent-a",
        id: "run-1",
        pauseCategory: null,
        projectId: "project-1",
        roundCount: 0,
        status: "running" as const,
        updatedAt: "2026-07-30T00:00:00.000Z",
        version: 1,
      },
    };
    const urls: string[] = [];
    let messagePersisted = false;
    const message = ownerMessage();
    const persistedRead = {
      ...activeRead,
      projectMessagesPage: { items: [message], nextAfter: null },
      timelinePage: {
        items: [
          {
            actorId: null,
            actorType: "owner" as const,
            createdAt: message.createdAt,
            id: "event-owner-1",
            payload: {
              mentionAgentId: null,
              mentionDisplayName: null,
              messageId: message.id,
              messageSequence: message.sequence,
            },
            runId: activeRead.run.id,
            sequence: 1,
            type: "owner_message" as const,
          },
        ],
        nextAfter: null,
      },
    };
    installFetch((url) => {
      if (url.endsWith("/collaboration")) {
        return Response.json(messagePersisted ? persistedRead : activeRead);
      }
      if (url.endsWith("/messages")) {
        urls.push(url);
        messagePersisted = true;
        return Response.json({
          fact: {
            activitySequence: 1,
            actorId: null,
            actorType: "owner",
            createdAt: message.createdAt,
            id: `fact-${message.id}`,
            message: {
              ...message,
              projectId: "project-1",
              replyTo: null,
              threadId: TEST_THREAD_ID,
            },
            messageId: message.id,
            payload: { messageId: message.id },
            policyRevisionId: null,
            projectId: "project-1",
            runEventId: null,
            runId: message.runId,
            sequence: 1,
            threadId: TEST_THREAD_ID,
            type: "owner_message",
          },
          message: {
            ...message,
            projectId: "project-1",
            replyTo: null,
            threadId: TEST_THREAD_ID,
          },
          run: {
            ...activeRead.run,
            threadId: TEST_THREAD_ID,
          },
        });
      }
      return Response.json(members);
    });
    const user = userEvent.setup();
    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId: TEST_THREAD_ID,
    }));
    const composer = await screen.findByLabelText("发送给项目群聊");
    await user.type(composer, "Plan the release");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    const renderedMessage = await screen.findByText("Plan the release");
    await waitFor(() => expect(renderedMessage.closest("li")).toHaveFocus());
    expect(composer).toHaveValue("");
    expect(urls).toEqual([
      `/api/projects/project-1/threads/${TEST_THREAD_ID}/messages`,
    ]);
  });

  it("renders immutable mention snapshots and left-member state without parsing plain @ text", async () => {
    installFetch((url) =>
      url.endsWith("/collaboration")
        ? Response.json({
            ...emptyRead,
            projectMessagesPage: {
              items: [
                ownerMessage({
                  content: "Ask @renamed text",
                  mentionAgentId: "agent-gone",
                  mentionDisplayName: "Former Name",
                  mentionMemberStatus: "left",
                  runId: null,
                }),
              ],
              nextAfter: null,
            },
          })
        : Response.json(members),
    );
    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      threadId: TEST_THREAD_ID,
    }));

    expect(await screen.findByText("@Former Name")).toBeInTheDocument();
    expect(screen.getByText("已离组")).toBeInTheDocument();
    expect(screen.getByText("Ask @renamed text")).toBeInTheDocument();
    expect(screen.queryByText("@renamed")).not.toBeInTheDocument();
  });
});
