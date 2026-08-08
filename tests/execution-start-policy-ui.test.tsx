// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionPanel } from "@/components/execution/execution-panel";

const PROJECT_ID = "project-policy-ui";
const RUN_ID = "run-policy-ui";
const SOURCE_TUPLE = {
  projectId: PROJECT_ID,
  runId: RUN_ID,
  threadId: "thread-policy-ui",
} as const;

const emptyPolicy = {
  classifierVersion: 1,
  entries: [],
  policyHash: "a".repeat(64),
  projectId: PROJECT_ID,
  revisionId: "revision-1",
  revisionNo: 1,
  version: 1,
  warningAccepted: false,
};

const execution = {
  agent: { accentToken: "sage", avatarText: "A", id: "agent-a", name: "Alpha" },
  attemptNo: 1,
  businessDeadlineAt: null,
  businessRounds: 0,
  createdAt: "2026-07-30T08:00:00.000Z",
  currentAction: {
    actionIndex: 0,
    kind: "sandbox_build",
    lastHeartbeatAt: null,
    overallDeadlineAt: "2026-07-30T08:15:00.000Z",
    startedAt: "2026-07-30T08:00:00.000Z",
  },
  firstRunningAt: null,
  id: "execution-a",
  limits: {
    businessClockStarts: "first_running",
    businessRounds: 20,
    businessWallClockSeconds: 900,
    commandSeconds: 120,
    sandboxBuildSeconds: 900,
    toolCalls: 40,
  },
  manualRecoveryRequired: false,
  mergedAt: null,
  projectId: PROJECT_ID,
  reasonCode: null,
  resumeTarget: null,
  sourceCollaborationRunId: RUN_ID,
  sourceCollaborationThreadId: SOURCE_TUPLE.threadId,
  status: "queued",
  toolCalls: 0,
  updatedAt: "2026-07-30T08:00:00.000Z",
  usage: { completionTokens: 0, maxTokens: 1000, promptTokens: 0, totalTokens: 0 },
  version: 1,
  workItem: { id: "task-a", title: "Task A" },
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

function installBaseFetch(
  handler?: (url: URL, init?: RequestInit) =>
    Response | Promise<Response | undefined> | undefined,
) {
  let executions = [] as Array<typeof execution>;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const handled = await handler?.(url, init);
    if (handled) return handled;
    if (url.pathname.endsWith("/mission")) {
      return Response.json({
        mission: { id: "mission" },
        workItems: [
          { assigneeAgentId: "agent-a", dependencyIds: [], id: "task-a", status: "in_progress", title: "Task A" },
          { assigneeAgentId: "agent-b", dependencyIds: [], id: "task-b", status: "in_progress", title: "Task B" },
          { assigneeAgentId: "agent-c", dependencyIds: [], id: "task-c", status: "in_progress", title: "Task C" },
        ],
      });
    }
    if (url.pathname.endsWith("/collaboration")) {
      return Response.json({ run: { id: RUN_ID, status: "planned" } });
    }
    if (url.pathname.endsWith("/validation-policy/revisions")) {
      return Response.json({ items: [emptyPolicy], nextCursor: null });
    }
    if (url.pathname.endsWith("/validation-policy")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return Response.json({
          outcome: "saved",
          policy: { ...emptyPolicy, entries: body.entries, revisionId: "revision-2", revisionNo: 2, version: 2 },
          reasonCode: null,
        });
      }
      return Response.json({ policy: emptyPolicy });
    }
    if (url.pathname.endsWith("/executions") && init?.method === "POST") {
      executions = [execution];
      return Response.json({ execution }, { status: 201 });
    }
    if (url.pathname.endsWith("/executions")) return Response.json({ executions });
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("T-27 execution start UI", () => {
  it("starts at most two eligible tasks concurrently and keeps each result and retry independent", async () => {
    const user = userEvent.setup();
    const pending: Array<() => void> = [];
    const bodies: Array<{ operationId: string; workItemId: string }> = [];
    installBaseFetch(async (url, init) => {
      if (!url.pathname.endsWith("/executions") || init?.method !== "POST") return undefined;
      const body = JSON.parse(String(init.body)) as { operationId: string; workItemId: string };
      bodies.push(body);
      if (bodies.length <= 2) await new Promise<void>((resolve) => pending.push(resolve));
      if (body.workItemId === "task-b" && bodies.length === 2) {
        return Response.json(
          { rejection: { code: "PROJECT_LIMIT", messageKey: "project_limit", workItemId: "task-b" } },
          { status: 409 },
        );
      }
      return Response.json({ execution }, { status: 201 });
    });

    render(createElement(ExecutionPanel, {
      projectId: PROJECT_ID,
      sourceTuple: SOURCE_TUPLE,
    }));
    await user.click(await screen.findByRole("checkbox", { name: "Task A" }));
    await user.click(screen.getByRole("checkbox", { name: "Task B" }));
    expect(screen.getByRole("checkbox", { name: "Task C" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "开始执行所选任务" }));

    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(new Set(bodies.map(({ operationId }) => operationId)).size).toBe(2);
    expect(screen.getAllByText("正在启动…")).toHaveLength(2);
    pending.splice(0).forEach((resolve) => resolve());
    expect(await screen.findByText("Task A 已启动")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Task B");
    const successfulHeading = await screen.findByRole("heading", { name: "Task A" });
    expect(successfulHeading).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "重试 Task B" }));
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]?.operationId).toBe(bodies[1]?.operationId);
    expect(screen.getByText("Task A 已启动")).toBeInTheDocument();
  });
});

describe("T-27 append-only validation policy UI", () => {
  it("loads immutable history and keeps an errored CAS draft while enforcing standing warnings", async () => {
    const user = userEvent.setup();
    let saveCount = 0;
    installBaseFetch((url, init) => {
      if (!url.pathname.endsWith("/validation-policy") || init?.method !== "PUT") return undefined;
      saveCount += 1;
      return Response.json(
        { error: { code: "POLICY_VERSION_CONFLICT", currentVersion: 2, message: "changed" } },
        { status: 409 },
      );
    });

    render(createElement(ExecutionPanel, {
      projectId: PROJECT_ID,
      sourceTuple: SOURCE_TUPLE,
    }));
    await user.click(screen.getByRole("button", { name: "管理验证政策" }));
    expect(await screen.findByText("活动修订 #1")).toBeInTheDocument();
    expect(screen.getByText("不可变修订 #1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "添加持续批准" }));
    const executable = screen.getByRole("textbox", { name: "可执行文件" });
    await user.type(executable, "powershell");
    await user.type(screen.getByRole("textbox", { name: "参数（每行一项）" }), "-Command{enter}npm test");
    expect(screen.getByText("SHELL_EXECUTABLE_DENIED")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存验证政策" })).toBeDisabled();

    await user.clear(executable);
    await user.type(executable, "curl");
    expect(screen.getByText(/unknown_non_path/)).toBeInTheDocument();
    const warning = screen.getByRole("checkbox", { name: /hostile OS sandbox/ });
    expect(warning).not.toBeChecked();
    expect(screen.getByRole("button", { name: "保存验证政策" })).toBeDisabled();
    await user.click(warning);
    await user.click(screen.getByRole("button", { name: "保存验证政策" }));
    expect(saveCount).toBe(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("版本");
    expect(executable).toHaveValue("curl");
  });

  it("saves expectedVersion, tuple fields, required and warningAccepted, then announces and focuses success", async () => {
    const user = userEvent.setup();
    let savedBody: Record<string, unknown> | undefined;
    installBaseFetch((url, init) => {
      if (!url.pathname.endsWith("/validation-policy") || init?.method !== "PUT") return undefined;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      savedBody = body;
      return Response.json({
        outcome: "saved",
        policy: { ...emptyPolicy, entries: body.entries, revisionId: "revision-2", revisionNo: 2, version: 2 },
        reasonCode: null,
      });
    });

    render(createElement(ExecutionPanel, {
      projectId: PROJECT_ID,
      sourceTuple: SOURCE_TUPLE,
    }));
    await user.click(screen.getByRole("button", { name: "管理验证政策" }));
    await screen.findByText("活动修订 #1");
    await user.click(screen.getByRole("button", { name: "添加持续批准" }));
    await user.type(screen.getByRole("textbox", { name: "可执行文件" }), "node");
    await user.type(screen.getByRole("textbox", { name: "参数（每行一项）" }), "test");
    await user.click(screen.getByRole("checkbox", { name: "必需验证" }));
    await user.click(screen.getByRole("checkbox", { name: /hostile OS sandbox/ }));
    await user.click(screen.getByRole("button", { name: "保存验证政策" }));

    expect(savedBody).toMatchObject({
      expectedVersion: 1,
      warningAccepted: true,
      entries: [{ args: ["test"], executable: "node", required: true, workdir: "." }],
    });
    const success = await screen.findByText("验证政策已保存为修订 #2。");
    expect(success).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("heading", { name: "验证政策" })).toHaveFocus();
  });
});
