// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionPanel } from "@/components/execution/execution-panel";

const PROJECT_ID = "project-recovery-ui";
const OLD = "a".repeat(64);
const POST = "b".repeat(64);
const OBSERVED = "c".repeat(64);
const CHANGED = "d".repeat(64);

function execution(overrides: Record<string, unknown> = {}) {
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
    id: "execution-recovery",
    limits: {
      businessClockStarts: "first_running",
      businessRounds: 20,
      businessWallClockSeconds: 900,
      commandSeconds: 120,
      sandboxBuildSeconds: 900,
      toolCalls: 40,
    },
    manualRecoveryRequired: true,
    mergedAt: null,
    projectId: PROJECT_ID,
    reasonCode: "MANUAL_RECOVERY_REQUIRED",
    resumeTarget: null,
    sourceCollaborationRunId: "run-recovery",
    status: "conflicted",
    toolCalls: 7,
    updatedAt: "2026-07-30T08:05:00.000Z",
    usage: { completionTokens: 300, maxTokens: 2_000, promptTokens: 600, totalTokens: 900 },
    version: 7,
    workItem: { id: "task-recovery", title: "Recover workspace" },
    ...overrides,
  } as const;
}

function detail(observedManifestHash = OBSERVED) {
  return {
    counts: {
      approvals: 1,
      artifacts: 0,
      events: 1,
      mergeFiles: 2,
      stagedBlockers: 0,
      stagedObservations: 0,
      validations: 0,
    },
    execution: execution(),
    frozen: {
      agentVersion: 1,
      baselineManifestHash: OLD,
      contextHash: OLD,
      memoryHash: OLD,
      missionVersion: 1,
      permissionsHash: OLD,
      policyHash: OLD,
      policyRevisionId: "policy-1",
      policyVersion: 1,
      providerVersion: 1,
      rosterHash: OLD,
      skillsHash: OLD,
      taskVersion: 1,
    },
    recovery: {
      allowedResolutions: ["recovered_old", "recovered_new", "abandon"],
      journalStatus: "manual_recovery",
      mismatchPathKey: null,
      mismatchPhase: "rollback_after_replace",
      observedManifestHash,
      oldManifestHash: OLD,
      postManifestHash: POST,
      required: true,
    },
    staged: null,
  };
}

function installFetch(
  resolve?: (body: Record<string, unknown>) => Response | Promise<Response>,
) {
  const calls: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/mission")) return Response.json({ mission: null, workItems: [] });
    if (url.pathname.endsWith("/collaboration")) {
      return Response.json({ run: { id: "run-recovery", status: "planned" } });
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/executions`) {
      return Response.json({ executions: [execution()] });
    }
    if (url.pathname === "/api/executions/execution-recovery") {
      return Response.json(detail());
    }
    if (url.pathname.endsWith("/recovery/files")) {
      return Response.json(url.searchParams.has("after")
        ? {
            items: [{
              isMismatch: false,
              oldExists: false,
              oldHash: null,
              path: "owned/item-21.tmp",
              pathKey: "owned/item-21.tmp",
              postHash: POST,
              position: 20,
              status: "pending",
            }],
            nextCursor: null,
          }
        : {
            items: [{
              isMismatch: false,
              oldExists: true,
              oldHash: OLD,
              path: "src/changed.ts",
              pathKey: "src/changed.ts",
              postHash: POST,
              position: 0,
              status: "applied",
            }],
            nextCursor: "recovery-next",
          });
    }
    if (url.pathname.endsWith("/recovery/resolve") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      return resolve?.(body) ?? Response.json({
        execution: execution({
          manualRecoveryRequired: false,
          reasonCode: null,
          status: body.action === "recovered_new"
            ? "merged"
            : body.action === "abandon" ? "stopped" : "conflicted",
          version: 8,
        }),
        recovery: {
          journalStatus: body.action === "recovered_old"
            ? "resolved_old"
            : body.action === "recovered_new" ? "resolved_new" : "abandoned",
          observedManifestHash: OBSERVED,
        },
        uncleanedOwnedPathCount: body.action === "abandon" ? 1 : 0,
        uncleanedOwnedPaths: body.action === "abandon" ? ["owned/item-21.tmp"] : [],
      });
    }
    if (url.pathname.endsWith("/approvals")) {
      return Response.json({ items: [], nextCursor: null });
    }
    if (url.pathname.endsWith("/events")) {
      return Response.json({ items: [], nextCursor: null });
    }
    throw new Error(`Unexpected request ${url.pathname}${url.search}`);
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("T-30 manual recovery UI", () => {
  it("replaces ordinary actions, shows manifest facts, and independently pages affected paths", async () => {
    installFetch();
    const user = userEvent.setup();
    render(<ExecutionPanel projectId={PROJECT_ID} />);

    const card = await screen.findByRole("region", { name: "Recover workspace" });
    const recovery = await within(card).findByRole("region", { name: "需要人工恢复" });
    await within(recovery).findByText("rollback_after_replace");
    expect(recovery).toHaveTextContent("rollback_after_replace");
    expect(recovery).toHaveTextContent("整体不匹配");
    expect(recovery).toHaveTextContent(OLD.slice(0, 12));
    expect(recovery).toHaveTextContent(POST.slice(0, 12));
    expect(recovery).toHaveTextContent(OBSERVED.slice(0, 12));
    expect(recovery).toHaveTextContent("平台已停止自动改写");
    expect(within(card).queryByRole("tablist", { name: "执行审阅" })).toBeNull();
    expect(within(card).queryByRole("button", { name: /暂停|继续|停止|批准|合入|重试推进/u })).toBeNull();

    expect(await within(recovery).findByText("src/changed.ts")).toBeInTheDocument();
    await user.click(within(recovery).getByRole("button", { name: "加载更多差异路径" }));
    expect(await within(recovery).findByText("owned/item-21.tmp")).toBeInTheDocument();
  });

  it.each([
    ["recovered_old", "已恢复为旧版本并重试", "确认已恢复旧版本", "重试 Recover workspace"],
    ["recovered_new", "已确认完整新版本", "确认完整新版本", "Recover workspace"],
    ["abandon", "放弃且不改 canonical", "确认放弃恢复", "Recover workspace"],
  ] as const)(
    "submits exact %s only after second confirmation and restores focus to its outcome",
    async (action, firstLabel, confirmLabel, focusName) => {
      const calls = installFetch();
      const user = userEvent.setup();
      render(<ExecutionPanel projectId={PROJECT_ID} />);
      const recovery = await screen.findByRole("region", { name: "需要人工恢复" });

      await user.click(await within(recovery).findByRole("button", { name: firstLabel }));
      const confirmation = screen.getByRole("dialog", { name: /确认人工恢复/u });
      expect(confirmation).toHaveTextContent("整个 manifest");
      expect(confirmation).toHaveTextContent("expected version 7");
      expect(confirmation).toHaveTextContent(OBSERVED.slice(0, 12));
      expect(calls).toHaveLength(0);
      await user.click(within(confirmation).getByRole("button", { name: confirmLabel }));

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({
        action,
        expectedVersion: 7,
        observedManifestHash: OBSERVED,
      });
      if (action === "recovered_old") {
        const outcome = await screen.findByRole("button", { name: focusName });
        await waitFor(() => expect(outcome).toHaveFocus());
      } else {
        const outcome = await screen.findByRole("heading", { name: focusName });
        await waitFor(() => expect(outcome).toHaveFocus());
      }
      if (action === "abandon") {
        expect(screen.getByText("owned/item-21.tmp")).toBeInTheDocument();
      }
    },
  );

  it("refreshes the observed manifest and clears confirmation after mismatch", async () => {
    let mismatch = true;
    installFetch(() => {
      if (mismatch) {
        mismatch = false;
        return Response.json({
          error: { code: "RECOVERY_MANIFEST_MISMATCH", message: "changed" },
          recovery: { observedManifestHash: CHANGED, observedPathCount: 2 },
        }, { status: 409 });
      }
      return Response.json({});
    });
    const user = userEvent.setup();
    render(<ExecutionPanel projectId={PROJECT_ID} />);
    const recovery = await screen.findByRole("region", { name: "需要人工恢复" });
    await user.click(await within(recovery).findByRole("button", { name: "放弃且不改 canonical" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认放弃恢复" }));

    expect(await within(recovery).findByText(new RegExp(CHANGED.slice(0, 12), "u"))).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /确认人工恢复/u })).toBeNull();
    expect(within(recovery).getByRole("alert")).toHaveTextContent("manifest");
  });
});
