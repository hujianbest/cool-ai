// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectThreadNavigation } from "@/components/project-thread-navigation";

const project = {
  createdAt: "2026-08-08T00:00:00.000Z",
  id: "project-1",
  name: "Launch plan",
};

type TestTag = {
  createdAt: string;
  id: string;
  name: string;
  projectId: string;
  threadCount: number;
};

type TestThread = {
  availability: "ready";
  createdAt: string;
  favoritedAt: string | null;
  id: string;
  isFavorite: boolean;
  lastActivitySequence: number;
  policyVersion: number;
  projectId: string;
  tags: Array<{ id: string; name: string }>;
  title: string;
  updatedAt: string;
  version: number;
};

function thread(
  id: string,
  title: string,
  activity: number,
  tagRefs: Array<{ id: string; name: string }> = [],
): TestThread {
  return {
    availability: "ready",
    createdAt: "2026-08-08T00:00:00.000Z",
    favoritedAt: null,
    id,
    isFavorite: false,
    lastActivitySequence: activity,
    policyVersion: 1,
    projectId: project.id,
    tags: tagRefs,
    title,
    updatedAt: "2026-08-08T00:00:00.000Z",
    version: 1,
  };
}

function tag(id: string, name: string): TestTag {
  return {
    createdAt: "2026-08-08T00:00:00.000Z",
    id,
    name,
    projectId: project.id,
    threadCount: 0,
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ThreadTagsHarness({ projectId = project.id }: { projectId?: string }) {
  const backgroundRef = useRef<HTMLElement>(null);
  return (
    <main data-testid="thread-tags-background" ref={backgroundRef}>
      <ProjectThreadNavigation
        backgroundRef={backgroundRef}
        projectId={projectId}
      />
    </main>
  );
}

type BatchCall = {
  addTagIds: string[];
  operationId: string;
  removeTagIds: string[];
  threadIds: string[];
};

function stubTagServer(initialThreads: TestThread[], initialTags: TestTag[]) {
  const state = {
    tags: initialTags.map((item) => ({ ...item })),
    threads: initialThreads.map((item) => ({
      ...item,
      tags: item.tags.map((ref) => ({ ...ref })),
    })),
  };
  const recount = () => {
    for (const item of state.tags) {
      item.threadCount = state.threads.filter((entry) =>
        entry.tags.some((ref) => ref.id === item.id)
      ).length;
    }
  };
  recount();
  const batchCalls: BatchCall[] = [];
  const requestedUrls: string[] = [];
  let createHandler: ((name: string) => Response) | null = null;
  let deleteHandler: ((tagId: string) => Response) | null = null;
  let batchHandler: ((call: BatchCall) => Response | Promise<Response>) | null =
    null;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requestedUrls.push(url);
    const parsed = new URL(url, "https://cockpit.test");
    const threadsPath = `/api/projects/${project.id}/threads`;
    const tagsPath = `/api/projects/${project.id}/thread-tags`;
    if (parsed.pathname === tagsPath && !init?.method) {
      recount();
      return Response.json({ tags: state.tags });
    }
    if (parsed.pathname === tagsPath && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string };
      if (createHandler) return createHandler(body.name);
      const existing = state.tags.find(
        (item) => item.name.toLowerCase() === body.name.toLowerCase(),
      );
      if (existing) {
        const { threadCount: _ignored, ...existingDto } = existing;
        return Response.json({ created: false, tag: existingDto });
      }
      const createdTag: TestTag = {
        createdAt: "2026-08-11T00:00:00.000Z",
        id: `tag-${state.tags.length + 1}`,
        name: body.name,
        projectId: project.id,
        threadCount: 0,
      };
      state.tags.push(createdTag);
      const { threadCount: _threadCount, ...createdDto } = createdTag;
      return Response.json({ created: true, tag: createdDto }, { status: 201 });
    }
    const deleteMatch = parsed.pathname.match(
      new RegExp(`^/api/projects/${project.id}/thread-tags/([^/]+)$`),
    );
    if (deleteMatch && init?.method === "DELETE") {
      const tagId = deleteMatch[1]!;
      if (deleteHandler) return deleteHandler(tagId);
      const target = state.tags.find((item) => item.id === tagId);
      if (!target) {
        return Response.json(
          { error: { code: "RESOURCE_NOT_FOUND", message: "missing" } },
          { status: 404 },
        );
      }
      let removedEdgeCount = 0;
      for (const entry of state.threads) {
        const before = entry.tags.length;
        entry.tags = entry.tags.filter((ref) => ref.id !== tagId);
        removedEdgeCount += before - entry.tags.length;
      }
      state.tags = state.tags.filter((item) => item.id !== tagId);
      return Response.json({ removedEdgeCount, tagId });
    }
    if (parsed.pathname === threadsPath && !init?.method) {
      const favoritesOnly = parsed.searchParams.get("favorites") === "true";
      const tagId = parsed.searchParams.get("tagId");
      let items = state.threads;
      if (favoritesOnly) {
        items = items.filter((entry) => entry.isFavorite);
      } else if (tagId) {
        items = items.filter((entry) =>
          entry.tags.some((ref) => ref.id === tagId)
        );
      }
      return Response.json({ nextCursor: null, threads: items });
    }
    if (
      parsed.pathname === `/api/projects/${project.id}/thread-tag-batch`
      && init?.method === "POST"
    ) {
      const call = JSON.parse(String(init.body)) as BatchCall;
      if (batchHandler) return batchHandler(call);
      batchCalls.push(call);
      const applied = call.threadIds.map((threadId) => {
        const entry = state.threads.find((item) => item.id === threadId);
        if (!entry) {
          return { addedTagIds: [], removedTagIds: [], threadId };
        }
        const addedTagIds: string[] = [];
        const removedTagIds: string[] = [];
        for (const addId of call.addTagIds) {
          if (!entry.tags.some((ref) => ref.id === addId)) {
            const target = state.tags.find((item) => item.id === addId);
            if (target) {
              entry.tags.push({ id: target.id, name: target.name });
              addedTagIds.push(addId);
            }
          }
        }
        for (const removeId of call.removeTagIds) {
          const before = entry.tags.length;
          entry.tags = entry.tags.filter((ref) => ref.id !== removeId);
          if (entry.tags.length !== before) removedTagIds.push(removeId);
        }
        return { addedTagIds, removedTagIds, threadId };
      });
      recount();
      return Response.json({
        applied,
        operationId: call.operationId,
        replayed: false,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  return {
    batchCalls,
    fetchMock,
    requestedUrls,
    state,
    setBatchHandler(handler: typeof batchHandler) {
      batchHandler = handler;
    },
    setCreateHandler(handler: typeof createHandler) {
      createHandler = handler;
    },
    setDeleteHandler(handler: typeof deleteHandler) {
      deleteHandler = handler;
    },
  };
}

afterEach(() => {
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("manage tags dialog", () => {
  it("opens from the thread section, lists tags with usage counts, closes on Escape and returns focus", async () => {
    const server = stubTagServer(
      [thread("thread-1", "发布计划", 1)],
      [tag("tag-1", "发布"), tag("tag-2", "缺陷")],
    );
    server.state.threads[0]!.tags.push({ id: "tag-1", name: "发布" });
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });

    const opener = screen.getByRole("button", { name: "管理标签" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "管理标签" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("thread-tags-background")).toHaveAttribute("inert");
    expect(within(dialog).getByLabelText("新标签名称")).toHaveFocus();

    const rows = within(dialog).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("发布")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("已分配 1 条线程")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("已分配 0 条线程")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "管理标签" })).toBeNull();
    expect(opener).toHaveFocus();
    expect(screen.getByTestId("thread-tags-background")).not.toHaveAttribute("inert");
  });

  it("validates the create input with trim and a 40-grapheme limit before posting", async () => {
    const server = stubTagServer([thread("thread-1", "发布计划", 1)], []);
    const created: string[] = [];
    server.setCreateHandler((name) => {
      created.push(name);
      return Response.json(
        {
          created: true,
          tag: {
            createdAt: "2026-08-11T00:00:00.000Z",
            id: "tag-new",
            name,
            projectId: project.id,
          },
        },
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });
    await user.click(screen.getByRole("button", { name: "管理标签" }));
    const dialog = await screen.findByRole("dialog", { name: "管理标签" });

    const input = within(dialog).getByLabelText("新标签名称");
    await user.click(within(dialog).getByRole("button", { name: "创建标签" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "请输入标签名称。",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(created).toHaveLength(0);

    await user.type(input, "  发布  ");
    await user.click(within(dialog).getByRole("button", { name: "创建标签" }));
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "已创建标签“发布”。",
    );
    expect(created).toEqual(["发布"]);
    expect(input).toHaveValue("");
    expect(
      await within(dialog).findByText("已分配 0 条线程"),
    ).toBeInTheDocument();

    await user.type(input, "长".repeat(41));
    await user.click(within(dialog).getByRole("button", { name: "创建标签" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "标签名称不能超过 40 个字符。",
    );
    expect(created).toEqual(["发布"]);
  });

  it("announces an idempotent reuse notice when the folded name already exists", async () => {
    const server = stubTagServer(
      [thread("thread-1", "发布计划", 1)],
      [tag("tag-1", "Release")],
    );
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });
    await user.click(screen.getByRole("button", { name: "管理标签" }));
    const dialog = await screen.findByRole("dialog", { name: "管理标签" });

    await user.type(within(dialog).getByLabelText("新标签名称"), "release");
    await user.click(within(dialog).getByRole("button", { name: "创建标签" }));
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "标签“Release”已存在。",
    );
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
  });

  it("filters the manage list by contains and shows an honest empty result", async () => {
    const server = stubTagServer(
      [thread("thread-1", "发布计划", 1)],
      [tag("tag-1", "发布"), tag("tag-2", "缺陷")],
    );
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });
    await user.click(screen.getByRole("button", { name: "管理标签" }));
    const dialog = await screen.findByRole("dialog", { name: "管理标签" });

    const search = within(dialog).getByLabelText("搜索标签");
    await user.type(search, "缺");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
    expect(within(dialog).getByText("缺陷")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "不存在");
    expect(await within(dialog).findByText("无匹配标签。")).toBeInTheDocument();

    await user.clear(search);
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
  });

  it("deletes a tag through a strong confirmation that reports the exact edge count", async () => {
    const server = stubTagServer(
      [
        thread("thread-1", "发布计划", 2, [{ id: "tag-1", name: "发布" }]),
        thread("thread-2", "缺陷复盘", 1, [{ id: "tag-1", name: "发布" }]),
      ],
      [tag("tag-1", "发布"), tag("tag-2", "缺陷")],
    );
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });
    await user.click(screen.getByRole("button", { name: "管理标签" }));
    const dialog = await screen.findByRole("dialog", { name: "管理标签" });

    await user.click(
      within(dialog).getByRole("button", { name: "删除标签 发布" }),
    );
    const confirm = await screen.findByRole("dialog", { name: "删除标签" });
    expect(confirm).toHaveTextContent(
      "删除标签“发布”将解除 2 条分配。此操作不可撤销。",
    );
    expect(screen.getByRole("dialog", { name: "管理标签" })).toBeInTheDocument();
    expect(
      within(confirm).getByRole("button", { name: "取消" }),
    ).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "删除标签" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "管理标签" })).toBeInTheDocument();

    await user.click(
      within(screen.getByRole("dialog", { name: "管理标签" })).getByRole(
        "button",
        { name: "删除标签 发布" },
      ),
    );
    await user.click(
      within(await screen.findByRole("dialog", { name: "删除标签" })).getByRole(
        "button",
        { name: "确认删除" },
      ),
    );

    expect(
      await within(screen.getByRole("dialog", { name: "管理标签" })).findByRole(
        "status",
      ),
    ).toHaveTextContent("已删除标签“发布”，解除 2 条分配。");
    const manageDialog = screen.getByRole("dialog", { name: "管理标签" });
    expect(within(manageDialog).queryByText("发布")).toBeNull();
    expect(within(manageDialog).getAllByRole("listitem")).toHaveLength(1);

    await user.click(
      within(manageDialog).getByRole("button", { name: "关闭管理标签" }),
    );
    const filterGroup = await screen.findByRole("group", { name: "按标签筛选线程" });
    expect(
      within(filterGroup).queryByRole("button", { name: "发布" }),
    ).toBeNull();
    expect(
      within(filterGroup).getByRole("button", { name: "缺陷" }),
    ).toBeInTheDocument();
    const entry = await screen.findByRole("button", { name: "发布计划" });
    expect(
      within(entry.closest("li")!).queryByText("发布"),
    ).toBeNull();
  });

  it("clears the active tag filter when that tag is deleted", async () => {
    const server = stubTagServer(
      [
        thread("thread-1", "发布计划", 2, [{ id: "tag-1", name: "发布" }]),
        thread("thread-2", "缺陷复盘", 1),
      ],
      [tag("tag-1", "发布")],
    );
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });
    await user.click(screen.getByRole("button", { name: "发布" }));
    await waitFor(() =>
      expect(server.requestedUrls).toContain(
        `/api/projects/${project.id}/threads?limit=100&tagId=tag-1`,
      )
    );
    expect(screen.queryByRole("button", { name: "缺陷复盘" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "管理标签" }));
    const dialog = await screen.findByRole("dialog", { name: "管理标签" });
    await user.click(
      within(dialog).getByRole("button", { name: "删除标签 发布" }),
    );
    await user.click(
      within(await screen.findByRole("dialog", { name: "删除标签" })).getByRole(
        "button",
        { name: "确认删除" },
      ),
    );

    expect(
      await within(dialog).findByText("已删除标签“发布”，解除 1 条分配。"),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "关闭管理标签" }),
    );
    expect(await screen.findByRole("button", { name: "缺陷复盘" })).toBeInTheDocument();
  });

  it("shows a sanitized error with retry when the tag list fails to load", async () => {
    const server = stubTagServer([thread("thread-1", "发布计划", 1)], []);
    const failing = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(`/api/projects/${project.id}/thread-tags`)) {
        if (!init?.method) {
          return Response.json(
            { error: { code: "INTERNAL_ERROR", message: "private detail" } },
            { status: 500 },
          );
        }
      }
      return server.fetchMock(input, init);
    });
    vi.stubGlobal("fetch", failing);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });

    const filterError = (await screen.findAllByRole("alert")).find((node) =>
      node.textContent?.includes("服务暂时出现问题")
    );
    expect(filterError).toBeDefined();
    expect(filterError).not.toHaveTextContent("private detail");

    await user.click(screen.getByRole("button", { name: "管理标签" }));
    const dialog = await screen.findByRole("dialog", { name: "管理标签" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "服务暂时出现问题",
    );

    vi.stubGlobal("fetch", server.fetchMock);
    const retries = within(dialog).getAllByRole("button", {
      name: "重试加载标签",
    });
    await user.click(retries[0]!);
    expect(
      await within(dialog).findByText("暂无标签。创建标签后开始整理线程。"),
    ).toBeInTheDocument();
  });
});

describe("thread list tag chips and the filter chip bar", () => {
  it("renders each thread's tags as status-label chips and filters the list through the tagId seam", async () => {
    const server = stubTagServer(
      [
        thread("thread-1", "发布计划", 2, [
          { id: "tag-1", name: "发布" },
          { id: "tag-2", name: "缺陷" },
        ]),
        thread("thread-2", "闲聊", 1),
      ],
      [tag("tag-1", "发布"), tag("tag-2", "缺陷")],
    );
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    const entry = await screen.findByRole("button", { name: "发布计划" });
    const row = entry.closest("li")!;
    const chips = row.querySelectorAll(".status-label.thread-tag-chip");
    expect(Array.from(chips).map((node) => node.textContent)).toEqual([
      "发布",
      "缺陷",
    ]);
    expect(
      screen.getByRole("button", { name: "闲聊" }).closest("li")!
        .querySelectorAll(".thread-tag-chip"),
    ).toHaveLength(0);

    const group = screen.getByRole("group", { name: "按标签筛选线程" });
    const releaseChip = within(group).getByRole("button", { name: "发布" });
    expect(releaseChip).toHaveAttribute("aria-pressed", "false");

    await user.click(releaseChip);
    await waitFor(() =>
      expect(server.requestedUrls).toContain(
        `/api/projects/${project.id}/threads?limit=100&tagId=tag-1`,
      )
    );
    expect(releaseChip).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("button", { name: "发布计划" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "闲聊" })).toBeNull();

    await user.click(releaseChip);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "闲聊" })).toBeInTheDocument(),
    );
    expect(releaseChip).toHaveAttribute("aria-pressed", "false");
    const listReads = server.requestedUrls.filter(
      (url) => url === `/api/projects/${project.id}/threads?limit=100`,
    );
    expect(listReads.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps tag filtering and the favorites view mutually exclusive in both directions", async () => {
    const favorited = {
      ...thread("thread-2", "已收藏线程", 1),
      favoritedAt: "2026-08-09T00:00:00.000Z",
      isFavorite: true,
    };
    const server = stubTagServer(
      [
        thread("thread-1", "发布计划", 2, [{ id: "tag-1", name: "发布" }]),
        favorited,
      ],
      [tag("tag-1", "发布")],
    );
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });

    await user.click(screen.getByRole("tab", { name: "已收藏" }));
    await screen.findByRole("button", { name: "已收藏线程" });
    expect(
      server.requestedUrls.some((url) => url.includes("favorites=true")),
    ).toBe(true);

    const group = screen.getByRole("group", { name: "按标签筛选线程" });
    await user.click(within(group).getByRole("button", { name: "发布" }));
    await waitFor(() =>
      expect(server.requestedUrls).toContain(
        `/api/projects/${project.id}/threads?limit=100&tagId=tag-1`,
      )
    );
    expect(screen.getByRole("tab", { name: "全部" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "已收藏" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(await screen.findByRole("button", { name: "发布计划" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "已收藏" }));
    await screen.findByRole("button", { name: "已收藏线程" });
    expect(
      within(screen.getByRole("group", { name: "按标签筛选线程" })).getByRole(
        "button",
        { name: "发布" },
      ),
    ).toHaveAttribute("aria-pressed", "false");
    const filteredReads = server.requestedUrls.filter((url) =>
      url.includes("tagId=")
    );
    expect(filteredReads).toHaveLength(1);
  });

  it("shows an honest filtered empty state with a clear-filter action", async () => {
    const server = stubTagServer(
      [thread("thread-1", "闲聊", 1)],
      [tag("tag-1", "发布")],
    );
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "闲聊" });
    const group = screen.getByRole("group", { name: "按标签筛选线程" });
    await user.click(within(group).getByRole("button", { name: "发布" }));

    expect(
      await screen.findByText("标签“发布”下暂无线程。"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(await screen.findByRole("button", { name: "闲聊" })).toBeInTheDocument();
  });

  it("hides the filter bar while keeping the manage entry available when the project has no tags", async () => {
    const server = stubTagServer([thread("thread-1", "闲聊", 1)], []);
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "闲聊" });
    await waitFor(() =>
      expect(server.requestedUrls).toContain(
        `/api/projects/${project.id}/thread-tags?limit=100`,
      )
    );
    expect(screen.queryByRole("group", { name: "按标签筛选线程" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "管理标签" }),
    ).toBeInTheDocument();
  });
});

describe("organize mode and the batch bar", () => {
  it("multi-selects threads, applies add/remove tags through a confirmation, then refreshes silently", async () => {
    const operationId = "22222222-2222-4222-8222-222222222222";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    const server = stubTagServer(
      [
        thread("thread-1", "发布计划", 3, [{ id: "tag-2", name: "缺陷" }]),
        thread("thread-2", "发布清单", 2),
        thread("thread-3", "闲聊", 1),
      ],
      [tag("tag-1", "发布"), tag("tag-2", "缺陷")],
    );
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });

    const organizeToggle = screen.getByRole("button", { name: "整理线程" });
    expect(organizeToggle).toHaveAttribute("aria-pressed", "false");
    await user.click(organizeToggle);
    expect(organizeToggle).toHaveAttribute("aria-pressed", "true");

    const bar = await screen.findByRole("region", { name: "批量整理线程" });
    expect(within(bar).getByText("已选 0 条线程")).toBeInTheDocument();
    const apply = within(bar).getByRole("button", { name: "应用更改" });
    expect(apply).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "选择线程 发布计划" }));
    await user.click(screen.getByRole("checkbox", { name: "选择线程 发布清单" }));
    expect(within(bar).getByText("已选 2 条线程")).toBeInTheDocument();

    const addGroup = within(bar).getByRole("group", { name: "添加标签" });
    const removeGroup = within(bar).getByRole("group", { name: "移除标签" });
    await user.click(within(addGroup).getByRole("button", { name: "发布" }));
    await user.click(within(removeGroup).getByRole("button", { name: "缺陷" }));
    expect(
      within(addGroup).getByRole("button", { name: "发布" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(apply).toBeEnabled();

    await user.click(apply);
    const confirm = await screen.findByRole("dialog", { name: "确认批量整理" });
    expect(confirm).toHaveTextContent(
      "将为 2 条线程添加 1 个标签、移除 1 个标签。",
    );
    expect(confirm).toHaveTextContent("移除会立即解除这些线程上的标签分配。");
    await user.click(within(confirm).getByRole("button", { name: "确认应用" }));

    expect(server.batchCalls).toEqual([
      {
        addTagIds: ["tag-1"],
        operationId,
        removeTagIds: ["tag-2"],
        threadIds: ["thread-1", "thread-2"],
      },
    ]);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已为 2 条线程更新标签。",
    );
    expect(screen.queryByRole("region", { name: "批量整理线程" })).toBeNull();
    expect(screen.getByRole("button", { name: "整理线程" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await waitFor(() => {
      const firstRow = screen
        .getByRole("button", { name: "发布计划" })
        .closest("li")!;
      expect(
        Array.from(firstRow.querySelectorAll(".thread-tag-chip")).map(
          (node) => node.textContent,
        ),
      ).toEqual(["发布"]);
    });
    await waitFor(() =>
      expect(server.requestedUrls).toContain(
        `/api/projects/${project.id}/thread-tags?limit=100`,
      )
    );
    expect(server.state.tags.find((item) => item.id === "tag-1")?.threadCount).toBe(2);
  });

  it("reports a batch failure inline and retries with the same operationId", async () => {
    const operationId = "33333333-3333-4333-8333-333333333333";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    const server = stubTagServer(
      [thread("thread-1", "发布计划", 1)],
      [tag("tag-1", "发布")],
    );
    let attempts = 0;
    const attempted: string[] = [];
    server.setBatchHandler((call) => {
      attempts += 1;
      attempted.push(call.operationId);
      if (attempts === 1) {
        return Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "private detail" } },
          { status: 503 },
        );
      }
      server.state.threads[0]!.tags.push({ id: "tag-1", name: "发布" });
      return Response.json({
        applied: [{ addedTagIds: ["tag-1"], removedTagIds: [], threadId: "thread-1" }],
        operationId: call.operationId,
        replayed: false,
      });
    });
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });
    await user.click(screen.getByRole("button", { name: "整理线程" }));
    const bar = await screen.findByRole("region", { name: "批量整理线程" });
    await user.click(screen.getByRole("checkbox", { name: "选择线程 发布计划" }));
    await user.click(
      within(within(bar).getByRole("group", { name: "添加标签" })).getByRole(
        "button",
        { name: "发布" },
      ),
    );
    await user.click(within(bar).getByRole("button", { name: "应用更改" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "确认批量整理" })).getByRole(
        "button",
        { name: "确认应用" },
      ),
    );

    const alert = await within(
      await screen.findByRole("region", { name: "批量整理线程" }),
    ).findByRole("alert");
    expect(alert).toHaveTextContent("服务暂时不可用");
    expect(alert).not.toHaveTextContent("private detail");
    expect(screen.getByRole("checkbox", { name: "选择线程 发布计划" })).toBeChecked();

    await user.click(
      within(screen.getByRole("region", { name: "批量整理线程" })).getByRole(
        "button",
        { name: "重试批量整理" },
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已为 1 条线程更新标签。",
    );
    expect(attempted).toEqual([operationId, operationId]);
    expect(attempts).toBe(2);
  });

  it("exits organize mode on Escape without closing the enclosing surface and returns focus", async () => {
    const server = stubTagServer(
      [thread("thread-1", "发布计划", 1)],
      [tag("tag-1", "发布")],
    );
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });
    const background = screen.getByTestId("thread-tags-background");
    const enclosingKeydown = vi.fn();
    background.addEventListener("keydown", enclosingKeydown);
    try {
      const toggle = screen.getByRole("button", { name: "整理线程" });
      await user.click(toggle);
      await screen.findByRole("region", { name: "批量整理线程" });
      await user.click(
        screen.getByRole("checkbox", { name: "选择线程 发布计划" }),
      );

      await user.keyboard("{Escape}");
      expect(enclosingKeydown).not.toHaveBeenCalled();
      expect(screen.queryByRole("region", { name: "批量整理线程" })).toBeNull();
      expect(
        screen.queryByRole("checkbox", { name: "选择线程 发布计划" }),
      ).toBeNull();
      expect(toggle).toHaveFocus();

      await user.keyboard("{Escape}");
      expect(enclosingKeydown).toHaveBeenCalledTimes(1);
    } finally {
      background.removeEventListener("keydown", enclosingKeydown);
    }
  });

  it("toggles picker chips with the keyboard and keeps add/remove selections mutually exclusive", async () => {
    const server = stubTagServer(
      [thread("thread-1", "发布计划", 1, [{ id: "tag-1", name: "发布" }])],
      [tag("tag-1", "发布"), tag("tag-2", "缺陷")],
    );
    vi.stubGlobal("fetch", server.fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });
    await user.click(screen.getByRole("button", { name: "整理线程" }));
    const bar = await screen.findByRole("region", { name: "批量整理线程" });
    const addGroup = within(bar).getByRole("group", { name: "添加标签" });
    const removeGroup = within(bar).getByRole("group", { name: "移除标签" });

    within(addGroup).getByRole("button", { name: "发布" }).focus();
    await user.keyboard("{Enter}");
    expect(
      within(addGroup).getByRole("button", { name: "发布" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(within(removeGroup).getByRole("button", { name: "发布" }));
    expect(
      within(removeGroup).getByRole("button", { name: "发布" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(addGroup).getByRole("button", { name: "发布" }),
    ).toHaveAttribute("aria-pressed", "false");

    await user.click(within(bar).getByRole("button", { name: "取消整理" }));
    expect(screen.queryByRole("region", { name: "批量整理线程" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "整理线程" }),
    ).toHaveFocus();
  });
});

describe("target switching and staleness guards", () => {
  it("resets tag state fully and discards in-flight tag responses when the project switches", async () => {
    const otherProject = "project-2";
    const pendingOldTags = deferredResponse();
    const tagSignals: AbortSignal[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/projects/${project.id}/threads?limit=100`) {
        return Promise.resolve(
          Response.json({
            nextCursor: null,
            threads: [thread("thread-1", "发布计划", 1)],
          }),
        );
      }
      if (url === `/api/projects/${otherProject}/threads?limit=100`) {
        return Promise.resolve(
          Response.json({
            nextCursor: null,
            threads: [
              { ...thread("thread-9", "其他项目线程", 1), projectId: otherProject },
            ],
          }),
        );
      }
      if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
        if (init?.signal) tagSignals.push(init.signal);
        return pendingOldTags.promise;
      }
      if (url === `/api/projects/${otherProject}/thread-tags?limit=100`) {
        return Promise.resolve(
          Response.json({
            tags: [
              {
                createdAt: "2026-08-08T00:00:00.000Z",
                id: "tag-9",
                name: "其他项目标签",
                projectId: otherProject,
                threadCount: 0,
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    const view = render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });

    await user.click(screen.getByRole("button", { name: "整理线程" }));
    await screen.findByRole("region", { name: "批量整理线程" });
    await user.click(screen.getByRole("checkbox", { name: "选择线程 发布计划" }));

    window.history.replaceState(null, "", `/projects/${otherProject}?thread=thread-9`);
    view.rerender(<ThreadTagsHarness projectId={otherProject} />);

    expect(
      await screen.findByRole("button", { name: "其他项目线程" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "批量整理线程" })).toBeNull();
    expect(
      await within(
        await screen.findByRole("group", { name: "按标签筛选线程" }),
      ).findByRole("button", { name: "其他项目标签" }),
    ).toBeInTheDocument();
    expect(tagSignals.length).toBeGreaterThan(0);
    expect(tagSignals.every((signal) => signal.aborted)).toBe(true);

    pendingOldTags.resolve(
      Response.json({
        tags: [
          {
            createdAt: "2026-08-08T00:00:00.000Z",
            id: "tag-old",
            name: "旧项目标签",
            projectId: project.id,
            threadCount: 0,
          },
        ],
      }),
    );
    await act(async () => undefined);
    expect(
      screen.queryByRole("button", { name: "旧项目标签" }),
    ).toBeNull();
  });

  it("closes the manage dialog on a project switch", async () => {
    const otherProject = "project-2";
    const server = stubTagServer(
      [thread("thread-1", "发布计划", 1)],
      [tag("tag-1", "发布")],
    );
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(`/api/projects/${otherProject}/threads`)) {
        return Promise.resolve(
          Response.json({
            nextCursor: null,
            threads: [
              { ...thread("thread-9", "其他项目线程", 1), projectId: otherProject },
            ],
          }),
        );
      }
      if (url.startsWith(`/api/projects/${otherProject}/thread-tags`)) {
        return Promise.resolve(Response.json({ tags: [] }));
      }
      return server.fetchMock(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    const view = render(<ThreadTagsHarness />);
    await screen.findByRole("button", { name: "发布计划" });
    await user.click(screen.getByRole("button", { name: "管理标签" }));
    await screen.findByRole("dialog", { name: "管理标签" });

    window.history.replaceState(null, "", `/projects/${otherProject}?thread=thread-9`);
    view.rerender(<ThreadTagsHarness projectId={otherProject} />);

    expect(
      await screen.findByRole("button", { name: "其他项目线程" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "管理标签" })).toBeNull();
  });
});

describe("tag styling contract", () => {
  it("keeps every new tag rule on design tokens with 44px interactive targets", () => {
    const tokens = readFileSync("app/tokens.css", "utf8");
    const cockpit = readFileSync("app/cockpit.css", "utf8");
    expect(tokens).toContain("--control-min: 2.75rem");

    const ruleBlock = (selector: string) => {
      const match = cockpit.match(
        new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, "m"),
      );
      expect(match, `missing rule for ${selector}`).not.toBeNull();
      return match![1]!;
    };

    const interactiveChip = ruleBlock(".status-label.thread-tag-filter-chip");
    expect(interactiveChip).toContain("min-height: var(--control-min)");
    const selection = ruleBlock(".thread-list-select");
    expect(selection).toContain("min-width: var(--control-min)");
    expect(selection).toContain("min-height: var(--control-min)");

    for (const selector of [
      ".thread-tag-chip-list",
      ".thread-tag-filter-bar",
      ".thread-batch-bar",
      ".thread-batch-group",
      ".thread-tag-manage-list",
      ".thread-tag-manage-item",
      ".thread-list-main",
    ]) {
      const block = ruleBlock(selector);
      expect(block).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
      expect(block).not.toMatch(/\d+(px|rem|em)/);
      expect(block).toContain("var(--");
    }
  });
});
