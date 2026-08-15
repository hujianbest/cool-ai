// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import { ProjectThreadNavigation } from "@/components/project-thread-navigation";
import { parseProjectSelection } from "@/components/settings-navigation";
import type {
  ThreadFactDto,
  ThreadMessageDto,
} from "@/src/shared/collaboration-contracts";
import type { ThreadSearchResultItemDto } from "@/src/shared/thread-search-contracts";
import {
  TEST_THREAD_ID,
  threadPolicy,
  threadRun,
  threadSummary,
} from "@/tests/cockpit-test-fetch";

const project = {
  createdAt: "2026-08-08T00:00:00.000Z",
  id: "project-1",
  name: "Launch plan",
};

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

function titleHit(threadId: string, title: string): ThreadSearchResultItemDto {
  return {
    kind: "thread_title",
    messageId: null,
    occurredAt: "2026-08-09T10:00:00.000Z",
    snippet: title,
    threadId,
    threadTitle: title,
  };
}

function messageHit(
  threadId: string,
  title: string,
  messageId: string,
  snippet: string,
): ThreadSearchResultItemDto {
  return {
    kind: "message",
    messageId,
    occurredAt: "2026-08-09T11:00:00.000Z",
    snippet,
    threadId,
    threadTitle: title,
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ThreadSearchHarness({ projectId = project.id }: { projectId?: string }) {
  const backgroundRef = useRef<HTMLElement>(null);
  return (
    <main data-testid="thread-search-background" ref={backgroundRef}>
      <ProjectThreadNavigation
        backgroundRef={backgroundRef}
        projectId={projectId}
      />
    </main>
  );
}

function listThreads(threads: ReturnType<typeof thread>[]) {
  return { nextCursor: null, threads };
}

function searchUrl(query: string, before?: string) {
  const suffix = before ? `&before=${encodeURIComponent(before)}` : "";
  return `/api/projects/${project.id}/thread-search?q=${encodeURIComponent(query)}${suffix}`;
}

function readableTime(timestamp: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(timestamp));
}

afterEach(() => {
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("thread search entry in project thread navigation", () => {
  it("debounces input for about 300ms before issuing one search request", async () => {
    const searchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Response.json(listThreads([thread("thread-1", "发布计划", 1)]));
        }
        if (url.startsWith(`/api/projects/${project.id}/thread-search`)) {
          searchCalls.push(url);
          return Response.json({ nextCursor: null, results: [] });
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadSearchHarness />);
    const input = await screen.findByLabelText("搜索对话");
    await user.type(input, "部署");

    expect(searchCalls).toHaveLength(0);
    await waitFor(() => expect(searchCalls).toHaveLength(1));
    expect(searchCalls[0]).toBe(searchUrl("部署"));
    expect(
      await screen.findByText("无匹配结果。"),
    ).toBeInTheDocument();
  });

  it("renders title and message hits with kind badges, snippet and time", async () => {
    const results = [
      titleHit("thread-1", "部署计划评审"),
      messageHit("thread-2", "发布清单", "message-9", "…下周完成部署窗口…"),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Response.json(
            listThreads([
              thread("thread-1", "部署计划评审", 2),
              thread("thread-2", "发布清单", 1),
            ]),
          );
        }
        if (url === searchUrl("部署")) {
          return Response.json({ nextCursor: null, results });
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadSearchHarness />);
    const input = await screen.findByLabelText("搜索对话");
    await user.type(input, "部署");

    const region = await screen.findByRole("region", { name: "对话搜索结果" });
    const items = within(region).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const titleEntry = within(items[0]!).getByRole("button", {
      name: /部署计划评审/,
    });
    expect(within(titleEntry).getByText("标题")).toBeInTheDocument();
    expect(
      within(titleEntry).queryByText("…下周完成部署窗口…"),
    ).toBeNull();
    const messageEntry = within(items[1]!).getByRole("button", {
      name: /发布清单/,
    });
    expect(within(messageEntry).getByText("内容")).toBeInTheDocument();
    expect(
      within(messageEntry).getByText("…下周完成部署窗口…"),
    ).toBeInTheDocument();
    expect(
      within(messageEntry).getByText(readableTime("2026-08-09T11:00:00.000Z")),
    ).toBeInTheDocument();
  });

  it("replaces the thread tablist and list while search is active and restores them on clear", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Response.json(listThreads([thread("thread-1", "发布计划", 1)]));
        }
        if (url === searchUrl("发布")) {
          return Response.json({
            nextCursor: null,
            results: [titleHit("thread-1", "发布计划")],
          });
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadSearchHarness />);
    expect(
      await screen.findByRole("tablist", { name: "对话视图" }),
    ).toBeInTheDocument();

    const input = await screen.findByLabelText("搜索对话");
    await user.type(input, "发布");
    expect(
      await screen.findByRole("region", { name: "对话搜索结果" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "对话视图" })).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "项目对话" }),
    ).toBeNull();

    await user.clear(input);
    expect(
      await screen.findByRole("tablist", { name: "对话视图" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "项目对话" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "对话搜索结果" })).toBeNull();
  });

  it("clears the query and restores the list on Escape from the input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Response.json(listThreads([thread("thread-1", "发布计划", 1)]));
        }
        if (url === searchUrl("发布")) {
          return Response.json({
            nextCursor: null,
            results: [titleHit("thread-1", "发布计划")],
          });
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadSearchHarness />);
    const input = await screen.findByLabelText("搜索对话");
    await user.type(input, "发布");
    expect(
      await screen.findByRole("region", { name: "对话搜索结果" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(
      await screen.findByRole("tablist", { name: "对话视图" }),
    ).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
  });

  it("consumes Escape natively while a query is active so an enclosing surface stays open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Response.json(listThreads([thread("thread-1", "发布计划", 1)]));
        }
        if (url === searchUrl("发布")) {
          return Response.json({
            nextCursor: null,
            results: [titleHit("thread-1", "发布计划")],
          });
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadSearchHarness />);
    const input = await screen.findByLabelText("搜索对话");
    await user.type(input, "发布");
    await screen.findByRole("region", { name: "对话搜索结果" });

    const background = screen.getByTestId("thread-search-background");
    const enclosingKeydown = vi.fn();
    background.addEventListener("keydown", enclosingKeydown);
    try {
      await user.keyboard("{Escape}");
      expect(enclosingKeydown).not.toHaveBeenCalled();
      expect(input).toHaveValue("");
      expect(input).toHaveFocus();
      expect(screen.queryByRole("region", { name: "对话搜索结果" })).toBeNull();

      await user.keyboard("{Escape}");
      expect(enclosingKeydown).toHaveBeenCalledTimes(1);
    } finally {
      background.removeEventListener("keydown", enclosingKeydown);
    }
  });

  it("shows a loading status while the search request is pending", async () => {
    const pending = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Promise.resolve(
            Response.json(listThreads([thread("thread-1", "发布计划", 1)])),
          );
        }
        if (url === searchUrl("发布")) return pending.promise;
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadSearchHarness />);
    const input = await screen.findByLabelText("搜索对话");
    await user.type(input, "发布");

    expect(await screen.findByText("正在搜索…")).toBeInTheDocument();
    pending.resolve(Response.json({ nextCursor: null, results: [] }));
    expect(await screen.findByText("无匹配结果。")).toBeInTheDocument();
  });

  it("shows a sanitized error with retry when the search fails", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Response.json(listThreads([thread("thread-1", "发布计划", 1)]));
        }
        if (url === searchUrl("发布")) {
          attempts += 1;
          if (attempts === 1) {
            return Response.json(
              { error: { code: "INTERNAL", message: "private detail" } },
              { status: 500 },
            );
          }
          return Response.json({
            nextCursor: null,
            results: [titleHit("thread-1", "发布计划")],
          });
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadSearchHarness />);
    const input = await screen.findByLabelText("搜索对话");
    await user.type(input, "发布");

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("private detail");
    const retry = within(alert.parentElement as HTMLElement).getByRole(
      "button",
      { name: "重试搜索" },
    );
    await user.click(retry);
    expect(
      await screen.findByRole("region", { name: "对话搜索结果" }),
    ).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("appends the next page via the load-more control with the opaque cursor", async () => {
    const first = [titleHit("thread-1", "部署计划评审")];
    const second = [messageHit("thread-2", "发布清单", "message-9", "…部署窗口…")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Response.json(
            listThreads([
              thread("thread-1", "部署计划评审", 2),
              thread("thread-2", "发布清单", 1),
            ]),
          );
        }
        if (url === searchUrl("部署")) {
          return Response.json({ nextCursor: "cursor-page-2", results: first });
        }
        if (url === searchUrl("部署", "cursor-page-2")) {
          return Response.json({ nextCursor: null, results: second });
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadSearchHarness />);
    const input = await screen.findByLabelText("搜索对话");
    await user.type(input, "部署");

    const region = await screen.findByRole("region", { name: "对话搜索结果" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);
    await user.click(
      within(region).getByRole("button", { name: "加载更多搜索结果" }),
    );
    await waitFor(() =>
      expect(within(region).getAllByRole("listitem")).toHaveLength(2)
    );
    expect(
      within(region).queryByRole("button", { name: "加载更多搜索结果" }),
    ).toBeNull();
  });

  it("navigates to the canonical thread+message URL when activating a result", async () => {
    const results = [
      messageHit("thread-2", "发布清单", "message-9", "…部署窗口…"),
      titleHit("thread-1", "部署计划评审"),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Response.json(
            listThreads([
              thread("thread-1", "部署计划评审", 2),
              thread("thread-2", "发布清单", 1),
            ]),
          );
        }
        if (url === searchUrl("部署")) {
          return Response.json({ nextCursor: null, results });
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadSearchHarness />);
    const input = await screen.findByLabelText("搜索对话");
    await user.type(input, "部署");

    const messageEntry = await screen.findByRole("button", { name: /发布清单/ });
    await user.click(messageEntry);
    expect(window.location.pathname).toBe(`/projects/${project.id}`);
    expect(window.location.search).toBe("?thread=thread-2&message=message-9");

    const titleEntry = await screen.findByRole("button", {
      name: /部署计划评审/,
    });
    await user.click(titleEntry);
    expect(window.location.search).toBe("?thread=thread-1");
  });

  it("moves focus between input and results with arrow keys and activates with Enter", async () => {
    const results = [
      titleHit("thread-1", "部署计划评审"),
      messageHit("thread-2", "发布清单", "message-9", "…部署窗口…"),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Response.json(
            listThreads([
              thread("thread-1", "部署计划评审", 2),
              thread("thread-2", "发布清单", 1),
            ]),
          );
        }
        if (url === searchUrl("部署")) {
          return Response.json({ nextCursor: null, results });
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadSearchHarness />);
    const input = await screen.findByLabelText("搜索对话");
    await user.type(input, "部署");
    const firstResult = await screen.findByRole("button", { name: /部署计划评审/ });
    const secondResult = await screen.findByRole("button", { name: /发布清单/ });

    input.focus();
    await user.keyboard("{ArrowDown}");
    expect(firstResult).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(secondResult).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(firstResult).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(window.location.search).toBe("?thread=thread-2&message=message-9");
  });

  it("discards a stale earlier search response resolving after a newer one", async () => {
    const stale = deferredResponse();
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Promise.resolve(
            Response.json(listThreads([thread("thread-1", "发布计划", 1)])),
          );
        }
        if (url === searchUrl("alpha")) {
          requested.push(url);
          return stale.promise;
        }
        if (url === searchUrl("beta")) {
          return Promise.resolve(
            Response.json({
              nextCursor: null,
              results: [titleHit("thread-1", "beta 命中标题")],
            }),
          );
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<ThreadSearchHarness />);
    const input = await screen.findByLabelText("搜索对话");
    await user.type(input, "alpha");
    await waitFor(() => expect(requested).toContain(searchUrl("alpha")));
    expect(await screen.findByText("正在搜索…")).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "beta");
    expect(await screen.findByText("beta 命中标题")).toBeInTheDocument();

    stale.resolve(
      Response.json({
        nextCursor: null,
        results: [titleHit("thread-1", "alpha 过期标题")],
      }),
    );
    await act(async () => undefined);
    expect(screen.queryByText("alpha 过期标题")).toBeNull();
    expect(screen.getByText("beta 命中标题")).toBeInTheDocument();
  });

  it("aborts and clears search state when the project target switches", async () => {
    const otherProject = "project-2";
    const pending = deferredResponse();
    const searchSignals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `/api/projects/${project.id}/threads?limit=100`) {
          return Promise.resolve(
            Response.json(listThreads([thread("thread-1", "发布计划", 1)])),
          );
        }
        if (url === `/api/projects/${otherProject}/threads?limit=100`) {
          return Promise.resolve(
            Response.json({
              nextCursor: null,
              threads: [{ ...thread("thread-9", "其他对话", 1), projectId: otherProject }],
            }),
          );
        }
        if (url.startsWith(`/api/projects/${project.id}/thread-search`)) {
          if (init?.signal) searchSignals.push(init.signal);
          return pending.promise;
        }
        if (url.includes("/thread-tags?limit=100")) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    const view = render(<ThreadSearchHarness />);
    const input = await screen.findByLabelText("搜索对话");
    await user.type(input, "发布");
    await waitFor(() => expect(searchSignals.length).toBeGreaterThan(0));
    await screen.findByText("正在搜索…");

    window.history.replaceState(null, "", `/projects/${otherProject}?thread=thread-9`);
    view.rerender(<ThreadSearchHarness projectId={otherProject} />);

    expect(
      await screen.findByRole("button", { name: "其他对话" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "对话搜索结果" })).toBeNull();
    expect(screen.getByLabelText("搜索对话")).toHaveValue("");
    expect(searchSignals.length).toBeGreaterThan(0);
    expect(searchSignals.every((signal) => signal.aborted)).toBe(true);

    pending.resolve(
      Response.json({
        nextCursor: null,
        results: [titleHit("thread-1", "旧项目结果")],
      }),
    );
    await act(async () => undefined);
    expect(screen.queryByText("旧项目结果")).toBeNull();
  });
});

describe("parseProjectSelection message parameter", () => {
  it("accepts an optional message parameter alongside thread", () => {
    const selection = parseProjectSelection(
      "/projects/project-1?thread=thread-1&message=message-9",
    );
    expect(selection).toEqual({
      href: "/projects/project-1?thread=thread-1&message=message-9",
      projectHref: "/projects/project-1",
      projectId: "project-1",
      messageId: "message-9",
      runId: null,
      threadId: "thread-1",
    });
  });

  it("keeps behavior unchanged when no message parameter is present", () => {
    const selection = parseProjectSelection("/projects/project-1?thread=thread-1");
    expect(selection?.messageId).toBeNull();
    expect(selection?.href).toBe("/projects/project-1?thread=thread-1");
    expect(parseProjectSelection("/projects/project-1")?.messageId).toBeNull();
  });

  it("canonicalizes parameter order with run before message", () => {
    const selection = parseProjectSelection(
      "/projects/project-1?message=message-9&run=run-1&thread=thread-1",
    );
    expect(selection?.href).toBe(
      "/projects/project-1?thread=thread-1&run=run-1&message=message-9",
    );
    expect(selection?.runId).toBe("run-1");
    expect(selection?.messageId).toBe("message-9");
  });

  it("falls back to null for duplicate, unsafe, or thread-less message parameters", () => {
    expect(
      parseProjectSelection(
        "/projects/project-1?thread=thread-1&message=a&message=b",
      ),
    ).toBeNull();
    expect(
      parseProjectSelection("/projects/project-1?message=message-9"),
    ).toBeNull();
    expect(
      parseProjectSelection("/projects/project-1?thread=thread-1&message=bad/id"),
    ).toBeNull();
    expect(
      parseProjectSelection("/projects/project-1?thread=thread-1&message="),
    ).toBeNull();
    expect(
      parseProjectSelection(
        "/projects/project-1?thread=thread-1&message=message-9&extra=1",
      ),
    ).toBeNull();
  });
});

describe("collaboration panel consumes the URL message parameter", () => {
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

  function message(
    id: string,
    sequence: number,
    authorType: "owner" | "agent",
    content: string,
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
      projectId: project.id,
      replyTo: null,
      runId: "run-1",
      sequence,
      threadId: TEST_THREAD_ID,
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
      projectId: project.id,
      runEventId: null,
      runId: nestedMessage.runId,
      sequence,
      threadId: nestedMessage.threadId,
      type: nestedMessage.authorType === "owner" ? "owner_message" : "agent_message",
    };
  }

  function detail(threadId = TEST_THREAD_ID) {
    const run = threadRun(project.id);
    const selectedRun = { ...run, threadId };
    const summary = { ...threadSummary(project.id), id: threadId };
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

  function listItemFor(text: string): HTMLElement {
    const list = screen.getByRole("log", { name: "协作时间线" });
    const item = Array.from(list.querySelectorAll("li")).find(
      (candidate) =>
        Array.from(candidate.querySelectorAll("p")).some(
          (paragraph) => paragraph.textContent === text,
        ),
    );
    expect(item).toBeDefined();
    return item as HTMLElement;
  }

  it("scrolls and focuses a loaded message referenced by the URL", async () => {
    const target = message("message-target", 1, "owner", "URL target message");
    const other = message("message-other", 2, "agent", "Other content");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(
            Response.json({ items: [target, other], nextAfter: null }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [
                messageFact("fact-target", 1, target),
                messageFact("fact-other", 2, other),
              ],
              nextAfter: null,
            }),
          );
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <CollaborationPanel
        projectId={project.id}
        requestedMessageId="message-target"
        threadId={TEST_THREAD_ID}
      />,
    );

    expect(await screen.findByText("URL target message")).toBeInTheDocument();
    const targetItem = listItemFor("URL target message");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    await waitFor(() => expect(targetItem).toHaveFocus());
    expect(targetItem.className).toContain("reply-target-highlight");
  });

  it("backfills fact pages until the requested message is loaded, then locates it", async () => {
    const first = message("message-first", 1, "owner", "First page message");
    const late = message("message-late", 2, "owner", "Late URL message");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(
            Response.json({ items: [first, late], nextAfter: null }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-first", 1, first)],
              nextAfter: 1,
            }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts?after=1`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-late", 2, late)],
              nextAfter: null,
            }),
          );
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <CollaborationPanel
        projectId={project.id}
        requestedMessageId="message-late"
        threadId={TEST_THREAD_ID}
      />,
    );

    expect(await screen.findByText("Late URL message")).toBeInTheDocument();
    const targetItem = listItemFor("Late URL message");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    await waitFor(() => expect(targetItem).toHaveFocus());
    expect(
      screen.queryByText(/无法定位指定的消息/),
    ).toBeNull();
  });

  it("shows an honest status placeholder when the message is not in readable history", async () => {
    const only = message("message-only", 1, "owner", "Only message");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(
            Response.json({ items: [only], nextAfter: null }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-only", 1, only)],
              nextAfter: null,
            }),
          );
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <CollaborationPanel
        projectId={project.id}
        requestedMessageId="message-missing"
        threadId={TEST_THREAD_ID}
      />,
    );

    expect(await screen.findByText("Only message")).toBeInTheDocument();
    const notice = await screen.findByText(
      "无法定位指定的消息：它不在当前可读取的协作历史中。",
    );
    expect(notice).toHaveAttribute("role", "status");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("clears the locate placeholder when the thread target switches", async () => {
    const only = message("message-only", 1, "owner", "Only message");
    const newThread = "thread-2";
    const newMessage: ThreadMessageDto = {
      ...message("message-new", 1, "owner", "New thread message"),
      threadId: newThread,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(
            Response.json({ items: [only], nextAfter: null }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-only", 1, only)],
              nextAfter: null,
            }),
          );
        }
        if (url.endsWith(`/threads/${newThread}`)) {
          return Promise.resolve(Response.json(detail(newThread)));
        }
        if (url.endsWith(`/threads/${newThread}/messages`)) {
          return Promise.resolve(
            Response.json({ items: [newMessage], nextAfter: null }),
          );
        }
        if (url.endsWith(`/threads/${newThread}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [
                messageFact("fact-new", 1, {
                  ...newMessage,
                }),
              ],
              nextAfter: null,
            }),
          );
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const view = render(
      <CollaborationPanel
        projectId={project.id}
        requestedMessageId="message-missing"
        threadId={TEST_THREAD_ID}
      />,
    );
    const notice = await screen.findByText(
      "无法定位指定的消息：它不在当前可读取的协作历史中。",
    );
    expect(notice).toHaveAttribute("role", "status");

    view.rerender(
      <CollaborationPanel
        projectId={project.id}
        threadId={newThread}
      />,
    );
    expect(await screen.findByText("New thread message")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText(/无法定位指定的消息/),
      ).toBeNull()
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not locate anything when no message parameter is provided", async () => {
    const only = message("message-only", 1, "owner", "Plain load message");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${TEST_THREAD_ID}`)) {
          return Promise.resolve(Response.json(detail()));
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/messages`)) {
          return Promise.resolve(
            Response.json({ items: [only], nextAfter: null }),
          );
        }
        if (url.endsWith(`/threads/${TEST_THREAD_ID}/facts`)) {
          return Promise.resolve(
            Response.json({
              items: [messageFact("fact-only", 1, only)],
              nextAfter: null,
            }),
          );
        }
        if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
          return Promise.resolve(Response.json({ tags: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <CollaborationPanel projectId={project.id} threadId={TEST_THREAD_ID} />,
    );

    expect(await screen.findByText("Plain load message")).toBeInTheDocument();
    await act(async () => undefined);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.queryByText(/无法定位指定的消息/)).toBeNull();
  });
});
