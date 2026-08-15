// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectPanel } from "@/components/project-panel";
import type {
  CollaborationRun,
  DecisionRequest,
} from "@/src/shared/collaboration-contracts";
import {
  TEST_RUN_ID,
  TEST_THREAD_ID,
  threadDetailPayload,
  threadFactsPayload,
  threadListPayload,
  threadMessage,
  threadMessagesPayload,
  threadRun,
  threadTimelinePayload,
} from "@/tests/cockpit-test-fetch";

const project = {
  createdAt: "2026-07-30T00:00:00.000Z",
  id: "project-1",
  name: "Launch plan",
};

const members = {
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

function run(status: CollaborationRun["status"] = "paused"): CollaborationRun {
  return threadRun(project.id, status);
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
  version: 1,
};

function stubViewport(narrow: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: narrow,
      media: "(max-width: 56.25rem)",
      removeEventListener: vi.fn(),
    })),
  );
}

function installFetch(status: CollaborationRun["status"] = "paused") {
  const calls: Array<{ body: Record<string, unknown>; url: string }> = [];
  window.history.replaceState(
    null,
    "",
    `/projects/${project.id}?thread=${TEST_THREAD_ID}&run=${TEST_RUN_ID}`,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/control")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({ body, url });
        return Response.json({
          fact: threadFactsPayload(project.id).items[1],
          run: run(body.action === "stop" ? "stopped" : status),
        });
      }
      if (init?.method === "POST" && url.includes("/decisions/")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({ body, url });
        const message = threadMessage(project.id);
        const facts = threadFactsPayload(project.id).items;
        return Response.json({
          decision: {
            ...decision,
            answer: body.answer,
            projectId: project.id,
            status: "answered",
            threadId: TEST_THREAD_ID,
            version: 2,
          },
          facts: [facts[0], facts[1]],
          message,
          run: run("paused"),
        });
      }
      const payloads: Record<string, unknown> = {
        "/api/agents": { agents: [] },
        "/api/projects": { projects: [project] },
        "/api/projects/project-1/members": members,
        "/api/projects/project-1/capability-insight": {
          portraits: [],
          suggestions: [],
        },
        "/api/projects/project-1/threads?limit=100":
          threadListPayload(project.id),
        [`/api/projects/project-1/threads/${TEST_THREAD_ID}?run=${TEST_RUN_ID}`]:
          threadDetailPayload(project.id, status),
        [`/api/projects/project-1/threads/${TEST_THREAD_ID}/messages`]:
          threadMessagesPayload(project.id),
        [`/api/projects/project-1/threads/${TEST_THREAD_ID}/facts`]:
          threadFactsPayload(project.id),
        [`/api/projects/project-1/threads/${TEST_THREAD_ID}/runs/${TEST_RUN_ID}/timeline`]:
          threadTimelinePayload(
            project.id,
            status === "waiting_owner" ? decision : undefined,
          ),
        "/api/projects/project-1/mission": {
          mission: {
            createdAt: "2026-07-30T00:00:00.000Z",
            goal: "Prepare launch",
            id: "mission-1",
            projectId: project.id,
            title: "Launch",
            updatedAt: "2026-07-30T00:00:00.000Z",
            version: 1,
          },
          workItems: [],
        },
        "/api/projects/project-1/tasks": { events: [], tasks: [] },
        "/api/projects/project-1/workspace": {
          projectVersion: 1,
          workspace: null,
        },
      };
      const payload = payloads[url];
      if (!payload) throw new Error(`Unexpected request: ${url}`);
      return Response.json(payload);
    }),
  );
  return calls;
}

function channel(hex: string): [number, number, number] {
  const value = hex.slice(1);
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function luminance(hex: string): number {
  const components = channel(hex).map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * components[0] + 0.7152 * components[1] + 0.0722 * components[2];
}

function contrast(left: string, right: string): number {
  const lighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

afterEach(() => {
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("narrow collaboration cockpit accessibility", () => {
  it("uses the chat surface without board or run tabs", async () => {
    stubViewport(true);
    installFetch();
    const user = userEvent.setup();
    const view = render(<ProjectPanel />);

    await user.click(await screen.findByRole("button", { name: "打开编辑" }));
    const editor = screen.getByRole("dialog", { name: "任务编辑" });
    expect(within(editor).queryByRole("tablist", { name: "协作视图" })).toBeNull();
    expect(within(editor).queryByRole("tab", { name: "看板" })).toBeNull();
    expect(within(editor).queryByRole("tab", { name: "运行详情" })).toBeNull();
    expect(within(editor).queryByRole("heading", { name: "使命看板" })).toBeNull();
    expect(within(editor).getByLabelText("发送给项目对话")).toBeVisible();

    view.unmount();
    stubViewport(false);
    installFetch();
    render(<ProjectPanel />);
    expect(await screen.findByRole("heading", { name: "项目对话" })).toHaveClass("sr-only");
    expect(screen.queryByRole("heading", { name: "使命看板" })).toBeNull();
    expect(screen.queryByRole("region", { name: "运行控制" })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "协作视图" })).toBeNull();
  });

  it("keeps the chat composer reachable from the narrow editor without run chrome", async () => {
    stubViewport(true);
    installFetch("waiting_owner");
    const user = userEvent.setup();
    render(<ProjectPanel />);

    await user.click(await screen.findByRole("button", { name: "打开编辑" }));
    const editor = screen.getByRole("dialog", { name: "任务编辑" });
    expect(within(editor).queryByRole("tab", { name: "运行详情" })).toBeNull();
    const composer = within(editor).getByLabelText("发送给项目对话");
    composer.focus();
    expect(composer).toHaveFocus();
    expect(within(editor).queryByRole("button", { name: "停止" })).toBeNull();
  });

  it("keeps the editor as the sole modal without a nested run confirmation surface", async () => {
    stubViewport(true);
    installFetch();
    const user = userEvent.setup();
    render(<ProjectPanel />);

    await user.click(await screen.findByRole("button", { name: "打开编辑" }));
    const editor = screen.getByRole("dialog", { name: "任务编辑" });
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(editor).queryByRole("tab", { name: "运行详情" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "确认停止协作" })).toBeNull();
    expect(editor).toHaveAttribute("aria-modal", "true");
  });

  it("keeps target sizing and text colors on accessible design tokens", () => {
    const tokens = readFileSync("app/tokens.css", "utf8");
    const cockpit = readFileSync("app/cockpit.css", "utf8");
    const lightBlock = tokens.slice(
      tokens.indexOf(":root"),
      tokens.indexOf(':root[data-theme="dark"]'),
    );
    const declarations = new Map(
      [...lightBlock.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map(
        (match) => [match[1], match[2].trim()] as const,
      ),
    );
    const token = (name: string) => {
      let value = declarations.get(name);
      for (let depth = 0; depth < 3 && value; depth += 1) {
        const ref = value.match(/var\(--([^)]+)\)/);
        if (!ref) break;
        value = declarations.get(ref[1]);
      }
      return value?.match(/#[0-9A-Fa-f]{6}/)?.[0] ?? "";
    };

    expect(tokens).toContain("--control-min: 2.75rem");
    expect(cockpit).toContain("min-height: var(--control-min)");
    expect(cockpit).toMatch(/\.collaboration-mobile-tabs[\s\S]*var\(--/);
    // Pair contract mirrors the canonical AA matrix in
    // tests/browser/cockpit-shell/visual-tokens.test.ts (DESIGN.md tokens).
    expect(
      contrast(token("text-primary"), token("surface-card")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(token("text-subtle"), token("surface-panel")),
    ).toBeGreaterThanOrEqual(3.0);
    expect(
      contrast(token("danger"), token("status-danger-surface")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(cockpit).not.toMatch(/\.collaboration-mobile-tabs[^}]*#[0-9A-Fa-f]{3,8}/);
  });

  it("floats the composer on overlay shadows and keeps chat chrome on tokens", () => {
    const tokens = readFileSync("app/tokens.css", "utf8");
    const cockpit = readFileSync("app/cockpit.css", "utf8");

    expect(tokens).toContain("--accent: var(--color-primary)");
    expect(tokens).toContain("--surface: var(--color-on-primary)");
    expect(tokens).toContain("--text-muted: var(--text-subtle)");
    expect(cockpit).toMatch(
      /\.composer\s*\{[^}]*background:\s*var\(--color-card-strong\)[^}]*border-radius:\s*var\(--rounded-lg\)[^}]*box-shadow:\s*var\(--shadow-1\),\s*var\(--shadow-2\)/s,
    );
    expect(cockpit).toMatch(
      /\.cockpit-flow \.panel-heading\s*\{[^}]*background:\s*var\(--surface-panel\)[^}]*border-bottom:[^;]*var\(--border-subtle\)/s,
    );
    expect(cockpit).toMatch(
      /\.collaboration-timeline\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0/s,
    );
    expect(cockpit).toMatch(
      /\.structured-block\s*\{[^}]*background:\s*var\(--surface-card\)[^}]*border-radius:\s*var\(--rounded-md\)/s,
    );
  });
});
