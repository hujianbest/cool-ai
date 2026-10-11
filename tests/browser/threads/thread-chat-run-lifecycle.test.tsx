// @vitest-environment jsdom
// T-A1：运行生命周期重挂会话面（surface="chat"）。
// 契约（product/ui/UI设计.md §9.1.3 运行生命周期区）：
// - 决策答复在会话面内联可达；
// - 会话面呈现当前运行（显式选择优先 → 本对话持有的活动运行 → 最近一次运行）的状态/控制/用量；
// - 会话面不提供运行选择控件；历史运行查看走规范深链；
// - 另一对话持有活动运行时可返回该对话。
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import type {
  ThreadRunDto,
  TimelineEvent,
} from "@/src/shared/collaboration-contracts";

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
    roundCount: 3,
    status,
    threadId: selectedThreadId,
    updatedAt: createdAt,
    version: 1,
  };
}

const running = run("run-new", "running", "2026-08-08T08:00:00.000Z");
const planned = run("run-done", "planned", "2026-08-08T08:00:00.000Z");

function detail({
  activeRun = null,
  runs = [running],
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

const decisionEvent: TimelineEvent = {
  actorId: "agent-a",
  actorType: "agent",
  createdAt: "2026-08-08T08:01:00.000Z",
  id: "run-event-decision",
  payload: {
    agentId: "agent-a",
    decisionId: "decision-1",
    options: ["Ship now", "Wait"],
    question: "When should we ship?",
    turnId: "turn-1",
  },
  runId: running.id,
  sequence: 2,
  type: "decision_requested",
};

function installFetch(
  readDetail: (url: string) => Response = (url) =>
    Response.json(detail({ selectedRun: url.includes("?run=") ? running : null })),
  timelineItems: TimelineEvent[] = [],
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes(`/threads/${threadId}/runs/`) && url.endsWith("/timeline")) {
      return Response.json({ items: timelineItems, nextAfter: null });
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function detailWithPolicy(availability: "ready" | "repair_required") {
  const base = detail();
  return {
    ...base,
    thread: {
      ...base.thread,
      availability,
      policy: {
        ...base.thread.policy,
        availability,
        members: base.thread.policy.members.map((member, index) => (
          availability === "repair_required" && index === 1
            ? { ...member, live: "removed" as const }
            : member
        )),
        unavailableMemberIds:
          availability === "repair_required" ? ["agent-b"] : [],
      },
    },
  };
}

describe("chat surface run lifecycle", () => {
  it("renders the pending decision inline in the chat surface without a run selector", async () => {
    installFetch(undefined, [decisionEvent]);
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);

    render(
      <CollaborationPanel
        projectId={projectId}
        surface="chat"
        threadId={threadId}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "等待你的决策" }),
    ).toBeInTheDocument();
    expect(screen.getByText("When should we ship?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Ship now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled();
    expect(
      screen.queryByRole("combobox", { name: "选择对话运行" }),
    ).not.toBeInTheDocument();
  });

  it("shows the current run status, controls, and usage in the chat surface", async () => {
    installFetch();
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);

    render(
      <CollaborationPanel
        projectId={projectId}
        surface="chat"
        threadId={threadId}
      />,
    );

    expect(await screen.findByText("运行状态：running")).toBeVisible();
    const controls = screen.getByRole("region", { name: "运行控制" });
    expect(within(controls).getByRole("button", { name: "停止" })).toBeVisible();
    expect(screen.getByRole("region", { name: "运行用量" })).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "选择对话运行" }),
    ).not.toBeInTheDocument();
  });

  it("marks an ended run in the chat surface and keeps the new-round composer available", async () => {
    installFetch(() => Response.json(detail({ runs: [planned] })));
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);

    render(
      <CollaborationPanel
        projectId={projectId}
        surface="chat"
        threadId={threadId}
      />,
    );

    expect(await screen.findByText("运行状态：planned")).toBeVisible();
    expect(screen.getByText(/本轮已结束/)).toBeVisible();
  });

  it("surfaces the fail-closed thread policy repair entry in the chat surface", async () => {
    installFetch(() => Response.json(detailWithPolicy("repair_required")) as Response);
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);

    render(
      <CollaborationPanel
        projectId={projectId}
        surface="chat"
        threadId={threadId}
      />,
    );

    expect(
      await screen.findByText(/需要修复：策略包含已移出项目或无效的成员/u),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "修复对话成员策略" }),
    ).toBeVisible();
  });

  it("keeps the policy repair entry out of the chat surface when the policy is ready", async () => {
    installFetch(() => Response.json(detailWithPolicy("ready")) as Response);
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);

    render(
      <CollaborationPanel
        projectId={projectId}
        surface="chat"
        threadId={threadId}
      />,
    );

    expect(await screen.findByText("运行状态：running")).toBeVisible();
    expect(screen.queryByText(/需要修复/u)).toBeNull();
    expect(
      screen.queryByRole("region", { name: "对话成员策略" }),
    ).toBeNull();
  });

  it("returns to the active run owned by another thread from the chat surface", async () => {
    const active = { runId: "run-active", threadId: "thread-active" };
    installFetch(() => Response.json(detail({ activeRun: active, runs: [] })));
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);

    render(
      <CollaborationPanel
        projectId={projectId}
        surface="chat"
        threadId={threadId}
      />,
    );

    const returnLink = await screen.findByRole("link", {
      name: `返回活动对话 ${active.runId}`,
    });
    expect(returnLink).toHaveAttribute(
      "href",
      `/projects/${projectId}?thread=${active.threadId}&run=${active.runId}`,
    );
  });
});
