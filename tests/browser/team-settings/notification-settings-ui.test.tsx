// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RootLayout from "@/app/layout";
import { NOTIFICATION_PREFS_KEY } from "@/components/notifications/browser-notification-adapter";
import { __settingsPreferencesStoreTest } from "@/components/settings-preferences-store";
import { TeamPanel } from "@/components/team-panel";

class MockNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn(
    async (): Promise<NotificationPermission> => MockNotification.permission,
  );

  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {}
}

function stubTeamResources() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const payloads: Record<string, unknown> = {
        "/api/agent-templates": { templates: [] },
        "/api/agents": { agents: [] },
        "/api/providers": { providers: [] },
        "/api/skills": { skills: [] },
      };
      const payload = payloads[input.toString()];
      if (!payload) throw new Error(`Unexpected request: ${input.toString()}`);
      return Response.json(payload);
    }),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      media: "(max-width: 56.25rem)",
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  __settingsPreferencesStoreTest?.reset(
    () => new Date("2026-08-08T00:00:01.000Z"),
  );
  window.localStorage.clear();
  MockNotification.permission = "default";
  MockNotification.requestPermission = vi.fn(
    async (): Promise<NotificationPermission> => MockNotification.permission,
  );
  vi.stubGlobal("Notification", MockNotification);
  stubTeamResources();
});

afterEach(() => {
  __settingsPreferencesStoreTest?.reset();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("team notification settings", () => {
  it("renders a 通知 region with both type switches off and 44px token targets", () => {
    render(<TeamPanel returnTo="/" section="skills" />);

    const region = screen.getByRole("region", { name: "通知" });
    const approval = within(region).getByRole("switch", { name: "审批通知" });
    const mission = within(region).getByRole("switch", { name: "任务通知" });
    expect(approval).toHaveAttribute("aria-checked", "false");
    expect(mission).toHaveAttribute("aria-checked", "false");
    expect(approval).toHaveClass("notification-switch");
    expect(mission).toHaveClass("notification-switch");

    const cockpit = readFileSync(join(process.cwd(), "app", "cockpit.css"), "utf8");
    const tokens = readFileSync(join(process.cwd(), "app", "tokens.css"), "utf8");
    expect(tokens).toContain("--control-min: 2.75rem");
    expect(cockpit).toMatch(
      /\.notification-switch\s*\{[^}]*min-height:\s*var\(--control-min\)[^}]*min-width:\s*var\(--control-min\)/s,
    );
  });

  it("persists the approval switch and shows degraded copy when permission is denied", async () => {
    const user = userEvent.setup();
    MockNotification.permission = "denied";
    render(<TeamPanel returnTo="/" section="skills" />);

    const region = screen.getByRole("region", { name: "通知" });
    expect(
      within(region).getByText("浏览器未授权系统通知，驾驶舱不会弹出提醒。"),
    ).toBeInTheDocument();

    await user.click(within(region).getByRole("switch", { name: "审批通知" }));

    await waitFor(() => {
      expect(
        within(region).getByRole("switch", { name: "审批通知" }),
      ).toHaveAttribute("aria-checked", "true");
    });
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
    const stored = JSON.parse(
      window.localStorage.getItem(NOTIFICATION_PREFS_KEY) ?? "null",
    ) as { approval?: boolean; mission?: boolean };
    expect(stored.approval).toBe(true);
    expect(stored.mission).toBe(false);
    expect(
      within(region).getByText("浏览器未授权系统通知，驾驶舱不会弹出提醒。"),
    ).toBeInTheDocument();
  });

  it("links a local PWA manifest that does not cache API or .data", () => {
    const layout = RootLayout({ children: null });
    const markup = JSON.stringify(layout);
    expect(markup).toContain("/manifest.webmanifest");

    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "public", "manifest.webmanifest"), "utf8"),
    ) as {
      theme_color?: string;
      icons?: Array<{ src?: string }>;
    };
    expect(manifest.theme_color).toBe("#7B3F31");
    expect(manifest.icons?.[0]?.src).toBe("/cool-ai-mark.svg");

    const manifestSource = readFileSync(
      join(process.cwd(), "public", "manifest.webmanifest"),
      "utf8",
    );
    expect(manifestSource).not.toMatch(/\/api\/|\.data/u);
    expect(readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8")).toContain(
      'rel="manifest"',
    );
  });
});
