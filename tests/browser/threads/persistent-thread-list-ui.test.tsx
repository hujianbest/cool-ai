// @vitest-environment jsdom
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
    favoritedAt: null as string | null,
    id,
    isFavorite: false,
    lastActivitySequence: activity,
    policyVersion: 1,
    projectId: project.id,
    tags: [] as Array<{ id: string; name: string }>,
    title,
    updatedAt: "2026-08-08T00:00:00.000Z",
    version: 1,
  };
}

function createdThread(id = "thread-created", title = "Release") {
  const {
    favoritedAt: _favoritedAt,
    isFavorite: _isFavorite,
    tags: _tags,
    ...summary
  } = thread(id, title, 9);
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

function DirectThreadHarness() {
  const backgroundRef = useRef<HTMLElement>(null);
  return (
    <main data-testid="thread-background" ref={backgroundRef}>
      <ProjectThreadNavigation
        backgroundRef={backgroundRef}
        directMode
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
    if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
      return Response.json({ tags: [] });
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
      await screen.findByRole("navigation", { name: "项目对话" }),
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
      name: "项目对话",
    });
    await within(threadNavigation).findByText("暂无对话。创建对话后开始协作。");
    expect(
      within(threadNavigation).getAllByRole("button", { name: "创建对话" }),
    ).toHaveLength(1);
    await waitFor(() =>
      expect(
        screen.queryByLabelText("发送给项目对话"),
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
    const withTags = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/thread-tags")) return Response.json({ tags: [] });
      return fetchMock(input, init);
    });
    vi.stubGlobal("fetch", withTags);
    window.history.replaceState(null, "", `/projects/${project.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "服务暂时不可用",
    );
    await user.click(screen.getByRole("button", { name: "重试加载对话" }));
    await screen.findByText("暂无对话。创建对话后开始协作。");
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
        "所选对话无效或不属于当前项目",
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

    await screen.findByText("暂无对话。创建对话后开始协作。");
    const opener = screen.getByRole("button", { name: "新对话" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "创建对话" });
    expect(within(dialog).getByLabelText("对话标题")).toHaveFocus();
    expect(screen.getByTestId("thread-background")).toHaveAttribute("inert");

    within(dialog).getByRole("button", { name: "取消" }).focus();
    fireEvent.keyDown(
      within(dialog).getByRole("button", { name: "取消" }),
      { key: "Tab" },
    );
    expect(
      within(dialog).getByRole("button", { name: "关闭创建对话" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();

    await user.click(opener);
    await screen.findByLabelText(memberOne.name);
    expect(screen.getByRole("button", { name: "创建对话" })).toBeDisabled();
    await user.click(screen.getByLabelText(memberOne.name));
    await user.click(screen.getByLabelText(memberTwo.name));
    await user.click(
      within(screen.getByRole("dialog", { name: "创建对话" })).getByRole(
        "button",
        { name: "创建对话" },
      ),
    );
    expect(await screen.findByText("请输入对话标题。")).toBeInTheDocument();
    expect(screen.getByLabelText("对话标题")).toHaveAttribute(
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
      if (url.endsWith("/thread-tags?limit=100")) {
        return Response.json({ tags: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    window.history.replaceState(null, "", `/projects/${project.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    await screen.findByText("暂无对话。创建对话后开始协作。");
    await user.click(screen.getByRole("button", { name: "创建对话" }));
    await user.type(screen.getByLabelText("对话标题"), created.thread.title);
    await user.click(await screen.findByLabelText(memberOne.name));
    await user.click(screen.getByLabelText(memberTwo.name));
    await user.click(
      within(screen.getByRole("dialog", { name: "创建对话" })).getByRole(
        "button",
        { name: "创建对话" },
      ),
    );

    expect(screen.getByText("创建请求处理中，表单暂不可用。")).toBeVisible();
    expect(screen.getByLabelText("对话标题")).toBeDisabled();
    pending.resolve(Response.json(created, { status: 201 }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(`对话“${created.thread.title}”已创建`);
    const createdEntry = screen.getByRole("button", {
      name: created.thread.title,
    });
    await waitFor(() => expect(createdEntry).toHaveFocus());
    expect(window.location.search).toBe(`?thread=${created.thread.id}`);
  });

  it("creates a home conversation with its sole Agent and no policy picker", async () => {
    const created = createdThread("direct-thread", "Personal chat");
    const directCreated = {
      ...created,
      thread: {
        ...created.thread,
        policy: {
          ...created.thread.policy,
          members: created.thread.policy.members.slice(0, 1),
        },
      },
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/threads?limit=100")) {
          return Response.json(list([]));
        }
        if (url.endsWith("/thread-tags?limit=100")) {
          return Response.json({ tags: [] });
        }
        if (url.endsWith("/members")) {
          return Response.json({
            members: [memberOne],
            projectVersion: 2,
          });
        }
        if (url.endsWith("/threads") && init?.method === "POST") {
          return Response.json(directCreated, { status: 201 });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    window.history.replaceState(null, "", "/");
    const user = userEvent.setup();

    render(<DirectThreadHarness />);

    await screen.findByText("暂无对话。创建对话后开始协作。");
    await user.click(screen.getByRole("button", { name: "创建对话" }));
    const dialog = screen.getByRole("dialog", { name: "创建对话" });
    expect(await within(dialog).findByText(memberOne.name)).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("对话标题"), "Personal chat");
    await user.click(within(dialog).getByRole("button", { name: "创建对话" }));

    await screen.findByRole("button", { name: "Personal chat" });
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/threads") && init?.method === "POST",
    );
    expect(createCall).toBeDefined();
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      memberAgentIds: [memberOne.agentId],
      title: "Personal chat",
    });
  });

  it("reconciles an unknown create by operation without resending", async () => {
    const created = createdThread("thread-reconciled", "Reconciled");
    const { policy: _policy, ...createdDetail } = created.thread;
    const createdSummary = {
      ...createdDetail,
      favoritedAt: null,
      isFavorite: false,
      tags: [],
    };
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
      if (url.endsWith("/thread-tags?limit=100")) {
        return Response.json({ tags: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    window.history.replaceState(null, "", `/projects/${project.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    await screen.findByText("暂无对话。创建对话后开始协作。");
    await user.click(screen.getByRole("button", { name: "创建对话" }));
    await user.type(screen.getByLabelText("对话标题"), created.thread.title);
    await user.click(await screen.findByLabelText(memberOne.name));
    await user.click(screen.getByLabelText(memberTwo.name));
    await user.click(
      within(screen.getByRole("dialog", { name: "创建对话" })).getByRole(
        "button",
        { name: "创建对话" },
      ),
    );

    expect(
      await screen.findByText(/已通过操作核对确认对话/),
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
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/thread-tags")) return Response.json({ tags: [] });
        return Response.json({
          nextCursor: null,
          threads: [{ ...thread("thread-1", "Foreign", 1), projectId: "other" }],
        });
      }),
    );
    window.history.replaceState(
      null,
      "",
      `/projects/${project.id}?thread=thread-1`,
    );

    render(<ThreadHarness />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法加载项目对话",
    );
    expect(window.location.search).toBe("?thread=thread-1");
    expect(screen.queryByRole("button", { name: "Foreign" })).not.toBeInTheDocument();
  });
});

describe("thread favorites UI", () => {
  type ThreadItem = ReturnType<typeof thread>;
  type FavoriteWriteHandler = (
    threadId: string,
    favorite: boolean,
  ) => Response | Promise<Response>;

  function favorited(id: string, title: string, activity: number, favoritedAt: string) {
    return { ...thread(id, title, activity), favoritedAt, isFavorite: true };
  }

  function favoriteResponse(threadId: string, favorite: boolean, favoritedAt: string | null) {
    return {
      favoritedAt,
      isFavorite: favorite,
      projectId: project.id,
      threadId,
    };
  }

  function stubFavoriteServer(initial: ThreadItem[]) {
    const favorites = new Map<string, string>();
    for (const item of initial) {
      if (item.isFavorite && item.favoritedAt) {
        favorites.set(item.id, item.favoritedAt);
      }
    }
    const calls: { favorite: boolean; threadId: string }[] = [];
    let writeHandler: FavoriteWriteHandler | null = null;
    const decorate = (item: ThreadItem) => ({
      ...item,
      favoritedAt: favorites.get(item.id) ?? null,
      isFavorite: favorites.has(item.id),
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/projects/${project.id}/threads?limit=100`) {
        return Response.json(list(initial.map(decorate)));
      }
      if (url === `/api/projects/${project.id}/threads?limit=100&favorites=true`) {
        const favoritesOnly = initial
          .map(decorate)
          .filter((item) => item.isFavorite)
          .sort(
            (left, right) =>
              (right.favoritedAt ?? "").localeCompare(left.favoritedAt ?? "")
              || left.id.localeCompare(right.id),
          );
        return Response.json(list(favoritesOnly));
      }
      const favoriteMatch = url.match(
        new RegExp(`^/api/projects/${project.id}/threads/([^/]+)/favorite$`),
      );
      if (favoriteMatch && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { favorite: boolean };
        const threadId = favoriteMatch[1]!;
        calls.push({ favorite: body.favorite, threadId });
        if (writeHandler) return writeHandler(threadId, body.favorite);
        if (body.favorite) favorites.set(threadId, "2026-08-10T00:00:00.000Z");
        else favorites.delete(threadId);
        return Response.json(
          favoriteResponse(threadId, body.favorite, favorites.get(threadId) ?? null),
        );
      }
      if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
        return Response.json({ tags: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    return {
      calls,
      fetchMock,
      setWriteHandler(handler: FavoriteWriteHandler | null) {
        writeHandler = handler;
      },
    };
  }

  function threadTitles(): string[] {
    return screen
      .getAllByRole("button")
      .filter((button) => button.dataset.threadId !== undefined)
      .map((button) => button.textContent ?? "");
  }

  it("toggles favorites with aria-pressed, accessible names, keyboard, and stable list order", async () => {
    const alpha = thread("thread-alpha", "Alpha", 2);
    const beta = favorited("thread-beta", "Beta", 1, "2026-08-09T00:00:00.000Z");
    const server = stubFavoriteServer([alpha, beta]);
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=${alpha.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    const alphaStar = await screen.findByRole("button", { name: "收藏对话 Alpha" });
    expect(alphaStar).toHaveAttribute("aria-pressed", "false");
    const betaStar = screen.getByRole("button", { name: "取消收藏 Beta" });
    expect(betaStar).toHaveAttribute("aria-pressed", "true");

    await user.click(alphaStar);
    expect(
      screen.getByRole("button", { name: "取消收藏 Alpha" }),
    ).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(server.calls).toEqual([{ favorite: true, threadId: "thread-alpha" }]),
    );
    expect(threadTitles()).toEqual(["Alpha", "Beta"]);

    screen.getByRole("button", { name: "取消收藏 Beta" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(server.calls).toContainEqual({ favorite: false, threadId: "thread-beta" }),
    );
    expect(
      await screen.findByRole("button", { name: "收藏对话 Beta" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(threadTitles()).toEqual(["Alpha", "Beta"]);
  });

  it("rolls back an optimistic favorite and surfaces an alert when the write fails", async () => {
    const alpha = thread("thread-alpha", "Alpha", 1);
    const server = stubFavoriteServer([alpha]);
    server.setWriteHandler(() =>
      Response.json(
        { error: { code: "STORAGE_UNAVAILABLE", message: "read failed" } },
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=${alpha.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    await user.click(await screen.findByRole("button", { name: "收藏对话 Alpha" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用");
    expect(
      screen.getByRole("button", { name: "收藏对话 Alpha" }),
    ).toHaveAttribute("aria-pressed", "false");

    server.setWriteHandler(() => {
      throw new TypeError("connection lost");
    });
    await user.click(screen.getByRole("button", { name: "收藏对话 Alpha" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法更新收藏状态，请重试。",
    );
    expect(
      screen.getByRole("button", { name: "收藏对话 Alpha" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("disables the star toggle while the favorite write is pending", async () => {
    const pending = deferredResponse();
    const alpha = thread("thread-alpha", "Alpha", 1);
    const server = stubFavoriteServer([alpha]);
    server.setWriteHandler(() => pending.promise);
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=${alpha.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    await user.click(await screen.findByRole("button", { name: "收藏对话 Alpha" }));
    expect(screen.getByRole("button", { name: "取消收藏 Alpha" })).toBeDisabled();

    pending.resolve(
      Response.json(favoriteResponse("thread-alpha", true, "2026-08-10T00:00:00.000Z")),
    );
    expect(
      await screen.findByRole("button", { name: "取消收藏 Alpha" }),
    ).toBeEnabled();
  });

  it("filters the favorites view with server order, removes unfavorited threads, and shows an empty state", async () => {
    const alpha = favorited("thread-alpha", "Alpha", 3, "2026-08-09T10:00:00.000Z");
    const beta = thread("thread-beta", "Beta", 2);
    const charlie = favorited("thread-charlie", "Charlie", 1, "2026-08-09T09:00:00.000Z");
    const server = stubFavoriteServer([alpha, beta, charlie]);
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=${beta.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    await screen.findByRole("button", { name: "Beta" });
    await user.click(screen.getByRole("tab", { name: "收藏" }));

    expect(await screen.findByRole("button", { name: "Alpha" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Charlie" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Beta" })).not.toBeInTheDocument();
    expect(threadTitles()).toEqual(["Alpha", "Charlie"]);
    expect(server.fetchMock).toHaveBeenCalledWith(
      `/api/projects/${project.id}/threads?limit=100&favorites=true`,
      expect.anything(),
    );

    await user.click(screen.getByRole("button", { name: "取消收藏 Alpha" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Alpha" })).not.toBeInTheDocument(),
    );
    expect(threadTitles()).toEqual(["Charlie"]);

    await user.click(screen.getByRole("button", { name: "取消收藏 Charlie" }));
    expect(
      await screen.findByText(/暂无收藏对话/),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "查看全部对话" }));
    expect(await screen.findByRole("button", { name: "Beta" })).toBeVisible();
    expect(threadTitles()).toEqual(["Alpha", "Beta", "Charlie"]);
  });

  it("reinserts a thread into the favorites view when an unfavorite fails", async () => {
    const alpha = favorited("thread-alpha", "Alpha", 2, "2026-08-09T10:00:00.000Z");
    const beta = favorited("thread-beta", "Beta", 1, "2026-08-09T09:00:00.000Z");
    const server = stubFavoriteServer([alpha, beta]);
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=${alpha.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    await user.click(await screen.findByRole("tab", { name: "收藏" }));
    await screen.findByRole("button", { name: "取消收藏 Beta" });

    server.setWriteHandler(() => {
      throw new TypeError("connection lost");
    });
    await user.click(screen.getByRole("button", { name: "取消收藏 Beta" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法更新收藏状态，请重试。",
    );
    expect(threadTitles()).toEqual(["Alpha", "Beta"]);
    expect(
      screen.getByRole("button", { name: "取消收藏 Beta" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the selected thread context when switching between views", async () => {
    const alpha = favorited("thread-alpha", "Alpha", 2, "2026-08-09T10:00:00.000Z");
    const beta = thread("thread-beta", "Beta", 1);
    const server = stubFavoriteServer([alpha, beta]);
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=${beta.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    await screen.findByRole("button", { name: "Beta" });
    await user.click(screen.getByRole("tab", { name: "收藏" }));
    await screen.findByRole("button", { name: "Alpha" });

    expect(window.location.search).toBe(`?thread=${beta.id}`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "全部" }));
    await screen.findByRole("button", { name: "Beta" });
    expect(window.location.search).toBe(`?thread=${beta.id}`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("moves between view tabs with arrow keys", async () => {
    const alpha = favorited("thread-alpha", "Alpha", 1, "2026-08-09T10:00:00.000Z");
    const server = stubFavoriteServer([alpha]);
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=${alpha.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);

    const allTab = await screen.findByRole("tab", { name: "全部" });
    allTab.focus();
    await user.keyboard("{ArrowRight}");
    const favoritesTab = screen.getByRole("tab", { name: "收藏" });
    expect(favoritesTab).toHaveFocus();
    expect(favoritesTab).toHaveAttribute("aria-selected", "true");
    await screen.findByRole("button", { name: "取消收藏 Alpha" });

    await user.keyboard("{ArrowLeft}");
    expect(allTab).toHaveFocus();
    expect(allTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "标签" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "标签" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("opens a new conversation from the header control or Cmd+N and keeps 回收站 off the tablist", async () => {
    const alpha = favorited("thread-alpha", "Alpha", 1, "2026-08-09T10:00:00.000Z");
    const server = stubFavoriteServer([alpha]);
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=${alpha.id}`);
    const user = userEvent.setup();

    render(<ThreadHarness />);
    await screen.findByRole("button", { name: "Alpha" });

    const tablist = screen.getByRole("tablist", { name: "对话视图" });
    expect(
      [...tablist.querySelectorAll('[role="tab"]')].map((node) => node.textContent),
    ).toEqual(["全部", "收藏", "标签"]);
    expect(within(tablist).queryByRole("tab", { name: "回收站" })).toBeNull();
    expect(screen.getByRole("button", { name: "回收站" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await user.click(screen.getByRole("button", { name: "新对话" }));
    expect(await screen.findByRole("dialog", { name: "创建对话" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "创建对话" })).toBeNull();

    await user.keyboard("{Control>}n{/Control}");
    expect(await screen.findByRole("dialog", { name: "创建对话" })).toBeInTheDocument();
  });

  it("restores favorite state from the server after a remount", async () => {
    const alpha = thread("thread-alpha", "Alpha", 1);
    const server = stubFavoriteServer([alpha]);
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=${alpha.id}`);
    const user = userEvent.setup();

    const first = render(<ThreadHarness />);
    await user.click(await screen.findByRole("button", { name: "收藏对话 Alpha" }));
    await screen.findByRole("button", { name: "取消收藏 Alpha" });
    first.unmount();

    render(<ThreadHarness />);
    expect(
      await screen.findByRole("button", { name: "取消收藏 Alpha" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
