// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __settingsPreferencesStoreTest } from "@/components/settings-preferences-store";
import { TeamPanel } from "@/components/team-panel";
import { serviceHealthResponse } from "@/tests/fixtures/browser/service-health";

function stubTeamResources() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const health = serviceHealthResponse(input);
      if (health) return health;
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
  stubTeamResources();
});

afterEach(() => {
  __settingsPreferencesStoreTest?.reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("team service health region", () => {
  it("renders four health cards and does not paint unknown as success", async () => {
    render(<TeamPanel returnTo="/" section="skills" />);

    const region = await screen.findByRole("region", { name: "服务健康" });
    expect(within(region).getByRole("heading", { name: "应用" })).toBeInTheDocument();
    expect(within(region).getByText("已就绪")).toBeInTheDocument();
    expect(within(region).getByRole("heading", { name: "模型服务" })).toBeInTheDocument();
    expect(within(region).getByText("未配置模型服务")).toBeInTheDocument();
    expect(within(region).getByRole("heading", { name: "记忆索引" })).toBeInTheDocument();
    expect(within(region).getByRole("heading", { name: "执行" })).toBeInTheDocument();
    expect(within(region).getAllByText("需要打开项目")).toHaveLength(2);
    expect(within(region).queryByText("已就绪", { selector: "[data-status='unknown']" })).toBeNull();
    expect(within(region).getByRole("link", { name: "配置模型服务" })).toHaveAttribute(
      "href",
      "/team?section=providers&returnTo=%2F",
    );
    expect(within(region).getByRole("link", { name: "打开文件夹" })).toHaveAttribute("href", "/");
    expect(within(region).getByRole("link", { name: "打开审计" })).toHaveAttribute("aria-disabled", "true");
  });

  it("enables project-scoped recovery links when returnTo is a project", async () => {
    render(<TeamPanel returnTo="/projects/project-1" section="skills" />);
    const region = await screen.findByRole("region", { name: "服务健康" });
    expect(within(region).getByRole("link", { name: "打开记忆" })).toHaveAttribute(
      "href",
      "/projects/project-1",
    );
    expect(within(region).getByRole("link", { name: "打开审计" })).toHaveAttribute(
      "href",
      "/projects/project-1",
    );
  });
});
