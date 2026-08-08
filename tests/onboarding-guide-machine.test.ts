import { describe, expect, it } from "vitest";

import {
  GUIDE_STEPS,
  INITIAL_GUIDE_STATE,
  guideHref,
  parseGuideUrl,
  parseProjectCreateEnvelope,
  parseProjectGuideEnvelope,
  reduceGuideMachine,
  uniquelyReconciledProject,
  type GuideMachineState,
  type GuideRoute,
} from "@/src/shared/onboarding-guide-machine";

const projectIds = ["project-a", "project-b"];

function route(input: string): GuideRoute {
  const result = parseGuideUrl(input, projectIds);
  if (result.kind !== "guide") throw new Error(`Expected guide URL: ${input}`);
  return result.route;
}

describe("strict onboarding guide URL parser", () => {
  it.each([
    ["provider", "/team?section=providers&guide=provider&returnTo=/", null],
    ["agent", "/team?section=agents&guide=agent&returnTo=/", null],
    ["project-select", "/?guide=project-select", null],
    ["workspace", "/projects/project-a?guide=workspace", "project-a"],
    ["members", "/projects/project-a?guide=members", "project-a"],
    ["goal", "/projects/project-a?guide=goal", "project-a"],
  ])("parses the %s deep link exactly", (step, href, projectId) => {
    expect(parseGuideUrl(href, projectIds)).toEqual({
      kind: "guide",
      route: { href, projectId, step },
    });
  });

  it("defines exactly the six planned substates", () => {
    expect(GUIDE_STEPS).toEqual([
      "provider",
      "agent",
      "project-select",
      "workspace",
      "members",
      "goal",
    ]);
  });

  it.each([[], ["only-project"], ["one", "two", "three"]])(
    "keeps project selection explicit for %s available projects",
    (availableProjectIds) => {
      expect(
        parseGuideUrl("/?guide=project-select", availableProjectIds),
      ).toEqual({
        kind: "guide",
        route: {
          href: "/?guide=project-select",
          projectId: null,
          step: "project-select",
        },
      });
    },
  );

  it.each([
    ["/?guide=project-select&guide=goal", "duplicate_parameter", "guide"],
    [
      "/team?section=providers&guide=provider&returnTo=/&returnTo=/",
      "duplicate_parameter",
      "returnTo",
    ],
    [
      "/projects/project-a?guide=goal&project=one&project=two",
      "duplicate_parameter",
      "project",
    ],
    [
      "/projects/project-a?guide=goal&project=project-a",
      "unknown_parameter",
      "project",
    ],
    ["/?guide=surprise", "unknown_step", "guide"],
    [
      "/team?section=providers&guide=provider&returnTo=/projects/project-a",
      "invalid_return_to",
      "returnTo",
    ],
    [
      "/team?section=agents&guide=provider&returnTo=/",
      "invalid_section",
      "section",
    ],
  ])("rejects malformed guide URL %s", (href, code, parameter) => {
    expect(parseGuideUrl(href, projectIds)).toEqual({
      code,
      kind: "error",
      parameter,
    });
  });

  it("rejects unknown project IDs instead of falling back", () => {
    expect(
      parseGuideUrl("/projects/missing?guide=workspace", projectIds),
    ).toEqual({ code: "unknown_project", kind: "error" });
  });

  it.each([
    "/projects/project-a?guide=project-select",
    "/?guide=goal",
    "/projects/project-a/extra?guide=goal",
    "/team?guide=agent&section=agents&returnTo=/#fragment",
  ])("rejects a guide on an invalid path: %s", (href) => {
    expect(parseGuideUrl(href, projectIds)).toMatchObject({
      kind: "error",
    });
  });

  it("keeps project IDs only in project guide paths", () => {
    expect(guideHref("project-select")).not.toContain("project-a");
    expect(guideHref("provider")).not.toContain("project-a");
    expect(guideHref("goal", "project-a")).toBe(
      "/projects/project-a?guide=goal",
    );
  });

  it("replays back, forward, and refresh from URL alone", () => {
    const history = [
      guideHref("provider"),
      guideHref("agent"),
      guideHref("project-select"),
      guideHref("workspace", "project-a"),
      guideHref("members", "project-a"),
      guideHref("goal", "project-a"),
    ];
    const firstPass = history.map((href) => parseGuideUrl(href, projectIds));
    const back = history
      .toReversed()
      .map((href) => parseGuideUrl(href, projectIds));
    const forward = history.map((href) => parseGuideUrl(href, projectIds));

    expect(back.toReversed()).toEqual(firstPass);
    expect(forward).toEqual(firstPass);
    expect(parseGuideUrl(history.at(-1)!, projectIds)).toEqual(
      firstPass.at(-1),
    );
  });
});

describe("strict onboarding project facts", () => {
  const project = {
    createdAt: "2026-08-08T00:00:00.000Z",
    id: "project-a",
    name: "Project A",
  };

  it("accepts only exact list and create envelopes with path-safe IDs", () => {
    expect(parseProjectGuideEnvelope({ projects: [project] })).toEqual({
      kind: "success",
      projects: [project],
    });
    expect(parseProjectCreateEnvelope({ project })).toEqual(project);
    expect(
      parseProjectGuideEnvelope({
        projects: [{ ...project, Authorization: "secret" }],
      }),
    ).toEqual({ kind: "invalid", projects: [] });
    expect(
      parseProjectCreateEnvelope({ project: { ...project, id: "../project-a" } }),
    ).toBeNull();
  });

  it("confirms an unknown write only when GET contains exactly one new ID", () => {
    const previous = new Set(["project-before"]);
    expect(
      uniquelyReconciledProject(previous, {
        projects: [
          { ...project, id: "project-before", name: "Same Name" },
          project,
        ],
      }),
    ).toEqual(project);
    expect(
      uniquelyReconciledProject(previous, {
        projects: [
          project,
          { ...project, id: "project-b", name: project.name },
        ],
      }),
    ).toBeNull();
    expect(
      uniquelyReconciledProject(previous, {
        projects: [{ ...project, id: "project-before", name: project.name }],
      }),
    ).toBeNull();
  });
});

describe("pure onboarding guide state machine", () => {
  const goalRoute = route("/projects/project-a?guide=goal");

  function loading(): GuideMachineState {
    return reduceGuideMachine(INITIAL_GUIDE_STATE, {
      result: { kind: "guide", route: goalRoute },
      type: "route_changed",
    });
  }

  it("moves BOOT through loading to active", () => {
    const state = loading();
    expect(state.phase).toBe("loading");
    expect(
      reduceGuideMachine(state, {
        facts: { status: "active" },
        href: goalRoute.href,
        type: "facts_changed",
      }),
    ).toEqual({ error: null, phase: "active", route: goalRoute });
  });

  it.each(["blocked", "error"] as const)(
    "moves facts_changed to %s and retry back to loading",
    (status) => {
      const resolved = reduceGuideMachine(loading(), {
        facts: { reason: `${status}-reason`, status },
        href: goalRoute.href,
        type: "facts_changed",
      });
      expect(resolved).toEqual({
        error: `${status}-reason`,
        phase: status,
        route: goalRoute,
      });
      expect(
        reduceGuideMachine(resolved, { type: "retry" }),
      ).toEqual({
        error: null,
        phase: "loading",
        route: goalRoute,
      });
    },
  );

  it("ignores stale facts after history changes the route", () => {
    const membersRoute = route("/projects/project-a?guide=members");
    const state = reduceGuideMachine(loading(), {
      result: { kind: "guide", route: membersRoute },
      type: "route_changed",
    });

    expect(
      reduceGuideMachine(state, {
        facts: { status: "active" },
        href: goalRoute.href,
        type: "facts_changed",
      }),
    ).toBe(state);
  });

  it("fails closed for a rejected route and returns to BOOT off-guide", () => {
    const failed = reduceGuideMachine(INITIAL_GUIDE_STATE, {
      result: { code: "unknown_step", kind: "error", parameter: "guide" },
      type: "route_changed",
    });
    expect(failed).toEqual({
      error: "unknown_step",
      phase: "error",
      route: null,
    });
    expect(
      reduceGuideMachine(failed, {
        result: { kind: "none" },
        type: "route_changed",
      }),
    ).toEqual(INITIAL_GUIDE_STATE);
  });
});
