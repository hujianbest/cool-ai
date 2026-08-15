// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActivityBar } from "@/components/activity-bar";
import { ProjectPanel } from "@/components/project-panel";
import { TeamPanel } from "@/components/team-panel";

vi.mock("@/components/project-context/project-setup-panel", () => ({
  ProjectSetupPanel: () => <section>项目设置</section>,
}));
vi.mock("@/components/task-panel", () => ({
  TaskPanel: () => <section>任务</section>,
}));
vi.mock("@/components/agent-panel", () => ({
  AgentPanel: () => <section>Agent</section>,
}));
vi.mock("@/components/provider-panel", () => ({
  ProviderPanel: () => <section>模型服务</section>,
}));
vi.mock("@/components/skill-panel", () => ({
  SkillPanel: () => <section>技能</section>,
}));

function themeToggle() {
  return screen.getByRole("button", { name: /主题/ });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "light";
  document.documentElement.style.colorScheme = "light";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString() === "/api/projects") {
        return Response.json({ projects: [] });
      }
      throw new Error(`Unexpected request: ${input.toString()}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ActivityBar theme toggle", () => {
  it("keeps the ActivityBar in the first narrow column while normal content uses the second", () => {
    const tokens = readFileSync("app/tokens.css", "utf8");
    const narrow = tokens.slice(tokens.indexOf("@media (max-width: 56.25rem)"));

    expect(narrow).toMatch(
      /\.collaboration-cockpit\s*\{[^}]*grid-template-columns:\s*var\(--activity-bar-width\) minmax\(0, 1fr\)[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s,
    );
    expect(narrow).toMatch(
      /\.activity-bar\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*1\s*\/\s*span 2/s,
    );
    expect(narrow).toMatch(
      /\.mobile-toolbar\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*1/s,
    );
    expect(narrow).toMatch(
      /\.collaboration-cockpit > \.cockpit-flow\[role="tabpanel"\]\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*2[^}]*width:\s*var\(--full-width\)/s,
    );
    expect(narrow).toMatch(
      /\.narrow-project-load-error\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*2/s,
    );
  });

  it("keeps narrow drawers as fixed overlays at their existing widths", () => {
    const tokens = readFileSync("app/tokens.css", "utf8");
    const narrow = tokens.slice(tokens.indexOf("@media (max-width: 56.25rem)"));

    expect(narrow).toMatch(
      /\.cockpit-sidebar,[\s\S]*?\.cockpit-context\s*\{[^}]*position:\s*fixed/s,
    );
    expect(narrow).toMatch(
      /\.cockpit-sidebar\[data-open="true"\]\s*\{[^}]*width:\s*var\(--sidebar-width\)/s,
    );
    expect(narrow).toMatch(
      /\.cockpit-context\[data-open="true"\]\s*\{[^}]*width:\s*var\(--context-width\)/s,
    );
    expect(narrow).toMatch(
      /\.cockpit-flow\[data-open="true"\]\s*\{[^}]*inset:\s*0[^}]*width:\s*var\(--full-width\)/s,
    );
  });

  it("inherits its 44px target from the existing control token", () => {
    const tokens = readFileSync("app/tokens.css", "utf8");
    const cockpit = readFileSync("app/cockpit.css", "utf8");

    expect(tokens).toContain("--control-min: 2.75rem");
    expect(cockpit).toMatch(
      /\.activity-bar \.activity-bar-item\s*\{[^}]*min-height:\s*var\(--control-min\)[^}]*min-width:\s*var\(--control-min\)/s,
    );
  });

  it("styles the activity rail with rail tokens and a gold current item", () => {
    const cockpit = readFileSync("app/cockpit.css", "utf8");

    expect(cockpit).toMatch(
      /\.activity-bar\s*\{[^}]*background:\s*var\(--color-rail\)[^}]*color:\s*var\(--color-rail-ink\)/s,
    );
    expect(cockpit).toMatch(
      /\.activity-bar \.activity-bar-item\[aria-current="page"\]\s*\{[^}]*color:\s*var\(--interactive-primary\)/s,
    );
  });

  it("renders a non-claiming disabled loading control before hydration", () => {
    const html = renderToString(<ActivityBar activePath="/" />);

    expect(html).toContain('class="activity-bar-item"');
    expect(html).toContain('aria-label="主题偏好加载中"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
    expect(html).toContain(">·<");
    expect(html).not.toMatch(/>[夜日]</);
    expect(html).not.toMatch(/aria-label="主题偏好加载中"[^>]*aria-pressed/);
  });

  it("switches immediately by pointer and keyboard while keeping root and ARIA synchronized", async () => {
    const user = userEvent.setup();
    render(<ActivityBar activePath="/" />);

    const toggle = await screen.findByRole("button", {
      name: "当前为明色主题，切换到暗色主题",
    });
    expect(toggle).toHaveClass("activity-bar-item");
    expect(toggle.querySelector("svg")).not.toBeNull();
    expect(toggle).not.toHaveTextContent("夜");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).not.toBeDisabled();
    expect(toggle).not.toHaveAttribute("aria-busy");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    await user.click(toggle);
    expect(toggle.querySelector("svg")).not.toBeNull();
    expect(toggle).not.toHaveTextContent("日");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAccessibleName("当前为暗色主题，切换到明色主题");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    toggle.focus();
    await user.keyboard(" ");
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("announces a write failure without stealing focus or changing the active theme", async () => {
    // This test requires the theme store to fail on write
    // Since the store captures localStorage at module load, we need to mock it early
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();

    render(<ActivityBar activePath="/" />);
    const toggle = await screen.findByRole("button", {
      name: "当前为明色主题，切换到暗色主题",
    });

    // jsdom Storage instances do not honor own-property setItem overrides for
    // window.localStorage writes, so the failure must be injected on the
    // Storage prototype (verified by focused probe).
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage unavailable");
      });

    toggle.focus();
    await user.keyboard("{Enter}");

    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("status")).toHaveTextContent(
      "主题偏好保存失败，仍保持当前主题",
    );
    expect(screen.getByRole("status")).toHaveClass("activity-bar-status");

    setItemSpy.mockRestore();
    consoleError.mockRestore();
  });

  it("uses a non-wrapping overlay for storage errors without consuming navigation space", () => {
    const cockpit = readFileSync("app/cockpit.css", "utf8");

    expect(cockpit).toMatch(
      /\.activity-bar \.activity-bar-item\s*\{[^}]*white-space:\s*nowrap/s,
    );
    expect(cockpit).toMatch(
      /\.activity-bar-status\s*\{[^}]*position:\s*absolute[^}]*width:\s*var\(--sidebar-width\)/s,
    );
  });
});

describe("ActivityBar route integration", () => {
  it.each([
    ["/", "workbench"],
    ["/projects/project-1", "real project"],
  ])("mounts exactly one shared toggle on %s (%s)", async (path) => {
    window.history.replaceState(null, "", path);
    render(<ProjectPanel />);

    const nav = screen.getByRole("navigation", { name: "主导航" });
    await waitFor(() =>
      expect(within(nav).getAllByRole("button", { name: /主题/ })).toHaveLength(1),
    );
  });

  it("mounts exactly one shared toggle on /team and preserves theme across routes", async () => {
    window.history.replaceState(null, "", "/");
    const user = userEvent.setup();
    const project = render(<ProjectPanel />);
    const projectToggle = await screen.findByRole("button", {
      name: "当前为明色主题，切换到暗色主题",
    });
    await user.click(projectToggle);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    project.unmount();

    window.history.replaceState(null, "", "/team");
    render(<TeamPanel />);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const toggles = within(nav).getAllByRole("button", { name: /主题/ });
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
});
