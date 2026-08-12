// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";

const projectId = "project-1";
const threadId = "thread-1";

function detail(dispatch: "ready" | "project_run_active" = "ready") {
  return {
    activeRun: dispatch === "project_run_active"
      ? { runId: "run-other", threadId: "thread-other" }
      : null,
    readiness: {
      dispatch,
      missingProjectFacts: [],
      selectedMemberId: null,
    },
    runs: [],
    selectedRun: null,
    thread: {
      availability: "ready",
      createdAt: "2026-08-12T05:00:00.000Z",
      id: threadId,
      lastActivitySequence: 1,
      policy: {
        availability: "ready",
        createdAt: "2026-08-12T05:00:00.000Z",
        members: [],
        revisionId: "revision-1",
        unavailableMemberIds: [],
        version: 1,
      },
      policyVersion: 1,
      projectId,
      title: "Thread queue",
      updatedAt: "2026-08-12T05:00:00.000Z",
      version: 3,
    },
  };
}

const queueItems = [
  {
    content: "first pending",
    createdAt: "2026-08-12T05:00:00.000Z",
    id: "queue-1",
    position: 1,
    projectId,
    status: "pending",
    threadId,
    updatedAt: "2026-08-12T05:00:00.000Z",
  },
  {
    content: "second pending",
    createdAt: "2026-08-12T05:01:00.000Z",
    id: "queue-2",
    position: 2,
    projectId,
    status: "pending",
    threadId,
    updatedAt: "2026-08-12T05:01:00.000Z",
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("thread queue panel", () => {
  it("renders loading and empty queue states with retry", async () => {
    let resolveQueue!: (response: Response) => void;
    const pendingQueue = new Promise<Response>((resolve) => {
      resolveQueue = resolve;
    });
    let queueReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/threads/${threadId}`)) return Response.json(detail());
      if (url.includes(`/threads/${threadId}/messages`)) {
        return Response.json({ items: [], nextAfter: null });
      }
      if (url.includes(`/threads/${threadId}/facts`)) {
        return Response.json({ items: [], nextAfter: null });
      }
      if (url.endsWith(`/threads/${threadId}/queue`)) {
        queueReads += 1;
        if (queueReads === 1) return pendingQueue;
        return Response.json({ items: [] });
      }
      if (url.endsWith(`/projects/${projectId}/members`)) {
        return Response.json({ members: [], projectVersion: 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    render(<CollaborationPanel projectId={projectId} threadId={threadId} />);

    await screen.findByText("尚无协作消息。请发送第一条消息。");
    const expand = screen.getByRole("button", { name: "展开待处理消息队列" });
    await user.click(expand);
    expect(await screen.findByText("正在加载待处理消息队列…")).toBeVisible();
    resolveQueue(
      Response.json(
        { error: { code: "STORAGE_UNAVAILABLE", message: "private" } },
        { status: 503 },
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用");
    expect(screen.queryByText("private")).toBeNull();
    await user.click(screen.getByRole("button", { name: "重试加载队列" }));
    expect(await screen.findByText("暂无待处理消息。")).toBeVisible();
  });

  it("supports keyboard steer/cancel/reorder and disables steer under governance conflict", async () => {
    const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/threads/${threadId}`)) return Response.json(detail());
      if (url.includes(`/threads/${threadId}/messages`)) {
        return Response.json({ items: [], nextAfter: null });
      }
      if (url.includes(`/threads/${threadId}/facts`)) {
        return Response.json({ items: [], nextAfter: null });
      }
      if (url.endsWith(`/threads/${threadId}/queue`)) {
        return Response.json({ items: queueItems });
      }
      if (url.endsWith(`/queue/queue-2/steer`) && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({ body, url });
        return Response.json({
          item: { ...queueItems[1], position: 1 },
          steered: true,
          threadVersion: 4,
        });
      }
      if (url.endsWith(`/queue/queue-1/reorder`) && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({ body, url });
        return Response.json({
          item: { ...queueItems[0], position: 2 },
          reordered: true,
          threadVersion: 5,
        });
      }
      if (url.endsWith(`/queue/queue-1/cancel`) && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({ body, url });
        return Response.json({
          cancelled: true,
          item: { ...queueItems[0], status: "cancelled" },
          threadVersion: 6,
        });
      }
      if (url.endsWith(`/projects/${projectId}/members`)) {
        return Response.json({ members: [], projectVersion: 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    const view = render(<CollaborationPanel projectId={projectId} threadId={threadId} />);
    const expand = await screen.findByRole("button", { name: "展开待处理消息队列" });
    await user.click(expand);

    const queueRegion = await screen.findByRole("region", { name: "待处理消息队列" });
    expect(within(queueRegion).getByText("first pending")).toBeVisible();
    expect(within(queueRegion).getByText("second pending")).toBeVisible();

    const steerSecond = within(queueRegion).getByRole("button", { name: "Steer second pending" });
    steerSecond.focus();
    expect(steerSecond).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(requests.some((entry) => entry.url.endsWith("/queue/queue-2/steer"))).toBe(true)
    );

    await user.click(within(queueRegion).getByRole("button", { name: "下移 first pending" }));
    await user.click(within(queueRegion).getByRole("button", { name: "撤回 first pending" }));
    expect(requests.some((entry) => entry.url.endsWith("/queue/queue-1/reorder"))).toBe(true);
    expect(requests.some((entry) => entry.url.endsWith("/queue/queue-1/cancel"))).toBe(true);
    view.unmount();

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/threads/${threadId}`)) return Response.json(detail("project_run_active"));
      if (url.includes(`/threads/${threadId}/messages`)) {
        return Response.json({ items: [], nextAfter: null });
      }
      if (url.includes(`/threads/${threadId}/facts`)) {
        return Response.json({ items: [], nextAfter: null });
      }
      if (url.endsWith(`/threads/${threadId}/queue`)) {
        return Response.json({ items: queueItems });
      }
      if (url.endsWith(`/projects/${projectId}/members`)) {
        return Response.json({ members: [], projectVersion: 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<CollaborationPanel projectId={projectId} threadId={threadId} />);
    await user.click(await screen.findByRole("button", { name: "展开待处理消息队列" }));
    const disabledSteer = await screen.findByRole("button", { name: "Steer first pending" });
    expect(disabledSteer).toBeDisabled();
  });
});
