// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType, ReactNode } from "react";

import { ProjectPanel } from "@/components/project-panel";

type ProjectContextModule = {
  ProjectContextPanel: ComponentType<{
    projectId: string;
    skeleton: ReactNode;
  }>;
};

const modules =
  import.meta.glob<ProjectContextModule>("../../../components/project-context/project-context-panel.tsx");

async function projectContextPanel() {
  const load =
    modules["../../../components/project-context/project-context-panel.tsx"];
  expect(load, "the right-panel tab system must exist").toBeTypeOf("function");
  return (await load()).ProjectContextPanel;
}

function stubMobile(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: true,
      media: "(max-width: 56.25rem)",
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("context navigation accessibility", () => {
  it("implements selected roving tabs with Arrow, Home and End keys", async () => {
    const ProjectContextPanel = await projectContextPanel();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/memories")) {
          return Response.json({ memories: [] });
        }
        if (url.includes("/audit-events")) {
          return Response.json({
            events: [],
            freshness: { lag: 0, status: "caught_up" },
            nextBeforeSeq: null,
          });
        }
        if (url.includes("/approvals/pending")) {
          return Response.json({ approvals: [] });
        }
        return Response.json({ members: [], projectVersion: 1 });
      }),
    );
    const user = userEvent.setup();
    render(
      <ProjectContextPanel
        projectId="project-1"
        skeleton={<p>骨架内容</p>}
      />,
    );

    const tabs = screen.getByRole("tablist", { name: "项目上下文资源" });
    const memory = within(tabs).getByRole("tab", { name: "共享记忆" });
    const context = within(tabs).getByRole("tab", { name: "上下文预览" });
    const skeleton = within(tabs).getByRole("tab", { name: "骨架运行" });
    const approvals = within(tabs).getByRole("tab", { name: "审批" });
    const audit = within(tabs).getByRole("tab", { name: "审计" });
    expect(memory).toHaveAttribute("aria-selected", "true");
    memory.focus();
    await user.keyboard("{ArrowRight}");
    expect(context).toHaveFocus();
    expect(context).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(audit).toHaveFocus();
    expect(audit).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("尚无审计事件。")).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(approvals).toHaveFocus();
    expect(approvals).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("没有待裁决的请求。")).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(skeleton).toHaveFocus();
    expect(screen.getByText("骨架内容")).toBeInTheDocument();
    await user.keyboard("{Home}");
    expect(memory).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(audit).toHaveFocus();
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  });

  it("integrates tabs in the single narrow context modal without exposing background interaction", async () => {
    stubMobile();
    window.history.replaceState(null, "", "/projects/project-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        const payloads: Record<string, unknown> = {
          "/api/projects": {
            projects: [
              {
                id: "project-1",
                name: "Launch",
                createdAt: "2026-08-08T00:00:00.000Z",
              },
            ],
          },
          "/api/projects/project-1/tasks": { tasks: [], events: [] },
          "/api/projects/project-1/workspace": {
            workspace: null,
            projectVersion: 1,
          },
          "/api/projects/project-1/members": {
            members: [],
            projectVersion: 1,
          },
          "/api/projects/project-1/capability-insight": {
            portraits: [],
            suggestions: [],
          },
          "/api/projects/project-1/mission": {
            mission: null,
            workItems: [],
          },
          "/api/agents": { agents: [] },
        };
        if (url.pathname.endsWith("/memories")) {
          return Response.json({ memories: [] });
        }
        const payload = payloads[url.pathname];
        if (!payload) throw new Error(`Unexpected request: ${url.pathname}`);
        return Response.json(payload);
      }),
    );
    const user = userEvent.setup();
    render(<ProjectPanel />);
    const opener = await screen.findByRole("button", {
      name: "打开当前任务上下文",
    });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "当前任务上下文" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByTestId("editor-surface")).toHaveAttribute("inert");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();

    const css = readFileSync(join(process.cwd(), "app", "cockpit.css"), "utf8");
    expect(css).toMatch(
      /\.project-context-tabs\s*\{[^}]*gap:\s*var\(--space-2\)/s,
    );
    expect(css).toMatch(
      /\.project-context-tabs button\[aria-selected="true"\]\s*\{[^}]*background:\s*var\(--interactive-accent-soft\)[^}]*color:\s*var\(--text-primary\)/s,
    );
  });
});
