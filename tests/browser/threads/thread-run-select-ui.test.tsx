// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import type { ThreadRunDto } from "@/src/shared/collaboration-contracts";

const projectId = "project-1";
const threadId = "thread-1";

function run(
  id: string,
  status: ThreadRunDto["status"],
  createdAt: string,
  selectedThreadId = threadId,
): ThreadRunDto {
  return {
    createdAt,
    currentAgentId: "agent-a",
    id,
    pauseCategory: status === "paused" ? "manual" : null,
    projectId,
    roundCount: id === "run-old" ? 2 : 7,
    status,
    threadId: selectedThreadId,
    updatedAt: createdAt,
    version: 1,
  };
}

const newest = run("run-new", "running", "2026-08-08T08:00:00.000Z");
const older = run("run-old", "stopped", "2026-08-07T08:00:00.000Z");

function detail({
  activeRun = null,
  runs = [newest, older],
  selectedRun = null,
}: {
  activeRun?: { runId: string; threadId: string } | null;
  runs?: ThreadRunDto[];
  selectedRun?: ThreadRunDto | null;
} = {}) {
  return {
    activeRun,
    readiness: {
      dispatch: activeRun && activeRun.threadId !== threadId
        ? "project_run_active"
        : "ready",
      missingProjectFacts: [],
      selectedMemberId: null,
    },
    runs,
    selectedRun,
    thread: {
      availability: "ready",
      createdAt: "2026-08-06T08:00:00.000Z",
      id: threadId,
      lastActivitySequence: 3,
      policy: {
        availability: "ready",
        createdAt: "2026-08-06T08:00:00.000Z",
        members: [],
        revisionId: "revision-1",
        unavailableMemberIds: [],
        version: 1,
      },
      policyVersion: 1,
      projectId,
      title: "Selected thread",
      updatedAt: "2026-08-08T08:00:00.000Z",
      version: 1,
    },
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function selectedRunFromUrl(url: string): ThreadRunDto | null {
  const selected = new URL(url, "http://localhost").searchParams.get("run");
  return [newest, older].find((candidate) => candidate.id === selected) ?? null;
}

function installFetch(
  readDetail: (url: string) => Response | Promise<Response> = (url) =>
    Response.json(detail({ selectedRun: selectedRunFromUrl(url) })),
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes(`/threads/${threadId}/runs/`) && url.endsWith("/timeline")) {
      return Response.json({ items: [], nextAfter: null });
    }
    if (url.endsWith(`/threads/${threadId}`) || url.includes(`/threads/${threadId}?run=`)) {
      return readDetail(url);
    }
    if (url.endsWith(`/threads/${threadId}/messages`)) {
      return Response.json({ items: [], nextAfter: null });
    }
    if (url.endsWith(`/threads/${threadId}/facts`)) {
      return Response.json({ items: [], nextAfter: null });
    }
    if (url.endsWith(`/projects/${projectId}/members`)) {
      return Response.json({ members: [], projectVersion: 1 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function UrlHarness({ surface = "all" }: { surface?: "all" | "run" }) {
  const [, setLocationVersion] = useState(0);
  useEffect(() => {
    const update = () => setLocationVersion((value) => value + 1);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const query = new URLSearchParams(window.location.search);
  return (
    <CollaborationPanel
      projectId={projectId}
      selectedRunId={query.get("run")}
      surface={surface}
      threadId={query.get("thread")}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("selected thread run selection", () => {
  it("keeps selectedRun null, shows stable historical choices, and disables downstream controls with a reason", async () => {
    installFetch();
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);

    render(<UrlHarness />);

    const selector = await screen.findByRole("combobox", { name: "选择对话运行" });
    expect(selector).toHaveValue("");
    expect(window.location.search).toBe(`?thread=${threadId}`);
    const options = within(selector).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[1]).toHaveTextContent(/running.*run-new/);
    expect(options[2]).toHaveTextContent(/stopped.*run-old/);
    const controls = screen.getByRole("region", { name: "运行控制" });
    expect(within(controls).getByRole("button", { name: "暂停" })).toBeDisabled();
    expect(controls).toHaveTextContent("请先明确选择此对话的一次运行");
    expect(screen.queryByText(/运行状态：running/)).not.toBeInTheDocument();
  });

  it("keeps owner messages writable while another thread owns the active run", async () => {
    const activeOther = run(
      "run-other",
      "running",
      "2026-08-08T09:00:00.000Z",
      "thread-other",
    );
    const ownerMessage = {
      authorAgentId: null,
      authorDisplayName: "Owner",
      authorType: "owner",
      content: "Keep this thread moving",
      createdAt: "2026-08-08T09:01:00.000Z",
      id: "message-owner",
      mentionAgentId: null,
      mentionDisplayName: null,
      mentionMemberStatus: null,
      projectId,
      replyTo: null,
      runId: null,
      sequence: 1,
      threadId,
    };
    const ownerFact = {
      activitySequence: 4,
      actorId: null,
      actorType: "owner",
      createdAt: ownerMessage.createdAt,
      id: "fact-owner",
      message: ownerMessage,
      messageId: ownerMessage.id,
      payload: { messageId: ownerMessage.id },
      policyRevisionId: null,
      projectId,
      runEventId: null,
      runId: null,
      sequence: 1,
      threadId,
      type: "owner_message",
    };
    let persisted = false;
    const postedBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith(`/threads/${threadId}/messages`) && init?.method === "POST") {
        postedBodies.push(JSON.parse(String(init.body)));
        persisted = true;
        return Response.json({
          fact: ownerFact,
          message: ownerMessage,
          run: null,
        }, { status: 201 });
      }
      if (url.endsWith(`/threads/${threadId}`)) {
        return Response.json(detail({
          activeRun: { runId: activeOther.id, threadId: activeOther.threadId },
          runs: [],
          selectedRun: null,
        }));
      }
      if (url.endsWith(`/threads/${threadId}/messages`)) {
        return Response.json({
          items: persisted ? [ownerMessage] : [],
          nextAfter: null,
        });
      }
      if (url.endsWith(`/threads/${threadId}/facts`)) {
        return Response.json({
          items: persisted ? [ownerFact] : [],
          nextAfter: null,
        });
      }
      if (url.endsWith(`/projects/${projectId}/members`)) {
        return Response.json({ members: [], projectVersion: 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);
    const user = userEvent.setup();

    render(<UrlHarness />);

    expect(await screen.findByText(/另一对话有活动运行/)).toBeVisible();
    const composer = screen.getByLabelText("发送给项目对话");
    await user.type(composer, ownerMessage.content);
    const submit = screen.getByRole("button", { name: "发送消息" });
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await screen.findByText(ownerMessage.content)).toBeVisible();
    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]).toMatchObject({ content: ownerMessage.content });
    expect(screen.getByText(/不能在此启动新一轮/)).toBeVisible();
  });

  it("selects the exact historical run instead of project latest, uses canonical history, announces, and focuses", async () => {
    const pendingSelection = deferredResponse();
    let olderReads = 0;
    installFetch((url) => {
      if (url.includes(`?run=${older.id}`)) {
        olderReads += 1;
        return olderReads === 1
          ? pendingSelection.promise
          : Response.json(detail({ selectedRun: older }));
      }
      return Response.json(detail({ selectedRun: selectedRunFromUrl(url) }));
    });
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);
    const user = userEvent.setup();

    render(<UrlHarness />);

    const selector = await screen.findByRole("combobox", { name: "选择对话运行" });
    await user.selectOptions(selector, older.id);
    expect(screen.getByText("正在切换运行…")).toBeVisible();
    expect(window.location.search).toBe(`?thread=${threadId}&run=${older.id}`);
    pendingSelection.resolve(Response.json(detail({ selectedRun: older })));

    const heading = await screen.findByRole("heading", { name: `运行 ${older.id}` });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole("status", { name: "运行选择状态" })).toHaveTextContent(
      `已选择运行 ${older.id}`,
    );
    expect(screen.getByText("运行状态：stopped")).toBeVisible();
    expect(screen.getByText(/本轮已结束/)).toBeVisible();
    expect(screen.getByRole("button", { name: "发送并开始新一轮" })).toBeVisible();

    window.history.back();
    await waitFor(() =>
      expect(window.location.search).toBe(`?thread=${threadId}`)
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "选择对话运行" }))
        .toHaveValue("")
    );
    window.history.forward();
    await waitFor(() =>
      expect(window.location.search).toBe(`?thread=${threadId}&run=${older.id}`)
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "选择对话运行" }))
        .toHaveValue(older.id)
    );
  });

  it("shows loading, empty, and retryable detail error states without inventing a run", async () => {
    const pending = deferredResponse();
    let reads = 0;
    installFetch(async (url) => {
      reads += 1;
      if (reads === 1) return pending.promise;
      return Response.json(detail({ runs: [], selectedRun: null }));
    });
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);
    const user = userEvent.setup();

    render(<UrlHarness />);

    expect(screen.getByText("正在加载运行列表…")).toHaveAttribute("aria-busy", "true");
    pending.resolve(
      Response.json(
        { error: { code: "STORAGE_UNAVAILABLE", message: "failed" } },
        { status: 503 },
      ),
    );
    expect(await screen.findByRole("region", { name: "运行加载失败" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试加载运行" }));
    expect(await screen.findByText("尚无运行。发送首条消息以开始首次运行。"))
      .toBeVisible();
    expect(screen.getByRole("combobox", { name: "选择对话运行" })).toBeDisabled();
    expect(window.location.search).toBe(`?thread=${threadId}`);
  });

  it("recovers a stale run URL by clearing only the run and never selecting latest", async () => {
    let selectedReads = 0;
    installFetch((url) => {
      if (url.includes("?run=stale-run")) {
        selectedReads += 1;
        return selectedReads === 1
          ? Response.json(
              { error: { code: "RESOURCE_NOT_FOUND", message: "not found" } },
              { status: 404 },
            )
          : Response.json(detail({
              runs: [newest, run("stale-run", "paused", newest.createdAt, "other-thread")],
              selectedRun: run("stale-run", "paused", newest.createdAt, "other-thread"),
            }));
      }
      return Response.json(detail({ selectedRun: null }));
    });
    window.history.replaceState(
      null,
      "",
      `/projects/${projectId}?thread=${threadId}&run=stale-run`,
    );

    render(<UrlHarness />);

    await waitFor(() =>
      expect(window.location.search).toBe(`?thread=${threadId}`)
    );
    expect(await screen.findByRole("combobox", { name: "选择对话运行" }))
      .toHaveValue("");
    expect(screen.getByRole("status", { name: "运行选择状态" })).toHaveTextContent(
      "所选运行无效或已失效，已清除选择",
    );
    expect(screen.queryByText(/运行状态：running/)).not.toBeInTheDocument();
  });

  it("fails closed on a cross-thread selected run envelope and recovers to no selection", async () => {
    const crossRun = run(
      "run-cross",
      "paused",
      "2026-08-08T09:00:00.000Z",
      "other-thread",
    );
    installFetch((url) =>
      url.includes("?run=run-cross")
        ? Response.json(detail({ runs: [newest, crossRun], selectedRun: crossRun }))
        : Response.json(detail({ selectedRun: null }))
    );
    window.history.replaceState(
      null,
      "",
      `/projects/${projectId}?thread=${threadId}&run=run-cross`,
    );

    render(<UrlHarness />);

    await waitFor(() =>
      expect(window.location.search).toBe(`?thread=${threadId}`)
    );
    expect(await screen.findByRole("combobox", { name: "选择对话运行" }))
      .toHaveValue("");
    expect(screen.queryByRole("heading", { name: "运行 run-cross" }))
      .not.toBeInTheDocument();
  });

  it("returns safely to a server-provided active run in another thread without mutating it", async () => {
    const active = { runId: "run-active", threadId: "thread-active" };
    const fetchMock = installFetch((url) => {
      if (url.includes(`/threads/${threadId}`)) {
        return Response.json(detail({ activeRun: active, selectedRun: null }));
      }
      throw new Error(`Unexpected detail: ${url}`);
    });
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);
    const user = userEvent.setup();

    render(<UrlHarness />);

    const returnLink = await screen.findByRole("link", {
      name: "返回活动对话 run-active",
    });
    expect(returnLink).toHaveAttribute(
      "href",
      `/projects/${projectId}?thread=${active.threadId}&run=${active.runId}`,
    );
    returnLink.focus();
    await user.keyboard("{Enter}");
    expect(window.location.search).toBe(
      `?thread=${active.threadId}&run=${active.runId}`,
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
    ).toBe(false);
  });

  it("keeps the selector keyboard reachable in the narrow run-detail surface", async () => {
    installFetch((url) =>
      Response.json(detail({
        runs: [newest],
        selectedRun: url.includes(`?run=${newest.id}`) ? newest : null,
      }))
    );
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);
    const user = userEvent.setup();

    render(<UrlHarness surface="run" />);

    const selector = await screen.findByRole("combobox", { name: "选择对话运行" });
    expect(within(selector).getAllByRole("option")).toHaveLength(2);
    selector.focus();
    await user.selectOptions(selector, newest.id);
    expect(await screen.findByRole("heading", { name: `运行 ${newest.id}` }))
      .toHaveFocus();
    expect(screen.queryByLabelText("发送给项目对话")).not.toBeInTheDocument();
  });
});
