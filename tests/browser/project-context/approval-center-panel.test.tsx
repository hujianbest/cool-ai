// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import type { ApprovalCenterItemDto } from "@/src/shared/approval-center-contracts";

type ApprovalCenterModule = {
  ApprovalCenterPanel: ComponentType<{ projectId: string }>;
};

const modules = import.meta.glob<ApprovalCenterModule>(
  "../../../components/project-context/approval-center-panel.tsx",
);

async function approvalCenterPanel() {
  const load = modules["../../../components/project-context/approval-center-panel.tsx"];
  expect(load, "the approval center panel must exist").toBeTypeOf("function");
  return (await load()).ApprovalCenterPanel;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function item(overrides: Partial<ApprovalCenterItemDto>): ApprovalCenterItemDto {
  return {
    approvalId: "approval-1",
    createdAt: "2026-08-10T04:00:00.005Z",
    decisionHint: null,
    domain: "execution",
    impactSummary: "Run the build",
    kind: "command",
    sourceRef: { executionId: "exec-1", messageId: null, runId: null, threadId: null },
    status: "pending",
    title: "node -v",
    ...overrides,
  };
}

function inlineItem(overrides: Partial<ApprovalCenterItemDto> = {}): ApprovalCenterItemDto {
  return item({
    approvalId: "block-1",
    createdAt: "2026-08-10T04:00:00.004Z",
    domain: "inline_decision",
    impactSummary: "Ship it.",
    kind: "proposal",
    sourceRef: {
      executionId: null,
      messageId: "message-1",
      runId: "run-1",
      threadId: "thread-1",
    },
    title: "Adopt plan",
    ...overrides,
  });
}

function page(items: ApprovalCenterItemDto[]) {
  return Response.json({ approvals: items });
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Approval center panel", () => {
  it("shows loading, a sanitized load error with retry, and the empty state", async () => {
    const ApprovalCenterPanel = await approvalCenterPanel();
    const first = deferred<Response>();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        requests.push(String(input));
        if (requests.length === 1) return first.promise;
        return Promise.resolve(page([]));
      }),
    );
    render(<ApprovalCenterPanel projectId="project-1" />);

    expect(screen.getByText("正在加载待裁决请求…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(requests).toEqual(["/api/projects/project-1/approvals/pending"]);

    await act(async () => {
      first.resolve(Response.json(
        { error: { code: "INTERNAL_ERROR", message: "raw boom detail" } },
        { status: 500 },
      ));
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("服务暂时出现问题，请稍后重试。");
    expect(alert).not.toHaveTextContent("raw boom detail");

    await userEvent.setup().click(
      screen.getByRole("button", { name: "重试加载待裁决请求" }),
    );
    expect(await screen.findByText("没有待裁决的请求。")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders both domains in order with badges, summaries, lapsed state and no edit entry", async () => {
    const ApprovalCenterPanel = await approvalCenterPanel();
    const items = [
      item({}),
      inlineItem({}),
      item({
        approvalId: "approval-merge",
        createdAt: "2026-08-10T04:00:00.003Z",
        decisionHint: "expired",
        impactSummary: null,
        kind: "staged_merge",
        sourceRef: {
          executionId: "exec-merge",
          messageId: null,
          runId: null,
          threadId: null,
        },
        status: "expired",
        title: null,
      }),
    ];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(page(items))));
    render(<ApprovalCenterPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "待裁决请求" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    const [commandRow, proposalRow, lapsedRow] = rows;
    const commandBadge = within(commandRow!).getByText("执行");
    expect(commandBadge).toHaveClass("status-label");
    expect(commandBadge).toHaveClass("status-running");
    expect(within(commandRow!).getByRole("heading", { name: "node -v" }))
      .toBeInTheDocument();
    expect(within(commandRow!).getByText("Run the build")).toBeInTheDocument();
    expect(within(commandRow!).getByText("命令")).toBeInTheDocument();
    expect(
      within(commandRow!).getByText("2026-08-10T04:00:00.005Z").tagName,
    ).toBe("TIME");
    expect(within(commandRow!).getByText("待裁决")).toBeInTheDocument();

    const proposalBadge = within(proposalRow!).getByText("内联决策");
    expect(proposalBadge).toHaveClass("status-label");
    expect(proposalBadge).toHaveClass("status-queued");
    expect(within(proposalRow!).getByRole("heading", { name: "Adopt plan" }))
      .toBeInTheDocument();
    expect(within(proposalRow!).getByText("Ship it.")).toBeInTheDocument();

    expect(within(lapsedRow!).getByRole("heading", { name: "Staged 合入" }))
      .toBeInTheDocument();
    const lapsedBadge = within(lapsedRow!).getByText("已过期");
    expect(lapsedBadge).toHaveClass("status-label");
    expect(lapsedBadge).toHaveClass("status-failed");
    expect(within(lapsedRow!).getByText(/无法裁决：请求已过期。/))
      .toBeInTheDocument();
    expect(within(lapsedRow!).queryByRole("button", { name: /^批准/ })).toBeNull();
    expect(within(lapsedRow!).queryByRole("button", { name: /^拒绝/ })).toBeNull();

    expect(within(commandRow!).getByRole("button", { name: "批准 node -v" }))
      .toBeEnabled();
    expect(within(commandRow!).getByRole("button", { name: "拒绝 node -v" }))
      .toBeEnabled();
    expect(
      within(proposalRow!).getByRole("button", { name: "批准 Adopt plan" }),
    ).toBeEnabled();

    // 除裁决与定位/刷新外无任何编辑入口。
    expect(within(list).queryByRole("textbox")).toBeNull();
    expect(within(list).queryByRole("checkbox")).toBeNull();
    expect(within(list).queryByRole("button", { name: /编辑|删除|修改/ }))
      .toBeNull();
  });

  it("dispatches an execution approval decision through the existing route and refreshes", async () => {
    const ApprovalCenterPanel = await approvalCenterPanel();
    const post = deferred<Response>();
    const calls: Array<{ body?: unknown; method: string; url: string }> = [];
    let listCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          method,
          url,
        });
        if (method === "GET" && url === "/api/projects/project-1/approvals/pending") {
          listCalls += 1;
          return Promise.resolve(page(listCalls === 1 ? [item({})] : []));
        }
        if (method === "GET" && url === "/api/executions/exec-1") {
          return Promise.resolve(Response.json({ execution: { version: 7 } }));
        }
        if (method === "POST" && url === "/api/executions/exec-1/approvals/approval-1") {
          return post.promise;
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-0000000000d1",
    );
    const user = userEvent.setup();
    render(<ApprovalCenterPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "待裁决请求" });
    await user.click(
      within(list).getByRole("button", { name: "批准 node -v" }),
    );

    expect(
      await screen.findByRole("button", { name: "批准 node -v" }),
    ).toBeDisabled();
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[1]).toEqual({ method: "GET", url: "/api/executions/exec-1" });
    expect(calls[2]).toEqual({
      body: {
        action: "approve",
        expectedVersion: 7,
        operationId: "00000000-0000-4000-8000-0000000000d1",
      },
      method: "POST",
      url: "/api/executions/exec-1/approvals/approval-1",
    });

    await act(async () => {
      post.resolve(Response.json({ approval: {}, execution: {} }));
    });
    expect(await screen.findByText("没有待裁决的请求。")).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已批准，列表已刷新。",
    );
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual({
      method: "GET",
      url: "/api/projects/project-1/approvals/pending",
    });
  });

  it("dispatches an inline proposal rejection through the structured message decision route", async () => {
    const ApprovalCenterPanel = await approvalCenterPanel();
    const calls: Array<{ body?: unknown; method: string; url: string }> = [];
    let listCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          method,
          url,
        });
        if (method === "GET" && url === "/api/projects/project-1/approvals/pending") {
          listCalls += 1;
          return Promise.resolve(page(listCalls === 1 ? [inlineItem({})] : []));
        }
        if (
          method === "GET"
          && url === "/api/projects/project-1/threads/thread-1/runs/run-1/messages/message-1/blocks/block-1"
        ) {
          return Promise.resolve(Response.json({ block: { stateVersion: 3 } }));
        }
        if (method === "POST" && url.endsWith("/decision")) {
          return Promise.resolve(Response.json({ kind: "completed" }));
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-0000000000d2",
    );
    const user = userEvent.setup();
    render(<ApprovalCenterPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "待裁决请求" });
    await user.click(
      within(list).getByRole("button", { name: "拒绝 Adopt plan" }),
    );

    expect(await screen.findByText("没有待裁决的请求。")).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已拒绝，列表已刷新。",
    );
    expect(calls).toHaveLength(4);
    expect(calls[1]).toEqual({
      method: "GET",
      url: "/api/projects/project-1/threads/thread-1/runs/run-1/messages/message-1/blocks/block-1",
    });
    expect(calls[2]).toEqual({
      body: {
        action: "reject",
        expectedStateVersion: 3,
        operationId: "00000000-0000-4000-8000-0000000000d2",
      },
      method: "POST",
      url: "/api/projects/project-1/threads/thread-1/runs/run-1/messages/message-1/blocks/block-1/decision",
    });
    expect(calls[3]).toEqual({
      method: "GET",
      url: "/api/projects/project-1/approvals/pending",
    });
  });

  it("shows a sanitized inline error and re-enables the buttons when the decision fails", async () => {
    const ApprovalCenterPanel = await approvalCenterPanel();
    let listCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "GET" && url === "/api/projects/project-1/approvals/pending") {
          listCalls += 1;
          return Promise.resolve(page([item({})]));
        }
        if (method === "GET" && url === "/api/executions/exec-1") {
          return Promise.resolve(Response.json({ execution: { version: 7 } }));
        }
        if (method === "POST") {
          return Promise.resolve(Response.json(
            {
              error: {
                code: "APPROVAL_STATE_CONFLICT",
                message: "raw conflict detail with internals",
              },
            },
            { status: 409 },
          ));
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(<ApprovalCenterPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "待裁决请求" });
    await user.click(
      within(list).getByRole("button", { name: "批准 node -v" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("裁决未完成，请刷新后重试。");
    expect(alert).not.toHaveTextContent("raw conflict detail");
    expect(
      within(list).getByRole("button", { name: "批准 node -v" }),
    ).toBeEnabled();
    expect(
      within(list).getByRole("button", { name: "拒绝 node -v" }),
    ).toBeEnabled();
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(listCalls).toBe(1);
  });

  it("locates the source execution and links inline decisions to the canonical thread target", async () => {
    const ApprovalCenterPanel = await approvalCenterPanel();
    const target = document.createElement("h3");
    target.id = "execution-exec-1-title";
    target.tabIndex = -1;
    document.body.appendChild(target);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(page([
          item({}),
          inlineItem({}),
          inlineItem({
            approvalId: "block-orphan",
            createdAt: "2026-08-10T04:00:00.002Z",
            sourceRef: {
              executionId: null,
              messageId: "message-orphan",
              runId: null,
              threadId: "thread-orphan",
            },
            title: "Orphan plan",
          }),
        ])),
      ),
    );
    const user = userEvent.setup();
    render(<ApprovalCenterPanel projectId="project-1" />);

    const list = await screen.findByRole("list", { name: "待裁决请求" });
    const rows = within(list).getAllByRole("listitem");
    await user.click(
      within(rows[0]!).getByRole("button", { name: "定位来源执行" }),
    );
    expect(target).toHaveFocus();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已定位到来源执行。",
    );

    const threadLink = within(rows[1]!).getByRole("link", {
      name: "查看来源消息",
    });
    expect(threadLink).toHaveAttribute(
      "href",
      "/projects/project-1?thread=thread-1&run=run-1",
    );
    const orphanLink = within(rows[2]!).getByRole("link", {
      name: "查看来源消息",
    });
    expect(orphanLink).toHaveAttribute(
      "href",
      "/projects/project-1?thread=thread-orphan",
    );
    expect(
      within(rows[1]!).queryByRole("button", { name: "定位来源执行" }),
    ).toBeNull();
  });

  it("refreshes the list manually through the refresh button", async () => {
    const ApprovalCenterPanel = await approvalCenterPanel();
    let listCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        listCalls += 1;
        return Promise.resolve(page(listCalls === 1 ? [item({})] : []));
      }),
    );
    const user = userEvent.setup();
    render(<ApprovalCenterPanel projectId="project-1" />);

    await screen.findByRole("list", { name: "待裁决请求" });
    await user.click(screen.getByRole("button", { name: "刷新列表" }));
    expect(await screen.findByText("没有待裁决的请求。")).toBeInTheDocument();
    expect(listCalls).toBe(2);
  });

  it("discards stale responses after the project target switches", async () => {
    const ApprovalCenterPanel = await approvalCenterPanel();
    const first = deferred<Response>();
    const signals: AbortSignal[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        if (init?.signal) signals.push(init.signal);
        if (calls === 1) return first.promise;
        return Promise.resolve(page([]));
      }),
    );
    const { rerender } = render(<ApprovalCenterPanel projectId="project-1" />);
    expect(screen.getByText("正在加载待裁决请求…")).toBeInTheDocument();

    rerender(<ApprovalCenterPanel projectId="project-2" />);
    await waitFor(() => expect(calls).toBe(2));
    expect(signals[0]?.aborted).toBe(true);

    await act(async () => {
      first.resolve(page([item({})]));
    });
    expect(await screen.findByText("没有待裁决的请求。")).toBeInTheDocument();
    expect(screen.queryByText("node -v")).toBeNull();
  });
});

describe("approval center chrome", () => {
  it("elevates approval cards with overlay shadows", () => {
    const css = readFileSync("app/cockpit.css", "utf8");
    expect(css).toMatch(
      /\.approval-center-list \.task-summary\s*\{[^}]*background:\s*var\(--color-card-strong\)[^}]*border-radius:\s*var\(--rounded-lg\)[^}]*box-shadow:\s*var\(--shadow-1\),\s*var\(--shadow-2\)/s,
    );
  });
});
