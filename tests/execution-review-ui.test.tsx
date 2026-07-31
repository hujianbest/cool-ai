// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionPanel } from "@/components/execution/execution-panel";

const PROJECT_ID = "project-review-ui";
const RUN_ID = "run-review-ui";
const HASH = "a".repeat(64);
const STAGED_HASH = "b".repeat(64);

function execution(
  status: "running" | "waiting_approval" | "staged" | "stale" | "conflicted" = "staged",
) {
  return {
    agent: { accentToken: "sage", avatarText: "A", id: "agent-a", name: "Alpha" },
    attemptNo: 2,
    businessDeadlineAt: "2026-07-30T08:15:00.000Z",
    businessRounds: 4,
    createdAt: "2026-07-30T08:00:00.000Z",
    currentAction: {
      actionIndex: null,
      kind: null,
      lastHeartbeatAt: null,
      overallDeadlineAt: null,
      startedAt: null,
    },
    firstRunningAt: "2026-07-30T08:00:00.000Z",
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
    reasonCode: status === "stale" ? "STAGED_CONTEXT_STALE" : null,
    resumeTarget: null,
    sourceCollaborationRunId: RUN_ID,
    status,
    toolCalls: 7,
    updatedAt: "2026-07-30T08:05:00.000Z",
    usage: { completionTokens: 300, maxTokens: 2_000, promptTokens: 600, totalTokens: 900 },
    version: 3,
    workItem: { id: "task-a", title: "Task A" },
  } as const;
}

function detail(
  status: Parameters<typeof execution>[0] = "staged",
  classification: "auto_eligible" | "approval_required" | "blocked" = "approval_required",
) {
  return {
    counts: {
      approvals: 1,
      artifacts: 1,
      events: 101,
      mergeFiles: 2,
      stagedBlockers: classification === "blocked" ? 101 : 0,
      stagedObservations: 101,
      validations: 1,
    },
    execution: execution(status),
    frozen: {
      agentVersion: 1,
      baselineManifestHash: HASH,
      contextHash: HASH,
      memoryHash: HASH,
      missionVersion: 1,
      permissionsHash: HASH,
      policyHash: HASH,
      policyRevisionId: "policy-1",
      policyVersion: 1,
      providerVersion: 1,
      rosterHash: HASH,
      skillsHash: HASH,
      taskVersion: 1,
    },
    recovery: {
      allowedResolutions: [],
      journalStatus: null,
      mismatchPhase: null,
      observedManifestHash: null,
      oldManifestHash: null,
      postManifestHash: null,
      required: false,
    },
    staged: {
      blockReasons: classification === "blocked" ? ["unsupported_change"] : [],
      blockerCount: classification === "blocked" ? 101 : 0,
      blockerCounts: classification === "blocked" ? { binary: 101 } : {},
      classification,
      id: "staged-1",
      mergeFileCount: 2,
      mergeFinalBytes: 512,
      observedFinalBytes: 4_096,
      observedPathCount: 101,
      stagedHash: STAGED_HASH,
    },
  };
}

type Handler = (url: URL, init?: RequestInit) =>
  Response | Promise<Response> | undefined;

function installFetch(
  status: Parameters<typeof execution>[0] = "staged",
  classification: "auto_eligible" | "approval_required" | "blocked" = "approval_required",
  handler?: Handler,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const handled = await handler?.(url, init);
    if (handled) return handled;
    if (url.pathname.endsWith("/mission")) {
      return Response.json({ mission: null, workItems: [] });
    }
    if (url.pathname.endsWith("/collaboration")) {
      return Response.json({ run: { id: RUN_ID, status: "planned" } });
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/executions`) {
      return Response.json({ executions: [execution(status)] });
    }
    if (url.pathname === "/api/executions/execution-a") {
      return Response.json(detail(status, classification));
    }
    throw new Error(`Unexpected request ${url.pathname}${url.search}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("T-29 execution review UI", () => {
  it("uses an arrow-key tablist and independently paginates timeline summaries", async () => {
    const user = userEvent.setup();
    installFetch("staged", "approval_required", (url) => {
      if (url.pathname.endsWith("/events")) {
        return Response.json(url.searchParams.has("after")
          ? {
              items: [{
                actorId: null,
                actorType: "system",
                attemptNo: 2,
                createdAt: "2026-07-30T08:06:00.000Z",
                id: "event-101",
                payload: {},
                sequence: 101,
                type: "staged_created",
              }],
              nextCursor: null,
            }
          : {
              items: [{
                actorId: null,
                actorType: "system",
                attemptNo: 2,
                createdAt: "2026-07-30T08:05:00.000Z",
                id: "event-1",
                payload: {},
                sequence: 1,
                type: "execution_created",
              }],
              nextCursor: "events-next",
            });
      }
      return undefined;
    });

    render(createElement(ExecutionPanel, { projectId: PROJECT_ID }));
    const card = await screen.findByRole("region", { name: "Task A" });
    const tabs = await within(card).findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["时间线", "验证", "变更"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(await within(card).findByRole("log", { name: "执行时间线" })).toHaveTextContent("execution_created");

    tabs[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(tabs[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(tabs[0]).toHaveFocus();

    await user.click(within(card).getByRole("button", { name: "加载更多时间线" }));
    expect(await within(card).findByText(/staged_created/)).toBeInTheDocument();
  });

  it("lazy-loads validation stdout one chunk at a time, shows metadata, and preserves read data on error", async () => {
    const user = userEvent.setup();
    let chunkRequest = 0;
    installFetch("staged", "approval_required", (url) => {
      if (url.pathname.endsWith("/validations")) {
        return Response.json({
          items: [{
            afterLastWrite: true,
            exitCode: 0,
            finishedAt: "2026-07-30T08:04:00.000Z",
            id: "validation-1",
            policyEntryId: "required-test",
            required: true,
            stderr: { bytes: 0, sha256: HASH, truncated: false },
            stdout: { bytes: 1_048_576, sha256: HASH, truncated: true },
            succeeded: true,
          }],
          nextCursor: null,
        });
      }
      if (url.pathname.includes("/validations/validation-1/stdout/chunks")) {
        chunkRequest += 1;
        if (chunkRequest === 2) {
          return Response.json(
            { error: { code: "STORAGE_UNAVAILABLE", message: "down" } },
            { status: 503 },
          );
        }
        return Response.json({
          items: [{
            byteLength: 65_536,
            byteOffset: 0,
            chunkIndex: 0,
            sha256: HASH,
            stream: "stdout",
            text: "first retained output",
          }],
          nextCursor: "stdout-next",
        });
      }
      return undefined;
    });

    render(createElement(ExecutionPanel, { projectId: PROJECT_ID }));
    const card = await screen.findByRole("region", { name: "Task A" });
    await user.click(await within(card).findByRole("tab", { name: "验证" }));
    expect(await within(card).findByText(/1048576 bytes/)).toBeInTheDocument();
    expect(within(card).getByText(/已截断/)).toBeInTheDocument();
    expect(within(card).getByText(/必需 · 新鲜/)).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "读取 stdout" }));
    expect(await within(card).findByText("first retained output")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "加载更多 stdout" }));
    expect((await within(card).findAllByRole("alert")).some(
      (alert) => alert.textContent?.includes("服务暂时不可用"),
    )).toBe(true);
    expect(within(card).getByText("first retained output")).toBeInTheDocument();
    expect(within(card).getAllByText(new RegExp(HASH.slice(0, 12))).length).toBeGreaterThan(0);
  });

  it("loads artifacts and text diffs incrementally while independently reaching observation and blocker item 101", async () => {
    const user = userEvent.setup();
    installFetch("staged", "blocked", (url) => {
      if (url.pathname.endsWith("/artifacts")) {
        return Response.json({
          items: [{
            contentBytes: 9,
            createdAt: "2026-07-30T08:04:00.000Z",
            id: "artifact-1",
            name: "notes",
            path: "notes.txt",
            sha256: HASH,
            truncated: false,
          }],
          nextCursor: null,
        });
      }
      if (url.pathname.includes("/artifacts/artifact-1/chunks")) {
        return Response.json({
          items: [{
            byteLength: 9,
            byteOffset: 0,
            chunkIndex: 0,
            sha256: HASH,
            stream: "artifact",
            text: "artifact!",
          }],
          nextCursor: null,
        });
      }
      if (url.pathname.endsWith("/observations")) {
        const position = url.searchParams.has("after") ? 100 : 0;
        return Response.json({
          items: [{
            baselineHash: HASH,
            diffBytes: 12,
            diffTruncated: false,
            finalSize: 8,
            id: position === 100 ? "observation-101" : "observation-1",
            kind: "modified",
            observedHash: STAGED_HASH,
            path: position === 100 ? "item101.txt" : "item1.txt",
            position,
          }],
          nextCursor: position === 0 ? "observations-next" : null,
        });
      }
      if (url.pathname.endsWith("/blockers")) {
        const position = url.searchParams.has("after") ? 100 : 0;
        return Response.json({
          items: [{
            detailCode: "BINARY_NOT_MERGEABLE",
            kind: "binary",
            observationId: position === 100 ? "observation-101" : "observation-1",
            path: position === 100 ? "item101.txt" : "item1.txt",
            position,
            secondaryCodes: [],
          }],
          nextCursor: position === 0 ? "blockers-next" : null,
        });
      }
      if (url.pathname.endsWith("/diff")) {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return Response.json({
          nextOffset: offset === 0 ? 6 : null,
          observationId: "observation-1",
          offset,
          sha256: HASH,
          text: offset === 0 ? "-old\n+" : "new\n",
          totalBytes: 10,
        });
      }
      return undefined;
    });

    render(createElement(ExecutionPanel, { projectId: PROJECT_ID }));
    const card = await screen.findByRole("region", { name: "Task A" });
    await user.click(await within(card).findByRole("tab", { name: "验证" }));
    await user.click(await within(card).findByRole("button", { name: "读取 artifact notes" }));
    expect(await within(card).findByText("artifact!")).toBeInTheDocument();

    await user.click(within(card).getByRole("tab", { name: "变更" }));
    expect(await within(card).findByText("观察到 101 个路径 · 4096 bytes")).toBeInTheDocument();
    expect(within(card).getByText("可合入边界 2 个文件 · 512 bytes")).toBeInTheDocument();
    expect(within(card).getByText(/阻断 · 不可自动合入/)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /自动合入/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /批准当前 staged hash/ })).not.toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "加载更多观察" }));
    expect(await within(card).findByText("item101.txt")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "加载更多阻断" }));
    expect(within(card).getAllByText("item101.txt")).toHaveLength(2);

    await user.click(within(card).getByRole("button", { name: "读取 item1.txt 文本差异" }));
    expect(await within(card).findByText(/-old/)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "加载更多 item1.txt 文本差异" }));
    expect(within(card).getByText(/new/)).toBeInTheDocument();
  });

  it("shows exact one-shot command approval details and supports approve, reject, revoke, and replace states", async () => {
    const user = userEvent.setup();
    let approvalStatus = "pending";
    const actions: string[] = [];
    installFetch("waiting_approval", "approval_required", (url, init) => {
      if (url.pathname.endsWith("/approvals") && init?.method !== "POST") {
        return Response.json({
          items: [{
            command: {
              args: ["test", "--runInBand"],
              executable: "C:\\Program Files\\node.exe",
              expectedEffect: "run required tests",
              permission: "execute",
              riskReasons: ["unknown_non_path"],
              workdir: ".",
            },
            consumedAt: null,
            createdAt: "2026-07-30T08:04:00.000Z",
            decidedAt: null,
            id: "approval-1",
            inputHash: HASH,
            kind: "command",
            requestHash: STAGED_HASH,
            stagedHash: null,
            status: approvalStatus,
          }],
          nextCursor: null,
        });
      }
      if (url.pathname.endsWith("/approvals/approval-1") && init?.method === "POST") {
        const action = (JSON.parse(String(init.body)) as { action: string }).action;
        actions.push(action);
        approvalStatus = action === "approve" ? "approved" : action === "reject"
          ? "rejected" : action === "revoke" ? "revoked" : "replaced";
        return Response.json({
          approval: {
            command: {
              args: ["test", "--runInBand"],
              executable: "C:\\Program Files\\node.exe",
              expectedEffect: "run required tests",
              permission: "execute",
              riskReasons: ["unknown_non_path"],
              workdir: ".",
            },
            consumedAt: null,
            createdAt: "2026-07-30T08:04:00.000Z",
            decidedAt: "2026-07-30T08:05:00.000Z",
            id: "approval-1",
            inputHash: HASH,
            kind: "command",
            requestHash: STAGED_HASH,
            stagedHash: null,
            status: approvalStatus,
          },
          execution: { ...execution("waiting_approval"), version: 4 },
        });
      }
      return undefined;
    });

    render(createElement(ExecutionPanel, { projectId: PROJECT_ID }));
    const dialog = await screen.findByRole("dialog", { name: "命令一次性审批" });
    expect(dialog).toHaveTextContent("C:\\Program Files\\node.exe");
    expect(dialog).toHaveTextContent("test");
    expect(dialog).toHaveTextContent("--runInBand");
    expect(dialog).toHaveTextContent("工作目录：.");
    expect(dialog).toHaveTextContent("权限：execute");
    expect(dialog).toHaveTextContent("风险：unknown_non_path");
    expect(dialog).toHaveTextContent(HASH.slice(0, 12));
    expect(dialog).toHaveTextContent(STAGED_HASH.slice(0, 12));
    expect(dialog).toHaveTextContent("一次性，仅此 attempt");
    expect(dialog).toHaveTextContent("不是 hostile OS sandbox");

    await user.click(within(dialog).getByRole("button", { name: "批准命令" }));
    expect(await within(dialog).findByText("审批状态：已批准")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "撤销批准" }));
    expect(await within(dialog).findByText("审批状态：已撤销")).toBeInTheDocument();
    expect(actions).toEqual(["approve", "revoke"]);
    expect(within(dialog).getByText(/审批已更新/)).toHaveAttribute("aria-live", "polite");
  });

  it.each(["blocked", "stale", "conflicted"] as const)(
    "never presents auto merge for %s review state and keeps staged-hash approval separate",
    async (state) => {
      installFetch(
        state === "blocked" ? "staged" : state,
        state === "blocked" ? "blocked" : "approval_required",
        (url) => {
          if (url.pathname.endsWith("/observations") || url.pathname.endsWith("/blockers")) {
            return Response.json({ items: [], nextCursor: null });
          }
          return undefined;
        },
      );
      render(createElement(ExecutionPanel, { projectId: PROJECT_ID }));
      const card = await screen.findByRole("region", { name: "Task A" });
      await userEvent.click(await within(card).findByRole("tab", { name: "变更" }));
      expect((await within(card).findAllByText(
        new RegExp(STAGED_HASH.slice(0, 12)),
      )).length).toBeGreaterThan(0);
      expect(within(card).queryByRole("button", { name: /自动合入/ })).not.toBeInTheDocument();
      if (state === "blocked") {
        expect(within(card).queryByRole("button", { name: /批准当前 staged hash/ })).not.toBeInTheDocument();
      } else {
        expect(within(card).getByRole("button", { name: /批准当前 staged hash/ })).toBeDisabled();
      }
      expect(within(card).queryByRole("button", { name: "批准命令" })).not.toBeInTheDocument();
    },
  );
});
