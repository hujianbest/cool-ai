import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createProject } from "@/src/server/projects";

type WorkItemStatus = "todo" | "in_progress" | "blocked" | "done";
type WorkItem = {
  id: string;
  missionId: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  assigneeAgentId: string | null;
  dependencyIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};
type Mission = { id: string };

type MissionServiceModule = {
  createMission(
    databasePath: string,
    projectId: string,
    input: { title: string; goal: string },
  ): Mission;
  createWorkItem(
    databasePath: string,
    missionId: string,
    input: {
      title: string;
      description: string;
      assigneeAgentId: null;
      dependencyIds: [];
    },
  ): WorkItem;
  transitionWorkItem?: (
    databasePath: string,
    workItemId: string,
    input: { toStatus: WorkItemStatus; expectedVersion: number },
  ) => WorkItem;
};

type TransitionRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ workItemId: string }> },
  ): Promise<Response>;
};

const serviceModules =
  import.meta.glob<MissionServiceModule>("../src/server/mission-service.ts");
const routeModules =
  import.meta.glob<TransitionRoute>(
    "../app/api/work-items/[workItemId]/transition/route.ts",
  );

let directory: string;
let databasePath: string;

async function service(): Promise<
  MissionServiceModule & {
    transitionWorkItem: NonNullable<MissionServiceModule["transitionWorkItem"]>;
  }
> {
  const load = serviceModules["../src/server/mission-service.ts"];
  expect(load).toBeTypeOf("function");
  const domain = await load();
  expect(
    domain.transitionWorkItem,
    "the dedicated transition service must exist",
  ).toBeTypeOf("function");
  return domain as MissionServiceModule & {
    transitionWorkItem: NonNullable<MissionServiceModule["transitionWorkItem"]>;
  };
}

async function route(): Promise<TransitionRoute> {
  const load =
    routeModules["../app/api/work-items/[workItemId]/transition/route.ts"];
  expect(load, "the dedicated transition route must exist").toBeTypeOf("function");
  return load();
}

function setupMission(domain: MissionServiceModule): Mission {
  const project = createProject("Transitions", databasePath);
  return domain.createMission(databasePath, project.id, {
    title: "Transition mission",
    goal: "Exercise every state edge",
  });
}

function createItem(
  domain: MissionServiceModule,
  missionId: string,
  title: string,
): WorkItem {
  return domain.createWorkItem(databasePath, missionId, {
    title,
    description: "",
    assigneeAgentId: null,
    dependencyIds: [],
  });
}

function setState(itemId: string, status: WorkItemStatus, version = 1): void {
  const database = openDatabase(databasePath);
  database
    .prepare("UPDATE work_items SET status = ?, version = ? WHERE id = ?")
    .run(status, version, itemId);
  database.close();
}

function readState(itemId: string): { status: WorkItemStatus; version: number } {
  const database = openDatabase(databasePath);
  const state = database
    .prepare("SELECT status, version FROM work_items WHERE id = ?")
    .get(itemId) as { status: WorkItemStatus; version: number };
  database.close();
  return state;
}

function addDependency(workItemId: string, dependsOnId: string): void {
  const database = openDatabase(databasePath);
  database
    .prepare(
      `INSERT INTO work_item_dependencies (work_item_id, depends_on_id)
       VALUES (?, ?)`,
    )
    .run(workItemId, dependsOnId);
  database.close();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-work-item-transition-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("work-item transition service", () => {
  it("allows exactly the declared state edges and increments version atomically", async () => {
    const domain = await service();
    const mission = setupMission(domain);
    const allowed: Array<[WorkItemStatus, WorkItemStatus]> = [
      ["todo", "in_progress"],
      ["todo", "blocked"],
      ["in_progress", "blocked"],
      ["blocked", "todo"],
      ["blocked", "in_progress"],
    ];

    for (const [from, to] of allowed) {
      const item = createItem(domain, mission.id, `${from} to ${to}`);
      setState(item.id, from);
      const transitioned = domain.transitionWorkItem(databasePath, item.id, {
        toStatus: to,
        expectedVersion: 1,
      });
      expect(transitioned).toMatchObject({ id: item.id, status: to, version: 2 });
      expect(readState(item.id)).toEqual({ status: to, version: 2 });
    }
  });

  it("rejects same-status and every undeclared edge without mutating status or version", async () => {
    const domain = await service();
    const mission = setupMission(domain);
    const allowed = new Set([
      "todo:in_progress",
      "todo:blocked",
      "in_progress:blocked",
      "blocked:todo",
      "blocked:in_progress",
    ]);
    const statuses: WorkItemStatus[] = ["todo", "in_progress", "blocked"];

    for (const from of statuses) {
      for (const to of statuses) {
        if (allowed.has(`${from}:${to}`)) continue;
        if (to === "done") continue;
        const item = createItem(domain, mission.id, `${from} rejects ${to}`);
        setState(item.id, from);
        expect(() =>
          domain.transitionWorkItem(databasePath, item.id, {
            toStatus: to,
            expectedVersion: 1,
          }),
        ).toThrowError(expect.objectContaining({ code: "INVALID_TRANSITION" }));
        expect(readState(item.id)).toEqual({ status: from, version: 1 });
      }
    }
  });

  it("requires a passed dependency when entering in_progress", async () => {
    const domain = await service();
    const mission = setupMission(domain);
    const prerequisite = createItem(domain, mission.id, "Prerequisite");
    const dependent = createItem(domain, mission.id, "Dependent");
    addDependency(dependent.id, prerequisite.id);

    for (const [from, to] of [
      ["todo", "in_progress"],
      ["blocked", "in_progress"],
    ] as Array<[WorkItemStatus, WorkItemStatus]>) {
      setState(prerequisite.id, "in_progress");
      setState(dependent.id, from);
      expect(() =>
        domain.transitionWorkItem(databasePath, dependent.id, {
          toStatus: to,
          expectedVersion: 1,
        }),
      ).toThrowError(expect.objectContaining({ code: "DEPENDENCY_NOT_READY" }));
      expect(readState(dependent.id)).toEqual({ status: from, version: 1 });

    }
  });

  it("enforces expectedVersion without mutating the current state", async () => {
    const domain = await service();
    const mission = setupMission(domain);
    const prerequisite = createItem(domain, mission.id, "Versioned prerequisite");
    setState(prerequisite.id, "todo", 4);
    expect(() =>
      domain.transitionWorkItem(databasePath, prerequisite.id, {
        toStatus: "blocked",
        expectedVersion: 3,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RESOURCE_CONFLICT", currentVersion: 4 }),
    );
    expect(readState(prerequisite.id)).toEqual({ status: "todo", version: 4 });
  });
});

describe("work-item transition API", () => {
  it("exposes only POST transition behavior with stable errors", async () => {
    const domain = await service();
    const transitionRoute = await route();
    const mission = setupMission(domain);
    const item = createItem(domain, mission.id, "API transition");
    const context = { params: Promise.resolve({ workItemId: item.id }) };
    const url = `http://localhost/api/work-items/${item.id}/transition`;

    const response = await transitionRoute.POST(
      new Request(url, {
        body: JSON.stringify({ toStatus: "blocked", expectedVersion: 1 }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      context,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workItem: expect.objectContaining({ id: item.id, status: "blocked", version: 2 }),
    });

    const sameStatus = await transitionRoute.POST(
      new Request(url, {
        body: JSON.stringify({ toStatus: "blocked", expectedVersion: 2 }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      context,
    );
    expect(sameStatus.status).toBe(409);
    await expect(sameStatus.json()).resolves.toEqual({
      error: {
        code: "INVALID_TRANSITION",
        message: "Work item transition is not allowed.",
      },
    });
  });
});
