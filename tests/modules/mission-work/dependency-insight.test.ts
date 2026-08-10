import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getMissionDependencies } from "@/app/api/projects/[projectId]/missions/[missionId]/dependencies/route";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { createWorkItem } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import {
  deriveMissionDependencyInsight,
  getMissionDependencyInsight,
} from "@/src/adapters/outbound/sqlite/mission-work/dependency-insight";
import { createMission } from "@/src/composition/mission-commands";
import type { MissionDependencyInsight } from "@/src/modules/mission-work";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type WorkItem = ReturnType<typeof createWorkItem>;
type Edge = MissionDependencyInsight["edges"][number];

let databasePath: string;
let missionOperationSequence: number;

function createProjectMission(name: string) {
  const project = createProject(name, databasePath);
  const mission = createMission(databasePath, project.id, {
    expectedVersion: 0,
    title: `${name} mission`,
    goal: `${name} goal`,
    operationId: `16000000-0000-4000-8000-${(++missionOperationSequence)
      .toString(16)
      .padStart(12, "0")}`,
  });
  return { project, mission };
}

function item(
  missionId: string,
  title: string,
  dependencyIds: string[] = [],
): WorkItem {
  return createWorkItem(databasePath, missionId, {
    title,
    description: `${title} description`,
    assigneeAgentId: null,
    dependencyIds,
  });
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byEdge(left: Edge, right: Edge): number {
  return (
    byCodeUnit(left.fromWorkItemId, right.fromWorkItemId) ||
    byCodeUnit(left.toWorkItemId, right.toWorkItemId)
  );
}

function nodeById(insight: MissionDependencyInsight, workItemId: string) {
  const node = insight.nodes.find((candidate) => candidate.workItemId === workItemId);
  expect(node, `node for work item ${workItemId}`).toBeDefined();
  return node!;
}

function setStatus(workItemId: string, status: "todo" | "in_progress" | "blocked"): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare("UPDATE work_items SET status = ? WHERE id = ?")
      .run(status, workItemId);
  } finally {
    database.close();
  }
}

// Cycles are unreachable through the write path (DEPENDENCY_CYCLE guard), so
// cycle fixtures insert dependency rows directly; two-node cycles satisfy the
// table's FK and CHECK constraints, while self-loops are DB-unrepresentable
// and therefore covered through the pure derivation below.
function insertDependencyRow(workItemId: string, dependsOnId: string): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO work_item_dependencies (work_item_id, depends_on_id)
         VALUES (?, ?)`,
      )
      .run(workItemId, dependsOnId);
  } finally {
    database.close();
  }
}

function routeContext(projectId: string, missionId: string) {
  return { params: Promise.resolve({ projectId, missionId }) };
}

beforeEach(() => {
  missionOperationSequence = 0;
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
});

describe("getMissionDependencyInsight tuple validation and empty states", () => {
  it("returns an empty insight for a mission without work items", () => {
    const { project, mission } = createProjectMission("Empty");

    expect(getMissionDependencyInsight(databasePath, project.id, mission.id)).toEqual({
      nodes: [],
      edges: [],
      cycles: [],
      hasDependencies: false,
    });
  });

  it("lists work items without dependencies as isolated nodes", () => {
    const { project, mission } = createProjectMission("Isolated");
    const first = item(mission.id, "First");
    const second = item(mission.id, "Second");

    const insight = getMissionDependencyInsight(databasePath, project.id, mission.id);

    expect(insight.hasDependencies).toBe(false);
    expect(insight.edges).toEqual([]);
    expect(insight.cycles).toEqual([]);
    expect(insight.nodes.map((node) => node.workItemId)).toEqual(
      [first.id, second.id].sort(byCodeUnit),
    );
    for (const node of insight.nodes) {
      expect(node).toMatchObject({
        blockedByIds: [],
        blockingIds: [],
        blockedReason: null,
        cycleId: null,
        missingDependencyIds: [],
      });
    }
    const firstNode = insight.nodes.find((node) => node.workItemId === first.id);
    expect(firstNode).toMatchObject({ status: "todo", title: "First" });
  });

  it("fails closed with PROJECT_NOT_FOUND for an unknown project", () => {
    const { mission } = createProjectMission("Known");

    expectCode(
      () => getMissionDependencyInsight(databasePath, "missing-project", mission.id),
      "PROJECT_NOT_FOUND",
    );
  });

  it("fails closed with MISSION_NOT_FOUND for unknown or cross-project missions", () => {
    const first = createProjectMission("First");
    const second = createProjectMission("Second");

    expectCode(
      () => getMissionDependencyInsight(databasePath, first.project.id, "missing-mission"),
      "MISSION_NOT_FOUND",
    );
    expectCode(
      () => getMissionDependencyInsight(databasePath, first.project.id, second.mission.id),
      "MISSION_NOT_FOUND",
    );
  });
});

describe("getMissionDependencyInsight graph derivation", () => {
  it("derives a linear chain with stable edge order and blocking direction", () => {
    const { project, mission } = createProjectMission("Chain");
    const first = item(mission.id, "First");
    const second = item(mission.id, "Second", [first.id]);
    const third = item(mission.id, "Third", [second.id]);

    const insight = getMissionDependencyInsight(databasePath, project.id, mission.id);

    expect(insight.hasDependencies).toBe(true);
    expect(insight.cycles).toEqual([]);
    expect(insight.edges).toEqual(
      [
        { fromWorkItemId: first.id, toWorkItemId: second.id },
        { fromWorkItemId: second.id, toWorkItemId: third.id },
      ].sort(byEdge),
    );
    expect(nodeById(insight, first.id)).toMatchObject({
      blockedByIds: [],
      blockingIds: [second.id],
      blockedReason: null,
      cycleId: null,
      missingDependencyIds: [],
    });
    expect(nodeById(insight, second.id)).toMatchObject({
      blockedByIds: [first.id],
      blockingIds: [third.id],
      blockedReason: "前置依赖未完成：待办 1 项",
      cycleId: null,
    });
    expect(nodeById(insight, third.id)).toMatchObject({
      blockedByIds: [second.id],
      blockingIds: [],
      blockedReason: "前置依赖未完成：待办 1 项",
      cycleId: null,
    });
  });

  it("derives a diamond with deterministic multi-edge and id ordering", () => {
    const { project, mission } = createProjectMission("Diamond");
    const root = item(mission.id, "Root");
    const left = item(mission.id, "Left", [root.id]);
    const right = item(mission.id, "Right", [root.id]);
    const join = item(mission.id, "Join", [right.id, left.id]);

    const insight = getMissionDependencyInsight(databasePath, project.id, mission.id);

    expect(insight.hasDependencies).toBe(true);
    expect(insight.edges).toEqual(
      [
        { fromWorkItemId: root.id, toWorkItemId: left.id },
        { fromWorkItemId: root.id, toWorkItemId: right.id },
        { fromWorkItemId: left.id, toWorkItemId: join.id },
        { fromWorkItemId: right.id, toWorkItemId: join.id },
      ].sort(byEdge),
    );
    expect(nodeById(insight, root.id)?.blockingIds).toEqual(
      [left.id, right.id].sort(byCodeUnit),
    );
    expect(nodeById(insight, join.id)?.blockedByIds).toEqual(
      [left.id, right.id].sort(byCodeUnit),
    );
    expect(nodeById(insight, join.id)?.blockedReason).toBe("前置依赖未完成：待办 2 项");
  });

  it("derives blocked reasons from dependency statuses using existing status vocabulary", () => {
    const { project, mission } = createProjectMission("Reasons");
    const inProgress = item(mission.id, "In progress");
    const blocked = item(mission.id, "Blocked");
    const todo = item(mission.id, "Todo");
    setStatus(inProgress.id, "in_progress");
    setStatus(blocked.id, "blocked");
    const waitingOnInProgress = item(mission.id, "Waiting on progress", [inProgress.id]);
    const waitingOnBlocked = item(mission.id, "Waiting on blocked", [blocked.id]);
    const waitingOnMixed = item(mission.id, "Waiting on mixed", [
      todo.id,
      blocked.id,
      inProgress.id,
    ]);

    const insight = getMissionDependencyInsight(databasePath, project.id, mission.id);

    expect(nodeById(insight, waitingOnInProgress.id)?.blockedReason).toBe(
      "前置依赖未完成：进行中 1 项",
    );
    expect(nodeById(insight, waitingOnBlocked.id)?.blockedReason).toBe(
      "前置依赖未完成：阻塞 1 项",
    );
    expect(nodeById(insight, waitingOnMixed.id)?.blockedReason).toBe(
      "前置依赖未完成：待办 1 项、进行中 1 项、阻塞 1 项",
    );
    expect(nodeById(insight, inProgress.id)?.blockedReason).toBeNull();
  });

  it("treats fully done dependencies as unblocked in the pure derivation", () => {
    const insight = deriveMissionDependencyInsight(
      [
        { id: "a", status: "done", title: "Done dependency" },
        { id: "b", status: "in_progress", title: "Dependent" },
      ],
      [{ workItemId: "b", dependsOnId: "a" }],
    );

    expect(nodeById(insight, "b")).toMatchObject({
      blockedByIds: ["a"],
      blockedReason: null,
    });
    expect(insight.hasDependencies).toBe(true);
  });

  it("returns byte-identical output for repeated calls over the same facts", () => {
    const { project, mission } = createProjectMission("Deterministic");
    const root = item(mission.id, "Root");
    const left = item(mission.id, "Left", [root.id]);
    const right = item(mission.id, "Right", [root.id]);
    item(mission.id, "Join", [left.id, right.id]);
    setStatus(right.id, "blocked");

    const first = getMissionDependencyInsight(databasePath, project.id, mission.id);
    const second = getMissionDependencyInsight(databasePath, project.id, mission.id);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("getMissionDependencyInsight cycle detection", () => {
  it("marks a two-node cycle with a stable cycle id and readable path", () => {
    const { project, mission } = createProjectMission("Two node cycle");
    const first = item(mission.id, "First");
    const second = item(mission.id, "Second");
    insertDependencyRow(first.id, second.id);
    insertDependencyRow(second.id, first.id);

    const insight = getMissionDependencyInsight(databasePath, project.id, mission.id);

    const members = [first.id, second.id].sort(byCodeUnit);
    const titleById = new Map([
      [first.id, first.title],
      [second.id, second.title],
    ]);
    const expectedPath = [...members, members[0]]
      .map((id) => titleById.get(id))
      .join(" → ");
    expect(insight.cycles).toEqual([
      { cycleId: "cycle-1", memberWorkItemIds: members, path: expectedPath },
    ]);
    expect(nodeById(insight, first.id)?.cycleId).toBe("cycle-1");
    expect(nodeById(insight, second.id)?.cycleId).toBe("cycle-1");
    expect(nodeById(insight, first.id)?.blockedReason).toBe("前置依赖未完成：待办 1 项");
    expect(insight.edges).toHaveLength(2);
    expect(insight.hasDependencies).toBe(true);
  });

  it("marks only cycle members when cyclic and acyclic work items coexist", () => {
    const { project, mission } = createProjectMission("Mixed");
    const cyclicFirst = item(mission.id, "Cyclic first");
    const cyclicSecond = item(mission.id, "Cyclic second");
    const downstream = item(mission.id, "Downstream", [cyclicFirst.id]);
    const isolated = item(mission.id, "Isolated");
    insertDependencyRow(cyclicFirst.id, cyclicSecond.id);
    insertDependencyRow(cyclicSecond.id, cyclicFirst.id);

    const insight = getMissionDependencyInsight(databasePath, project.id, mission.id);

    expect(insight.cycles).toHaveLength(1);
    expect(nodeById(insight, cyclicFirst.id)?.cycleId).toBe("cycle-1");
    expect(nodeById(insight, cyclicSecond.id)?.cycleId).toBe("cycle-1");
    expect(nodeById(insight, downstream.id)?.cycleId).toBeNull();
    expect(nodeById(insight, isolated.id)?.cycleId).toBeNull();
    expect(nodeById(insight, downstream.id)?.blockedByIds).toEqual([cyclicFirst.id]);
  });
});

describe("deriveMissionDependencyInsight defensive cases", () => {
  it("marks a self-dependency as a single-node cycle (DB CHECK makes it unreachable)", () => {
    const insight = deriveMissionDependencyInsight(
      [{ id: "a", status: "todo", title: "Solo" }],
      [{ workItemId: "a", dependsOnId: "a" }],
    );

    expect(insight.cycles).toEqual([
      { cycleId: "cycle-1", memberWorkItemIds: ["a"], path: "Solo → Solo" },
    ]);
    expect(nodeById(insight, "a")).toMatchObject({
      blockedByIds: ["a"],
      cycleId: "cycle-1",
    });
  });

  it("assigns stable cycle ids in discovery order across multiple cycles", () => {
    const insight = deriveMissionDependencyInsight(
      [
        { id: "a", status: "todo", title: "A" },
        { id: "b", status: "todo", title: "B" },
        { id: "c", status: "todo", title: "C" },
        { id: "d", status: "todo", title: "D" },
      ],
      [
        { workItemId: "a", dependsOnId: "b" },
        { workItemId: "b", dependsOnId: "a" },
        { workItemId: "c", dependsOnId: "d" },
        { workItemId: "d", dependsOnId: "c" },
      ],
    );

    expect(insight.cycles).toEqual([
      { cycleId: "cycle-1", memberWorkItemIds: ["a", "b"], path: "A → B → A" },
      { cycleId: "cycle-2", memberWorkItemIds: ["c", "d"], path: "C → D → C" },
    ]);
  });

  it("reports dangling dependencies as missing without fabricating nodes", () => {
    const insight = deriveMissionDependencyInsight(
      [
        { id: "a", status: "todo", title: "Waiting" },
        { id: "b", status: "blocked", title: "Blocker" },
      ],
      [
        { workItemId: "a", dependsOnId: "b" },
        { workItemId: "a", dependsOnId: "ghost" },
      ],
    );

    expect(insight.nodes).toHaveLength(2);
    expect(nodeById(insight, "a")).toMatchObject({
      blockedByIds: ["b"],
      missingDependencyIds: ["ghost"],
      blockedReason: "前置依赖未完成：阻塞 1 项；1 项前置依赖缺失",
    });
    expect(insight.edges).toEqual([{ fromWorkItemId: "b", toWorkItemId: "a" }]);
    expect(insight.hasDependencies).toBe(true);
  });

  it("drops rows that reference unknown work items", () => {
    const insight = deriveMissionDependencyInsight(
      [{ id: "a", status: "todo", title: "Solo" }],
      [{ workItemId: "ghost", dependsOnId: "a" }],
    );

    expect(insight.edges).toEqual([]);
    expect(insight.cycles).toEqual([]);
    expect(insight.hasDependencies).toBe(false);
    expect(nodeById(insight, "a")).toMatchObject({
      blockedByIds: [],
      blockingIds: [],
      missingDependencyIds: [],
    });
  });
});

describe("GET /api/projects/:projectId/missions/:missionId/dependencies", () => {
  it("returns the derived insight for a valid tuple", async () => {
    const { project, mission } = createProjectMission("Route");
    const root = item(mission.id, "Root");
    item(mission.id, "Dependent", [root.id]);

    const response = await getMissionDependencies(
      new Request(
        `http://localhost/api/projects/${project.id}/missions/${mission.id}/dependencies`,
      ),
      routeContext(project.id, mission.id),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as MissionDependencyInsight;
    expect(body.hasDependencies).toBe(true);
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
    expect(body.cycles).toEqual([]);
  });

  it("returns a stable sanitized 404 envelope for cross-tuple access", async () => {
    const first = createProjectMission("Route first");
    const second = createProjectMission("Route second");

    const response = await getMissionDependencies(
      new Request(
        `http://localhost/api/projects/${first.project.id}/missions/${second.mission.id}/dependencies`,
      ),
      routeContext(first.project.id, second.mission.id),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "MISSION_NOT_FOUND", message: "Mission was not found." },
    });
  });

  it("rejects blank ids and query parameters with INVALID_INPUT", async () => {
    const { project, mission } = createProjectMission("Route invalid");

    const blank = await getMissionDependencies(
      new Request(
        `http://localhost/api/projects/${project.id}/missions/${mission.id}/dependencies`,
      ),
      routeContext(" ", mission.id),
    );
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "Mission input is invalid.",
        fields: [{ field: "projectId", code: "invalid_format" }],
      },
    });

    const withQuery = await getMissionDependencies(
      new Request(
        `http://localhost/api/projects/${project.id}/missions/${mission.id}/dependencies?verbose=true`,
      ),
      routeContext(project.id, mission.id),
    );
    expect(withQuery.status).toBe(400);
    const body = (await withQuery.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_INPUT");
  });
});
