import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectPanel } from "@/components/project-panel";
import { ProjectThreadNavigation } from "@/components/project-thread-navigation";

const project = {
  createdAt: "2026-08-08T00:00:00.000Z",
  id: "project-1",
  name: "Launch plan",
};

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const memberOne = { agentId: "agent-1", name: "Ada" };
const memberTwo = { agentId: "agent-2", name: "Lin" };
const operationId = "11111111-1111-4111-8111-111111111111";

function thread(id: string, title: string, activity: number) {
  return {
    availability: "ready" as const,
    createdAt: "2026-08-08T00:00:00.000Z",
    id,
    lastActivitySequence: activity,
    policyVersion: 1,
    projectId: project.id,
    title,
    updatedAt: "2026-08-08T00:00:00.000Z",
    version: 1,
  };
}

function createdThread(id = "thread-created", title = "Release") {
  const summary = thread(id, title, 9);
  return {
    created: true as const,
    fact: {
      activitySequence: 8,
      actorId: null,
      actorType: "owner" as const,
      createdAt: "2026-08-08T00:00:00.000Z",
      id: "fact-created",
      message: null,
      messageId: null,
      payload: { title },
      policyRevisionId: null,
      projectId: project.id,
      runEventId: null,
      runId: null,
      sequence: 1,
      threadId: id,
      type: "thread_created" as const,
    },
    thread: {
      ...summary,
      policy: {
        availability: "ready" as const,
        createdAt: "2026-08-08T00:00:00.000Z",
        members: [
          {
            agentId: memberOne.agentId,
            displayNameSnapshot: memberOne.name,
            live: "current" as const,
            position: 0,
          },
          {
            agentId: memberTwo.agentId,
            displayNameSnapshot: memberTwo.name,
            live: "current" as const,
            position: 1,
          },
        ],
        revisionId: "revision-1",
        unavailableMemberIds: [],
        version: 1,
      },
    },
  };
}

function list(threads: ReturnType<typeof thread>[]) {
  return { nextCursor: null, threads };
}

function ThreadHarness() {
  const backgroundRef = useRef<HTMLElement>(null);
  return (
    <main data-testid="thread-background" ref={backgroundRef}>
      <span>
        Project content
      </span>
      <ProjectThreadNavigation
        backgroundRef={backgroundRef}
        projectId={project.id}
      />
    </main>
  );
}

function stubListAndMembers(threads: ReturnType<typeof thread>[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/projects/${project.id}/threads?limit=100`) {
      return Response.json(list(threads));
    }
    if (url === `/api/projects/${project.id}/members`) {
      return Response.json({
        members: [memberOne, memberTwo],
        projectVersion: 1,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function stubProjectPanelFetch(threads: ReturnType<typeof thread>[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/projects") {
      return Response.json({ projects: [project] });
    }
    if (url === `/api/projects/${project.id}/threads?limit=100`) {
      return Response.json(list(threads));
    }
    if (url.endsWith("/tasks")) return Response.json({ events: [], tasks: [] });
    if (url.endsWith("/members")) {
      return Response.json({ members: [], projectVersion: 1 });
    }
    if (url.endsWith("/mission")) {
      return Response.json({ mission: null, workItems: [] });
    }
    if (url.endsWith("/executions")) {
      return Response.json({ executions: [] });
    }
    return Response.json({});
  });
}

afterEach(() => {
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("persistent project thread list and creation", () => {
  it("renders the project thread list as busy while the strict list API is loading", async () => {
    const threads = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects") {
          return Response.json({ projects: [project] });
        }
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return threads.promise;
        }
        if (url === `/api/projects/${project.id}/tasks`) {
          return Response.json({ events: [], tasks: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}`);

    render(<ProjectPanel />);

    expect(
      await screen.findByRole("navigation", { name: "项目线程" }),
    ).toHaveAttribute("aria-busy", "true");
  });

  it("shows one clear empty CTA and removes the collaboration composer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects") {
          return Response.json({ projects: [project] });
        }
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Response.json(list([]));
        }
        if (url.endsWith("/tasks")) return Response.json({ events: [], tasks: [] });
        if (url.endsWith("/members")) {
          return Response.json({ members: [], projectVersion: 1 });
        }
        if (url.endsWith("/mission")) {
          return Response.json({ mission: null, workItems: [] });
        }
        if (url.endsWith("/collaboration")) {
          return Response.json({
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
          });
        }
        if (url.endsWith("/executions")) {
          return Response.json({ executions: [] });
        }
        return Response.json({});
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}`);

    render(<ProjectPanel />);

    const threadNavigation = await screen.findByRole("navigation", {
      name: "项目线程",
    });
    await within(threadNavigation).findByText("暂无线程。创建线程后开始协作。");
    expect(
      within(threadNavigation).getAllByRole("button", { name: "创建线程" }),
    ).toHaveLength(1);
    await waitFor(() =>
      expect(
        screen.queryByLabelText("发送给项目群聊"),
      ).not.toBeInTheDocument(),
    );
  });

  it("renders an alert and retries a failed strict list read", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "read failed" } },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(Response.json(list([])));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "服务暂时不可用",
    );
    await user.click(screen.getByRole("button", { name: "重试加载线程" }));
    await screen.findByText("暂无线程。创建线程后开始协作。");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps thread navigation usable inside the narrow project drawer", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: true,
        media: "(max-width: 56.25rem)",
        removeEventListener: vi.fn(),
      })),
    );
    vi.stubGlobal(
      "fetch",
      stubProjectPanelFetch([thread("thread-mobile", "Mobile thread", 1)]),
    );
    window.history.replaceState(null, "", `/projects/${project.id}`);
    const user = userEvent.setup();

    render(<ProjectPanel />);

    await user.click(
      await screen.findByRole("button", { name: "打开项目导航" }),
    );
    const drawer = screen.getByRole("dialog", { name: "项目导航" });
    expect(
      await within(drawer).findByRole("button", { name: "Mobile thread" }),
    ).toBeVisible();
  });

  it("updates settings return links when the canonical thread selection changes", async () => {
    const first = thread("thread-first", "First", 2);
    const second = thread("thread-second", "Second", 1);
    vi.stubGlobal("fetch", stubProjectPanelFetch([first, second]));
    window.history.replaceState(
      null,
      "",
      `/projects/${project.id}?thread=${first.id}`,
    );
    const user = userEvent.setup();

    render(<ProjectPanel />);

    await user.click(
      await screen.findByRole("button", { name: second.title }),
    );
    const selectedHref = `/projects/${project.id}?thread=${second.id}`;
    expect(screen.getByRole("link", { name: "团队" })).toHaveAttribute(
      "href",
      `/team?section=skills&returnTo=${encodeURIComponent(selectedHref)}`,
    );
  });

  it("uses URL selection, replaces stale selection, and preserves explicit selection through history", async () => {
    const newest = thread("thread-new", "Same title", 20);
    const older = thread("thread-old", "Same title", 10);
    vi.stubGlobal("fetch", stubListAndMembers([newest, older]));
    window.history.replaceState(
      null,
      "",
      `/projects/${project.id}?thread=${older.id}`,
    );
    const user = userEvent.setup();

    render(<ThreadHarness />);

    const duplicateEntries = await screen.findAllByRole("button", {
      name: "Same title",
    });
    expect(duplicateEntries).toHaveLength(2);
    expect(duplicateEntries[1]).toHaveAttribute("aria-current", "page");
    expect(window.location.search).toBe(`?thread=${older.id}`);

    await user.click(duplicateEntries[0]!);
    expect(window.location.search).toBe(`?thread=${newest.id}`);
    expect(duplicateEntries[0]).toHaveFocus();

    window.history.back();
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() =>
      expect(duplicateEntries[1]).toHaveAttribute("aria-current", "page"),
    );

    window.history.replaceState(
      null,
      "",
      `/projects/${project.id}?thread=foreign-thread&run=foreign-run`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "所选线程无效或不属于当前项目",
      ),
    );
    expect(window.location.search).toBe("?thread=foreign-thread&run=foreign-run");
    expect(duplicateEntries[0]).not.toHaveAttribute("aria-current");
    expect(duplicateEntries[1]).not.toHaveAttribute("aria-current");

    window.history.replaceState(null, "", `/projects/${project.id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() =>
      expect(window.location.search).toBe(`?thread=${newest.id}`),
    );
  });

  it("traps dialog focus, closes on Escape, restores focus, and validates title and members", async () => {
    vi.stubGlobal("fetch", stubListAndMembers([]));
    window.history.replaceState(null, "", `/projects/${project.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    await screen.findByText("暂无线程。创建线程后开始协作。");
    const opener = screen.getByRole("button", { name: "创建线程" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "创建线程" });
    expect(within(dialog).getByLabelText("线程标题")).toHaveFocus();
    expect(screen.getByTestId("thread-background")).toHaveAttribute("inert");

    within(dialog).getByRole("button", { name: "取消" }).focus();
    fireEvent.keyDown(
      within(dialog).getByRole("button", { name: "取消" }),
      { key: "Tab" },
    );
    expect(
      within(dialog).getByRole("button", { name: "关闭创建线程" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    await user.click(opener);
    await screen.findByLabelText(memberOne.name);
    expect(screen.getByRole("button", { name: "创建线程" })).toBeDisabled();
    await user.click(screen.getByLabelText(memberOne.name));
    await user.click(screen.getByLabelText(memberTwo.name));
    await user.click(
      within(screen.getByRole("dialog", { name: "创建线程" })).getByRole(
        "button",
        { name: "创建线程" },
      ),
    );
    expect(await screen.findByText("请输入线程标题。")).toBeInTheDocument();
    expect(screen.getByLabelText("线程标题")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("locks the pending form with a reason, then announces success and focuses the created thread", async () => {
    const pending = deferredResponse();
    const created = createdThread();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/threads?limit=100")) return Response.json(list([]));
      if (url.endsWith("/members")) {
        return Response.json({
          members: [memberOne, memberTwo],
          projectVersion: 1,
        });
      }
      if (url.endsWith("/threads") && init?.method === "POST") {
        return pending.promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    window.history.replaceState(null, "", `/projects/${project.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    await screen.findByText("暂无线程。创建线程后开始协作。");
    await user.click(screen.getByRole("button", { name: "创建线程" }));
    await user.type(screen.getByLabelText("线程标题"), created.thread.title);
    await user.click(await screen.findByLabelText(memberOne.name));
    await user.click(screen.getByLabelText(memberTwo.name));
    await user.click(
      within(screen.getByRole("dialog", { name: "创建线程" })).getByRole(
        "button",
        { name: "创建线程" },
      ),
    );

    expect(screen.getByText("创建请求处理中，表单暂不可用。")).toBeVisible();
    expect(screen.getByLabelText("线程标题")).toBeDisabled();
    pending.resolve(Response.json(created, { status: 201 }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(`线程“${created.thread.title}”已创建`);
    const createdEntry = screen.getByRole("button", {
      name: created.thread.title,
    });
    await waitFor(() => expect(createdEntry).toHaveFocus());
    expect(window.location.search).toBe(`?thread=${created.thread.id}`);
  });

  it("reconciles an unknown create by operation without resending", async () => {
    const created = createdThread("thread-reconciled", "Reconciled");
    const { policy: _policy, ...createdSummary } = created.thread;
    let listReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/threads?limit=100")) {
        listReads += 1;
        return Response.json(list(listReads === 1 ? [] : [createdSummary]));
      }
      if (url.endsWith("/members")) {
        return Response.json({
          members: [memberOne, memberTwo],
          projectVersion: 1,
        });
      }
      if (url.endsWith("/threads") && init?.method === "POST") {
        throw new TypeError("connection lost");
      }
      if (url.endsWith(`/operations/${operationId}`)) {
        return Response.json({
          httpStatus: 201,
          kind: "thread_create",
          operationId,
          response: created,
          status: "completed",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    window.history.replaceState(null, "", `/projects/${project.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    await screen.findByText("暂无线程。创建线程后开始协作。");
    await user.click(screen.getByRole("button", { name: "创建线程" }));
    await user.type(screen.getByLabelText("线程标题"), created.thread.title);
    await user.click(await screen.findByLabelText(memberOne.name));
    await user.click(screen.getByLabelText(memberTwo.name));
    await user.click(
      within(screen.getByRole("dialog", { name: "创建线程" })).getByRole(
        "button",
        { name: "创建线程" },
      ),
    );

    expect(
      await screen.findByText(/已通过操作核对确认线程/),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith("/threads") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("rejects a cross-project list envelope without selecting a thread", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          nextCursor: null,
          threads: [{ ...thread("thread-1", "Foreign", 1), projectId: "other" }],
        }),
      ),
    );
    window.history.replaceState(
      null,
      "",
      `/projects/${project.id}?thread=thread-1`,
    );

    render(<ThreadHarness />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法加载项目线程",
    );
    expect(window.location.search).toBe("?thread=thread-1");
    expect(screen.queryByRole("button", { name: "Foreign" })).not.toBeInTheDocument();
  });
});
