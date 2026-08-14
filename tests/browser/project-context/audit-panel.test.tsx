// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import type {
  AuditEventListItemDto,
  AuditProjectionFreshness,
  ProjectAuditEventsPageDto,
  ProjectTimelinePageDto,
  TimelineEventItemDto,
} from "@/src/shared/audit-contracts";

type AuditPanelModule = {
  AuditPanel: ComponentType<{ projectId: string }>;
};

const modules =
  import.meta.glob<AuditPanelModule>("../../../components/project-context/audit-panel.tsx");

async function auditPanel() {
  const load = modules["../../../components/project-context/audit-panel.tsx"];
  expect(load, "the audit panel must exist").toBeTypeOf("function");
  return (await load()).AuditPanel;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function auditEvent(overrides: Partial<AuditEventListItemDto>): AuditEventListItemDto {
  return {
    actorType: "system",
    eventType: "status_changed",
    executionId: null,
    id: `event-${overrides.outboxSeq ?? 1}`,
    occurredAt: "2026-08-10T00:00:00.000Z",
    outboxSeq: 1,
    payload: {},
    ...overrides,
  };
}

function page(
  events: AuditEventListItemDto[],
  freshness: Partial<AuditProjectionFreshness> = {},
  nextBeforeSeq: number | null = null,
): ProjectAuditEventsPageDto {
  return {
    events,
    freshness: { lag: 0, status: "caught_up", ...freshness },
    nextBeforeSeq,
  };
}

function timelineItem(
  overrides: Partial<TimelineEventItemDto>,
): TimelineEventItemDto {
  return {
    ...auditEvent(overrides),
    sourceMissing: false,
    ...overrides,
  };
}

function timelinePage(
  items: TimelineEventItemDto[],
  freshness: Partial<AuditProjectionFreshness> = {},
): ProjectTimelinePageDto {
  return {
    freshness: { lag: 0, status: "caught_up", ...freshness },
    items,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Audit panel", () => {
  it("filters a mixed six-domain list and restores every row with 全部", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        eventType: "execution_created",
        executionId: "exec-1",
        id: "event-60",
        outboxSeq: 60,
      }),
      auditEvent({
        actorType: "owner",
        eventType: "owner_message",
        id: "event-59",
        outboxSeq: 59,
        payload: { threadId: "thread-1" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "work_item_created",
        id: "event-58",
        outboxSeq: 58,
        payload: { title: "任务筛选样例", workItemId: "work-1" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "project_created",
        id: "event-57",
        outboxSeq: 57,
        payload: { projectName: "项目筛选样例" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "approval_approved",
        id: "event-56",
        outboxSeq: 56,
        payload: { approvalId: "approval-1" },
      }),
      auditEvent({
        eventType: "runtime_call_succeeded",
        id: "event-55",
        outboxSeq: 55,
        payload: { model: "gpt-runtime", surface: "execution" },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    const user = userEvent.setup();
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const filters = screen.getByRole("group", { name: "按域筛选审计事件" });
    const allFilter = within(filters).getByRole("button", { name: "全部" });
    expect(allFilter).toHaveAttribute("aria-pressed", "true");
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);

    for (const [domain, heading] of [
      ["执行", "执行已创建"],
      ["协作", "Owner 消息"],
      ["任务", "看板任务已创建"],
      ["项目", "项目已创建"],
      ["治理", "审批已批准"],
      ["运行时", "运行时调用已成功"],
    ] as const) {
      const filter = within(filters).getByRole("button", { name: domain });
      if (domain === "执行") {
        filter.focus();
        await user.keyboard("{Enter}");
      } else {
        await user.click(filter);
      }
      expect(filter).toHaveAttribute("aria-pressed", "true");
      expect(allFilter).toHaveAttribute("aria-pressed", "false");
      const rows = within(list).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
      expect(within(rows[0]!).getByRole("heading", { name: heading }))
        .toBeInTheDocument();
    }

    await user.click(allFilter);
    expect(allFilter).toHaveAttribute("aria-pressed", "true");
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
  });

  it("shows the filtered empty state and re-filters events appended by load more", async () => {
    const AuditPanel = await auditPanel();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        return Promise.resolve(Response.json(
          calls === 1
            ? page([
              auditEvent({
                eventType: "execution_created",
                executionId: "exec-1",
                id: "event-3",
                outboxSeq: 3,
              }),
            ], {}, 3)
            : page([
              auditEvent({
                eventType: "owner_message",
                id: "event-2",
                outboxSeq: 2,
                payload: { threadId: "thread-1" },
              }),
              auditEvent({
                eventType: "runtime_call_succeeded",
                id: "event-1",
                outboxSeq: 1,
                payload: { model: "gpt-runtime", surface: "execution" },
              }),
            ]),
        ));
      }),
    );
    const user = userEvent.setup();
    render(<AuditPanel projectId="project-1" />);

    const filters = await screen.findByRole("group", {
      name: "按域筛选审计事件",
    });
    await user.click(
      within(filters).getByRole("button", { name: "运行时" }),
    );
    expect(screen.getByText("该筛选下尚无审计事件。")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "审计事件" })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "加载更多审计事件" }),
    );
    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByRole("heading", {
      name: "运行时调用已成功",
    })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Owner 消息" })).toBeNull();

    await user.click(within(filters).getByRole("button", { name: "全部" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  });

  it("shows loading, rebuilding conflict, generic load error with retry, and the empty state", async () => {
    const AuditPanel = await auditPanel();
    const first = deferred<Response>();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        requests.push(String(input));
        if (requests.length === 1) return first.promise;
        if (requests.length === 2) {
          return Promise.resolve(Response.json(
            { error: { code: "INTERNAL_ERROR", message: "boom" } },
            { status: 500 },
          ));
        }
        return Promise.resolve(Response.json(page([])));
      }),
    );
    render(<AuditPanel projectId="project-1" />);

    expect(screen.getByText("正在加载审计事件…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(requests).toEqual(["/api/projects/project-1/audit-events"]);

    await act(async () => {
      first.resolve(Response.json(
        {
          error: {
            code: "PROJECTION_REBUILD_IN_PROGRESS",
            message: "rebuild claimed",
          },
        },
        { status: 409 },
      ));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "审计投影正在重建，请稍后重试。",
    );

    await userEvent.setup().click(
      screen.getByRole("button", { name: "重试加载审计事件" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "服务暂时出现问题，请稍后重试。",
    );

    await userEvent.setup().click(
      screen.getByRole("button", { name: "重试加载审计事件" }),
    );
    expect(await screen.findByText("尚无审计事件。")).toBeInTheDocument();
    expect(screen.getByText("已追平")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders events in order with readable copy, unknown-type fallback, freshness and no edit entry", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        actorType: "agent",
        eventType: "execution_created",
        executionId: "exec-1",
        id: "event-9",
        occurredAt: "2026-08-10T01:02:03.000Z",
        outboxSeq: 9,
        payload: { status: "queued", workItemId: "work-1" },
      }),
      auditEvent({
        actorType: null,
        eventType: "future_custom_event",
        id: "event-8",
        occurredAt: "2026-08-10T01:01:03.000Z",
        outboxSeq: 8,
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("heading", { name: "执行已创建" }))
      .toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Agent/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText("2026-08-10T01:02:03.000Z").tagName)
      .toBe("TIME");
    expect(
      within(rows[0]!).getByRole("button", { name: "定位来源执行" }),
    ).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("heading", { name: "future_custom_event" }))
      .toBeInTheDocument();
    expect(within(rows[1]!).getByText(/未知/)).toBeInTheDocument();
    expect(
      within(rows[1]!).queryByRole("button", { name: "定位来源执行" }),
    ).toBeNull();
    expect(screen.getByText("已追平")).toBeInTheDocument();
    // 只读断言：审计列表不提供任何编辑入口。
    expect(within(list).queryByRole("textbox")).toBeNull();
    expect(within(list).queryByRole("checkbox")).toBeNull();
    expect(within(list).queryByRole("button", { name: /编辑|删除|修改/ }))
      .toBeNull();
    expect(screen.queryByText(/work-1/)).toBeNull();
  });

  it.each([
    { copy: "已追平", freshness: { lag: 0, status: "caught_up" }, variant: "status-completed" },
    { copy: "落后 3 条", freshness: { lag: 3, status: "behind" }, variant: "status-queued" },
    { copy: "重建中", freshness: { lag: 7, status: "rebuilding" }, variant: "status-running" },
  ] as const)(
    "marks freshness $copy with the $variant badge",
    async ({ copy, freshness, variant }) => {
      const AuditPanel = await auditPanel();
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(Response.json(page(
            [auditEvent({ outboxSeq: 2 })],
            freshness,
          ))),
        ),
      );
      render(<AuditPanel projectId="project-1" />);

      const badge = await screen.findByText(copy);
      expect(badge).toHaveClass("status-label");
      expect(badge).toHaveClass(variant);
    },
  );

  it("renders collaboration event types with readable copy and raw fallback for unknown types", async () => {
    const AuditPanel = await auditPanel();
    const collaborationCopy: ReadonlyArray<readonly [string, string]> = [
      ["run_started", "运行已开始"],
      ["run_paused", "运行已暂停"],
      ["run_resumed", "运行已恢复"],
      ["run_stopped", "运行已停止"],
      ["run_retried", "运行已重试"],
      ["run_planned", "运行已规划"],
      ["boundary_paused", "运行已在边界暂停"],
      ["owner_message", "Owner 消息"],
      ["agent_message", "Agent 消息"],
      ["handoff", "已交棒"],
      ["decision_requested", "决策已请求"],
      ["decision_answered", "决策已答复"],
      ["tasks_created", "任务已创建"],
      ["task_claimed", "任务已认领"],
      ["action_rejected", "动作已被拒绝"],
      ["context_changed", "上下文已变更"],
    ];
    const events = collaborationCopy.map(([eventType], index) =>
      auditEvent({
        actorType: "owner",
        eventType,
        id: `event-${100 - index}`,
        outboxSeq: 100 - index,
        payload: { runId: "run-1", threadId: "thread-1" },
      }),
    );
    events.push(auditEvent({
      eventType: "future_collaboration_event",
      id: "event-83",
      outboxSeq: 83,
      payload: { threadId: "thread-1" },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    for (const [, copy] of collaborationCopy) {
      expect(within(list).getByRole("heading", { name: copy }))
        .toBeInTheDocument();
    }
    expect(
      within(list).getByRole("heading", { name: "future_collaboration_event" }),
    ).toBeInTheDocument();
  });

  it("renders the thread recycle-bin lifecycle events with collaboration copy and badge", async () => {
    const AuditPanel = await auditPanel();
    const lifecycleCopy: ReadonlyArray<readonly [string, string]> = [
      ["thread_deleted", "线程已移入回收站"],
      ["thread_restored", "线程已恢复"],
      ["thread_purged", "线程已永久删除"],
    ];
    const events = lifecycleCopy.map(([eventType], index) =>
      auditEvent({
        actorType: "owner",
        eventType,
        id: `event-${100 - index}`,
        outboxSeq: 100 - index,
        payload: { threadId: "thread-1" },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    rows.forEach((row, index) => {
      expect(
        within(row).getByRole("heading", { name: lifecycleCopy[index]![1] }),
      ).toBeInTheDocument();
      const badge = within(row).getByText("协作");
      expect(badge).toHaveClass("status-label");
      expect(badge).toHaveClass("status-queued");
    });
  });

  it("badges every event with its source domain in a mixed execution/collaboration list", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        eventType: "execution_created",
        executionId: "exec-1",
        id: "event-30",
        outboxSeq: 30,
      }),
      auditEvent({
        actorType: "owner",
        eventType: "owner_message",
        id: "event-29",
        outboxSeq: 29,
        payload: { runId: "run-1", threadId: "thread-1" },
      }),
      auditEvent({
        actorType: "agent",
        eventType: "run_started",
        id: "event-28",
        outboxSeq: 28,
        payload: { runId: "run-1", threadId: "thread-1" },
      }),
      auditEvent({
        eventType: "tool_failed",
        executionId: "exec-1",
        id: "event-27",
        outboxSeq: 27,
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    const executionBadge = within(rows[0]!).getByText("执行");
    expect(executionBadge).toHaveClass("status-label");
    expect(executionBadge).toHaveClass("status-running");
    for (const row of [rows[1]!, rows[2]!]) {
      const badge = within(row).getByText("协作");
      expect(badge).toHaveClass("status-label");
      expect(badge).toHaveClass("status-queued");
    }
    expect(within(rows[3]!).getByText("执行")).toHaveClass("status-running");
    // Unknown types belong to the execution domain by default.
    expect(within(rows[0]!).queryByText("协作")).toBeNull();
  });

  it("shows the sanitized message excerpt for message events only", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        actorType: "owner",
        eventType: "owner_message",
        id: "event-40",
        outboxSeq: 40,
        payload: {
          messageExcerpt: "请帮我审查这个计划",
          runId: "run-1",
          threadId: "thread-1",
        },
      }),
      auditEvent({
        actorType: "agent",
        eventType: "agent_message",
        id: "event-39",
        outboxSeq: 39,
        payload: {
          messageExcerpt: "[redacted]",
          runId: "run-1",
          threadId: "thread-1",
        },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "owner_message",
        id: "event-38",
        outboxSeq: 38,
        payload: { threadId: "thread-1" },
      }),
      auditEvent({
        eventType: "run_started",
        id: "event-37",
        outboxSeq: 37,
        payload: { runId: "run-1", threadId: "thread-1" },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    const excerpt = within(rows[0]!).getByText("请帮我审查这个计划");
    expect(excerpt).toHaveClass("audit-event-excerpt");
    expect(within(rows[1]!).getByText("[redacted]"))
      .toHaveClass("audit-event-excerpt");
    // No excerpt row and non-message rows never render an excerpt element.
    expect(rows[2]!.querySelector(".audit-event-excerpt")).toBeNull();
    expect(rows[3]!.querySelector(".audit-event-excerpt")).toBeNull();
  });

  it("links collaboration events to the canonical thread/run target and keeps execution locate intact", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        actorType: "agent",
        eventType: "run_started",
        id: "event-50",
        outboxSeq: 50,
        payload: { runId: "run-1", threadId: "thread-1" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "owner_message",
        id: "event-49",
        outboxSeq: 49,
        payload: { threadId: "thread-2" },
      }),
      auditEvent({
        eventType: "execution_created",
        executionId: "exec-1",
        id: "event-48",
        outboxSeq: 48,
      }),
      auditEvent({
        actorType: "agent",
        eventType: "agent_message",
        id: "event-47",
        outboxSeq: 47,
        payload: { runId: 42 },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(
      within(rows[0]!).getByRole("link", { name: "定位来源线程" }),
    ).toHaveAttribute(
      "href",
      "/projects/project-1?thread=thread-1&run=run-1",
    );
    // runId null (owner_message fact mirror) omits the run parameter.
    expect(
      within(rows[1]!).getByRole("link", { name: "定位来源线程" }),
    ).toHaveAttribute("href", "/projects/project-1?thread=thread-2");
    // Execution rows keep the in-page focus button and gain no link.
    expect(
      within(rows[2]!).getByRole("button", { name: "定位来源执行" }),
    ).toBeInTheDocument();
    expect(within(rows[2]!).queryByRole("link")).toBeNull();
    // A malformed payload reference renders no link rather than a broken one.
    expect(within(rows[3]!).queryByRole("link")).toBeNull();
  });

  it("pages older events through the exclusive nextBeforeSeq cursor and keeps retry on failure", async () => {
    const AuditPanel = await auditPanel();
    const second = deferred<Response>();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        requests.push(String(input));
        if (requests.length === 1) {
          return Promise.resolve(Response.json(page(
            [
              auditEvent({ id: "event-5", outboxSeq: 5 }),
              auditEvent({ id: "event-4", outboxSeq: 4 }),
            ],
            { lag: 1, status: "behind" },
            4,
          )));
        }
        if (requests.length === 2) return second.promise;
        return Promise.resolve(Response.json(page(
          [auditEvent({ id: "event-3", outboxSeq: 3 })],
          { lag: 0, status: "caught_up" },
          null,
        )));
      }),
    );
    const user = userEvent.setup();
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("落后 1 条")).toBeInTheDocument();

    const more = screen.getByRole("button", { name: "加载更多审计事件" });
    await user.click(more);
    expect(
      await screen.findByRole("button", { name: "正在加载更多审计事件…" }),
    ).toBeDisabled();
    expect(requests[1]).toBe("/api/projects/project-1/audit-events?before=4");
    await act(async () => {
      second.resolve(Response.json(
        { error: { code: "STORAGE_UNAVAILABLE", message: "busy" } },
        { status: 503 },
      ));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "服务暂时不可用，请稍后重试。",
    );
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "加载更多审计事件" }));
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")).toHaveLength(3),
    );
    expect(within(list).getAllByRole("heading", { level: 3 })).toHaveLength(3);
    expect(screen.getByText("已追平")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "加载更多审计事件" }),
    ).toBeNull();
  });

  it("locates the source execution heading and reports when it is not rendered", async () => {
    const AuditPanel = await auditPanel();
    const target = document.createElement("h3");
    target.id = "execution-exec-1-title";
    target.tabIndex = -1;
    document.body.appendChild(target);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(Response.json(page([
          auditEvent({
            eventType: "merged",
            executionId: "exec-1",
            id: "event-12",
            outboxSeq: 12,
          }),
          auditEvent({
            eventType: "stale_detected",
            executionId: "exec-missing",
            id: "event-11",
            outboxSeq: 11,
          }),
        ]))),
      ),
    );
    const user = userEvent.setup();
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const [mergedRow, staleRow] = within(list).getAllByRole("listitem");
    await user.click(
      within(mergedRow!).getByRole("button", { name: "定位来源执行" }),
    );
    expect(target).toHaveFocus();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已定位到来源执行。",
    );

    await user.click(
      within(staleRow!).getByRole("button", { name: "定位来源执行" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "该执行未显示在运行详情列表中（仅展示最近的执行）。",
    );
  });

  it("discards stale responses after the project target switches", async () => {
    const AuditPanel = await auditPanel();
    const first = deferred<Response>();
    const signals: AbortSignal[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        if (init?.signal) signals.push(init.signal);
        if (calls === 1) return first.promise;
        return Promise.resolve(Response.json(page([])));
      }),
    );
    const { rerender } = render(<AuditPanel projectId="project-1" />);
    expect(screen.getByText("正在加载审计事件…")).toBeInTheDocument();

    rerender(<AuditPanel projectId="project-2" />);
    await waitFor(() => expect(calls).toBe(2));
    expect(signals[0]?.aborted).toBe(true);

    await act(async () => {
      first.resolve(Response.json(page([
        auditEvent({ id: "stale-event", outboxSeq: 42 }),
      ])));
    });
    expect(await screen.findByText("尚无审计事件。")).toBeInTheDocument();
    expect(screen.queryByText("状态已变更")).toBeNull();
  });
});

describe("Audit panel mission-work events", () => {
  it("renders mission-work types with readable copy and the task domain badge in a mixed three-domain list", async () => {
    const AuditPanel = await auditPanel();
    const missionWorkCopy: ReadonlyArray<readonly [string, string]> = [
      ["mission_created", "使命已创建"],
      ["task_created", "任务已创建"],
      ["task_started", "任务已开始"],
      ["task_completed", "任务已完成"],
      ["task_failed", "任务已失败"],
      ["work_item_created", "看板任务已创建"],
      ["work_item_status_changed", "看板任务状态已变更"],
    ];
    const events = missionWorkCopy.map(([eventType], index) =>
      auditEvent({
        actorType: "owner",
        eventType,
        id: `event-${100 - index}`,
        outboxSeq: 100 - index,
        payload: {
          missionId: "mission-1",
          title: `样例 ${eventType}`,
          workItemId: "work-1",
        },
      }),
    );
    events.push(auditEvent({
      eventType: "execution_created",
      executionId: "exec-1",
      id: "event-90",
      outboxSeq: 90,
    }));
    events.push(auditEvent({
      actorType: "agent",
      eventType: "run_started",
      id: "event-89",
      outboxSeq: 89,
      payload: { runId: "run-1", threadId: "thread-1" },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    for (const [, copy] of missionWorkCopy) {
      expect(within(list).getByRole("heading", { name: copy }))
        .toBeInTheDocument();
    }
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(9);
    for (const row of rows.slice(0, 7)) {
      const badge = within(row).getByText("任务", { selector: "span" });
      expect(badge).toHaveClass("status-label");
      expect(badge).toHaveClass("status-completed");
    }
    expect(within(rows[7]!).getByText("执行")).toHaveClass("status-running");
    expect(within(rows[8]!).getByText("协作")).toHaveClass("status-queued");
    // 只读断言：任务域事件同样不提供任何编辑入口。
    expect(within(list).queryByRole("textbox")).toBeNull();
    expect(within(list).queryByRole("checkbox")).toBeNull();
    expect(within(list).queryByRole("button", { name: /编辑|删除|修改/ }))
      .toBeNull();
  });

  it("links mission-work events to canonical task/mission targets only when references are valid", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        actorType: "owner",
        eventType: "work_item_status_changed",
        id: "event-60",
        outboxSeq: 60,
        payload: {
          fromStatus: "todo",
          missionId: "mission-1",
          title: "写规格",
          toStatus: "in_progress",
          workItemId: "work-1",
        },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "mission_created",
        id: "event-59",
        outboxSeq: 59,
        payload: { missionId: "mission-1", title: "交付审计" },
      }),
      auditEvent({
        eventType: "task_started",
        id: "event-58",
        outboxSeq: 58,
        payload: {
          message: "Task started.",
          status: "running",
          taskId: "task-1",
          title: "整理仓库",
        },
      }),
      // A malformed workItemId falls back to the valid mission reference.
      auditEvent({
        actorType: "owner",
        eventType: "work_item_created",
        id: "event-57",
        outboxSeq: 57,
        payload: { missionId: "mission-1", title: "坏行", workItemId: 42 },
      }),
      // Every reference malformed or absent renders no link at all.
      auditEvent({
        actorType: "owner",
        eventType: "mission_created",
        id: "event-56",
        outboxSeq: 56,
        payload: { missionId: "", title: "空引用" },
      }),
      auditEvent({
        eventType: "task_failed",
        id: "event-55",
        outboxSeq: 55,
        payload: { message: "Task failed.", status: "failed", title: "无引用" },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(6);
    expect(
      within(rows[0]!).getByRole("link", { name: "定位来源任务" }),
    ).toHaveAttribute("href", "/projects/project-1/tasks/work-1");
    expect(
      within(rows[1]!).getByRole("link", { name: "定位来源使命" }),
    ).toHaveAttribute("href", "/projects/project-1/missions/mission-1");
    expect(
      within(rows[2]!).getByRole("link", { name: "定位来源任务" }),
    ).toHaveAttribute("href", "/projects/project-1/task-runs/task-1");
    expect(
      within(rows[3]!).getByRole("link", { name: "定位来源使命" }),
    ).toHaveAttribute("href", "/projects/project-1/missions/mission-1");
    expect(within(rows[4]!).queryByRole("link")).toBeNull();
    expect(within(rows[5]!).queryByRole("link")).toBeNull();
  });

  it("shows the public title excerpt for mission-work events only", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        eventType: "task_created",
        id: "event-70",
        outboxSeq: 70,
        payload: {
          message: "Task queued.",
          status: "queued",
          taskId: "task-1",
          title: "整理仓库",
        },
      }),
      auditEvent({
        actorType: "agent",
        eventType: "work_item_created",
        id: "event-69",
        outboxSeq: 69,
        payload: {
          missionId: "mission-1",
          title: "[redacted]",
          workItemId: "work-1",
        },
      }),
      // No title and empty title render no excerpt element.
      auditEvent({
        actorType: "owner",
        eventType: "mission_created",
        id: "event-68",
        outboxSeq: 68,
        payload: { missionId: "mission-1" },
      }),
      auditEvent({
        actorType: "system",
        eventType: "work_item_status_changed",
        id: "event-67",
        outboxSeq: 67,
        payload: {
          fromStatus: "done",
          missionId: "mission-1",
          title: "",
          toStatus: "in_progress",
          workItemId: "work-1",
        },
      }),
      // Execution events never render a mission-work title excerpt.
      auditEvent({
        eventType: "execution_created",
        executionId: "exec-1",
        id: "event-66",
        outboxSeq: 66,
        payload: { title: "不应显示", workItemId: "work-9" },
      }),
      // 030 message excerpt behavior stays intact.
      auditEvent({
        actorType: "owner",
        eventType: "owner_message",
        id: "event-65",
        outboxSeq: 65,
        payload: { messageExcerpt: "协作摘要", threadId: "thread-1" },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(6);
    expect(within(rows[0]!).getByText("整理仓库"))
      .toHaveClass("audit-event-excerpt");
    expect(within(rows[1]!).getByText("[redacted]"))
      .toHaveClass("audit-event-excerpt");
    expect(rows[2]!.querySelector(".audit-event-excerpt")).toBeNull();
    expect(rows[3]!.querySelector(".audit-event-excerpt")).toBeNull();
    expect(rows[4]!.querySelector(".audit-event-excerpt")).toBeNull();
    expect(screen.queryByText("不应显示")).toBeNull();
    expect(within(rows[5]!).getByText("协作摘要"))
      .toHaveClass("audit-event-excerpt");
  });
});

describe("Audit panel project-workspace events", () => {
  it("renders project-workspace types with readable copy and the neutral project badge in a mixed four-domain list", async () => {
    const AuditPanel = await auditPanel();
    const projectCopy: ReadonlyArray<readonly [string, string]> = [
      ["project_created", "项目已创建"],
      ["workspace_bound", "工作区已绑定"],
      ["workspace_rebound", "工作区已改绑"],
      ["member_joined", "成员已加入"],
      ["member_removed", "成员已移除"],
      ["validation_policy_changed", "验证政策已变更"],
    ];
    const events = projectCopy.map(([eventType], index) =>
      auditEvent({
        actorType: "owner",
        eventType,
        id: `event-${100 - index}`,
        outboxSeq: 100 - index,
        payload: { projectName: `样例 ${eventType}` },
      }),
    );
    events.push(auditEvent({
      eventType: "execution_created",
      executionId: "exec-1",
      id: "event-90",
      outboxSeq: 90,
    }));
    events.push(auditEvent({
      actorType: "agent",
      eventType: "run_started",
      id: "event-89",
      outboxSeq: 89,
      payload: { runId: "run-1", threadId: "thread-1" },
    }));
    events.push(auditEvent({
      actorType: "owner",
      eventType: "work_item_created",
      id: "event-88",
      outboxSeq: 88,
      payload: { missionId: "mission-1", title: "看板样例", workItemId: "work-1" },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    for (const [, copy] of projectCopy) {
      expect(within(list).getByRole("heading", { name: copy }))
        .toBeInTheDocument();
    }
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(9);
    for (const row of rows.slice(0, 6)) {
      // The project badge reuses the bare neutral .status-label base variant
      // (review/thread-policy precedent): no status-* modifier is attached.
      const badge = within(row).getByText("项目", { selector: "span" });
      expect(badge).toHaveClass("status-label", { exact: true });
    }
    expect(within(rows[6]!).getByText("执行")).toHaveClass("status-running");
    expect(within(rows[7]!).getByText("协作")).toHaveClass("status-queued");
    expect(within(rows[8]!).getByText("任务")).toHaveClass("status-completed");
    // 只读断言：项目域事件同样不提供任何编辑入口。
    expect(within(list).queryByRole("textbox")).toBeNull();
    expect(within(list).queryByRole("checkbox")).toBeNull();
    expect(within(list).queryByRole("button", { name: /编辑|删除|修改/ }))
      .toBeNull();
  });

  it("links project-workspace events to the canonical project identity", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        actorType: "owner",
        eventType: "project_created",
        id: "event-60",
        outboxSeq: 60,
        payload: { projectName: "审计项目" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "member_joined",
        id: "event-59",
        outboxSeq: 59,
        payload: { agentDisplayName: "Alpha", agentId: "agent-alpha" },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(
        within(row).getByRole("link", { name: "定位来源项目" }),
      ).toHaveAttribute("href", "/projects/project-1");
    }
  });

  it("renders no project locate link when the project identity is malformed", async () => {
    const AuditPanel = await auditPanel();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page([
        auditEvent({
          actorType: "owner",
          eventType: "project_created",
          id: "event-50",
          outboxSeq: 50,
          payload: { projectName: "审计项目" },
        }),
      ])))),
    );
    render(<AuditPanel projectId="" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).queryByRole("link")).toBeNull();
  });

  it("shows the public project summary fields and omits malformed or foreign excerpts", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        actorType: "owner",
        eventType: "project_created",
        id: "event-70",
        outboxSeq: 70,
        payload: { projectName: "审计项目" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "workspace_rebound",
        id: "event-69",
        outboxSeq: 69,
        payload: {
          previousWorkspaceName: "alpha-workspace",
          workspaceName: "beta-workspace",
        },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "workspace_bound",
        id: "event-68",
        outboxSeq: 68,
        payload: { workspaceName: "alpha-workspace" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "member_removed",
        id: "event-67",
        outboxSeq: 67,
        payload: { agentDisplayName: "Beta", agentId: "agent-beta" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "validation_policy_changed",
        id: "event-66",
        outboxSeq: 66,
        payload: { entryCount: 3, policyHash: "a".repeat(64), revisionNo: 2 },
      }),
      // Malformed fields render no excerpt element.
      auditEvent({
        actorType: "owner",
        eventType: "validation_policy_changed",
        id: "event-65",
        outboxSeq: 65,
        payload: { entryCount: "3", revisionNo: 2 },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "project_created",
        id: "event-64",
        outboxSeq: 64,
        payload: { projectName: "" },
      }),
      // Execution events never render a project-domain summary.
      auditEvent({
        eventType: "execution_created",
        executionId: "exec-1",
        id: "event-63",
        outboxSeq: 63,
        payload: { projectName: "不应显示" },
      }),
      // 030 message excerpt behavior stays intact.
      auditEvent({
        actorType: "owner",
        eventType: "owner_message",
        id: "event-62",
        outboxSeq: 62,
        payload: { messageExcerpt: "协作摘要", threadId: "thread-1" },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(9);
    expect(within(rows[0]!).getByText("审计项目"))
      .toHaveClass("audit-event-excerpt");
    expect(within(rows[1]!).getByText("alpha-workspace → beta-workspace"))
      .toHaveClass("audit-event-excerpt");
    expect(within(rows[2]!).getByText("alpha-workspace"))
      .toHaveClass("audit-event-excerpt");
    expect(within(rows[3]!).getByText("Beta"))
      .toHaveClass("audit-event-excerpt");
    expect(within(rows[4]!).getByText("修订 #2 · 3 项"))
      .toHaveClass("audit-event-excerpt");
    expect(rows[5]!.querySelector(".audit-event-excerpt")).toBeNull();
    expect(rows[6]!.querySelector(".audit-event-excerpt")).toBeNull();
    expect(rows[7]!.querySelector(".audit-event-excerpt")).toBeNull();
    expect(screen.queryByText("不应显示")).toBeNull();
    expect(within(rows[8]!).getByText("协作摘要"))
      .toHaveClass("audit-event-excerpt");
  });
});

describe("Audit panel governance events", () => {
  it("renders governance types with readable copy and the neutral governance badge in a mixed five-domain list", async () => {
    const AuditPanel = await auditPanel();
    const governanceCopy: ReadonlyArray<readonly [string, string]> = [
      ["approval_approved", "审批已批准"],
      ["approval_consumed", "审批已消费"],
      ["approval_expired", "审批已过期"],
      ["approval_rejected", "审批已驳回"],
      ["approval_requested", "审批已请求"],
    ];
    const events = governanceCopy.map(([eventType], index) =>
      auditEvent({
        actorType: "owner",
        eventType,
        id: `event-${120 - index}`,
        outboxSeq: 120 - index,
        payload: {
          approvalId: `approval-${index}`,
          executionId: `exec-governance-${index}`,
          kind: "command",
        },
      }),
    );
    events.push(auditEvent({
      actorType: "agent",
      eventType: "approval_requested",
      executionId: "exec-safe",
      id: "event-110",
      outboxSeq: 110,
      payload: { approvalId: "approval-safe", attemptNo: 2, kind: "command" },
    }));
    events.push(auditEvent({
      actorType: "agent",
      eventType: "run_started",
      id: "event-109",
      outboxSeq: 109,
      payload: { runId: "run-1", threadId: "thread-1" },
    }));
    events.push(auditEvent({
      actorType: "owner",
      eventType: "work_item_created",
      id: "event-108",
      outboxSeq: 108,
      payload: { missionId: "mission-1", title: "看板样例", workItemId: "work-1" },
    }));
    events.push(auditEvent({
      actorType: "owner",
      eventType: "project_created",
      id: "event-107",
      outboxSeq: 107,
      payload: { projectName: "项目样例" },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(9);
    for (const [index, [, copy]] of governanceCopy.entries()) {
      expect(within(rows[index]!).getByRole("heading", { name: copy }))
        .toBeInTheDocument();
      const badge = within(rows[index]!).getByText("治理", { selector: "span" });
      expect(badge).toHaveClass("status-label", { exact: true });
    }
    expect(within(rows[5]!).getByRole("heading", { name: "审批已请求" }))
      .toBeInTheDocument();
    expect(within(rows[5]!).getByText("执行")).toHaveClass("status-running");
    expect(within(rows[6]!).getByText("协作")).toHaveClass("status-queued");
    expect(within(rows[7]!).getByText("任务")).toHaveClass("status-completed");
    expect(within(rows[8]!).getByText("项目"))
      .toHaveClass("status-label", { exact: true });
    expect(within(list).queryByRole("textbox")).toBeNull();
    expect(within(list).queryByRole("checkbox")).toBeNull();
    expect(within(list).queryByRole("button", { name: /编辑|删除|修改/ }))
      .toBeNull();
  });

  it("links governance events to canonical execution and approval identities", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        actorType: "owner",
        eventType: "approval_approved",
        executionId: "exec/one",
        id: "event-90",
        outboxSeq: 90,
        payload: { approvalId: "approval one", executionId: "exec/one" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "approval_expired",
        executionId: "exec-two",
        id: "event-89",
        outboxSeq: 89,
        payload: { executionId: "exec-two" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "approval_rejected",
        id: "event-88",
        outboxSeq: 88,
        payload: { approvalId: "approval-three" },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByRole("link", { name: "定位来源审批" }))
      .toHaveAttribute(
        "href",
        "/projects/project-1/executions/exec%2Fone/approvals/approval%20one",
      );
    expect(within(rows[1]!).getByRole("link", { name: "定位来源审批" }))
      .toHaveAttribute("href", "/projects/project-1/executions/exec-two");
    expect(within(rows[2]!).getByRole("link", { name: "定位来源审批" }))
      .toHaveAttribute("href", "/projects/project-1/approvals/approval-three");
    expect(within(list).queryByRole("button", { name: "定位来源执行" }))
      .toBeNull();
  });

  it("renders no governance locate link for malformed ids or an empty project identity", async () => {
    const AuditPanel = await auditPanel();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page([
        auditEvent({
          actorType: "owner",
          eventType: "approval_consumed",
          id: "event-80",
          outboxSeq: 80,
          payload: { approvalId: "", executionId: 42 },
        }),
        auditEvent({
          actorType: "owner",
          eventType: "approval_expired",
          id: "event-79",
          outboxSeq: 79,
          payload: {},
        }),
      ])))),
    );
    const firstRender = render(<AuditPanel projectId="project-1" />);

    let list = await screen.findByRole("list", { name: "审计事件" });
    for (const row of within(list).getAllByRole("listitem")) {
      expect(within(row).queryByRole("link")).toBeNull();
    }

    firstRender.unmount();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page([
        auditEvent({
          actorType: "owner",
          eventType: "approval_approved",
          executionId: "exec-valid",
          id: "event-78",
          outboxSeq: 78,
          payload: {
            approvalId: "approval-valid",
            executionId: "exec-valid",
          },
        }),
      ])))),
    );
    render(<AuditPanel projectId="" />);

    list = await screen.findByRole("list", { name: "审计事件" });
    expect(within(list).queryByRole("link")).toBeNull();
  });

  it("shows only validated governance summary fields and omits malformed or foreign excerpts", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        actorType: "owner",
        eventType: "approval_expired",
        id: "event-70",
        outboxSeq: 70,
        payload: {
          commandText: "不应显示的命令",
          decision: "approved",
          hostPath: "C:\\private\\workspace",
          kind: "command",
          requestHash: "不应显示的哈希",
          scope: "project",
        },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "approval_rejected",
        id: "event-69",
        outboxSeq: 69,
        payload: {
          decision: "rejected",
          kind: "staged_merge",
          scope: "single",
        },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "approval_consumed",
        id: "event-68",
        outboxSeq: 68,
        payload: { decision: "approved", kind: "proposal" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "approval_approved",
        id: "event-67",
        outboxSeq: 67,
        payload: { decision: "later" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "approval_expired",
        id: "event-66",
        outboxSeq: 66,
        payload: { scope: 1 },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "approval_requested",
        id: "event-65",
        outboxSeq: 65,
        payload: { commandText: "不应显示的正文", requestHash: "secret-hash" },
      }),
      auditEvent({
        actorType: "agent",
        eventType: "approval_requested",
        executionId: "exec-safe",
        id: "event-64",
        outboxSeq: 64,
        payload: { attemptNo: 1, kind: "command" },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(7);
    expect(within(rows[0]!).getByText("命令 · 已批准 · 项目"))
      .toHaveClass("audit-event-excerpt");
    expect(within(rows[1]!).getByText("Staged 合入 · 已驳回 · 单项"))
      .toHaveClass("audit-event-excerpt");
    for (const row of rows.slice(2)) {
      expect(row.querySelector(".audit-event-excerpt")).toBeNull();
    }
    expect(screen.queryByText("不应显示的命令")).toBeNull();
    expect(screen.queryByText("C:\\private\\workspace")).toBeNull();
    expect(screen.queryByText("不应显示的哈希")).toBeNull();
    expect(screen.queryByText("不应显示的正文")).toBeNull();
    expect(screen.queryByText("secret-hash")).toBeNull();
  });
});

describe("Audit panel runtime events", () => {
  it("renders runtime types with readable copy and a neutral badge in a mixed six-domain list", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        actorType: "owner",
        eventType: "runtime_call_succeeded",
        id: "event-130",
        outboxSeq: 130,
        payload: {
          executionId: "exec-runtime",
          model: "gpt-runtime",
          surface: "execution",
        },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "runtime_call_failed",
        executionId: "exec-bait",
        id: "event-129",
        outboxSeq: 129,
        payload: {
          errorCategory: "provider_error",
          model: "gpt-runtime",
          reviewAttemptId: "review-runtime",
          surface: "review",
        },
      }),
      auditEvent({
        eventType: "execution_created",
        executionId: "exec-1",
        id: "event-128",
        outboxSeq: 128,
      }),
      auditEvent({
        actorType: "agent",
        eventType: "run_started",
        id: "event-127",
        outboxSeq: 127,
        payload: { runId: "run-1", threadId: "thread-1" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "work_item_created",
        id: "event-126",
        outboxSeq: 126,
        payload: { missionId: "mission-1", title: "看板样例", workItemId: "work-1" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "project_created",
        id: "event-125",
        outboxSeq: 125,
        payload: { projectName: "项目样例" },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "approval_approved",
        id: "event-124",
        outboxSeq: 124,
        payload: { approvalId: "approval-1", kind: "command" },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(7);
    expect(within(rows[0]!).getByRole("heading", { name: "运行时调用已成功" }))
      .toBeInTheDocument();
    expect(within(rows[1]!).getByRole("heading", { name: "运行时调用已失败" }))
      .toBeInTheDocument();
    for (const row of rows.slice(0, 2)) {
      expect(within(row).getByText("运行时", { selector: "span" }))
        .toHaveClass("status-label", { exact: true });
      expect(within(row).queryByRole("button", { name: "定位来源执行" }))
        .toBeNull();
    }
    expect(within(rows[2]!).getByText("执行")).toHaveClass("status-running");
    expect(within(rows[3]!).getByText("协作")).toHaveClass("status-queued");
    expect(within(rows[4]!).getByText("任务")).toHaveClass("status-completed");
    expect(within(rows[5]!).getByText("项目"))
      .toHaveClass("status-label", { exact: true });
    expect(within(rows[6]!).getByText("治理"))
      .toHaveClass("status-label", { exact: true });
    expect(within(list).queryByRole("textbox")).toBeNull();
    expect(within(list).queryByRole("checkbox")).toBeNull();
    expect(within(list).queryByRole("button", { name: /编辑|删除|修改/ }))
      .toBeNull();
  });

  it("links runtime events to canonical execution, review, and collaboration identities", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        actorType: "owner",
        eventType: "runtime_call_succeeded",
        id: "event-120",
        outboxSeq: 120,
        payload: {
          executionId: "exec/one",
          model: "gpt-runtime",
          surface: "execution",
        },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "runtime_call_failed",
        id: "event-119",
        outboxSeq: 119,
        payload: {
          errorCategory: "provider_error",
          model: "gpt-runtime",
          reviewAttemptId: "review one",
          surface: "review",
        },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "runtime_call_succeeded",
        id: "event-118",
        outboxSeq: 118,
        payload: {
          model: "gpt-runtime",
          runId: "run/one",
          surface: "collaboration",
          threadId: "thread one",
        },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "runtime_call_succeeded",
        id: "event-117",
        outboxSeq: 117,
        payload: {
          model: "gpt-runtime",
          surface: "collaboration",
          threadId: "thread-two",
        },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[0]!).getByRole("link", { name: "定位来源运行时" }))
      .toHaveAttribute(
        "href",
        "/projects/project-1/executions/exec%2Fone",
      );
    expect(within(rows[1]!).getByRole("link", { name: "定位来源运行时" }))
      .toHaveAttribute(
        "href",
        "/projects/project-1/reviews/review%20one",
      );
    expect(within(rows[2]!).getByRole("link", { name: "定位来源运行时" }))
      .toHaveAttribute(
        "href",
        "/projects/project-1?thread=thread+one&run=run%2Fone",
      );
    expect(within(rows[3]!).getByRole("link", { name: "定位来源运行时" }))
      .toHaveAttribute(
        "href",
        "/projects/project-1?thread=thread-two",
      );
  });

  it("renders no runtime locate link for malformed ids or an empty project identity", async () => {
    const AuditPanel = await auditPanel();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page([
        auditEvent({
          actorType: "owner",
          eventType: "runtime_call_succeeded",
          id: "event-110",
          outboxSeq: 110,
          payload: { executionId: "", model: "gpt-runtime", surface: "execution" },
        }),
        auditEvent({
          actorType: "owner",
          eventType: "runtime_call_failed",
          id: "event-109",
          outboxSeq: 109,
          payload: {
            errorCategory: "provider_error",
            model: "gpt-runtime",
            reviewAttemptId: 42,
            surface: "review",
          },
        }),
        auditEvent({
          actorType: "owner",
          eventType: "runtime_call_succeeded",
          id: "event-108",
          outboxSeq: 108,
          payload: {
            model: "gpt-runtime",
            runId: "run-1",
            surface: "collaboration",
            threadId: null,
          },
        }),
        auditEvent({
          actorType: "owner",
          eventType: "runtime_call_succeeded",
          id: "event-107",
          outboxSeq: 107,
          payload: {
            executionId: "exec-ignored",
            model: "gpt-runtime",
            surface: "unknown",
          },
        }),
      ])))),
    );
    const firstRender = render(<AuditPanel projectId="project-1" />);

    let list = await screen.findByRole("list", { name: "审计事件" });
    for (const row of within(list).getAllByRole("listitem")) {
      expect(within(row).queryByRole("link")).toBeNull();
    }

    firstRender.unmount();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page([
        auditEvent({
          actorType: "owner",
          eventType: "runtime_call_succeeded",
          id: "event-106",
          outboxSeq: 106,
          payload: {
            executionId: "exec-valid",
            model: "gpt-runtime",
            surface: "execution",
          },
        }),
      ])))),
    );
    render(<AuditPanel projectId="" />);

    list = await screen.findByRole("list", { name: "审计事件" });
    expect(within(list).queryByRole("link")).toBeNull();
  });

  it("shows only public runtime excerpts and omits malformed or foreign fields", async () => {
    const AuditPanel = await auditPanel();
    const events = [
      auditEvent({
        actorType: "owner",
        eventType: "runtime_call_succeeded",
        id: "event-100",
        outboxSeq: 100,
        payload: {
          apiKey: "secret-key",
          errorCategory: "foreign_category",
          model: "gpt-runtime",
          surface: "execution",
        },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "runtime_call_failed",
        id: "event-99",
        outboxSeq: 99,
        payload: {
          baseUrl: "https://private.example",
          errorCategory: "provider_error",
          model: "gpt-runtime",
          surface: "review",
        },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "runtime_call_failed",
        id: "event-98",
        outboxSeq: 98,
        payload: {
          errorCategory: "provider_error",
          model: "",
          surface: "collaboration",
        },
      }),
      auditEvent({
        actorType: "owner",
        eventType: "runtime_call_succeeded",
        id: "event-97",
        outboxSeq: 97,
        payload: { model: 42, surface: "execution" },
      }),
      auditEvent({
        eventType: "execution_created",
        executionId: "exec-1",
        id: "event-96",
        outboxSeq: 96,
        payload: {
          errorCategory: "不应显示的类别",
          model: "不应显示的模型",
        },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(page(events)))),
    );
    render(<AuditPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "审计事件" });
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[0]!).getByText("gpt-runtime"))
      .toHaveClass("audit-event-excerpt");
    expect(within(rows[1]!).getByText("gpt-runtime · provider_error"))
      .toHaveClass("audit-event-excerpt");
    for (const row of rows.slice(2)) {
      expect(row.querySelector(".audit-event-excerpt")).toBeNull();
    }
    expect(screen.queryByText("secret-key")).toBeNull();
    expect(screen.queryByText("https://private.example")).toBeNull();
    expect(screen.queryByText("foreign_category")).toBeNull();
    expect(screen.queryByText("不应显示的模型")).toBeNull();
    expect(screen.queryByText("不应显示的类别")).toBeNull();
  });
});

describe("Audit panel timeline view", () => {
  it("switches to 时间轴, fetches the timeline, and renders chronological items", async () => {
    const AuditPanel = await auditPanel();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("/timeline")) {
          return Promise.resolve(Response.json(timelinePage([
            timelineItem({
              eventType: "attempt_started",
              executionId: "exec-1",
              id: "timeline-1",
              occurredAt: "2026-08-15T01:00:00.000Z",
              outboxSeq: 2,
            }),
            timelineItem({
              eventType: "execution_created",
              executionId: "exec-1",
              id: "timeline-2",
              occurredAt: "2026-08-15T02:00:00.000Z",
              outboxSeq: 1,
            }),
          ])));
        }
        return Promise.resolve(Response.json(page([
          auditEvent({
            eventType: "execution_created",
            executionId: "exec-1",
            id: "event-9",
            outboxSeq: 9,
          }),
        ])));
      }),
    );
    const user = userEvent.setup();
    render(<AuditPanel projectId="project-1" />);

    const auditList = await screen.findByRole("list", { name: "审计事件" });
    expect(within(auditList).getByRole("heading", { name: "执行已创建" }))
      .toBeInTheDocument();
    expect(requests).toEqual(["/api/projects/project-1/audit-events"]);

    const timelineToggle = screen.getByRole("button", { name: "时间轴" });
    expect(timelineToggle).toHaveClass("audit-view-toggle");
    expect(timelineToggle).toHaveAttribute("aria-pressed", "false");
    await user.click(timelineToggle);

    expect(timelineToggle).toHaveAttribute("aria-pressed", "true");
    const timelineList = await screen.findByRole("list", { name: "运行轨迹" });
    const rows = within(timelineList).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("heading", { name: "尝试已开始" }))
      .toBeInTheDocument();
    expect(within(rows[0]!).getByText("2026-08-15T01:00:00.000Z").tagName)
      .toBe("TIME");
    expect(within(rows[1]!).getByRole("heading", { name: "执行已创建" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "审计事件" })).toBeNull();
    expect(screen.queryByRole("group", { name: "按域筛选审计事件" })).toBeNull();
    expect(requests).toEqual([
      "/api/projects/project-1/audit-events",
      "/api/projects/project-1/timeline",
    ]);
  });

  it("shows 来源缺失 when sourceMissing and reuses locate links otherwise", async () => {
    const AuditPanel = await auditPanel();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/timeline")) {
          return Promise.resolve(Response.json(timelinePage([
            timelineItem({
              eventType: "project_created",
              id: "missing",
              outboxSeq: 1,
              payload: { projectName: "审计项目" },
              sourceMissing: true,
            }),
            timelineItem({
              actorType: "owner",
              eventType: "owner_message",
              id: "located",
              outboxSeq: 2,
              payload: { threadId: "thread-1" },
              sourceMissing: false,
            }),
          ])));
        }
        return Promise.resolve(Response.json(page([
          auditEvent({
            eventType: "execution_created",
            executionId: "exec-1",
            id: "event-1",
            outboxSeq: 1,
          }),
        ])));
      }),
    );
    const user = userEvent.setup();
    render(<AuditPanel projectId="project-1" />);
    await screen.findByRole("list", { name: "审计事件" });
    await user.click(screen.getByRole("button", { name: "时间轴" }));

    const list = await screen.findByRole("list", { name: "运行轨迹" });
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[0]!).getByText("来源缺失")).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("link")).toBeNull();
    expect(within(rows[1]!).getByRole("link", { name: "定位来源线程" }))
      .toHaveAttribute("href", "/projects/project-1?thread=thread-1");
    expect(within(rows[1]!).queryByText("来源缺失")).toBeNull();
  });

  it("shows timeline loading, empty, and retryable error states", async () => {
    const AuditPanel = await auditPanel();
    const firstTimeline = deferred<Response>();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (!url.includes("/timeline")) {
          return Promise.resolve(Response.json(page([
            auditEvent({
              eventType: "execution_created",
              executionId: "exec-1",
              id: "event-1",
              outboxSeq: 1,
            }),
          ])));
        }
        if (requests.filter((entry) => entry.includes("/timeline")).length === 1) {
          return firstTimeline.promise;
        }
        if (requests.filter((entry) => entry.includes("/timeline")).length === 2) {
          return Promise.resolve(Response.json(
            { error: { code: "INTERNAL_ERROR", message: "boom" } },
            { status: 500 },
          ));
        }
        return Promise.resolve(Response.json(timelinePage([])));
      }),
    );
    const user = userEvent.setup();
    render(<AuditPanel projectId="project-1" />);
    await screen.findByRole("list", { name: "审计事件" });
    await user.click(screen.getByRole("button", { name: "时间轴" }));

    expect(screen.getByText("正在加载时间轴…")).toHaveAttribute(
      "aria-busy",
      "true",
    );

    await act(async () => {
      firstTimeline.resolve(Response.json(
        {
          error: {
            code: "PROJECTION_REBUILD_IN_PROGRESS",
            message: "rebuild claimed",
          },
        },
        { status: 409 },
      ));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "审计投影正在重建，请稍后重试。",
    );

    await user.click(screen.getByRole("button", { name: "重试加载时间轴" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "服务暂时出现问题，请稍后重试。",
    );

    await user.click(screen.getByRole("button", { name: "重试加载时间轴" }));
    expect(await screen.findByText("尚无运行轨迹。")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "运行轨迹" })).toBeNull();
  });
});

