// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __settingsPreferencesStoreTest } from "@/components/settings-preferences-store";
import { TeamPanel } from "@/components/team-panel";
import type { ContributionInsightDto } from "@/src/modules/operations-projection";
import {
  EMPTY_CONTRIBUTION_INSIGHT,
  serviceHealthResponse,
} from "@/tests/fixtures/browser/service-health";

const WITH_ROLES: ContributionInsightDto = {
  disclaimer: "not_ranking",
  project: { detail: null, projectId: "project-1" },
  roles: [
    {
      agentId: "planner-a",
      name: "Alpha",
      reviews: { failed: 0, passed: 0 },
      role: "规划",
      workItems: { blocked: 0, completed: 2, inProgress: 1 },
      evidence: [
        { id: "work-1", kind: "work_item", title: "Blocked A" },
        { id: "review-1", kind: "review", title: "Review A" },
      ],
    },
  ],
};

function stubTeamResources(contribution: ContributionInsightDto | "error" = EMPTY_CONTRIBUTION_INSIGHT) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/contribution")) {
        if (contribution === "error") return new Response("nope", { status: 500 });
        return Response.json(contribution);
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

describe("team contribution insight region", () => {
  it("states it is not a ranking and does not invent scores without a project", async () => {
    stubTeamResources();
    render(<TeamPanel returnTo="/" section="skills" />);
    const region = await screen.findByRole("region", { name: "协作贡献" });
    expect(within(region).getByText("这不是排行榜")).toBeInTheDocument();
    expect(within(region).getByText("需要打开项目")).toBeInTheDocument();
    expect(within(region).queryByText(/完成 \d+/u)).toBeNull();
    expect(within(region).getByRole("link", { name: "打开任务" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("shows role-scoped work item counts for a project", async () => {
    stubTeamResources(WITH_ROLES);
    render(<TeamPanel returnTo="/projects/project-1" section="skills" />);
    const region = await screen.findByRole("region", { name: "协作贡献" });
    expect(within(region).getByRole("heading", { name: "规划 · Alpha" })).toBeInTheDocument();
    expect(within(region).getByText("完成 2 · 进行中 1")).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: "打开任务" })).toHaveAttribute(
      "href",
      "/projects/project-1",
    );
  });

  it("deep-links evidence to existing task and review entries", async () => {
    stubTeamResources(WITH_ROLES);
    render(<TeamPanel returnTo="/projects/project-1" section="skills" />);
    const region = await screen.findByRole("region", { name: "协作贡献" });
    expect(within(region).getByRole("link", { name: "Blocked A" })).toHaveAttribute(
      "href",
      "/projects/project-1/tasks/work-1",
    );
    expect(within(region).getByRole("link", { name: "Review A" })).toHaveAttribute(
      "href",
      "/projects/project-1/reviews/review-1",
    );
  });
});
