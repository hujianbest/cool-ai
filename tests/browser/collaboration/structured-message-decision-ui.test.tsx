// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StructuredMessageBlock } from "@/components/collaboration/structured-message-block";
import type { TranscriptKnownBlock } from "@/src/shared/transcript-model";

const source = {
  entityVersion: null,
  id: "message-1",
  kind: "message",
  messageId: "message-1",
  projectId: "project-1",
  runId: "run-1",
  threadId: "thread-1",
};

function proposal(stateVersion = 1): TranscriptKnownBlock {
  return {
    actorLabel: "Alpha",
    blockRevision: 1,
    blockSchemaVersion: 1,
    body: "Choose safely.",
    executable: true,
    id: "proposal-1",
    kind: "proposal",
    payload: {
      actions: ["accept", "reject"],
      blockRevision: 1,
      blockSchemaVersion: 1,
      blockType: "proposal",
      body: "Choose safely.",
      logicalBlockId: "proposal-logical",
      title: "Proposal",
    },
    position: 0,
    source,
    sourceLabel: "message · message-1",
    state: { stateVersion, status: "pending" },
    stateVersion,
    title: "Proposal",
  };
}

function checklist(): TranscriptKnownBlock {
  return {
    actorLabel: "Alpha",
    blockRevision: 1,
    blockSchemaVersion: 1,
    executable: true,
    id: "checklist-1",
    items: [{ checked: false, id: "item-1", text: "Verify source" }],
    kind: "checklist",
    payload: {
      actions: ["check_item", "uncheck_item"],
      blockRevision: 1,
      blockSchemaVersion: 1,
      blockType: "checklist",
      items: [{ id: "item-1", text: "Verify source" }],
      logicalBlockId: "checklist-logical",
      title: "Checklist",
    },
    position: 0,
    source,
    sourceLabel: "message · message-1",
    state: {
      items: [{ checked: false, id: "item-1" }],
      stateVersion: 1,
    },
    stateVersion: 1,
    title: "Checklist",
  };
}

function checklistWith(
  items: Array<{ checked: boolean; id: string; text: string }>,
  stateVersion = 1,
): TranscriptKnownBlock {
  return {
    actorLabel: "Alpha",
    blockRevision: 1,
    blockSchemaVersion: 1,
    executable: true,
    id: "checklist-1",
    items,
    kind: "checklist",
    payload: {
      actions: ["check_item", "uncheck_item"],
      blockRevision: 1,
      blockSchemaVersion: 1,
      blockType: "checklist",
      items: items.map(({ id, text }) => ({ id, text })),
      logicalBlockId: "checklist-logical",
      title: "Checklist",
    },
    position: 0,
    source,
    sourceLabel: "message · message-1",
    state: {
      items: items.map(({ checked, id }) => ({ checked, id })),
      stateVersion,
    },
    stateVersion,
    title: "Checklist",
  };
}

function latestChecklistResponse(
  items: Array<{ checked: boolean; id: string; text: string }>,
  stateVersion: number,
) {
  return Response.json({
    block: {
      actor: { displayName: "Alpha", id: "agent-a", type: "agent" },
      blockRevision: 1,
      blockSchemaVersion: 1,
      blockType: "checklist",
      kind: "known",
      payload: checklistWith(items, stateVersion).payload,
      source: { id: "message-1", kind: "message", version: null },
      state: {
        items: items.map(({ checked, id }) => ({ checked, id })),
        stateVersion,
      },
      stateVersion,
    },
  });
}

function completed(operationId: string, action = "accept", fromStateVersion = 1) {
  return {
    kind: "completed",
    receipt: {
      action,
      blockId: action === "accept" ? "proposal-1" : "checklist-1",
      blockRevision: 1,
      decisionId: "decision-1",
      fromStateVersion,
      operationId,
      receiptId: "receipt-1",
      receiptSchemaVersion: 1,
      requestHash: "a".repeat(64),
      toStateVersion: fromStateVersion + 1,
      ...(action === "check_item" ? { itemId: "item-1" } : {}),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Proposal and Checklist fact-only UI public surface", () => {
  it("names Proposal and Checklist regions with their formal localized type and existing title", () => {
    vi.stubGlobal("fetch", vi.fn());
    const titledProposal: TranscriptKnownBlock = {
      ...proposal(),
      payload: { ...proposal().payload, title: "Launch plan" },
      title: "Launch plan",
    };
    const view = render(
      <StructuredMessageBlock block={titledProposal} targetKey="project-1|thread-1|run-1" />,
    );
    expect(screen.getByRole("region", { name: "Proposal：Launch plan" })).toBeVisible();

    view.rerender(
      <StructuredMessageBlock
        block={{
          ...checklistWith([{ checked: false, id: "item-1", text: "Verify source" }]),
          title: "Release checklist",
        }}
        targetKey="project-1|thread-1|run-1"
      />,
    );
    expect(screen.getByRole("region", { name: "Checklist：Release checklist" }))
      .toBeVisible();
  });

  it("renders a Proposal as a UCD block card with approve and reject actions", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<StructuredMessageBlock block={proposal()} targetKey="project-1|thread-1|run-1" />);
    const region = screen.getByRole("region", { name: "Proposal" });
    expect(region.querySelector(".block-card-tag")).toHaveTextContent("PROPOSAL");
    expect(region.querySelector(".block-provenance")).toHaveClass("sr-only");
    expect(region.querySelector(".source-tag")).toHaveTextContent(
      "冻结来源: message · message-1",
    );
    expect(screen.getByRole("button", { name: "接受 Proposal" })).toHaveTextContent(
      "批准方案",
    );
    expect(screen.getByRole("button", { name: "拒绝 Proposal" })).toHaveTextContent("驳回");
  });

  it("decides a focused Proposal with A to accept and R to reject", async () => {
    const acceptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(acceptId);
    const acceptFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(Response.json(completed(acceptId))),
    );
    vi.stubGlobal("fetch", acceptFetch);
    const user = userEvent.setup();
    const first = render(
      <StructuredMessageBlock block={proposal()} targetKey="project-1|thread-1|run-1" />,
    );
    screen.getByRole("region", { name: "Proposal" }).focus();
    await user.keyboard("a");
    expect(JSON.parse(String(acceptFetch.mock.calls[0]?.[1]?.body ?? ""))).toMatchObject({
      action: "accept",
    });
    first.unmount();

    const rejectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(rejectId);
    const rejectFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(Response.json(completed(rejectId, "reject"))),
    );
    vi.stubGlobal("fetch", rejectFetch);
    render(
      <StructuredMessageBlock block={proposal()} targetKey="project-1|thread-1|run-1" />,
    );
    screen.getByRole("region", { name: "Proposal" }).focus();
    await user.keyboard("r");
    expect(JSON.parse(String(rejectFetch.mock.calls[0]?.[1]?.body ?? ""))).toMatchObject({
      action: "reject",
    });
  });

  it("shows success and moves focus only after a strict completed Receipt", async () => {
    const operationId = "11111111-1111-4111-8111-111111111111";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(Response.json(completed(operationId)))
    ));
    const user = userEvent.setup();
    render(<StructuredMessageBlock block={proposal()} targetKey="project-1|thread-1|run-1" />);

    await user.click(screen.getByRole("button", { name: "接受 Proposal" }));

    const success = await screen.findByRole("status", { name: "Proposal 决定结果" });
    expect(success).toHaveTextContent("Receipt receipt-1");
    expect(success).toHaveTextContent("状态版本 1 → 2");
    expect(success).toHaveFocus();
    expect(screen.getByRole("button", { name: "接受 Proposal" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝 Proposal" })).toBeDisabled();
  });

  it("reconciles an unknown write with GET only and never automatically re-POSTs", async () => {
    const operationId = "22222222-2222-4222-8222-222222222222";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      if (init?.method === "POST") return Promise.reject(new TypeError("network"));
      return Promise.resolve(Response.json(completed(operationId)));
    }));
    const user = userEvent.setup();
    render(<StructuredMessageBlock block={proposal()} targetKey="project-1|thread-1|run-1" />);

    await user.click(screen.getByRole("button", { name: "接受 Proposal" }));

    expect(await screen.findByText(/Receipt receipt-1/)).toBeVisible();
    expect(calls.map(({ method }) => method)).toEqual(["POST", "GET"]);
    expect(calls[1]?.url).toContain(`/operations/${operationId}`);
  });

  it("shows the complete latest Proposal after VERSION_CONFLICT and requires an explicit new operation", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("33333333-3333-4333-8333-333333333333")
      .mockReturnValueOnce("44444444-4444-4444-8444-444444444444");
    const bodies: unknown[] = [];
    const calls: Array<{ method: string; url: string }> = [];
    let resolveHead!: (response: Response) => void;
    const headPending = new Promise<Response>((resolve) => {
      resolveHead = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url });
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        if (bodies.length === 1) {
          return Promise.resolve(Response.json({
            currentStateVersion: 2,
            error: { code: "VERSION_CONFLICT", message: "changed" },
            kind: "version_conflict",
          }, { status: 409 }));
        }
        return Promise.resolve(Response.json(completed(
          "44444444-4444-4444-8444-444444444444",
          "accept",
          2,
        )));
      }
      if (url.endsWith("/blocks/proposal-1")) {
        return headPending;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<StructuredMessageBlock block={proposal()} targetKey="project-1|thread-1|run-1" />);

    await user.click(screen.getByRole("button", { name: "接受 Proposal" }));

    const explanation = await screen.findByRole("alert");
    expect(explanation).toHaveTextContent("服务端状态已变化");
    expect(explanation).toHaveTextContent("正在读取最新状态");
    expect(explanation).toHaveFocus();
    expect(screen.getByRole("button", { name: "接受 Proposal" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝 Proposal" })).toBeDisabled();
    expect(calls.map(({ method }) => method)).toEqual(["POST", "GET"]);

    resolveHead(Response.json({
      block: {
        actor: { displayName: "Alpha", id: "agent-a", type: "agent" },
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        kind: "known",
        payload: { ...proposal(2).payload, body: "Choose safely — updated facts." },
        source: { id: "message-1", kind: "message", version: null },
        state: { stateVersion: 2, status: "pending" },
        stateVersion: 2,
      },
    }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "接受 Proposal" })).toBeEnabled()
    );
    expect(explanation).toHaveTextContent("状态版本 2");
    expect(screen.getByText("Choose safely — updated facts.")).toBeVisible();
    expect(screen.queryByText("Choose safely.")).toBeNull();
    expect(screen.getByText(/state 2/)).toBeVisible();
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "接受 Proposal" }));
    expect(await screen.findByText(/Receipt receipt-1/)).toBeVisible();
    expect(screen.getByRole("button", { name: "接受 Proposal" })).toBeDisabled();
    expect(bodies).toEqual([
      expect.objectContaining({ expectedStateVersion: 1 }),
      expect.objectContaining({
        expectedStateVersion: 2,
        operationId: "44444444-4444-4444-8444-444444444444",
      }),
    ]);
  });

  it("keeps old actions disabled and offers a read-only refresh when the latest read fails", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "55555555-5555-4555-8555-555555555555",
    );
    const calls: Array<{ method: string; url: string }> = [];
    let headReads = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url });
      if (init?.method === "POST") {
        return Promise.resolve(Response.json({
          currentStateVersion: 2,
          error: { code: "VERSION_CONFLICT", message: "changed" },
          kind: "version_conflict",
        }, { status: 409 }));
      }
      if (url.endsWith("/blocks/proposal-1")) {
        headReads += 1;
        if (headReads === 1) {
          return Promise.resolve(Response.json({
            error: { code: "STORAGE_UNAVAILABLE", message: "private" },
          }, { status: 503 }));
        }
        return Promise.resolve(Response.json({
          block: {
            actor: { displayName: "Alpha", id: "agent-a", type: "agent" },
            blockRevision: 1,
            blockSchemaVersion: 1,
            blockType: "proposal",
            kind: "known",
            payload: { ...proposal(2).payload, body: "Choose safely — updated facts." },
            source: { id: "message-1", kind: "message", version: null },
            state: { stateVersion: 2, status: "pending" },
            stateVersion: 2,
          },
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<StructuredMessageBlock block={proposal()} targetKey="project-1|thread-1|run-1" />);

    await user.click(screen.getByRole("button", { name: "接受 Proposal" }));

    const explanation = await screen.findByRole("alert");
    await waitFor(() =>
      expect(explanation).toHaveTextContent("无法读取服务端最新状态")
    );
    expect(explanation).toHaveFocus();
    expect(screen.getByRole("button", { name: "接受 Proposal" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝 Proposal" })).toBeDisabled();
    expect(screen.queryByText("Choose safely.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "重新读取最新状态" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "接受 Proposal" })).toBeEnabled()
    );
    expect(screen.getByText("Choose safely — updated facts.")).toBeVisible();
    expect(headReads).toBe(2);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  it("abandons an in-flight reconciliation read when the target changes", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "66666666-6666-4666-8666-666666666666",
    );
    let resolveHead!: (response: Response) => void;
    const headSignals: AbortSignal[] = [];
    const headPending = new Promise<Response>((resolve) => {
      resolveHead = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        return Promise.resolve(Response.json({
          currentStateVersion: 2,
          error: { code: "VERSION_CONFLICT", message: "changed" },
          kind: "version_conflict",
        }, { status: 409 }));
      }
      if (url.endsWith("/blocks/proposal-1")) {
        if (init?.signal) headSignals.push(init.signal);
        return headPending;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    const view = render(
      <StructuredMessageBlock block={proposal()} targetKey="project-1|thread-1|run-1" />,
    );

    await user.click(screen.getByRole("button", { name: "接受 Proposal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("正在读取最新状态");

    view.rerender(
      <StructuredMessageBlock
        block={{ ...proposal(), id: "proposal-2", title: "Proposal" }}
        targetKey="project-1|thread-2|run-2"
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "接受 Proposal" })).toBeEnabled();
    expect(headSignals[0]?.aborted).toBe(true);

    resolveHead(Response.json({
      block: {
        actor: { displayName: "Alpha", id: "agent-a", type: "agent" },
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        kind: "known",
        payload: { ...proposal(2).payload, body: "Choose safely — updated facts." },
        source: { id: "message-1", kind: "message", version: null },
        state: { stateVersion: 2, status: "pending" },
        stateVersion: 2,
      },
    }));
    await act(async () => undefined);
    expect(screen.queryByText(/updated facts/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "接受 Proposal" })).toBeEnabled();
  });

  it("shows the complete latest Checklist after conflict and only submits an explicit new operation", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("77777777-7777-4777-8777-777777777777")
      .mockReturnValueOnce("88888888-8888-4888-8888-888888888888");
    const bodies: Array<Record<string, unknown>> = [];
    const calls: Array<{ method: string; url: string }> = [];
    let resolveHead!: (response: Response) => void;
    const headPending = new Promise<Response>((resolve) => {
      resolveHead = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url });
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (bodies.length === 1) {
          return Promise.resolve(Response.json({
            currentStateVersion: 2,
            error: { code: "VERSION_CONFLICT", message: "changed" },
            kind: "version_conflict",
          }, { status: 409 }));
        }
        return Promise.resolve(Response.json(completed(
          "88888888-8888-4888-8888-888888888888",
          "check_item",
          2,
        )));
      }
      if (url.endsWith("/blocks/checklist-1")) {
        return headPending;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(
      <StructuredMessageBlock
        block={checklistWith([
          { checked: false, id: "item-1", text: "Verify source" },
          { checked: false, id: "item-2", text: "Review diff" },
        ])}
        targetKey="project-1|thread-1|run-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "勾选 Verify source" }));

    const explanation = await screen.findByRole("alert");
    expect(explanation).toHaveTextContent("正在读取最新状态");
    expect(explanation).toHaveFocus();
    expect(screen.getByRole("button", { name: "勾选 Verify source" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "勾选 Review diff" })).toBeDisabled();
    expect(calls.map(({ method }) => method)).toEqual(["POST", "GET"]);

    resolveHead(latestChecklistResponse([
      { checked: true, id: "item-2", text: "Review diff — updated" },
      { checked: false, id: "item-1", text: "Verify source" },
    ], 2));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "勾选 Verify source" })).toBeEnabled()
    );
    expect(explanation).toHaveTextContent("最新完整 Checklist");
    expect(explanation).toHaveTextContent("状态版本 2");
    expect(screen.getByText(/state 2/)).toBeVisible();
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Review diff — updated");
    expect(items[1]).toHaveTextContent("Verify source");
    expect(screen.getByRole("button", { name: "取消勾选 Review diff — updated" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /重新提交/ })).toBeNull();
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "勾选 Verify source" }));
    expect(await screen.findByText(/Receipt receipt-1/)).toBeVisible();
    expect(screen.getByRole("button", { name: "勾选 Verify source" })).toBeDisabled();
    expect(bodies).toEqual([
      expect.objectContaining({
        action: "check_item",
        expectedStateVersion: 1,
        itemId: "item-1",
        operationId: "77777777-7777-4777-8777-777777777777",
      }),
      expect.objectContaining({
        action: "check_item",
        expectedStateVersion: 2,
        itemId: "item-1",
        operationId: "88888888-8888-4888-8888-888888888888",
      }),
    ]);
  });

  it("offers no stale resubmission when the latest Checklist removed or completed the item", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "99999999-9999-4999-8999-999999999999",
    );
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url });
      if (init?.method === "POST") {
        return Promise.resolve(Response.json({
          currentStateVersion: 2,
          error: { code: "VERSION_CONFLICT", message: "changed" },
          kind: "version_conflict",
        }, { status: 409 }));
      }
      if (url.endsWith("/blocks/checklist-1")) {
        return Promise.resolve(latestChecklistResponse([
          { checked: true, id: "item-1", text: "Verify source" },
        ], 2));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(
      <StructuredMessageBlock
        block={checklistWith([
          { checked: false, id: "item-1", text: "Verify source" },
          { checked: false, id: "item-2", text: "Review diff" },
        ])}
        targetKey="project-1|thread-1|run-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "勾选 Verify source" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("状态版本 2");
    expect(screen.queryByRole("button", { name: "勾选 Verify source" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Review diff/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /重新提交/ })).toBeNull();
    const currentAction = screen.getByRole("button", { name: "取消勾选 Verify source" });
    expect(currentAction).toBeEnabled();
    expect(currentAction).toHaveAttribute("aria-pressed", "true");
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  it("returns to reconciliation on a second conflict without replaying or flashing stale items", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .mockReturnValueOnce("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const bodies: Array<Record<string, unknown>> = [];
    const calls: Array<{ method: string; url: string }> = [];
    let resolveSecondHead!: (response: Response) => void;
    const secondHeadPending = new Promise<Response>((resolve) => {
      resolveSecondHead = resolve;
    });
    let headReads = 0;
    let resolveRetry!: (response: Response) => void;
    const retryPending = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url });
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (bodies.length === 1) {
          return Promise.resolve(Response.json({
            currentStateVersion: 2,
            error: { code: "VERSION_CONFLICT", message: "changed" },
            kind: "version_conflict",
          }, { status: 409 }));
        }
        return retryPending;
      }
      if (url.endsWith("/blocks/checklist-1")) {
        headReads += 1;
        if (headReads === 1) {
          return Promise.resolve(latestChecklistResponse([
            { checked: false, id: "item-1", text: "Verify source — v2" },
          ], 2));
        }
        return secondHeadPending;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(
      <StructuredMessageBlock
        block={checklistWith([{ checked: false, id: "item-1", text: "Verify source" }])}
        targetKey="project-1|thread-1|run-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "勾选 Verify source" }));
    const explanation = await screen.findByRole("alert");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "勾选 Verify source — v2" })).toBeEnabled()
    );

    const retry = screen.getByRole("button", { name: "勾选 Verify source — v2" });
    await user.click(retry);
    expect(retry).toBeDisabled();
    expect(screen.getByText(/正在提交/)).toBeVisible();
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(2);

    resolveRetry(Response.json({
      currentStateVersion: 3,
      error: { code: "VERSION_CONFLICT", message: "changed again" },
      kind: "version_conflict",
    }, { status: 409 }));

    await waitFor(() =>
      expect(explanation).toHaveTextContent("正在读取最新状态")
    );
    expect(explanation).toHaveFocus();
    expect(screen.getByRole("button", { name: /Verify source/ })).toBeDisabled();
    expect(screen.getByText("Verify source — v2")).toBeVisible();
    expect(screen.queryByText("Verify source", { exact: true })).toBeNull();
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(2);

    resolveSecondHead(latestChecklistResponse([
      { checked: true, id: "item-1", text: "Verify source — v2" },
    ], 3));

    await waitFor(() =>
      expect(explanation).toHaveTextContent("状态版本 3")
    );
    expect(screen.queryByRole("button", { name: "勾选 Verify source — v2" })).toBeNull();
    expect(screen.getByRole("button", { name: "取消勾选 Verify source — v2" }))
      .toBeEnabled();
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(2);
    expect(calls.filter(({ method }) => method === "GET")).toHaveLength(2);
    expect(bodies.map((body) => body.operationId)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    expect(bodies[1]).toMatchObject({ expectedStateVersion: 2 });
  });

  it("supports keyboard Checklist updates and clears pending focus state on target switch", async () => {
    let resolveWrite!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveWrite = resolve;
    });
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "55555555-5555-4555-8555-555555555555",
    );
    vi.stubGlobal("fetch", vi.fn(() => pending));
    const user = userEvent.setup();
    const view = render(
      <StructuredMessageBlock block={checklist()} targetKey="project-1|thread-1|run-1" />,
    );
    const item = screen.getByRole("button", { name: "勾选 Verify source" });
    item.focus();
    await user.keyboard("{Enter}");
    expect(item).toBeDisabled();
    expect(item).toHaveFocus();

    view.rerender(
      <StructuredMessageBlock block={proposal()} targetKey="project-1|thread-2|run-2" />,
    );
    expect(screen.queryByText(/正在提交/)).toBeNull();
    expect(screen.getByRole("button", { name: "接受 Proposal" })).toBeEnabled();

    resolveWrite(Response.json(completed(
      "55555555-5555-4555-8555-555555555555",
      "check_item",
    )));
    await act(async () => undefined);
    await waitFor(() => expect(screen.queryByText(/Receipt receipt-1/)).toBeNull());
  });
});
