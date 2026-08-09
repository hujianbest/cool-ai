// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActivityBar } from "@/components/activity-bar";
import {
  __settingsPreferencesStoreTest,
  PINNED_SETTINGS_KEY,
} from "@/components/settings-preferences-store";
import { TeamPanel } from "@/components/team-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

function stubResources() {
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
  stubResources();
});

afterEach(() => {
  __settingsPreferencesStoreTest?.reset();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settings pinning UI", () => {
  it("server-renders hydration as busy with every pin control disabled", () => {
    const markup = renderToStaticMarkup(
      <TeamPanel returnTo="/projects/project-1" section="skills" />,
    );
    const document = new DOMParser().parseFromString(markup, "text/html");
    const controls = document.querySelector('[aria-label="固定设置分区"]');

    expect(controls?.getAttribute("aria-busy")).toBe("true");
    expect(
      Array.from(controls?.querySelectorAll("button") ?? []),
    ).toHaveLength(3);
    for (const button of controls?.querySelectorAll("button") ?? []) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("pins immediately, updates ActivityBar, and renders readonly clock history", async () => {
    const user = userEvent.setup();
    render(<TeamPanel returnTo="/projects/project-1" section="skills" />);

    const controls = screen.getByLabelText("固定设置分区");
    await waitFor(() => expect(controls).toHaveAttribute("aria-busy", "false"));
    const pinSkill = within(controls).getByRole("button", { name: "固定技能" });
    expect(pinSkill).toHaveAttribute("aria-pressed", "false");

    await user.click(pinSkill);

    expect(pinSkill).toHaveAttribute("aria-pressed", "true");
    expect(pinSkill).toHaveAccessibleName("取消固定技能");
    const shortcut = screen.getByRole("link", { name: "打开固定设置：技能" });
    expect(shortcut).toHaveClass("activity-bar-item");
    expect(shortcut).toHaveTextContent("技");
    expect(shortcut).toHaveAttribute(
      "href",
      "/team?section=skills&returnTo=%2Fprojects%2Fproject-1",
    );

    const history = screen.getByRole("region", { name: "固定历史" });
    expect(within(history).getByRole("listitem")).toHaveTextContent(
      "Clock 1 固定 技能 2026-08-08T00:00:01.000Z",
    );
    expect(within(history).queryByRole("button")).toBeNull();
    expect(within(history).queryByRole("textbox")).toBeNull();
  });

  it("announces a failed write without moving focus or publishing a shortcut", async () => {
    const user = userEvent.setup();
    render(<TeamPanel returnTo="/" section="skills" />);
    const pinProvider = await screen.findByRole("button", {
      name: "固定模型服务",
    });
    await waitFor(() => expect(pinProvider).toBeEnabled());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    pinProvider.focus();
    await user.click(pinProvider);

    expect(screen.getByRole("status")).toHaveTextContent(
      "固定设置保存失败，导航仍可继续使用。",
    );
    expect(pinProvider).toHaveFocus();
    expect(
      screen.queryByRole("link", { name: "打开固定设置：模型服务" }),
    ).toBeNull();
  });

  it("hydrates ActivityBar shortcuts and converges on cross-tab store updates", async () => {
    window.localStorage.setItem(
      PINNED_SETTINGS_KEY,
      JSON.stringify({
        version: 1,
        revision: 1,
        updatedAt: "2026-08-08T00:00:01.000Z",
        pinned: ["agents"],
        events: [
          {
            revision: 1,
            changedAt: "2026-08-08T00:00:01.000Z",
            action: "pin",
            section: "agents",
          },
        ],
      }),
    );
    render(<ActivityBar activePath="/" returnTo="/projects/project-1" />);

    const agentShortcut = await screen.findByRole("link", {
      name: "打开固定设置：Agent",
    });
    expect(agentShortcut).toHaveTextContent("A");
    expect(agentShortcut).toHaveAttribute(
      "href",
      "/team?section=agents&returnTo=%2Fprojects%2Fproject-1",
    );

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: PINNED_SETTINGS_KEY,
        newValue: JSON.stringify({
          version: 1,
          revision: 2,
          updatedAt: "2026-08-08T00:00:02.000Z",
          pinned: ["providers"],
          events: [
            {
              revision: 1,
              changedAt: "2026-08-08T00:00:01.000Z",
              action: "pin",
              section: "agents",
            },
            {
              revision: 2,
              changedAt: "2026-08-08T00:00:02.000Z",
              action: "pin",
              section: "providers",
            },
          ],
        }),
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "打开固定设置：模型服务" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("link", { name: "打开固定设置：Agent" }),
    ).toBeNull();
  });
});
