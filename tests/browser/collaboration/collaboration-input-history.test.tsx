// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import {
  __inputHistoryRecordingStoreTest,
  INPUT_HISTORY_RECORDING_KEY,
} from "@/components/input-history-recording-store";
import type { ProjectMessage } from "@/src/shared/collaboration-contracts";
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

type HistorySeed = {
  content: string;
  createdAt: string;
  id: string;
  threadId: string;
};

type HistoryCall = {
  method: string;
  query: string | null;
  url: string;
};

type SendBody = {
  content: string;
  operationId: string;
  recordInputHistory?: boolean;
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

function installFetch(options?: {
  historyGate?: Promise<void>;
  historyStatus?: number;
  seedHistory?: Record<string, HistorySeed[]>;
  seedMessages?: ProjectMessage[];
  sendGate?: Promise<void>;
}) {
  const history = new Map<string, HistorySeed[]>(
    Object.entries(options?.seedHistory ?? {}).map(([key, value]) => [
      key,
      [...value],
    ]),
  );
  const clearedAt = new Map<string, string>();
  const messages = [...(options?.seedMessages ?? [])];
  const historyCalls: HistoryCall[] = [];
  const sendBodies: SendBody[] = [];
  const draftCalls: { body?: Record<string, unknown>; method: string }[] = [];

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const historyMatch = url.match(/\/api\/projects\/([^/]+)\/input-history/);
      if (historyMatch) {
        const projectId = historyMatch[1];
        if (init?.method === "DELETE") {
          historyCalls.push({ method: "DELETE", query: null, url });
          history.set(projectId, []);
          clearedAt.set(projectId, "2026-08-10T01:00:00.000Z");
          return Response.json({
            cleared: true,
            clearedAt: "2026-08-10T01:00:00.000Z",
          });
        }
        historyCalls.push({
          method: "GET",
          query: new URL(url, "http://localhost").searchParams.get("query"),
          url,
        });
        if (options?.historyGate) await options.historyGate;
        if (options?.historyStatus && options.historyStatus !== 200) {
          return Response.json(
            { error: { code: "STORAGE_UNAVAILABLE", message: "raw history detail" } },
            { status: options.historyStatus },
          );
        }
        const query = (new URL(url, "http://localhost").searchParams.get("query") ?? "")
          .toLowerCase();
        const entries = (history.get(projectId) ?? [])
          .filter((entry) => entry.content.toLowerCase().includes(query))
          .map((entry) => ({ ...entry }));
        return Response.json({
          entries,
          lastClearedAt: clearedAt.get(projectId) ?? null,
        });
      }
      const draftMatch = url.match(
        /\/api\/projects\/([^/]+)\/threads\/([^/]+)\/draft$/,
      );
      if (draftMatch) {
        if (init?.method === "PUT") {
          draftCalls.push({
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
            method: "PUT",
          });
          return Response.json({ contentSaved: true, draft: null });
        }
        if (init?.method === "DELETE") {
          draftCalls.push({ method: "DELETE" });
          return Response.json({ cleared: true });
        }
        return Response.json({ draft: null });
      }
      if (url.endsWith("/messages") && init?.method === "POST") {
        if (options?.sendGate) await options.sendGate;
        const body = JSON.parse(String(init.body)) as SendBody;
        sendBodies.push(body);
        const message = ownerMessage({
          content: body.content,
          id: `message-sent-${sendBodies.length}`,
          runId: null,
          sequence: messages.length + 1,
        });
        messages.push(message);
        return Response.json(
          {
            fact: { id: `fact-${message.id}` },
            message: {
              ...message,
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
      const threadMessages = messages.map((item) => ({
        ...item,
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
  return { draftCalls, historyCalls, sendBodies };
}

afterEach(() => {
  window.localStorage.clear();
  __inputHistoryRecordingStoreTest?.resetBrowserStore();
  vi.unstubAllGlobals();
});

function renderPanel() {
  return render(createElement(CollaborationPanel, {
    projectId: "project-1",
    selectedRunId: "run-1",
    threadId: TEST_THREAD_ID,
  }));
}

function seedEntries(): Record<string, HistorySeed[]> {
  return {
    "project-1": [
      {
        content: "部署预发环境",
        createdAt: "2026-08-09T10:00:00.000Z",
        id: "entry-1",
        threadId: TEST_THREAD_ID,
      },
      {
        content: "release checklist review",
        createdAt: "2026-08-09T11:00:00.000Z",
        id: "entry-2",
        threadId: TEST_THREAD_ID,
      },
    ],
    "project-2": [
      {
        content: "foreign project wording",
        createdAt: "2026-08-09T12:00:00.000Z",
        id: "entry-foreign",
        threadId: "thread-9",
      },
    ],
  };
}

describe("input history panel", () => {
  it("opens from the composer toolbar, lists entries with time, and fills the composer on click", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { draftCalls } = installFetch({
      historyGate: gate,
      seedHistory: seedEntries(),
      seedMessages: [ownerMessage()],
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByLabelText("发送给项目群聊");

    const entry = screen.getByRole("button", { name: "输入历史" });
    expect(entry).toHaveAttribute("aria-expanded", "false");
    await user.click(entry);
    expect(entry).toHaveAttribute("aria-expanded", "true");

    const region = screen.getByRole("region", { name: "输入历史" });
    expect(screen.getByText("正在加载输入历史…")).toBeInTheDocument();
    release();

    expect(await screen.findByText("部署预发环境")).toBeInTheDocument();
    expect(screen.getByText("release checklist review")).toBeInTheDocument();
    expect(region.querySelectorAll("time").length).toBeGreaterThan(0);
    expect(screen.queryByText("foreign project wording"))
      .not.toBeInTheDocument();

    await user.click(screen.getByText("部署预发环境"));
    const composer = screen.getByLabelText("发送给项目群聊");
    expect(composer).toHaveValue("部署预发环境");
    expect(screen.queryByRole("region", { name: "输入历史" }))
      .not.toBeInTheDocument();
    expect(composer).toHaveFocus();

    await new Promise((resolve) => setTimeout(resolve, 700));
    const fillSave = draftCalls.find(
      (call) => call.method === "PUT" && call.body?.content === "部署预发环境",
    );
    expect(fillSave, "fill must flow through the debounced draft save")
      .toBeDefined();
  });

  it("searches with the submitted keyword and shows an empty state without matches", async () => {
    const { historyCalls } = installFetch({
      seedHistory: seedEntries(),
      seedMessages: [ownerMessage()],
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByLabelText("发送给项目群聊");
    await user.click(screen.getByRole("button", { name: "输入历史" }));
    await screen.findByText("部署预发环境");

    const searchInput = screen.getByLabelText("搜索输入历史");
    await user.type(searchInput, "release{Enter}");

    expect(await screen.findByText("release checklist review")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("部署预发环境"))
      .not.toBeInTheDocument());
    const searches = historyCalls.filter((call) => call.method === "GET");
    expect(searches.at(-1)?.query).toBe("release");

    await user.clear(searchInput);
    await user.type(searchInput, "没有命中{Enter}");
    expect(await screen.findByText("没有匹配的输入历史。")).toBeInTheDocument();
  });

  it("shows a sanitized error note and keeps the composer usable when loading fails", async () => {
    installFetch({ historyStatus: 503, seedMessages: [ownerMessage()] });
    const user = userEvent.setup();
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");
    await user.click(screen.getByRole("button", { name: "输入历史" }));

    expect(await screen.findByText(/输入历史加载失败/)).toBeInTheDocument();
    expect(screen.queryByText("raw history detail")).not.toBeInTheDocument();
    expect(composer).toBeEnabled();
  });

  it("clears all history only after an explicit confirmation", async () => {
    const { historyCalls } = installFetch({
      seedHistory: seedEntries(),
      seedMessages: [ownerMessage()],
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByLabelText("发送给项目群聊");
    await user.click(screen.getByRole("button", { name: "输入历史" }));
    await screen.findByText("部署预发环境");

    await user.click(screen.getByRole("button", { name: "清除全部" }));
    expect(screen.getByText(/确认清除全部输入历史/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText(/确认清除全部输入历史/)).not.toBeInTheDocument();
    expect(screen.getByText("部署预发环境")).toBeInTheDocument();
    expect(historyCalls.some((call) => call.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: "清除全部" }));
    await user.click(screen.getByRole("button", { name: "确认清除" }));

    expect(await screen.findByText("没有匹配的输入历史。")).toBeInTheDocument();
    expect(historyCalls.some((call) => call.method === "DELETE")).toBe(true);
  });

  it("closes with Escape and returns focus to the entry button", async () => {
    installFetch({ seedHistory: seedEntries(), seedMessages: [ownerMessage()] });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByLabelText("发送给项目群聊");
    const entry = screen.getByRole("button", { name: "输入历史" });
    await user.click(entry);

    const searchInput = await screen.findByLabelText("搜索输入历史");
    expect(searchInput).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "输入历史" }))
      .not.toBeInTheDocument();
    expect(entry).toHaveFocus();
  });
});

describe("input history recording toggle", () => {
  it("records by default and sends recordInputHistory:false after opting out", async () => {
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const { sendBodies } = installFetch({
      seedHistory: seedEntries(),
      seedMessages: [ownerMessage()],
      sendGate,
    });
    const user = userEvent.setup();
    renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");

    await user.click(screen.getByRole("button", { name: "输入历史" }));
    const toggle = await screen.findByRole("checkbox", { name: "记录新输入历史" });
    expect(toggle).toBeChecked();

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(
      window.localStorage.getItem(INPUT_HISTORY_RECORDING_KEY),
    ).toContain('"record":false'));

    await user.click(composer);
    await user.type(composer, "quiet send");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    const entry = screen.getByRole("button", { name: "输入历史" });
    expect(entry, "history entry is disabled while a send is pending")
      .toBeDisabled();
    releaseSend();

    await waitFor(() => expect(sendBodies).toHaveLength(1));
    expect(sendBodies[0].recordInputHistory).toBe(false);
  });

  it("omits the flag while recording is on and restores the opt-out after a remount", async () => {
    const first = installFetch({
      seedHistory: seedEntries(),
      seedMessages: [ownerMessage()],
    });
    const user = userEvent.setup();
    const view = renderPanel();
    const composer = await screen.findByLabelText("发送给项目群聊");
    await user.type(composer, "recorded send");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(first.sendBodies).toHaveLength(1));
    expect(first.sendBodies[0]).not.toHaveProperty("recordInputHistory");

    await user.click(screen.getByRole("button", { name: "输入历史" }));
    await user.click(
      await screen.findByRole("checkbox", { name: "记录新输入历史" }),
    );
    view.unmount();

    __inputHistoryRecordingStoreTest?.resetBrowserStore();
    renderPanel();
    await screen.findByLabelText("发送给项目群聊");
    await user.click(screen.getByRole("button", { name: "输入历史" }));
    expect(
      await screen.findByRole("checkbox", { name: "记录新输入历史" }),
    ).not.toBeChecked();
  });
});
