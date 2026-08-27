// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __settingsPreferencesStoreTest } from "@/components/settings-preferences-store";
import { TeamPanel } from "@/components/team-panel";
import type { UsageQuotaDto } from "@/src/modules/operations-projection";
import {
  EMPTY_USAGE_QUOTA,
  serviceHealthResponse,
} from "@/tests/fixtures/browser/service-health";

const REPORTED: UsageQuotaDto = {
  budgets: [
    {
      agentId: "agent-a",
      maxHandoffs: 5,
      maxTokens: 1000,
      name: "Alpha",
      usedTokens: 30,
    },
  ],
  disclaimer: "not_invoice",
  project: {
    detail: null,
    projectId: "project-1",
    totals: {
      completionTokens: 20,
      invalidCalls: 1,
      promptTokens: 10,
      totalTokens: 30,
      unreportedCalls: 1,
    },
  },
  providers: [
    {
      id: "provider-a",
      name: "Local",
      totals: {
        completionTokens: 20,
        invalidCalls: 1,
        promptTokens: 10,
        totalTokens: 30,
        unreportedCalls: 1,
      },
    },
  ],
  runs: [
    {
      id: "run-a",
      roundCount: 3,
      roundLimit: 50,
      totals: {
        completionTokens: 20,
        invalidCalls: 1,
        promptTokens: 10,
        totalTokens: 30,
        unreportedCalls: 1,
      },
    },
  ],
};

function stubTeamResources(usage: UsageQuotaDto | "error" = EMPTY_USAGE_QUOTA) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/usage")) {
        if (usage === "error") return new Response("nope", { status: 500 });
        return Response.json(usage);
      }
      const health = serviceHealthResponse(input);
      if (health) return health;
      const payloads: Record<string, unknown> = {
        "/api/agent-templates": { templates: [] },
        "/api/agents": { agents: [] },
        "/api/providers": { providers: [] },
        "/api/skills": { skills: [] },
      };
      const payload = payloads[url];
      if (!payload) throw new Error(`Unexpected request: ${url}`);
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
});

afterEach(() => {
  __settingsPreferencesStoreTest?.reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("team usage quota region", () => {
  it("shows the not-invoice disclaimer and does not invent totals without a project", async () => {
    stubTeamResources();
    render(<TeamPanel returnTo="/" section="skills" />);

    const region = await screen.findByRole("region", { name: "用量与配额" });
    expect(within(region).getByText("基础用量不是账单")).toBeInTheDocument();
    expect(within(region).getByRole("heading", { name: "本项目" })).toBeInTheDocument();
    expect(within(region).getByText("需要打开项目")).toBeInTheDocument();
    expect(within(region).queryByText("已报告 30 token")).toBeNull();
    expect(within(region).getByRole("link", { name: "配置 Agent" })).toHaveAttribute(
      "href",
      "/team?section=agents&returnTo=%2F",
    );
  });

  it("renders reported usage, run rounds, and provider breakdown for a project", async () => {
    stubTeamResources(REPORTED);
    render(<TeamPanel returnTo="/projects/project-1" section="skills" />);

    const region = await screen.findByRole("region", { name: "用量与配额" });
    expect(within(region).getByText("基础用量不是账单")).toBeInTheDocument();
    expect(within(region).getByText("已报告 30 token")).toBeInTheDocument();
    expect(within(region).getByText("未报告 1 · 无效 1")).toBeInTheDocument();
    expect(within(region).getByText("run-a 3/50 轮")).toBeInTheDocument();
    expect(within(region).getByText("Local 30")).toBeInTheDocument();
    expect(within(region).getByText("Alpha 30/1000 token")).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: "配置 Agent" })).toHaveAttribute(
      "href",
      "/team?section=agents&returnTo=%2Fprojects%2Fproject-1",
    );
  });

  it("covers loading and error states", async () => {
    stubTeamResources("error");
    render(<TeamPanel returnTo="/" section="skills" />);
    expect(screen.getByText("正在加载用量…")).toBeInTheDocument();
    expect(await screen.findByText("无法加载用量。")).toBeInTheDocument();
  });
});
