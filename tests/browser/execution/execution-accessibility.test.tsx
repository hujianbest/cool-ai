// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionPanel } from "@/components/execution/execution-panel";

const PROJECT_ID = "project-execution-a11y";
const HASH = "a".repeat(64);

function execution(id: string, title: string) {
  return {
    agent: { accentToken: "sage", avatarText: "A", id: `agent-${id}`, name: `Agent ${id}` },
    attemptNo: 1,
    businessDeadlineAt: null,
    businessRounds: 0,
    createdAt: "2026-07-30T08:00:00.000Z",
    currentAction: {
      actionIndex: null,
      kind: null,
      lastHeartbeatAt: null,
      overallDeadlineAt: null,
      startedAt: null,
    },
    firstRunningAt: null,
    id,
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
    reasonCode: "OWNER_PAUSED",
    resumeTarget: "running",
    sourceCollaborationRunId: "run-a11y",
    status: "paused",
    toolCalls: 0,
    updatedAt: "2026-07-30T08:00:00.000Z",
    usage: { completionTokens: 0, maxTokens: 2_000, promptTokens: 0, totalTokens: 0 },
    version: 1,
    workItem: { id: `task-${id}`, title },
  } as const;
}

function detail(item: ReturnType<typeof execution>) {
  return {
    counts: {
      approvals: 0,
      artifacts: 0,
      events: 0,
      mergeFiles: 0,
      stagedBlockers: 0,
      stagedObservations: 0,
      validations: 0,
    },
    execution: item,
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
    staged: null,
  };
}

function stubViewport(narrow: boolean) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    addEventListener: vi.fn(),
    matches: narrow,
    media: "(max-width: 56.25rem)",
    removeEventListener: vi.fn(),
  })));
}

function installFetch() {
  const first = execution("execution-one", "First execution");
  const second = execution("execution-two", "Second execution");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/mission")) return Response.json({ mission: null, workItems: [] });
    if (url.pathname.endsWith("/collaboration")) {
      return Response.json({ run: { id: "run-a11y", status: "planned" } });
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/executions`) {
      return Response.json({ executions: [first, second] });
    }
    if (url.pathname === `/api/executions/${first.id}`) return Response.json(detail(first));
    if (url.pathname === `/api/executions/${second.id}`) return Response.json(detail(second));
    if (url.pathname.endsWith("/events")) return Response.json({ items: [], nextCursor: null });
    throw new Error(`Unexpected request ${url.pathname}`);
  }));
}

afterEach(() => {
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("T-30 execution accessibility", () => {
  it("uses a narrow summary switcher and exactly one trapped detail overlay with Escape restore", async () => {
    stubViewport(true);
    installFetch();
    const user = userEvent.setup();
    render(<ExecutionPanel projectId={PROJECT_ID} />);

    const switcher = await screen.findByRole("list", { name: "执行摘要切换" });
    expect(within(switcher).getAllByRole("button")).toHaveLength(2);
    const firstTrigger = within(switcher).getByRole("button", { name: /First execution/u });
    await user.click(firstTrigger);

    const dialog = screen.getByRole("dialog", { name: "First execution 详情" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(switcher.closest(".execution-panel")).toHaveAttribute("inert");
    const close = within(dialog).getByRole("button", { name: "关闭执行详情" });
    const controls = within(dialog).getAllByRole("button");
    controls.at(-1)!.focus();
    await user.keyboard("{Tab}");
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(firstTrigger).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps desktop dual cards unchanged and exposes text status, focus, target, and overflow tokens", async () => {
    stubViewport(false);
    installFetch();
    render(<ExecutionPanel projectId={PROJECT_ID} />);
    expect(await screen.findByRole("region", { name: "First execution" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Second execution" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "执行摘要切换" })).toBeNull();
    expect(screen.getAllByText("已暂停")).toHaveLength(2);
    expect(screen.getAllByText(/阻断原因：OWNER_PAUSED/u)).toHaveLength(2);

    const css = readFileSync("app/cockpit.css", "utf8");
    const tokens = readFileSync("app/tokens.css", "utf8");
    expect(css).toMatch(/execution-mobile[\s\S]*overflow-x:\s*hidden/u);
    expect(css).toMatch(/execution[\s\S]*min-height:\s*var\(--control-min\)/u);
    expect(`${css}\n${tokens}`).toMatch(/focus-visible/u);
    expect(tokens).toContain("--control-min: 2.75rem");
    expect(css).not.toMatch(/\.execution[\s\S]{0,120}(#[0-9a-f]{3,8}|rgb\()/iu);
  });
});
