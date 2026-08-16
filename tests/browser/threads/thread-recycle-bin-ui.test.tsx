// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import { ProjectThreadNavigation } from "@/components/project-thread-navigation";

const project = {
  createdAt: "2026-08-11T00:00:00.000Z",
  id: "project-1",
  name: "Launch plan",
};

type ThreadItem = {
  availability: "ready";
  createdAt: string;
  favoritedAt: null;
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

type RecycleItem = {
  attachmentCount: number;
  deletedAt: string;
  id: string;
  messageCount: number;
  projectId: string;
  title: string;
};

function thread(id: string, title: string, sequence: number): ThreadItem {
  return {
    availability: "ready",
    createdAt: "2026-08-11T00:00:00.000Z",
    favoritedAt: null,
    id,
    isFavorite: false,
    lastActivitySequence: sequence,
    policyVersion: 1,
    projectId: project.id,
    tags: [],
    title,
    updatedAt: "2026-08-11T00:00:00.000Z",
    version: 1,
  };
}

function recycle(
  id: string,
  title: string,
  deletedAt: string,
  messageCount: number,
  attachmentCount: number,
): RecycleItem {
  return { attachmentCount, deletedAt, id, messageCount, projectId: project.id, title };
}

function NavigationHarness({
  onNavigate,
  projectId = project.id,
}: {
  onNavigate?: (href: string) => void;
  projectId?: string;
}) {
  const backgroundRef = useRef<HTMLElement>(null);
  return (
    <main data-testid="thread-recycle-background" ref={backgroundRef}>
      <ProjectThreadNavigation
        backgroundRef={backgroundRef}
        onNavigate={onNavigate}
        projectId={projectId}
      />
    </main>
  );
}

afterEach(() => {
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("thread recycle bin navigation", () => {
  it("renders a third recycle-bin tab and honest empty state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/projects/${project.id}/threads?limit=100`) {
        return Response.json({ nextCursor: null, threads: [thread("thread-1", "Thread A", 1)] });
      }
      if (url === `/api/projects/${project.id}/thread-recycle-bin?limit=50`) {
        return Response.json({ nextCursor: null, threads: [] });
      }
      if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
        return Response.json({ tags: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<NavigationHarness />);
    await screen.findByRole("button", { name: "Thread A" });
    await user.click(screen.getByRole("button", { name: "回收站" }));

    expect(await screen.findByText("回收站为空。")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === `/api/projects/${project.id}/thread-recycle-bin?limit=50`,
      ),
    ).toBe(true);
  });

  it("moves a thread into recycle bin with light confirmation and clears current selection", async () => {
    const activeThreads = [thread("thread-1", "Current thread", 2), thread("thread-2", "Next", 1)];
    const recycleItems: RecycleItem[] = [];
    const onNavigate = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/projects/${project.id}/threads?limit=100`) {
        return Response.json({ nextCursor: null, threads: activeThreads });
      }
      if (url === `/api/projects/${project.id}/thread-recycle-bin?limit=50`) {
        return Response.json({ nextCursor: null, threads: recycleItems });
      }
      if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
        return Response.json({ tags: [] });
      }
      if (
        url === `/api/projects/${project.id}/threads/thread-1`
        && init?.method === "DELETE"
      ) {
        const removed = activeThreads.shift()!;
        recycleItems.unshift(
          recycle(removed.id, removed.title, "2026-08-11T10:00:00.000Z", 3, 1),
        );
        return Response.json({
          deleted: true,
          deletedAt: "2026-08-11T10:00:00.000Z",
          threadId: removed.id,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<NavigationHarness onNavigate={onNavigate} />);
    await screen.findByRole("button", { name: "Current thread" });
    await user.click(screen.getByRole("button", { name: "移入回收站 Current thread" }));
    const confirm = await screen.findByRole("dialog", { name: "移入回收站" });
    expect(confirm).toHaveTextContent("可从回收站恢复");
    await user.click(within(confirm).getByRole("button", { name: "确认移入" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "对话“Current thread”已移入回收站。",
    );
    expect(onNavigate).toHaveBeenCalledWith(`/projects/${encodeURIComponent(project.id)}`);
    expect(screen.queryByRole("button", { name: "Current thread" })).toBeNull();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
  });

  it("restores and purges from recycle rows with correct confirmation copy and 409 alert", async () => {
    const activeThreads = [thread("thread-2", "Kept", 1)];
    const recycleItems = [
      recycle("thread-1", "Recover me", "2026-08-11T09:00:00.000Z", 5, 2),
      recycle("thread-blocked", "Blocked purge", "2026-08-11T08:00:00.000Z", 4, 1),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/projects/${project.id}/threads?limit=100`) {
        return Response.json({ nextCursor: null, threads: activeThreads });
      }
      if (url === `/api/projects/${project.id}/thread-recycle-bin?limit=50`) {
        return Response.json({ nextCursor: null, threads: recycleItems });
      }
      if (url === `/api/projects/${project.id}/thread-tags?limit=100`) {
        return Response.json({ tags: [] });
      }
      if (
        url === `/api/projects/${project.id}/threads/thread-1/restore`
        && init?.method === "POST"
      ) {
        activeThreads.unshift(thread("thread-1", "Recover me", 3));
        recycleItems.splice(
          recycleItems.findIndex((item) => item.id === "thread-1"),
          1,
        );
        return Response.json({ restored: true, threadId: "thread-1" });
      }
      if (
        url === `/api/projects/${project.id}/threads/thread-blocked/purge`
        && init?.method === "POST"
      ) {
        return Response.json(
          {
            error: {
              code: "OPERATION_CONFLICT",
              fields: { threadId: "has_executions" },
              message: "blocked",
            },
          },
          { status: 409 },
        );
      }
      if (
        url === `/api/projects/${project.id}/threads/thread-1/purge`
        && init?.method === "POST"
      ) {
        recycleItems.splice(
          recycleItems.findIndex((item) => item.id === "thread-1"),
          1,
        );
        return Response.json({
          purged: true,
          removedAttachmentCount: 2,
          removedMessageCount: 5,
          threadId: "thread-1",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-2`);
    const user = userEvent.setup();

    render(<NavigationHarness />);
    await screen.findByRole("button", { name: "Kept" });
    await user.click(screen.getByRole("button", { name: "回收站" }));
    await screen.findByRole("button", { name: "恢复 Recover me" });

    await user.click(screen.getByRole("button", { name: "永久删除 Recover me" }));
    const purgeConfirm = await screen.findByRole("dialog", { name: "永久删除对话" });
    expect(purgeConfirm).toHaveTextContent(
      "将永久删除 5 条消息、2 个附件。此操作不可恢复；删除操作会记录在审计日志中。",
    );
    expect(within(purgeConfirm).getByRole("button", { name: "取消" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "永久删除对话" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "恢复 Recover me" }));
    expect(await screen.findByRole("status")).toHaveTextContent("对话“Recover me”已恢复。");
    expect(screen.queryByRole("button", { name: "恢复 Recover me" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "永久删除 Blocked purge" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "永久删除对话" })).getByRole(
        "button",
        { name: "永久删除" },
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "该对话已产生执行记录，不可永久删除",
    );
  });
});

describe("thread deleted placeholder panel", () => {
  it("shows thread_deleted placeholder with restore and back actions", async () => {
    let restored = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/threads/thread-1`) && !init?.method) {
        if (!restored) {
          return Response.json(
            {
              error: {
                code: "RESOURCE_NOT_FOUND",
                message: "missing",
                reason: "thread_deleted",
              },
            },
            { status: 404 },
          );
        }
        return Response.json({
          activeRun: null,
          readiness: { dispatch: "ready", missingProjectFacts: [], selectedMemberId: null },
          runs: [],
          selectedRun: null,
          thread: {
            availability: "ready",
            createdAt: "2026-08-11T00:00:00.000Z",
            id: "thread-1",
            lastActivitySequence: 1,
            policy: {
              availability: "ready",
              createdAt: "2026-08-11T00:00:00.000Z",
              members: [],
              revisionId: "r1",
              unavailableMemberIds: [],
              version: 1,
            },
            policyVersion: 1,
            projectId: project.id,
            title: "Recovered",
            updatedAt: "2026-08-11T00:00:00.000Z",
            version: 1,
          },
        });
      }
      if (url.endsWith(`/threads/thread-1/restore`) && init?.method === "POST") {
        restored = true;
        return Response.json({ restored: true, threadId: "thread-1" });
      }
      if (url.endsWith(`/threads/thread-1/messages`)) {
        return Response.json({ items: [], nextAfter: null });
      }
      if (url.endsWith(`/threads/thread-1/facts`)) {
        return Response.json({ items: [], nextAfter: null });
      }
      if (url.endsWith(`/projects/${project.id}/members`)) {
        return Response.json({ members: [], projectVersion: 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    const user = userEvent.setup();

    render(<CollaborationPanel projectId={project.id} threadId="thread-1" />);
    expect(await screen.findByText("该对话已移入回收站。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回对话列表" }));
    expect(window.location.search).toBe("");

    window.history.replaceState(null, "", `/projects/${project.id}?thread=thread-1`);
    await user.click(screen.getByRole("button", { name: "恢复对话" }));
    expect(await screen.findByRole("status")).toHaveTextContent("对话已恢复。");
  });
});

describe("recycle-bin styling contract", () => {
  it("uses tokens and 44px minimum controls", () => {
    const tokens = readFileSync("app/tokens.css", "utf8");
    const cockpit = readFileSync("app/cockpit.css", "utf8");
    expect(tokens).toContain("--control-min: 2.75rem");

    const ruleBlock = (selector: string) => {
      const match = cockpit.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, "m"));
      expect(match, `missing rule for ${selector}`).not.toBeNull();
      return match![1]!;
    };

    expect(ruleBlock(".thread-recycle-item-action")).toContain("min-height: var(--control-min)");
    expect(ruleBlock(".thread-recycle-item-action")).toContain("min-width: var(--control-min)");

    for (const selector of [
      ".thread-recycle-meta",
      ".thread-recycle-counts",
      ".thread-recycle-item-actions",
      ".thread-delete-confirm",
      ".thread-purge-confirm",
      ".thread-deleted-placeholder",
    ]) {
      const block = ruleBlock(selector);
      expect(block).toContain("var(--");
      expect(block).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    }
  });
});
