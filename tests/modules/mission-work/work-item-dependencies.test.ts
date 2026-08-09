import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import {
  createWorkItem,
  getMissionState,
  updateWorkItem,
} from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { createMission } from "@/src/composition/mission-commands";

type WorkItem = ReturnType<typeof createWorkItem>;

let directory: string;
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

function replace(
  workItem: WorkItem,
  dependencyIds: string[],
  overrides: Partial<{
    title: string;
    description: string;
    expectedVersion: number;
  }> = {},
): WorkItem {
  return updateWorkItem(databasePath, workItem.id, {
    title: overrides.title ?? workItem.title,
    description: overrides.description ?? workItem.description,
    assigneeAgentId: null,
    dependencyIds,
    expectedVersion: overrides.expectedVersion ?? workItem.version,
  });
}

function persisted(workItemId: string) {
  const database = openDatabase(databasePath);
  const row = database
    .prepare(
      `SELECT title, description, status, version
       FROM work_items WHERE id = ?`,
    )
    .get(workItemId);
  const dependencies = (
    database
      .prepare(
        `SELECT depends_on_id AS dependencyId
         FROM work_item_dependencies
         WHERE work_item_id = ?
         ORDER BY depends_on_id`,
      )
      .all(workItemId) as Array<{ dependencyId: string }>
  ).map(({ dependencyId }) => dependencyId);
  database.close();
  return { row, dependencies };
}

function setStatus(workItemId: string, status: "todo" | "in_progress" | "done"): void {
  const database = openDatabase(databasePath);
  database
    .prepare("UPDATE work_items SET status = ? WHERE id = ?")
    .run(status, workItemId);
  database.close();
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

beforeEach(() => {
  missionOperationSequence = 0;
  directory = mkdtempSync(join(tmpdir(), "cockpit-work-item-dependencies-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("work-item dependency full replacement", () => {
  it("creates, returns, deterministically orders, replaces, and clears same-mission dependencies", () => {
    const { mission } = createProjectMission("Replacement");
    const first = item(mission.id, "First");
    const second = item(mission.id, "Second");
    let dependent!: WorkItem;
    expect(() => {
      dependent = item(mission.id, "Dependent", [second.id, first.id]);
    }).not.toThrow();

    const expectedOrder = [first, second]
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .map(({ id }) => id);
    expect(dependent.dependencyIds).toEqual(expectedOrder);

    const replaced = replace(dependent, [second.id], { title: "Replaced" });
    expect(replaced).toMatchObject({
      dependencyIds: [second.id],
      status: "todo",
      title: "Replaced",
      version: 2,
    });
    expect(replace(replaced, []).dependencyIds).toEqual([]);
    expect(
      getMissionState(databasePath, mission.projectId).workItems.find(
        ({ id }) => id === dependent.id,
      )?.dependencyIds,
    ).toEqual([]);
  });

  it("rejects duplicate, missing, cross-mission, and self references without mutation", () => {
    const firstScope = createProjectMission("First scope");
    const secondScope = createProjectMission("Second scope");
    const target = item(firstScope.mission.id, "Target");
    const sameMission = item(firstScope.mission.id, "Same mission");
    const otherMission = item(secondScope.mission.id, "Other mission");
    const before = persisted(target.id);

    for (const dependencyIds of [
      [sameMission.id, sameMission.id],
      ["missing-work-item"],
      [otherMission.id],
      [target.id],
    ]) {
      expectCode(() => replace(target, dependencyIds), "DEPENDENCY_SCOPE");
      expect(persisted(target.id)).toEqual(before);
    }

    const countBefore = getMissionState(databasePath, firstScope.project.id).workItems.length;
    expectCode(
      () => item(firstScope.mission.id, "Invalid create", [otherMission.id]),
      "DEPENDENCY_SCOPE",
    );
    expect(getMissionState(databasePath, firstScope.project.id).workItems).toHaveLength(
      countBefore,
    );
  });

  it("evaluates the complete replacement graph and atomically rejects cycles", () => {
    const { mission } = createProjectMission("Cycle");
    const third = item(mission.id, "Third");
    const second = item(mission.id, "Second", [third.id]);
    const first = item(mission.id, "First", [second.id]);
    const before = persisted(third.id);

    expectCode(
      () =>
        replace(third, [first.id], {
          title: "Must roll back",
          description: "Must also roll back",
        }),
      "DEPENDENCY_CYCLE",
    );
    expect(persisted(third.id)).toEqual(before);

    const safe = replace(second, []);
    expect(safe.dependencyIds).toEqual([]);
    expect(replace(third, [first.id]).dependencyIds).toEqual([first.id]);
  });

  it("does not treat a forged legacy done status as a passed dependency", () => {
    const { mission } = createProjectMission("Readiness");
    const prerequisite = item(mission.id, "Prerequisite");
    const active = item(mission.id, "Active");
    setStatus(active.id, "in_progress");
    const before = persisted(active.id);

    expectCode(
      () => replace(active, [prerequisite.id], { title: "Rejected metadata" }),
      "DEPENDENCY_NOT_READY",
    );
    expect(persisted(active.id)).toEqual(before);

    setStatus(prerequisite.id, "done");
    expectCode(
      () => replace(active, [prerequisite.id]),
      "SCHEMA_DATA_INVALID",
    );
  });
});
