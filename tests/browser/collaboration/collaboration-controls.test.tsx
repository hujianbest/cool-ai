// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import type {
  CollaborationReadResponse,
  CollaborationRun,
  DecisionRequest,
} from "@/src/shared/collaboration-contracts";
import type { MembershipState } from "@/src/shared/project-context-contracts";

const members: MembershipState = {
  members: [
    {
      accentToken: "sage",
      agentId: "agent-a",
      avatarText: "A",
      joinedAt: "2026-07-30T00:00:00.000Z",
      model: "test-model",
      name: "Alpha",
      permissions: { readFiles: true, runCommands: false, writeFiles: false },
      role: "Peer",
      skillNames: [],
    },
    {
      accentToken: "gold",
      agentId: "agent-b",
      avatarText: "B",
      joinedAt: "2026-07-30T00:00:00.000Z",
      model: "test-model",
      name: "Beta",
      permissions: { readFiles: true, runCommands: false, writeFiles: false },
      role: "Peer",
      skillNames: [],
    },
  ],
  projectVersion: 1,
};
const threadId = "thread-1";

function run(
  status: CollaborationRun["status"],
  pauseCategory: string | null = null,
): CollaborationRun {
  return {
    createdAt: "2026-07-30T00:00:00.000Z",
    currentAgentId: "agent-a",
    id: "run-1",
    pauseCategory,
    projectId: "project-1",
    roundCount: 7,
    status,
    updatedAt: "2026-07-30T00:00:00.000Z",
    version: 4,
  };
}

const decision: DecisionRequest = {
  answer: null,
  answerMessageId: null,
  answeredAt: null,
  createdAt: "2026-07-30T00:01:00.000Z",
  id: "decision-1",
  options: ["Ship now", "Wait"],
  question: "When should we ship?",
  requestingAgentId: "agent-a",
  runId: "run-1",
  status: "open",
  turnId: "turn-1",
  version: 3,
};

function read(
  status: CollaborationRun["status"] = "waiting_owner",
  pauseCategory: string | null = null,
  pendingDecision: DecisionRequest | null = status === "waiting_owner" ? decision : null,
): CollaborationReadResponse {
  return {
    pendingDecision,
    projectMessagesPage: { items: [], nextAfter: null },
    readiness: { missing: [], ready: true },
    run: run(status, pauseCategory),
    timelinePage: { items: [], nextAfter: null },
    usage: {
      byAgent: [
        {
          agentId: "agent-a",
          completionTokens: 120,
          handoffs: 2,
          promptTokens: 800,
          totalTokens: 920,
        },
        {
          agentId: "agent-b",
          completionTokens: 80,
          handoffs: 1,
          promptTokens: 500,
          totalTokens: 580,
        },
      ],
      completionTokens: 200,
      promptTokens: 1_300,
      repairCalls: 2,
      totalTokens: 1_500,
      unreportedCalls: 1,
    },
  };
}

function installFetch(
  collaboration: CollaborationReadResponse,
  mutation?: (url: string, init?: RequestInit) => Promise<Response> | Response,
) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (mutation && init?.method === "POST") return mutation(url, init);
      if (url.endsWith("/members")) return Response.json(members);
      if (url.endsWith(`/threads/${threadId}?run=${collaboration.run?.id}`)) {
        const selectedRun = collaboration.run
          ? { ...collaboration.run, threadId }
          : null;
        return Response.json({
          activeRun: selectedRun
            ? { runId: selectedRun.id, threadId }
            : null,
          readiness: {
            dispatch: "ready",
            missingProjectFacts: [],
            selectedMemberId: selectedRun?.currentAgentId ?? null,
          },
          runs: selectedRun ? [selectedRun] : [],
          selectedRun,
          thread: {
            availability: "ready",
            createdAt: "2026-07-30T00:00:00.000Z",
            id: threadId,
            lastActivitySequence: 1,
            policy: {
              availability: "ready",
              createdAt: "2026-07-30T00:00:00.000Z",
              members: [],
              revisionId: "revision-1",
              unavailableMemberIds: [],
              version: 1,
            },
            policyVersion: 1,
            projectId: "project-1",
            title: "Thread",
            updatedAt: "2026-07-30T00:00:00.000Z",
            version: 1,
          },
        });
      }
      if (
        url.endsWith(`/threads/${threadId}/messages`)
        || url.endsWith(`/threads/${threadId}/facts`)
      ) {
        return Response.json({ items: [], nextAfter: null });
      }
      if (url.endsWith(`/threads/${threadId}/runs/run-1/timeline`)) {
        let sequence = 0;
        const timeline = [];
        if (collaboration.pendingDecision) {
          timeline.push({
            actorId: collaboration.pendingDecision.requestingAgentId,
            actorType: "agent",
            createdAt: collaboration.pendingDecision.createdAt,
            id: "event-decision",
            payload: {
              agentId: collaboration.pendingDecision.requestingAgentId,
              decisionId: collaboration.pendingDecision.id,
              options: collaboration.pendingDecision.options,
              question: collaboration.pendingDecision.question,
              turnId: collaboration.pendingDecision.turnId,
            },
            runId: "run-1",
            sequence: ++sequence,
            type: "decision_requested",
          });
        }
        for (const usage of collaboration.usage.byAgent) {
          timeline.push({
            actorId: usage.agentId,
            actorType: "agent",
            createdAt: "2026-07-30T00:02:00.000Z",
            id: `event-usage-${usage.agentId}`,
            payload: {
              attemptId: `attempt-${usage.agentId}`,
              completionTokens: usage.completionTokens,
              kind: "primary",
              promptTokens: usage.promptTokens,
              reported: true,
              totalTokens: usage.totalTokens,
            },
            runId: "run-1",
            sequence: ++sequence,
            type: "usage_recorded",
          });
          for (let index = 0; index < usage.handoffs; index += 1) {
            timeline.push({
              actorId: usage.agentId,
              actorType: "agent",
              createdAt: "2026-07-30T00:03:00.000Z",
              id: `event-handoff-${usage.agentId}-${index}`,
              payload: {
                fromAgentId: usage.agentId,
                overriddenByMention: false,
                reason: "Fixture handoff",
                summary: "Fixture summary",
                toAgentId: usage.agentId === "agent-a" ? "agent-b" : "agent-a",
                turnId: `turn-handoff-${usage.agentId}-${index}`,
              },
              runId: "run-1",
              sequence: ++sequence,
              type: "handoff",
            });
          }
        }
        for (let index = 0; index < collaboration.usage.repairCalls; index += 1) {
          timeline.push({
            actorId: "agent-a",
            actorType: "agent",
            createdAt: "2026-07-30T00:04:00.000Z",
            id: `event-repair-${index}`,
            payload: {
              attemptId: `attempt-repair-${index}`,
              completionTokens: 0,
              kind: "repair",
              promptTokens: 0,
              reported: true,
              totalTokens: 0,
            },
            runId: "run-1",
            sequence: ++sequence,
            type: "usage_recorded",
          });
        }
        for (let index = 0; index < collaboration.usage.unreportedCalls; index += 1) {
          timeline.push({
            actorId: "agent-a",
            actorType: "agent",
            createdAt: "2026-07-30T00:05:00.000Z",
            id: `event-unreported-${index}`,
            payload: {
              attemptId: `attempt-unreported-${index}`,
              completionTokens: 0,
              kind: "primary",
              promptTokens: 0,
              reported: false,
              totalTokens: 0,
            },
            runId: "run-1",
            sequence: ++sequence,
            type: "usage_recorded",
          });
        }
        return Response.json({ items: timeline, nextAfter: null });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collaboration decisions, controls, and usage", () => {
  it("renders a waiting decision, radio options, free text, usage totals, and per-Agent metrics", async () => {
    installFetch(read());
    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId,
    }));

    expect(await screen.findByRole("heading", { name: "等待你的决策" })).toBeInTheDocument();
    expect(screen.getByText("When should we ship?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Ship now" })).toBeInTheDocument();
    expect(screen.getByLabelText("其他回答")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled();
    expect(screen.getByText("请选择一个选项或填写其他回答。")).toBeInTheDocument();

    const usage = screen.getByRole("region", { name: "运行用量" });
    expect(usage).toHaveTextContent("Prompt 1300");
    expect(usage).toHaveTextContent("Completion 200");
    expect(usage).toHaveTextContent("总计 1500");
    expect(usage).toHaveTextContent("轮次 7");
    expect(usage).toHaveTextContent("交棒 3");
    expect(usage).toHaveTextContent("修复调用 2");
    expect(usage).toHaveTextContent("未报告 1");
    await waitFor(() => expect(usage).toHaveTextContent("Alpha"));
    expect(usage).toHaveTextContent("Alpha");
    expect(usage).toHaveTextContent("920");
    expect(usage).toHaveTextContent("Beta");
  });

  it("enforces the 5000-grapheme decision answer boundary in the UI", async () => {
    const fetchMock = installFetch(read());
    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId,
    }));
    const input = await screen.findByLabelText("其他回答");
    expect(input).toHaveAttribute("maxlength", "5000");

    fireEvent.change(input, { target: { value: "答".repeat(5_001) } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("请输入 1 至 5000 个字符。");
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("answers with expectedVersion, a stable operation id, optional mention, and focuses success", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    installFetch(read(), (url, init) => {
      expect(url).toBe(
        `/api/projects/project-1/threads/${threadId}/runs/run-1/decisions/decision-1/answer`,
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return Response.json({
        decision: { ...decision, answer: "Ship now", status: "answered", version: 4 },
        run: run("running"),
      });
    });
    const user = userEvent.setup();
    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId,
    }));

    await user.click(await screen.findByRole("radio", { name: "Ship now" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "回答后交给成员" }),
      "agent-b",
    );
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      answer: "Ship now",
      expectedVersion: 1,
      mentionAgentId: "agent-b",
    });
    expect(bodies[0].operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(await screen.findByText("回答已提交，协作将继续。")).toHaveFocus();
  });

  it("preserves an answer draft during submission and sanitized failure", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    installFetch(read(), () => pending);
    const user = userEvent.setup();
    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId,
    }));
    const input = await screen.findByLabelText("其他回答");
    await user.type(input, "Keep this decision draft");
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    expect(input).toBeDisabled();
    expect(input).toHaveValue("Keep this decision draft");
    finish(
      Response.json(
        { error: { code: "PROVIDER_UPSTREAM", message: "raw provider stack" } },
        { status: 502 },
      ),
    );
    const providerAlert = await screen.findByText("Provider 服务暂时异常。");
    expect(providerAlert.closest('[role="alert"]')).toBe(providerAlert);
    expect(input).toBeEnabled();
    expect(input).toHaveValue("Keep this decision draft");
    expect(screen.queryByText("raw provider stack")).not.toBeInTheDocument();
  });

  it.each([
    ["running", null, "暂停", "继续", "仅手动暂停后可继续。"],
    ["paused", "manual", "继续", "重试", "手动暂停请使用继续。"],
    ["paused", "provider_auth", "重试", "继续", "当前暂停原因需要修复后重试。"],
    ["failed", "internal_failure", "重试", "继续", "失败状态只能在修复后重试。"],
    ["planned", null, null, "暂停", "运行已结束，不能再执行控制操作。"],
    ["stopped", null, null, "重试", "运行已结束，不能再执行控制操作。"],
  ] as const)(
    "shows valid controls and disabled reasons for %s/%s",
    async (status, category, enabledName, disabledName, reason) => {
      installFetch(read(status, category, null));
      render(createElement(CollaborationPanel, {
        projectId: "project-1",
        selectedRunId: "run-1",
        threadId,
      }));
      await screen.findByRole("region", { name: "运行控制" });

      if (enabledName) {
        expect(screen.getByRole("button", { name: enabledName })).toBeEnabled();
      }
      expect(screen.getByRole("button", { name: disabledName })).toBeDisabled();
      expect(screen.getByText(reason)).toBeInTheDocument();
    },
  );

  it("sends control expectedVersion and unique operation ids, with stop confirmation", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    installFetch(read("running", null, null), (url, init) => {
      if (url.endsWith("/advance")) return new Promise<Response>(() => undefined);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ body, url });
      return Response.json({ run: run(body.action === "stop" ? "stopped" : "paused", "manual") });
    });
    const user = userEvent.setup();
    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId,
    }));

    await user.click(await screen.findByRole("button", { name: "暂停" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      body: { action: "pause", expectedVersion: 4 },
      url: `/api/projects/project-1/threads/${threadId}/runs/run-1/control`,
    });

    await user.click(screen.getByRole("button", { name: "停止" }));
    const dialog = screen.getByRole("dialog", { name: "确认停止协作" });
    expect(dialog).toHaveTextContent("停止后不能继续或重试。");
    await user.click(screen.getByRole("button", { name: "取消停止" }));
    expect(screen.queryByRole("dialog", { name: "确认停止协作" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "停止" }));
    await user.click(screen.getByRole("button", { name: "确认停止" }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({
      body: { action: "stop", expectedVersion: 4 },
      url: `/api/projects/project-1/threads/${threadId}/runs/run-1/control`,
    });
    expect(calls[1].body.operationId).not.toBe(calls[0].body.operationId);
  });

  it("shows controls and usage loading, empty, fixed category errors, and retry success", async () => {
    const successfulFetch = installFetch({
      ...read("paused", "action_invalid", null),
      usage: {
        byAgent: [],
        completionTokens: 0,
        promptTokens: 0,
        repairCalls: 0,
        totalTokens: 0,
        unreportedCalls: 0,
      },
    });
    let detailReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/threads/${threadId}?run=run-1`)) {
          detailReads += 1;
        }
        if (detailReads === 1 && url.endsWith(`/threads/${threadId}?run=run-1`)) {
          return Response.json(
            { error: { code: "ACTION_INVALID", message: "raw action response" } },
            { status: 400 },
          );
        }
        return successfulFetch(input, init);
      }),
    );
    render(createElement(CollaborationPanel, {
      projectId: "project-1",
      selectedRunId: "run-1",
      threadId,
    }));

    expect(screen.getByText("正在加载项目群聊…")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent 提交的协作动作无效。",
    );
    expect(screen.queryByText("raw action response")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试加载群聊" }));

    const usage = await screen.findByRole("region", { name: "运行用量" });
    expect(usage).toHaveTextContent("尚无已报告的模型用量。");
    expect(screen.getByRole("region", { name: "运行控制" })).toBeInTheDocument();
  });
});
