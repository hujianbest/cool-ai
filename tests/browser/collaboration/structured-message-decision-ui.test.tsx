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

  it("reads the new head on VERSION_CONFLICT and requires an explicit new operation", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("33333333-3333-4333-8333-333333333333")
      .mockReturnValueOnce("44444444-4444-4444-8444-444444444444");
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
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
        return Promise.resolve(Response.json({
          block: {
            actor: { displayName: "Alpha", id: "agent-a", type: "agent" },
            blockRevision: 1,
            blockSchemaVersion: 1,
            blockType: "proposal",
            kind: "known",
            payload: proposal(2).payload,
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

    expect(await screen.findByRole("alert")).toHaveTextContent("状态版本已变为 2");
    expect(screen.getByRole("button", { name: "接受 Proposal" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "按状态版本 2 重新提交接受" }));
    expect(await screen.findByText(/Receipt receipt-1/)).toBeVisible();
    expect(bodies).toEqual([
      expect.objectContaining({ expectedStateVersion: 1 }),
      expect.objectContaining({
        expectedStateVersion: 2,
        operationId: "44444444-4444-4444-8444-444444444444",
      }),
    ]);
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
