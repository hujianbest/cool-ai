// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import type {
  AuditEventListItemDto,
  AuditProjectionFreshness,
  ProjectAuditEventsPageDto,
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

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Audit panel", () => {
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
