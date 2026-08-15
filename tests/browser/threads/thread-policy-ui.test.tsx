// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThreadPolicyPanel } from "@/components/collaboration/thread-policy-panel";
import { TaskPanel } from "@/components/task-panel";

const projectId = "project-1";
const threadId = "thread-1";
const operationId = "11111111-1111-4111-8111-111111111111";

const roster = [
  { agentId: "agent-a", name: "Alpha current" },
  { agentId: "agent-b", name: "Beta renamed" },
  { agentId: "agent-new", name: "New roster member" },
];

function policyDetail({
  availability = "ready",
  members = [
    {
      agentId: "agent-a",
      displayNameSnapshot: "Alpha snapshot",
      live: "current",
      position: 0,
    },
    {
      agentId: "agent-b",
      displayNameSnapshot: "Beta snapshot",
      live: "current",
      position: 1,
    },
  ],
  unavailableMemberIds = [],
  version = 1,
}: {
  availability?: "ready" | "repair_required";
  members?: Array<{
    agentId: string;
    displayNameSnapshot: string;
    live: "current" | "removed";
    position: number;
  }>;
  unavailableMemberIds?: string[];
  version?: number;
} = {}) {
  return {
    activeRun: null,
    readiness: {
      dispatch: availability === "ready" ? "ready" : "policy_repair_required",
      missingProjectFacts: [],
      selectedMemberId: null,
    },
    runs: [],
    selectedRun: null,
    thread: {
      availability,
      createdAt: "2026-08-08T00:00:00.000Z",
      id: threadId,
      lastActivitySequence: version + 1,
      policy: {
        availability,
        createdAt: "2026-08-08T00:00:00.000Z",
        members,
        revisionId: `revision-${version}`,
        unavailableMemberIds,
        version,
      },
      policyVersion: version,
      projectId,
      title: "Thread",
      updatedAt: "2026-08-08T00:00:00.000Z",
      version,
    },
  };
}

function policyFact(version: number) {
  return {
    activitySequence: version + 1,
    actorId: null,
    actorType: "owner",
    createdAt: "2026-08-08T00:00:00.000Z",
    id: `fact-policy-${version}`,
    message: null,
    messageId: null,
    payload: { policyVersion: version },
    policyRevisionId: `revision-${version}`,
    projectId,
    runEventId: null,
    runId: null,
    sequence: version + 1,
    threadId,
    type: "policy_changed",
  };
}

function policyUpdate(version: number, memberAgentIds = ["agent-a", "agent-b"]) {
  const names = new Map(roster.map((member) => [member.agentId, member.name]));
  const detail = policyDetail({
    members: memberAgentIds.map((agentId, position) => ({
      agentId,
      displayNameSnapshot: names.get(agentId)!,
      live: "current",
      position,
    })),
    version,
  });
  return {
    fact: policyFact(version),
    policy: detail.thread.policy,
    thread: detail.thread,
  };
}

function DirectHarness({
  canEdit = true,
}: {
  canEdit?: boolean;
}) {
  const backgroundRef = useRef<HTMLElement>(null);
  return (
    <main data-testid="policy-background" ref={backgroundRef}>
      <ThreadPolicyPanel
        canEdit={canEdit}
        modalBackgroundRef={backgroundRef}
        projectId={projectId}
        threadId={threadId}
      />
    </main>
  );
}

function standardFetch(detail = policyDetail(), rosterMembers = roster) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`/threads/${threadId}`)) return Response.json(detail);
    if (url.endsWith("/members")) {
      return Response.json({ members: rosterMembers, projectVersion: 1 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Harness() {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const editorCloseRef = useRef<HTMLButtonElement>(null);
  const contextRef = useRef<HTMLElement>(null);
  const contextCloseRef = useRef<HTMLButtonElement>(null);
  return (
    <TaskPanel
      contextCloseRef={contextCloseRef}
      contextOpen
      contextSurfaceRef={contextRef}
      currentProjectName="Project"
      currentProjectTitleRef={titleRef}
      editorCloseRef={editorCloseRef}
      editorOpen={false}
      editorSurfaceRef={editorRef}
      legacyTasksEnabled={false}
      narrow
      onCloseContext={() => undefined}
      onCloseEditor={() => undefined}
      onSelectProject={() => undefined}
      projectError={null}
      projectId={projectId}
      projectLoading={false}
      threadListState="ready"
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("selected thread member policy", () => {
  it("renders immutable policy in the narrow context drawer", async () => {
    window.history.replaceState(null, "", `/projects/${projectId}?thread=${threadId}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/threads/${threadId}`)) {
          return Response.json({
            activeRun: null,
            readiness: {
              dispatch: "ready",
              missingProjectFacts: [],
              selectedMemberId: null,
            },
            runs: [],
            selectedRun: null,
            thread: {
              availability: "ready",
              createdAt: "2026-08-08T00:00:00.000Z",
              id: threadId,
              lastActivitySequence: 2,
              policy: {
                availability: "ready",
                createdAt: "2026-08-08T00:00:00.000Z",
                members: [
                  {
                    agentId: "agent-a",
                    displayNameSnapshot: "Alpha snapshot",
                    live: "current",
                    position: 0,
                  },
                  {
                    agentId: "agent-b",
                    displayNameSnapshot: "Beta snapshot",
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
              title: "Thread",
              updatedAt: "2026-08-08T00:00:00.000Z",
              version: 1,
            },
          });
        }
        if (url.endsWith("/members")) {
          return Response.json({
            members: [
              { agentId: "agent-a", name: "Alpha current" },
              { agentId: "agent-b", name: "Beta current" },
            ],
            projectVersion: 1,
          });
        }
        if (url.endsWith("/context")) return Response.json({});
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<Harness />);

    expect(
      await screen.findByRole("heading", { name: "对话成员策略" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("context-surface")).toContainElement(
      screen.getByRole("region", { name: "对话成员策略" }),
    );
    expect(screen.getByText("策略版本 1")).toBeVisible();
  });

  it("distinguishes immutable snapshots from renamed, removed, unavailable, and new roster members", async () => {
    const detail = policyDetail({
      availability: "repair_required",
      members: [
        {
          agentId: "agent-a",
          displayNameSnapshot: "Alpha snapshot",
          live: "current",
          position: 0,
        },
        {
          agentId: "agent-removed",
          displayNameSnapshot: "Removed snapshot",
          live: "removed",
          position: 1,
        },
        {
          agentId: "agent-b",
          displayNameSnapshot: "Beta snapshot",
          live: "current",
          position: 2,
        },
      ],
      unavailableMemberIds: ["agent-b"],
    });
    vi.stubGlobal("fetch", standardFetch(detail));

    render(<DirectHarness />);

    await screen.findByText("Alpha snapshot");
    expect(screen.getByText(/当前名称：Beta renamed/)).toHaveTextContent(
      "快照名称已保留",
    );
    expect(screen.getByText("已移出项目，快照仍保留")).toBeVisible();
    expect(screen.getByText("Provider 不可用")).toBeVisible();
    expect(screen.getByText("New roster member")).toBeVisible();
    expect(screen.getByText(/新加入项目的成员不会自动加入/)).toBeVisible();
    expect(screen.getByRole("alert", { name: "" })).toHaveTextContent(
      "需要修复",
    );
    expect(
      screen.getByRole("button", { name: "修复对话成员策略" }),
    ).toBeEnabled();
  });

  it("uses semantic validation, traps focus, closes on Escape, and restores the owner control", async () => {
    vi.stubGlobal("fetch", standardFetch());
    const user = userEvent.setup();
    render(<DirectHarness />);

    const opener = await screen.findByRole("button", {
      name: "编辑对话成员策略",
    });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "编辑对话成员策略" });
    expect(within(dialog).getByLabelText("Alpha current")).toHaveFocus();
    expect(screen.getByTestId("policy-background")).toHaveAttribute("inert");
    expect(within(dialog).getByLabelText("New roster member")).not.toBeChecked();
    expect(within(dialog).getByRole("group", { name: "当前项目成员" }))
      .toBeInTheDocument();

    await user.click(within(dialog).getByLabelText("Beta renamed"));
    expect(within(dialog).getByRole("button", { name: "保存成员策略" }))
      .toBeDisabled();
    expect(within(dialog).getByText("至少选择 2 名不同的当前项目成员。"))
      .toBeVisible();

    within(dialog).getByRole("button", { name: "关闭成员策略编辑" }).focus();
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "编辑对话成员策略" }))
      .not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("submits expectedVersion and operationId, explains pending disablement, then announces and focuses success", async () => {
    const pending = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/threads/${threadId}`)) {
        return Response.json(policyDetail());
      }
      if (url.endsWith("/members")) {
        return Response.json({ members: roster, projectVersion: 1 });
      }
      if (url.endsWith("/policy") && init?.method === "PATCH") {
        return pending.promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    const user = userEvent.setup();
    render(<DirectHarness />);

    await user.click(
      await screen.findByRole("button", { name: "编辑对话成员策略" }),
    );
    await user.click(screen.getByLabelText("New roster member"));
    await user.click(screen.getByRole("button", { name: "保存成员策略" }));

    expect(screen.getByText("策略更新请求处理中，表单暂不可用。")).toBeVisible();
    expect(screen.getByRole("group", { name: "当前项目成员" })).toBeDisabled();
    const patch = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/policy")
        && (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
      expectedVersion: 1,
      memberAgentIds: ["agent-a", "agent-b", "agent-new"],
      operationId,
    });

    pending.resolve(Response.json(policyUpdate(2, ["agent-a", "agent-b", "agent-new"])));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "策略版本 2，事实 fact-policy-2",
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "对话成员策略" })).toHaveFocus()
    );
  });

  it("reloads detail and facts on VERSION_CONFLICT while preserving current owner choices", async () => {
    let detailReads = 0;
    let patchCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/threads/${threadId}`)) {
        detailReads += 1;
        return Response.json(policyDetail({ version: detailReads === 1 ? 1 : 2 }));
      }
      if (url.endsWith("/members")) {
        return Response.json({ members: roster, projectVersion: 1 });
      }
      if (url.endsWith("/facts")) {
        return Response.json({ items: [policyFact(2)], nextAfter: null });
      }
      if (url.endsWith("/policy") && init?.method === "PATCH") {
        patchCalls += 1;
        if (patchCalls === 1) {
          return Response.json(
            {
              error: {
                code: "VERSION_CONFLICT",
                currentVersion: 2,
                message: "stale",
              },
            },
            { status: 409 },
          );
        }
        return Response.json(policyUpdate(3, ["agent-a", "agent-new"]));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    const user = userEvent.setup();
    render(<DirectHarness />);

    await user.click(
      await screen.findByRole("button", { name: "编辑对话成员策略" }),
    );
    await user.click(screen.getByLabelText("Beta renamed"));
    await user.click(screen.getByLabelText("New roster member"));
    await user.click(screen.getByRole("button", { name: "保存成员策略" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "已重新加载最新版本和事实",
    );
    expect(screen.getByLabelText("Alpha current")).toBeChecked();
    expect(screen.getByLabelText("New roster member")).toBeChecked();
    expect(screen.getByLabelText("Beta renamed")).not.toBeChecked();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/facts")),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "保存成员策略" }));
    const secondBody = JSON.parse(
      String(
        (fetchMock.mock.calls.filter(
          ([url, init]) =>
            String(url).endsWith("/policy")
            && (init as RequestInit | undefined)?.method === "PATCH",
        )[1]![1] as RequestInit).body,
      ),
    );
    expect(secondBody.expectedVersion).toBe(2);
  });

  it("reconciles an unknown write by operation without resending", async () => {
    let patchCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/threads/${threadId}`)) return Response.json(policyDetail());
      if (url.endsWith("/members")) {
        return Response.json({ members: roster, projectVersion: 1 });
      }
      if (url.endsWith("/policy") && init?.method === "PATCH") {
        patchCalls += 1;
        throw new TypeError("connection lost");
      }
      if (url.endsWith(`/operations/${operationId}`)) {
        return Response.json({
          httpStatus: 200,
          kind: "policy_update",
          operationId,
          response: policyUpdate(2),
          status: "completed",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    const user = userEvent.setup();
    render(<DirectHarness />);

    await user.click(
      await screen.findByRole("button", { name: "编辑对话成员策略" }),
    );
    await user.click(screen.getByRole("button", { name: "保存成员策略" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "已通过操作核对确认",
    );
    expect(patchCalls).toBe(1);
  });

  it("covers loading, safe cross-tuple retry, impossible roster, and no-permission states", async () => {
    const pending = deferredResponse();
    let detailReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/threads/${threadId}`)) {
        detailReads += 1;
        if (detailReads === 1) return pending.promise;
        return Response.json(
          detailReads === 2
            ? {
                ...policyDetail(),
                thread: { ...policyDetail().thread, projectId: "other-project" },
              }
            : policyDetail(),
        );
      }
      if (url.endsWith("/members")) {
        return Response.json({
          members: roster.slice(0, 1),
          projectVersion: 1,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const view = render(<DirectHarness canEdit={false} />);

    expect(screen.getByText("正在加载对话成员策略…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    pending.resolve(Response.json({
      ...policyDetail(),
      thread: { ...policyDetail().thread, projectId: "other-project" },
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法加载对话成员策略",
    );
    expect(screen.queryByText("Alpha snapshot")).toBeNull();

    await user.click(screen.getByRole("button", { name: "重试加载成员策略" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法加载对话成员策略",
    );
    await user.click(screen.getByRole("button", { name: "重试加载成员策略" }));
    expect(await screen.findByText(/当前项目不足两名成员/)).toBeVisible();
    expect(screen.getByRole("button", { name: "编辑对话成员策略" }))
      .toBeDisabled();
    expect(screen.getByText("只有项目所有者可以修改对话成员策略。"))
      .toBeVisible();
    view.unmount();
  });
});
