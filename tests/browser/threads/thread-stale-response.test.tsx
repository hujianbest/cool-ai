// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import { ThreadPolicyPanel } from "@/components/collaboration/thread-policy-panel";
import { ProjectThreadNavigation } from "@/components/project-thread-navigation";

const projectId = "project-stale";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function run(project: string, thread: string, id: string) {
  return {
    createdAt: "2026-08-08T00:00:00.000Z",
    currentAgentId: "agent-a",
    id,
    pauseCategory: null,
    projectId: project,
    roundCount: 1,
    status: "running" as const,
    threadId: thread,
    updatedAt: "2026-08-08T00:00:00.000Z",
    version: 1,
  };
}

function detail(project: string, thread: string, selectedRunId: string | null = null) {
  const selectedRun = selectedRunId ? run(project, thread, selectedRunId) : null;
  return {
    activeRun: selectedRun ? { runId: selectedRun.id, threadId: thread } : null,
    readiness: {
      dispatch: "ready",
      missingProjectFacts: [],
      selectedMemberId: selectedRun?.currentAgentId ?? null,
    },
    runs: selectedRun ? [selectedRun] : [],
    selectedRun,
    thread: {
      availability: "ready",
      createdAt: "2026-08-08T00:00:00.000Z",
      id: thread,
      lastActivitySequence: 1,
      policy: {
        availability: "ready",
        createdAt: "2026-08-08T00:00:00.000Z",
        members: [
          {
            agentId: "agent-a",
            displayNameSnapshot: "Agent A",
            live: "current",
            position: 0,
          },
          {
            agentId: "agent-b",
            displayNameSnapshot: "Agent B",
            live: "current",
            position: 1,
          },
        ],
        revisionId: `policy-${thread}`,
        unavailableMemberIds: [],
        version: 1,
      },
      policyVersion: 1,
      projectId: project,
      title: `Title ${thread}`,
      updatedAt: "2026-08-08T00:00:00.000Z",
      version: 1,
    },
  };
}

function threadSummary(project: string, thread: string) {
  const { policy: _policy, ...summary } = detail(project, thread).thread;
  return { ...summary, favoritedAt: null, isFavorite: false, tags: [] };
}

function message(project: string, thread: string, content: string, runId: string | null = null) {
  const suffix = content.replaceAll(/[^A-Za-z0-9_-]/g, "-");
  return {
    attachments: [],
    authorAgentId: null,
    authorDisplayName: "Owner",
    authorType: "owner" as const,
    content,
    createdAt: "2026-08-08T00:00:00.000Z",
    id: `message-${thread}-${suffix}`,
    mentionAgentId: null,
    mentionDisplayName: null,
    mentionMemberStatus: null,
    projectId: project,
    replyTo: null,
    runId,
    sequence: 1,
    threadId: thread,
  };
}

function fact(project: string, thread: string, content: string, runId: string | null = null) {
  const item = message(project, thread, content, runId);
  const suffix = content.replaceAll(/[^A-Za-z0-9_-]/g, "-");
  return {
    activitySequence: 1,
    actorId: null,
    actorType: "owner" as const,
    createdAt: item.createdAt,
    id: `fact-${thread}-${suffix}`,
    message: item,
    messageId: item.id,
    payload: { messageId: item.id },
    policyRevisionId: null,
    projectId: project,
    runEventId: null,
    runId,
    sequence: 1,
    threadId: thread,
    type: "owner_message" as const,
  };
}

function policyUpdate(project: string, thread: string, version: number) {
  const next = detail(project, thread);
  next.thread.policy.version = version;
  next.thread.policy.revisionId = `policy-${thread}-${version}`;
  next.thread.policyVersion = version;
  next.thread.version = version;
  return {
    fact: {
      activitySequence: version,
      actorId: null,
      actorType: "owner",
      createdAt: "2026-08-08T00:00:00.000Z",
      id: `policy-fact-${thread}-${version}`,
      message: null,
      messageId: null,
      payload: { policyVersion: version },
      policyRevisionId: next.thread.policy.revisionId,
      projectId: project,
      runEventId: null,
      runId: null,
      sequence: version,
      threadId: thread,
      type: "policy_changed",
    },
    policy: next.thread.policy,
    thread: next.thread,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("canonical project/thread/run stale request protection", () => {
  it("aborts an old project thread list without changing the new project URL or focus", async () => {
    const oldProject = "project-old";
    const newProject = "project-new";
    const oldList = deferredResponse();
    const oldSignals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/projects/${oldProject}/threads?limit=100`) {
        if (init?.signal) oldSignals.push(init.signal);
        return oldList.promise;
      }
      if (url === `/api/projects/${newProject}/threads?limit=100`) {
        return Promise.resolve(Response.json({
          nextCursor: null,
          threads: [threadSummary(newProject, "thread-new")],
        }));
      }
      if (url.includes("/thread-tags?limit=100")) {
        return Promise.resolve(Response.json({ tags: [] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    window.history.replaceState(null, "", `/projects/${newProject}?thread=thread-new`);
    const backgroundRef = createRef<HTMLElement>();
    const view = render(
      <ProjectThreadNavigation
        backgroundRef={backgroundRef}
        projectId={oldProject}
      />,
    );
    view.rerender(
      <ProjectThreadNavigation
        backgroundRef={backgroundRef}
        projectId={newProject}
      />,
    );

    expect(await screen.findByRole("button", { name: "Title thread-new" })).toBeVisible();
    oldList.resolve(Response.json({
      nextCursor: null,
      threads: [threadSummary(oldProject, "thread-old")],
    }));
    await act(async () => undefined);
    expect(oldSignals.every((signal) => signal.aborted)).toBe(true);
    expect(screen.queryByRole("button", { name: "Title thread-old" })).toBeNull();
    expect(window.location.pathname).toBe(`/projects/${newProject}`);
    expect(window.location.search).toBe("?thread=thread-new");
  });

  it("aborts old detail/history reads and ignores their out-of-order completion", async () => {
    const oldThread = "thread-old";
    const newThread = "thread-new";
    const oldDetail = deferredResponse();
    const oldSignals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/threads/${oldThread}`)) {
        if (init?.signal) oldSignals.push(init.signal);
        if (url.endsWith(`/threads/${oldThread}`)) return oldDetail.promise;
        if (url.endsWith("/messages")) {
          return Promise.resolve(Response.json({
            items: [message(projectId, oldThread, "old transcript")],
            nextAfter: null,
          }));
        }
        if (url.endsWith("/facts")) {
          return Promise.resolve(Response.json({
            items: [fact(projectId, oldThread, "old transcript")],
            nextAfter: null,
          }));
        }
      }
      if (url.includes(`/threads/${newThread}`)) {
        if (url.endsWith(`/threads/${newThread}`)) {
          return Promise.resolve(Response.json(detail(projectId, newThread)));
        }
        if (url.endsWith("/messages")) {
          return Promise.resolve(Response.json({
            items: [message(projectId, newThread, "new transcript")],
            nextAfter: null,
          }));
        }
        if (url.endsWith("/facts")) {
          return Promise.resolve(Response.json({
            items: [fact(projectId, newThread, "new transcript")],
            nextAfter: null,
          }));
        }
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const view = render(
      <CollaborationPanel projectId={projectId} threadId={oldThread} />,
    );
    view.rerender(
      <CollaborationPanel projectId={projectId} threadId={newThread} />,
    );
    expect(await screen.findByText("new transcript")).toBeVisible();
    expect(oldSignals.length).toBeGreaterThan(0);
    expect(oldSignals.every((signal) => signal.aborted)).toBe(true);

    oldDetail.resolve(Response.json(detail(projectId, oldThread)));
    await act(async () => undefined);
    expect(screen.queryByText("old transcript")).toBeNull();
    expect(screen.getByText("new transcript")).toBeVisible();
  });

  it("does not reconcile or announce an old owner write after a run target switch", async () => {
    const thread = "thread-write";
    const oldRun = "run-old";
    const newRun = "run-new";
    const write = deferredResponse();
    const oldUrlsAfterSwitch: string[] = [];
    let switched = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (switched && url.includes(oldRun)) oldUrlsAfterSwitch.push(url);
      if (url.endsWith("/messages") && init?.method === "POST") return write.promise;
      if (url.endsWith(`/threads/${thread}?run=${oldRun}`)) {
        return Promise.resolve(Response.json(detail(projectId, thread, oldRun)));
      }
      if (url.endsWith(`/threads/${thread}?run=${newRun}`)) {
        return Promise.resolve(Response.json(detail(projectId, thread, newRun)));
      }
      if (url.endsWith(`/runs/${oldRun}/timeline`) || url.endsWith(`/runs/${newRun}/timeline`)) {
        return Promise.resolve(Response.json({ items: [], nextAfter: null }));
      }
      if (url.endsWith(`/threads/${thread}/messages`)) {
        return Promise.resolve(Response.json({ items: [], nextAfter: null }));
      }
      if (url.endsWith(`/threads/${thread}/facts`)) {
        return Promise.resolve(Response.json({ items: [], nextAfter: null }));
      }
      if (url.endsWith(`/projects/${projectId}/members`)) {
        return Promise.resolve(Response.json({ members: [], projectVersion: 1 }));
      }
      if (url.endsWith(`/runs/${oldRun}/advance`) || url.endsWith(`/runs/${newRun}/advance`)) {
        return new Promise<Response>(() => undefined);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    const view = render(
      <CollaborationPanel
        projectId={projectId}
        selectedRunId={oldRun}
        startOnly
        threadId={thread}
      />,
    );
    await screen.findByText(`运行 ${oldRun}`);
    await user.type(screen.getByLabelText("发送给项目群聊"), "old write");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    switched = true;
    view.rerender(
      <CollaborationPanel
        projectId={projectId}
        selectedRunId={newRun}
        startOnly
        threadId={thread}
      />,
    );
    expect(await screen.findByText(`运行 ${newRun}`)).toBeVisible();
    write.resolve(Response.json({
      fact: fact(projectId, thread, "old write", oldRun),
      message: message(projectId, thread, "old write", oldRun),
      run: run(projectId, thread, oldRun),
    }, { status: 201 }));
    await act(async () => undefined);

    expect(oldUrlsAfterSwitch).toEqual([]);
    expect(screen.queryByText(/已通过事实核对确认消息已发送/)).toBeNull();
    expect(screen.getByLabelText("发送给项目群聊")).toHaveValue("");
    expect(window.location.search).not.toContain(oldRun);
  });

  it("ignores a stale policy write and receipt reconciliation after thread switch", async () => {
    const oldThread = "policy-old";
    const newThread = "policy-new";
    const patch = deferredResponse();
    const staleSignals: AbortSignal[] = [];
    let switched = false;
    const callsAfterSwitch: string[] = [];
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "11111111-1111-4111-8111-111111111111",
    );
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (switched && url.includes(oldThread)) callsAfterSwitch.push(url);
      if (url.endsWith("/policy") && init?.method === "PATCH") {
        if (init.signal) staleSignals.push(init.signal);
        return patch.promise;
      }
      if (url.endsWith(`/threads/${oldThread}`)) {
        return Promise.resolve(Response.json(detail(projectId, oldThread)));
      }
      if (url.endsWith(`/threads/${newThread}`)) {
        return Promise.resolve(Response.json(detail(projectId, newThread)));
      }
      if (url.endsWith("/members")) {
        return Promise.resolve(Response.json({
          members: [
            { agentId: "agent-a", name: "Agent A" },
            { agentId: "agent-b", name: "Agent B" },
          ],
          projectVersion: 1,
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    const view = render(
      <ThreadPolicyPanel projectId={projectId} threadId={oldThread} />,
    );
    await user.click(await screen.findByRole("button", {
      name: "编辑线程成员策略",
    }));
    await user.click(screen.getByRole("button", { name: "保存成员策略" }));

    switched = true;
    view.rerender(
      <ThreadPolicyPanel projectId={projectId} threadId={newThread} />,
    );
    await screen.findByText("策略版本 1");
    patch.resolve(Response.json(policyUpdate(projectId, oldThread, 2)));
    await act(async () => undefined);

    expect(staleSignals.every((signal) => signal.aborted)).toBe(true);
    expect(callsAfterSwitch).toEqual([]);
    expect(screen.queryAllByText(/策略版本 2/)).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cleans timers and prevents late state/focus changes after unmount and remount", async () => {
    const thread = "thread-remount";
    const poll = deferredResponse();
    let pollCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/threads/${thread}`)) {
        return Promise.resolve(Response.json(detail(projectId, thread)));
      }
      if (url.endsWith("/messages")) {
        return Promise.resolve(Response.json({
          items: [message(projectId, thread, "current")],
          nextAfter: null,
        }));
      }
      if (url.endsWith("/facts")) {
        return Promise.resolve(Response.json({
          items: [fact(projectId, thread, "current")],
          nextAfter: null,
        }));
      }
      if (url.endsWith("/facts?after=1")) {
        pollCalls += 1;
        return poll.promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const first = render(
      <CollaborationPanel projectId={projectId} startOnly threadId={thread} />,
    );
    await screen.findByText("current");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_050));
    });
    expect(pollCalls).toBe(1);
    first.unmount();

    const second = render(
      <CollaborationPanel projectId={projectId} startOnly threadId={thread} />,
    );
    await screen.findByText("current");
    poll.resolve(Response.json({
      items: [fact(projectId, thread, "late unmounted")],
      nextAfter: null,
    }));
    await act(async () => undefined);
    expect(screen.queryByText("late unmounted")).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_050));
    });
    expect(pollCalls).toBe(2);
    second.unmount();
  });
});
