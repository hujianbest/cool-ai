// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import type { ProjectMessage } from "@/src/shared/collaboration-contracts";
import type { MembershipState } from "@/src/shared/project-context-contracts";
import {
  TEST_THREAD_ID,
  threadPolicy,
  threadSummary,
} from "@/tests/cockpit-test-fetch";

const OTHER_THREAD_ID = "thread-2";

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

const activeRun = {
  createdAt: "2026-07-30T00:00:00.000Z",
  currentAgentId: "agent-a",
  id: "run-1",
  pauseCategory: null,
  projectId: "project-1",
  roundCount: 1,
  status: "running",
  threadId: TEST_THREAD_ID,
  updatedAt: "2026-07-30T00:00:00.000Z",
  version: 1,
};

type DraftRecord = {
  attachments: Array<{ name: string; size: number }>;
  content: string;
  replyToMessageId: string | null;
  updatedAt: string;
  version: number;
};

function ownerMessage(overrides: Partial<ProjectMessage> = {}): ProjectMessage {
  return {
    attachments: [],
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

type DraftCall = {
  body?: Record<string, unknown>;
  method: string;
  url: string;
};

function installFetch(options?: {
  draftGate?: Promise<void>;
  draftReadStatus?: number;
  draftSaveStatus?: number;
  seedDrafts?: Record<string, DraftRecord>;
  seedMessages?: ProjectMessage[];
  sendGate?: Promise<void>;
}) {
  const drafts = new Map<string, DraftRecord>(
    Object.entries(options?.seedDrafts ?? {}),
  );
  const messages = [...(options?.seedMessages ?? [])];
  const draftCalls: DraftCall[] = [];
  let sentMessageCount = 0;

  function draftResponse(projectId: string, threadId: string) {
    const record = drafts.get(`${projectId}|${threadId}`) ?? null;
    return Response.json({
      draft: record
        ? { ...record, projectId, threadId }
        : null,
    });
  }

  function threadEnvelope(threadId: string) {
    const threadMessages = messages.map((item) => ({
      ...item,
      attachments: [],
      projectId: "project-1",
      replyTo: null,
      threadId,
    }));
    const facts = threadMessages.map((item, index) => ({
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
      threadId,
      type: item.authorType === "owner" ? "owner_message" : "agent_message",
    }));
    return { facts, threadMessages };
  }

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const draftMatch = url.match(
        /\/api\/projects\/([^/]+)\/threads\/([^/]+)\/draft$/,
      );
      if (draftMatch) {
        const [, projectId, threadId] = draftMatch;
        const key = `${projectId}|${threadId}`;
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            attachments: Array<{ name: string; size: number }>;
            content: string;
            replyToMessageId: string | null;
          };
          draftCalls.push({ body, method: "PUT", url });
          if (options?.draftSaveStatus && options.draftSaveStatus !== 200) {
            return Response.json(
              { error: { code: "STORAGE_UNAVAILABLE", message: "raw save detail" } },
              { status: options.draftSaveStatus },
            );
          }
          const contentSaved = !body.content.includes("sk-");
          const prior = drafts.get(key);
          const record: DraftRecord = {
            attachments: body.attachments,
            content: contentSaved ? body.content : "",
            replyToMessageId: body.replyToMessageId,
            updatedAt: "2026-08-10T00:00:00.000Z",
            version: (prior?.version ?? 0) + 1,
          };
          drafts.set(key, record);
          return Response.json({
            contentSaved,
            draft: { ...record, projectId, threadId },
          });
        }
        if (init?.method === "DELETE") {
          draftCalls.push({ method: "DELETE", url });
          drafts.delete(key);
          return Response.json({ cleared: true });
        }
        if (options?.draftGate) await options.draftGate;
        if (options?.draftReadStatus && options.draftReadStatus !== 200) {
          return Response.json(
            { error: { code: "STORAGE_UNAVAILABLE", message: "raw draft detail" } },
            { status: options.draftReadStatus },
          );
        }
        return draftResponse(projectId, threadId);
      }
      if (url.endsWith("/messages") && init?.method === "POST") {
        if (options?.sendGate) await options.sendGate;
        const body = JSON.parse(String(init.body)) as {
          content: string;
          mentionAgentId?: string;
          operationId: string;
          replyToMessageId?: string;
        };
        sentMessageCount += 1;
        const message = ownerMessage({
          content: body.content,
          id: `message-sent-${sentMessageCount}`,
          runId: null,
          sequence: messages.length + 1,
        });
        messages.push(message);
        return Response.json(
          {
            fact: { id: `fact-${message.id}` },
            message: {
              ...message,
              attachments: [],
              projectId: "project-1",
              replyTo: null,
              threadId: TEST_THREAD_ID,
            },
            run: null,
          },
          { status: 201 },
        );
      }
      const threadMatch = url.match(/\/threads\/(thread-[^/?]+)/);
      const threadId = threadMatch?.[1] ?? TEST_THREAD_ID;
      const { facts, threadMessages } = threadEnvelope(threadId);
      if (url.endsWith("/messages")) {
        return Response.json({ items: threadMessages, nextAfter: null });
      }
      if (url.includes("/facts")) {
        return Response.json({ items: facts, nextAfter: null });
      }
      if (url.includes("/timeline")) {
        return Response.json({ items: [], nextAfter: null });
      }
      if (url.endsWith("/members")) return Response.json(members);
      if (url.includes(`/threads/${threadId}`)) {
        return Response.json({
          activeRun: { runId: activeRun.id, threadId },
          readiness: {
            dispatch: "ready",
            missingProjectFacts: [],
            selectedMemberId: activeRun.currentAgentId,
          },
          runs: [{ ...activeRun, threadId }],
          selectedRun: url.includes("?run=") ? { ...activeRun, threadId } : null,
          thread: {
            ...threadSummary("project-1"),
            id: threadId,
            policy: threadPolicy(),
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { draftCalls, drafts, fetchMock, messages };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPanel(threadId: string = TEST_THREAD_ID) {
  return render(createElement(CollaborationPanel, {
    projectId: "project-1",
    selectedRunId: "run-1",
    threadId,
  }));
}

describe("composer draft recovery", () => {
  it("restores text, attachment placeholder chips, and the reply link on mount", async () => {
    installFetch({
      seedDrafts: {
        [`project-1|${TEST_THREAD_ID}`]: {
          attachments: [{ name: "notes.txt", size: 128 }],
          content: "恢复的文字",
          replyToMessageId: "message-1",
          updatedAt: "2026-08-10T00:00:00.000Z",
          version: 3,
        },
      },
      seedMessages: [ownerMessage()],
    });
    renderPanel();

    const composer = await screen.findByLabelText("发送给项目群聊");
    await waitFor(() => expect(composer).toHaveValue("恢复的文字"));
    const placeholder = await screen.findByText(/notes\.txt · 128 B/);
    expect(placeholder.textContent).toContain("需重新选择");
    expect(
      screen.getByText(/回复 项目所有者：Plan the release/),
    ).toBeInTheDocument();
  });

  it("restores the target thread draft after a switch and never writes the previous thread content across", async () => {
    const { draftCalls } = installFetch({
      seedDrafts: {
        [`project-1|${TEST_THREAD_ID}`]: {
          attachments: [],
          content: "线程一的草稿",
          replyToMessageId: null,
          updatedAt: "2026-08-10T00:00:00.000Z",
          version: 1,
        },
        [`project-1|${OTHER_THREAD_ID}`]: {
          attachments: [],
          content: "线程二的草稿",
          replyToMessageId: null,
          updatedAt: "2026-08-10T00:00:00.000Z",
          version: 2,
        },
      },
      seedMessages: [ownerMessage()],
    });
    const view = renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");
    await waitFor(() => expect(composer).toHaveValue("线程一的草稿"));

    view.rerender(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId: OTHER_THREAD_ID,
    }));
    const switchedComposer = await screen.findByLabelText("发送给项目群聊");
    await waitFor(() => expect(switchedComposer).toHaveValue("线程二的草稿"));

    await new Promise((resolve) => setTimeout(resolve, 700));
    const crossWrites = draftCalls.filter(
      (call) =>
        call.method === "PUT"
        && call.url.includes(OTHER_THREAD_ID)
        && String(call.body?.content).includes("线程一"),
    );
    expect(crossWrites).toEqual([]);
  });

  it("shows a restoring indicator, then a neutral note on read failure while the composer stays usable", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installFetch({ draftGate: gate, draftReadStatus: 503, seedMessages: [ownerMessage()] });
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");
    expect(screen.getByText("正在恢复草稿…")).toBeInTheDocument();
    release();
    expect(await screen.findByText(/草稿恢复失败/)).toBeInTheDocument();
    expect(screen.queryByText("raw draft detail")).not.toBeInTheDocument();
    expect(composer).toBeEnabled();
    fireEvent.change(composer, { target: { value: "仍可输入" } });
    expect(composer).toHaveValue("仍可输入");
  });
});

describe("composer draft saving", () => {
  it("upserts the draft after typing stops for the debounce interval, not before", async () => {
    const { draftCalls } = installFetch({ seedMessages: [ownerMessage()] });
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");

    fireEvent.change(composer, { target: { value: "防抖内容" } });
    expect(draftCalls.filter((call) => call.method === "PUT")).toEqual([]);

    await waitFor(
      () => {
        const puts = draftCalls.filter((call) => call.method === "PUT");
        expect(puts).toHaveLength(1);
        expect(puts[0].body).toEqual({
          attachments: [],
          content: "防抖内容",
          replyToMessageId: null,
        });
      },
      { timeout: 2000 },
    );
  });

  it("shows a neutral note when the debounced save fails and keeps the local text", async () => {
    installFetch({ draftSaveStatus: 503, seedMessages: [ownerMessage()] });
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");

    fireEvent.change(composer, { target: { value: "保存失败的草稿" } });
    expect(await screen.findByText(/草稿保存失败/, undefined, {
      timeout: 2000,
    })).toBeInTheDocument();
    expect(screen.queryByText("raw save detail")).not.toBeInTheDocument();
    expect(composer).toHaveValue("保存失败的草稿");
  });

  it("deletes the persisted draft when the composer is emptied", async () => {
    const { draftCalls, drafts } = installFetch({
      seedDrafts: {
        [`project-1|${TEST_THREAD_ID}`]: {
          attachments: [],
          content: "待清空",
          replyToMessageId: null,
          updatedAt: "2026-08-10T00:00:00.000Z",
          version: 1,
        },
      },
      seedMessages: [ownerMessage()],
    });
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");
    await waitFor(() => expect(composer).toHaveValue("待清空"));

    fireEvent.change(composer, { target: { value: "" } });
    await waitFor(
      () => {
        expect(
          draftCalls.some((call) => call.method === "DELETE"),
        ).toBe(true);
      },
      { timeout: 2000 },
    );
    expect(drafts.has(`project-1|${TEST_THREAD_ID}`)).toBe(false);
    expect(
      draftCalls.some(
        (call) => call.method === "PUT" && call.body?.content === "",
      ),
    ).toBe(false);
  });

  it("shows a neutral sensitive hint without echoing content when the save is degraded", async () => {
    const { drafts } = installFetch({ seedMessages: [ownerMessage()] });
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");

    fireEvent.change(composer, { target: { value: "token=sk-live-secret" } });
    const hintNode = await screen.findByText(/疑似敏感内容/, undefined, {
      timeout: 2000,
    });
    expect(hintNode).toHaveAttribute("role", "status");
    expect(hintNode.textContent).not.toContain("sk-live-secret");
    expect(drafts.get(`project-1|${TEST_THREAD_ID}`)?.content).toBe("");
  });

  it("clears the local composer after a confirmed send and does not resurrect the draft", async () => {
    const { draftCalls } = installFetch({
      seedDrafts: {
        [`project-1|${TEST_THREAD_ID}`]: {
          attachments: [{ name: "notes.txt", size: 128 }],
          content: "发送后应清空",
          replyToMessageId: null,
          updatedAt: "2026-08-10T00:00:00.000Z",
          version: 1,
        },
      },
      seedMessages: [ownerMessage()],
    });
    const user = userEvent.setup();
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");
    await waitFor(() => expect(composer).toHaveValue("发送后应清空"));
    expect(await screen.findByText(/notes\.txt/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "移除附件 notes.txt" }));
    await waitFor(() => {
      expect(screen.queryByText(/notes\.txt/)).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(composer).toHaveValue(""));
    expect(screen.queryByText(/notes\.txt/)).not.toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 700));
    const resurrectingPuts = draftCalls.filter(
      (call) => call.method === "PUT" && String(call.body?.content).includes("发送后应清空"),
    );
    expect(resurrectingPuts).toEqual([]);
  });
});

describe("composer reply and attachment placeholders", () => {
  it("sets a reply target from a transcript message, saves it, and carries it in the send body", async () => {
    const { draftCalls, fetchMock } = installFetch({ seedMessages: [ownerMessage()] });
    const user = userEvent.setup();
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");
    await screen.findByText("Plan the release");

    await user.click(screen.getByRole("button", { name: /回复 项目所有者 的消息/ }));
    expect(screen.getByText(/回复 项目所有者：Plan the release/)).toBeInTheDocument();
    expect(composer).toHaveFocus();

    fireEvent.change(composer, { target: { value: "回复内容" } });
    await waitFor(
      () => {
        const puts = draftCalls.filter((call) => call.method === "PUT");
        expect(puts.at(-1)?.body?.replyToMessageId).toBe("message-1");
      },
      { timeout: 2000 },
    );

    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).endsWith("/messages") && init?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
      expect(body.replyToMessageId).toBe("message-1");
    });
    await waitFor(() => expect(composer).toHaveValue(""));
    expect(
      screen.queryByText(/回复 项目所有者：Plan the release/),
    ).not.toBeInTheDocument();
  });

  it("removes the reply link via keyboard and saves the removal", async () => {
    const { draftCalls } = installFetch({ seedMessages: [ownerMessage()] });
    const user = userEvent.setup();
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");
    await screen.findByText("Plan the release");
    await user.click(screen.getByRole("button", { name: /回复 项目所有者 的消息/ }));
    expect(screen.getByText(/回复 项目所有者：Plan the release/)).toBeInTheDocument();
    fireEvent.change(composer, { target: { value: "保留的文字" } });

    const remove = screen.getByRole("button", { name: "移除回复链接" });
    remove.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.queryByText(/回复 项目所有者：Plan the release/),
    ).not.toBeInTheDocument();
    await waitFor(
      () => {
        const puts = draftCalls.filter((call) => call.method === "PUT");
        expect(puts.at(-1)?.body?.replyToMessageId).toBeNull();
        expect(puts.at(-1)?.body?.content).toBe("保留的文字");
      },
      { timeout: 2000 },
    );
  });

  it("keeps restored legacy placeholders blocking send until removed, and saves the removal", async () => {
    const { draftCalls } = installFetch({
      seedDrafts: {
        [`project-1|${TEST_THREAD_ID}`]: {
          attachments: [{ name: "plan.md", size: 5 }],
          content: "带附件的草稿",
          replyToMessageId: null,
          updatedAt: "2026-08-10T00:00:00.000Z",
          version: 1,
        },
      },
      seedMessages: [ownerMessage()],
    });
    const user = userEvent.setup();
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");
    await waitFor(() => expect(composer).toHaveValue("带附件的草稿"));

    const chip = await screen.findByText(/plan\.md · 5 B/);
    expect(chip.textContent).toContain("需重新选择");
    fireEvent.change(composer, { target: { value: "带附件的草稿。" } });
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    expect(screen.getByText(/后才能发送/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "移除附件 plan.md" }));
    expect(screen.queryByText(/plan\.md/)).not.toBeInTheDocument();
    await waitFor(
      () => {
        const puts = draftCalls.filter((call) => call.method === "PUT");
        expect(puts.at(-1)?.body?.attachments).toEqual([]);
        expect(puts.at(-1)?.body?.content).toBe("带附件的草稿。");
      },
      { timeout: 2000 },
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled();
    });
  });

  it("disables composer affordances while a send is pending", async () => {
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    installFetch({ seedMessages: [ownerMessage()], sendGate });
    const user = userEvent.setup();
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");
    await screen.findByText("Plan the release");
    await user.click(screen.getByRole("button", { name: /回复 项目所有者 的消息/ }));

    const attach = screen.getByRole("button", { name: "添加附件" });
    const removeReply = screen.getByRole("button", { name: "移除回复链接" });
    expect(attach).toBeEnabled();
    expect(removeReply).toBeEnabled();

    fireEvent.change(composer, { target: { value: "发送中" } });
    const send = screen.getByRole("button", { name: "发送消息" });
    fireEvent.submit(send.closest("form")!);
    await waitFor(() => expect(composer).toBeDisabled());
    expect(attach).toBeDisabled();
    expect(removeReply).toBeDisabled();
    releaseSend();
    await waitFor(() => expect(composer).toBeEnabled());
  });
});
