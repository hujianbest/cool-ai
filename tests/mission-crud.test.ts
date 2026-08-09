import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/server/db";
import { createProject } from "@/src/server/projects";

type Mission = {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type WorkItem = {
  id: string;
  missionId: string;
  title: string;
  description: string;
  status: "todo";
  assigneeAgentId: string | null;
  dependencyIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

type MissionState = {
  mission: Mission | null;
  workItems: WorkItem[];
};

type MissionServiceModule = {
  getMissionState(databasePath: string, projectId: string): MissionState;
  createMission(
    databasePath: string,
    projectId: string,
    input: {
      title: string;
      goal: string;
      operationId: string;
      expectedVersion: number;
    },
  ): Mission;
  updateMission(
    databasePath: string,
    missionId: string,
    input: { title: string; goal: string; expectedVersion: number },
  ): Mission;
  createWorkItem(
    databasePath: string,
    missionId: string,
    input: {
      title: string;
      description: string;
      assigneeAgentId: string | null;
      dependencyIds: string[];
    },
  ): WorkItem;
  updateWorkItem(
    databasePath: string,
    workItemId: string,
    input: {
      title: string;
      description: string;
      assigneeAgentId: string | null;
      dependencyIds: string[];
      expectedVersion: number;
    },
  ): WorkItem;
};

type ProjectMissionRoute = {
  GET(request: Request, context: ProjectContext): Promise<Response>;
  POST(request: Request, context: ProjectContext): Promise<Response>;
};
type MissionRoute = {
  PATCH(request: Request, context: MissionContext): Promise<Response>;
};
type WorkItemsRoute = {
  POST(request: Request, context: MissionContext): Promise<Response>;
};
type WorkItemRoute = {
  PATCH(request: Request, context: WorkItemContext): Promise<Response>;
};
type ProjectContext = { params: Promise<{ projectId: string }> };
type MissionContext = { params: Promise<{ missionId: string }> };
type WorkItemContext = { params: Promise<{ workItemId: string }> };

const serviceModules =
  import.meta.glob<MissionServiceModule>("../src/server/mission-service.ts");
const projectRouteModules =
  import.meta.glob<ProjectMissionRoute>("../app/api/projects/[projectId]/mission/route.ts");
const missionRouteModules =
  import.meta.glob<MissionRoute>("../app/api/missions/[missionId]/route.ts");
const workItemsRouteModules =
  import.meta.glob<WorkItemsRoute>("../app/api/missions/[missionId]/work-items/route.ts");
const workItemRouteModules =
  import.meta.glob<WorkItemRoute>("../app/api/work-items/[workItemId]/route.ts");

let directory: string;
let databasePath: string;

async function service(): Promise<MissionServiceModule> {
  const load = serviceModules["../src/server/mission-service.ts"];
  expect(load, "the mission service must exist").toBeTypeOf("function");
  return load();
}

async function routes() {
  const project = projectRouteModules["../app/api/projects/[projectId]/mission/route.ts"];
  const mission = missionRouteModules["../app/api/missions/[missionId]/route.ts"];
  const workItems =
    workItemsRouteModules["../app/api/missions/[missionId]/work-items/route.ts"];
  const workItem = workItemRouteModules["../app/api/work-items/[workItemId]/route.ts"];
  expect(project, "the project mission route must exist").toBeTypeOf("function");
  expect(mission, "the mission route must exist").toBeTypeOf("function");
  expect(workItems, "the mission work-items route must exist").toBeTypeOf("function");
  expect(workItem, "the work-item route must exist").toBeTypeOf("function");
  return {
    project: await project(),
    mission: await mission(),
    workItems: await workItems(),
    workItem: await workItem(),
  };
}

function seedMembers(projectId: string): void {
  const database = openDatabase(databasePath);
  database.exec(`
    INSERT INTO providers (
      id, name, base_url, default_model, api_key_cipher, api_key_iv, api_key_tag,
      credential_version, credential_generation, key_id, api_key_mask, verified_at,
      version, created_at, updated_at
    ) VALUES (
      'provider-mission', 'Provider', 'https://example.invalid', 'model',
      'cipher', 'iv', 'tag', 1, 1, 'key', '****', 'now', 1, 'now', 'now'
    );
    INSERT INTO agents (
      id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
      can_read, can_write, can_execute, max_tokens, max_handoffs, version, created_at, updated_at
    ) VALUES
      (
        'agent-one', 'One', 'Plans', 'private', 'provider-mission', 'model', '1', 'sage',
        1, 0, 0, 1000, 1, 1, 'now', 'now'
      ),
      (
        'agent-two', 'Two', 'Builds', 'private', 'provider-mission', 'model', '2', 'gold',
        1, 1, 1, 1000, 1, 1, 'now', 'now'
      ),
      (
        'agent-outsider', 'Outside', 'Waits', 'private', 'provider-mission', 'model', 'O', 'slate',
        1, 0, 0, 1000, 1, 1, 'now', 'now'
      );
  `);
  database
    .prepare(
      `INSERT INTO project_memberships (project_id, agent_id, joined_at)
       VALUES (?, 'agent-one', 'now'), (?, 'agent-two', 'now')`,
    )
    .run(projectId, projectId);
  database.close();
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

function request(url: string, body: unknown, method: "POST" | "PATCH"): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-mission-crud-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  vi.useRealTimers();
  rmSync(directory, { force: true, recursive: true });
});

describe("mission and basic work-item service", () => {
  it("enforces grapheme bounds, one current mission, todo creation, and metadata replacement", async () => {
    const domain = await service();
    const project = createProject("Mission CRUD", databasePath);
    seedMembers(project.id);
    const exactMissionTitle = "👨‍👩‍👧‍👦".repeat(80);
    const exactGoal = "目".repeat(5000);

    const mission = domain.createMission(databasePath, project.id, {
      title: `  ${exactMissionTitle}  `,
      goal: `  ${exactGoal}  `,
      operationId: "16000000-0000-4000-8000-000000000010",
      expectedVersion: 0,
    });
    expect(mission).toMatchObject({
      projectId: project.id,
      title: exactMissionTitle,
      goal: exactGoal,
      version: 1,
    });
    expectCode(
      () =>
        domain.createMission(databasePath, project.id, {
          title: "Second",
          goal: "Not allowed",
          operationId: "16000000-0000-4000-8000-000000000011",
          expectedVersion: 0,
        }),
      "MISSION_EXISTS",
    );

    const updatedMission = domain.updateMission(databasePath, mission.id, {
      title: "  Updated mission  ",
      goal: "  Updated goal  ",
      expectedVersion: 1,
    });
    expect(updatedMission).toMatchObject({
      title: "Updated mission",
      goal: "Updated goal",
      version: 2,
    });
    expect(() =>
      domain.updateMission(databasePath, mission.id, {
        title: "Stale",
        goal: "Stale",
        expectedVersion: 1,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RESOURCE_CONFLICT", currentVersion: 2 }),
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    const assigned = domain.createWorkItem(databasePath, mission.id, {
      title: `  ${"任".repeat(160)}  `,
      description: `  ${"述".repeat(5000)}  `,
      assigneeAgentId: "agent-one",
      dependencyIds: [],
    });
    const unassigned = domain.createWorkItem(databasePath, mission.id, {
      title: "Unassigned",
      description: "",
      assigneeAgentId: null,
      dependencyIds: [],
    });
    expect(assigned).toMatchObject({
      title: "任".repeat(160),
      description: "述".repeat(5000),
      status: "todo",
      assigneeAgentId: "agent-one",
      dependencyIds: [],
      version: 1,
    });
    expect(unassigned.status).toBe("todo");
    expectCode(
      () =>
        domain.createWorkItem(databasePath, mission.id, {
          title: "Outsider",
          description: "",
          assigneeAgentId: "agent-outsider",
          dependencyIds: [],
        }),
      "ASSIGNEE_NOT_MEMBER",
    );

    const replaced = domain.updateWorkItem(databasePath, assigned.id, {
      title: "  Replaced title  ",
      description: "  Replaced description  ",
      assigneeAgentId: null,
      dependencyIds: [],
      expectedVersion: 1,
    });
    expect(replaced).toMatchObject({
      title: "Replaced title",
      description: "Replaced description",
      assigneeAgentId: null,
      status: "todo",
      version: 2,
    });
    expect(domain.getMissionState(databasePath, project.id)).toEqual({
      mission: updatedMission,
      workItems: [assigned, unassigned]
        .map((item) => (item.id === replaced.id ? replaced : item))
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        ),
    });
  });

  it("returns exact field errors for empty, over-limit, and invalid metadata", async () => {
    const domain = await service();
    const project = createProject("Bounds", databasePath);
    seedMembers(project.id);

    for (const [input, field, code] of [
      [
        {
          title: " ",
          goal: "Goal",
          operationId: "16000000-0000-4000-8000-000000000020",
          expectedVersion: 0,
        },
        "title",
        "required",
      ],
      [
        {
          title: "题".repeat(81),
          goal: "Goal",
          operationId: "16000000-0000-4000-8000-000000000021",
          expectedVersion: 0,
        },
        "title",
        "too_long",
      ],
      [
        {
          title: "Title",
          goal: "目".repeat(5001),
          operationId: "16000000-0000-4000-8000-000000000022",
          expectedVersion: 0,
        },
        "goal",
        "too_long",
      ],
    ] as const) {
      expect(() => domain.createMission(databasePath, project.id, input)).toThrowError(
        expect.objectContaining({
          code: "INVALID_INPUT",
          fields: [{ field, code }],
        }),
      );
    }

    const mission = domain.createMission(databasePath, project.id, {
      title: "Valid",
      goal: "Valid",
      operationId: "16000000-0000-4000-8000-000000000023",
      expectedVersion: 0,
    });
    expect(() =>
      domain.createWorkItem(databasePath, mission.id, {
        title: "任".repeat(161),
        description: "述".repeat(5001),
        assigneeAgentId: null,
        dependencyIds: [],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        fields: [
          { field: "title", code: "too_long" },
          { field: "description", code: "too_long" },
        ],
      }),
    );
  });
});

describe("mission and basic work-item API", () => {
  it("requires client create identity/version and deterministically replays the HTTP command", async () => {
    const api = await routes();
    const project = createProject("Mission command API", databasePath);
    const context = { params: Promise.resolve({ projectId: project.id }) };
    const url = `http://localhost/api/projects/${project.id}/mission`;

    for (const body of [
      { title: "Mission", goal: "Goal", expectedVersion: 0 },
      { title: "Mission", goal: "Goal", operationId: "not-a-uuid", expectedVersion: 0 },
      {
        title: "Mission",
        goal: "Goal",
        operationId: "16000000-0000-4000-8000-000000000001",
      },
      {
        title: "Mission",
        goal: "Goal",
        operationId: "16000000-0000-4000-8000-000000000001",
        expectedVersion: 1,
      },
    ]) {
      const response = await api.project.POST(request(url, body, "POST"), context);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "INVALID_INPUT",
          message: "Mission input is invalid.",
          fields: expect.any(Array),
        },
      });
    }

    const command = {
      title: " Mission ",
      goal: " Goal ",
      operationId: "16000000-0000-4000-8000-000000000001",
      expectedVersion: 0,
    };
    const first = await api.project.POST(request(url, command, "POST"), context);
    const replay = await api.project.POST(request(url, command, "POST"), context);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());

    const conflict = await api.project.POST(
      request(url, { ...command, goal: "Different" }, "POST"),
      context,
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: {
        code: "OPERATION_CONFLICT",
        message: "Operation input changed.",
      },
    });
  });

  it("exposes deterministic CRUD responses and stable HTTP errors", async () => {
    const api = await routes();
    const project = createProject("Mission API", databasePath);
    seedMembers(project.id);
    const projectContext = { params: Promise.resolve({ projectId: project.id }) };
    const projectUrl = `http://localhost/api/projects/${project.id}/mission`;

    const empty = await api.project.GET(new Request(projectUrl), projectContext);
    await expect(empty.json()).resolves.toEqual({ mission: null, workItems: [] });

    const createdResponse = await api.project.POST(
      request(
        projectUrl,
        {
          title: " API mission ",
          goal: " API goal ",
          operationId: "16000000-0000-4000-8000-000000000030",
          expectedVersion: 0,
        },
        "POST",
      ),
      projectContext,
    );
    expect(createdResponse.status).toBe(201);
    const { mission } = await createdResponse.json();
    expect(mission).toMatchObject({ title: "API mission", goal: "API goal", version: 1 });

    const duplicate = await api.project.POST(
      request(
        projectUrl,
        {
          title: "Second",
          goal: "Second",
          operationId: "16000000-0000-4000-8000-000000000031",
          expectedVersion: 0,
        },
        "POST",
      ),
      projectContext,
    );
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({
      error: { code: "MISSION_EXISTS", message: "Project already has a mission." },
    });

    const itemResponse = await api.workItems.POST(
      request(
        `http://localhost/api/missions/${mission.id}/work-items`,
        {
          title: " API task ",
          description: "",
          assigneeAgentId: "agent-one",
          dependencyIds: [],
        },
        "POST",
      ),
      { params: Promise.resolve({ missionId: mission.id }) },
    );
    expect(itemResponse.status).toBe(201);
    const { workItem } = await itemResponse.json();
    expect(workItem).toMatchObject({ title: "API task", status: "todo", version: 1 });

    const stale = await api.workItem.PATCH(
      request(
        `http://localhost/api/work-items/${workItem.id}`,
        {
          title: "Changed",
          description: "",
          assigneeAgentId: null,
          dependencyIds: [],
          expectedVersion: 2,
        },
        "PATCH",
      ),
      { params: Promise.resolve({ workItemId: workItem.id }) },
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: {
        code: "RESOURCE_CONFLICT",
        currentVersion: 1,
        message: "Work item version is stale.",
      },
    });

    const missingMission = await api.mission.PATCH(
      request(
        "http://localhost/api/missions/missing",
        { title: "Missing", goal: "Missing", expectedVersion: 1 },
        "PATCH",
      ),
      { params: Promise.resolve({ missionId: "missing" }) },
    );
    expect(missingMission.status).toBe(404);
    await expect(missingMission.json()).resolves.toEqual({
      error: { code: "MISSION_NOT_FOUND", message: "Mission was not found." },
    });
  });
});
