import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import TeamPage from "@/app/team/page";
import { ProjectPanel } from "@/components/project-panel";
import {
  __settingsPreferencesStoreTest,
  pinSettingsSection,
} from "@/components/settings-preferences-store";

const project = {
  createdAt: "2026-07-29T00:00:00.000Z",
  id: "project-1",
  name: "Launch plan",
};

function stubApplicationFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/projects") {
        return Response.json({ projects: [project] });
      }
      if (url === `/api/projects/${project.id}/tasks`) {
        return Response.json({ events: [], tasks: [] });
      }
      const teamPayloads: Record<string, unknown> = {
        "/api/agent-templates": { templates: [] },
        "/api/agents": { agents: [] },
        "/api/providers": { providers: [] },
        "/api/skills": { skills: [] },
      };
      const payload = teamPayloads[url];
      if (!payload) throw new Error(`Unexpected request: ${url}`);
      return Response.json(payload);
    }),
  );
}

function stubNarrow(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches,
      media: "(max-width: 56.25rem)",
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  __settingsPreferencesStoreTest?.reset({
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    uuid: () => "event-1",
    writerId: "project-return-test",
  });
  __settingsPreferencesStoreTest?.hydrate();
  expect(pinSettingsSection("agents")).toBe(true);
  stubApplicationFetch();
});

afterEach(() => {
  __settingsPreferencesStoreTest?.reset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("real project settings return path", () => {
  it("carries the current project through ordinary and pinned ActivityBar entries", async () => {
    stubNarrow(false);
    window.history.replaceState(null, "", `/projects/${project.id}`);
    render(<ProjectPanel />);

    await screen.findByRole("button", { name: project.name });
    const expectedReturnTo = encodeURIComponent(`/projects/${project.id}`);
    expect(screen.getByRole("link", { name: "工作" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect.soft(screen.getByRole("link", { name: "团队" })).toHaveAttribute(
      "href",
      `/team?section=skills&returnTo=${expectedReturnTo}`,
    );
    expect.soft(
      await screen.findByRole("link", { name: "打开固定设置：Agent" }),
    ).toHaveAttribute(
      "href",
      `/team?section=agents&returnTo=${expectedReturnTo}`,
    );
  });

  it("preserves canonical thread and run selection across routed history props", async () => {
    stubNarrow(false);
    const RoutedProjectPanel = ProjectPanel as ComponentType<{
      returnTo?: string;
    }>;
    const first =
      `/projects/${project.id}?thread=thread-1&run=run-1`;
    const second =
      `/projects/${project.id}?thread=thread-2&run=run-2`;
    window.history.replaceState(null, "", first);
    const view = render(<RoutedProjectPanel returnTo={first} />);

    await screen.findByRole("button", { name: project.name });
    expect(screen.getByRole("link", { name: "团队" })).toHaveAttribute(
      "href",
      `/team?section=skills&returnTo=${encodeURIComponent(first)}`,
    );

    window.history.pushState(null, "", second);
    window.dispatchEvent(new PopStateEvent("popstate"));
    view.rerender(<RoutedProjectPanel returnTo={second} />);
    expect(screen.getByRole("link", { name: "团队" })).toHaveAttribute(
      "href",
      `/team?section=skills&returnTo=${encodeURIComponent(second)}`,
    );

    window.history.back();
    view.rerender(<RoutedProjectPanel returnTo={first} />);
    expect(screen.getByRole("link", { name: "团队" })).toHaveAttribute(
      "href",
      `/team?section=skills&returnTo=${encodeURIComponent(first)}`,
    );
  });

  it.each([
    ["desktop", false],
    ["narrow", true],
  ])("returns from team to the same project on %s", async (_label, narrow) => {
    stubNarrow(narrow);
    const user = userEvent.setup();
    render(
      await TeamPage({
        searchParams: Promise.resolve({
          returnTo: `/projects/${project.id}`,
          section: "agents",
        }),
      }),
    );

    if (narrow) {
      await user.click(
        screen.getByRole("button", { name: "打开团队资源" }),
      );
      const dialog = await screen.findByRole("dialog", { name: "团队导航" });
      expect(
        within(dialog).getByRole("link", { name: "返回原位置" }),
      ).toHaveAttribute("href", `/projects/${project.id}`);
      return;
    }

    expect(screen.getByRole("link", { name: "返回原位置" })).toHaveAttribute(
      "href",
      `/projects/${project.id}`,
    );
  });

  it.each([
    ["direct", undefined],
    ["illegal", "https://evil.example/projects/project-1"],
  ])("falls back to root for %s team deep links", async (_label, returnTo) => {
    stubNarrow(false);
    render(
      await TeamPage({
        searchParams: Promise.resolve({ returnTo, section: "skills" }),
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "返回原位置" })).toHaveAttribute(
        "href",
        "/",
      ),
    );
  });
});
