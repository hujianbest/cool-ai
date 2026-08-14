import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getSopState } from "@/app/api/projects/[projectId]/sop-state/route";
import {
  deriveSopItemFreshness,
  getSopStateProjection,
} from "@/src/adapters/outbound/sqlite/mission-work/sop-state-projection";
import { createWorkItem } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { bindWorkspace } from "@/src/adapters/outbound/sqlite/project-workspace/workspace-service";
import { createWindowsVerifiedExecutionAdapters } from "@/src/adapters/outbound/workspace/windows-verified-execution-adapter";
import { workspaceBrowseService } from "@/src/composition";
import { createMission } from "@/src/composition/mission-commands";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

vi.mock("server-only", () => ({}));

const fileAdapter = createWindowsVerifiedExecutionAdapters().fileAdapter;

const temporaryDirectories: string[] = [];

let databasePath: string;
let missionOperationSequence: number;

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-sop-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createProjectMission(name: string) {
  const project = createProject(name, databasePath);
  const mission = createMission(databasePath, project.id, {
    expectedVersion: 0,
    title: `${name} mission`,
    goal: `${name} goal`,
    operationId: `26000000-0000-4000-8000-${(++missionOperationSequence)
      .toString(16)
      .padStart(12, "0")}`,
  });
  return { project, mission };
}

function item(missionId: string, title: string) {
  return createWorkItem(databasePath, missionId, {
    title,
    description: `${title} description`,
    assigneeAgentId: null,
    dependencyIds: [],
  });
}

async function bindRoot(projectId: string, root: string): Promise<void> {
  await bindWorkspace(databasePath, projectId, {
    confirmRebind: false,
    expectedVersion: 1,
    path: root,
  });
}

function writeProgress(
  root: string,
  slug: string,
  fields: { title?: string; stage?: string; body?: string },
): void {
  mkdirSync(join(root, "features", slug), { recursive: true });
  const lines = ["# progress"];
  if (fields.title !== undefined) lines.push(`- 特性: ${fields.title}`);
  if (fields.stage !== undefined) lines.push(`- 当前阶段: ${fields.stage}`);
  if (fields.body !== undefined) lines.push("", fields.body);
  writeFileSync(join(root, "features", slug, "progress.md"), `${lines.join("\n")}\n`, "utf8");
}

function projectSopState(projectId: string) {
  return getSopStateProjection(databasePath, projectId, {
    listWorkspaceDirectory: (path, id, relativePath) =>
      workspaceBrowseService.listWorkspaceDirectory(path, id, relativePath, fileAdapter),
    readWorkspaceFilePreview: (path, id, relativePath) =>
      workspaceBrowseService.readWorkspaceFilePreview(path, id, relativePath, fileAdapter),
  });
}

function routeContext(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

beforeEach(() => {
  missionOperationSequence = 0;
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("getSopStateProjection", () => {
  it("returns workspaceBound false and empty items when the workspace is unbound", async () => {
    const { project } = createProjectMission("Unbound");

    const projection = await projectSopState(project.id);

    expect(projection).toMatchObject({
      workspaceBound: false,
      items: [],
    });
    expect(Number.isFinite(Date.parse(projection.readAt))).toBe(true);
  });

  it("returns workspaceBound true and empty items when features/ is missing", async () => {
    const { project } = createProjectMission("No features");
    const root = temporaryRoot();
    await bindRoot(project.id, root);

    const projection = await projectSopState(project.id);

    expect(projection).toMatchObject({
      workspaceBound: true,
      items: [],
    });
  });

  it("discovers one progress.md and parses title, stage, and relative path", async () => {
    const { project } = createProjectMission("Discover");
    const root = temporaryRoot();
    writeProgress(root, "demo-sop", {
      title: "SOP 状态投影",
      stage: "implement",
      body: "SECRET_BODY_TOKEN_SHOULD_NOT_LEAK",
    });
    await bindRoot(project.id, root);

    const projection = await projectSopState(project.id);

    expect(projection.workspaceBound).toBe(true);
    expect(projection.items).toEqual([
      {
        relativePath: "features/demo-sop/progress.md",
        title: "SOP 状态投影",
        declaredStage: "implement",
        freshness: "current",
        staleReason: null,
        workItems: [],
      },
    ]);
    expect(JSON.stringify(projection)).not.toContain("SECRET_BODY_TOKEN_SHOULD_NOT_LEAK");
  });

  it("lists a matching work item when the title contains the feature slug", async () => {
    const { project, mission } = createProjectMission("Match slug");
    const workItem = item(mission.id, "Implement demo-sop query");
    const root = temporaryRoot();
    writeProgress(root, "demo-sop", { title: "SOP 状态投影", stage: "implement" });
    await bindRoot(project.id, root);

    const projection = await projectSopState(project.id);

    expect(projection.items[0]?.workItems).toEqual([
      {
        workItemId: workItem.id,
        title: "Implement demo-sop query",
        status: "todo",
      },
    ]);
    expect(projection.items[0]?.freshness).toBe("current");
  });

  it("marks declared_stage_diverges when the file is done and a match is still todo", async () => {
    const { project, mission } = createProjectMission("Done vs todo");
    const workItem = item(mission.id, "demo-sop wrap-up");
    const root = temporaryRoot();
    writeProgress(root, "demo-sop", { title: "SOP 状态投影", stage: "done" });
    await bindRoot(project.id, root);

    const projection = await projectSopState(project.id);

    expect(projection.items[0]).toMatchObject({
      declaredStage: "done",
      freshness: "stale",
      staleReason: "declared_stage_diverges",
      workItems: [{ workItemId: workItem.id, status: "todo" }],
    });
  });

  it("marks declared_stage_diverges when the file is implement and every match is done", async () => {
    // Persisted status='done' requires a passed review graph (current-schema
    // data invariant). Same seam as dependency-insight: exercise done via the
    // pure derivation, then confirm the projection still matches both needles.
    const { project, mission } = createProjectMission("Implement vs done");
    const first = item(mission.id, "demo-sop first");
    const second = item(mission.id, "Ship SOP 状态投影");
    const root = temporaryRoot();
    writeProgress(root, "demo-sop", { title: "SOP 状态投影", stage: "implement" });
    await bindRoot(project.id, root);

    const projection = await projectSopState(project.id);
    expect(projection.items[0]?.workItems.map((entry) => entry.workItemId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(
      deriveSopItemFreshness(
        "implement",
        [
          { workItemId: first.id, title: first.title, status: "done" },
          { workItemId: second.id, title: second.title, status: "done" },
        ],
        false,
      ),
    ).toEqual({
      freshness: "stale",
      staleReason: "declared_stage_diverges",
    });
  });

  it("stays current when a readable file has no matching work items", async () => {
    const { project, mission } = createProjectMission("No match");
    item(mission.id, "Unrelated board task");
    const root = temporaryRoot();
    writeProgress(root, "demo-sop", { title: "SOP 状态投影", stage: "grill-with-docs" });
    await bindRoot(project.id, root);

    const projection = await projectSopState(project.id);

    expect(projection.items[0]).toMatchObject({
      freshness: "current",
      staleReason: null,
      workItems: [],
    });
  });

  it("skips a feature directory that has no progress.md", async () => {
    const { project } = createProjectMission("Skip missing");
    const root = temporaryRoot();
    mkdirSync(join(root, "features", "empty-slug"), { recursive: true });
    writeFileSync(join(root, "features", "notes.md"), "not a progress file\n", "utf8");
    writeProgress(root, "kept-sop", { title: "保留特性", stage: "to-spec" });
    await bindRoot(project.id, root);

    const projection = await projectSopState(project.id);

    expect(projection.items.map((entry) => entry.relativePath)).toEqual([
      "features/kept-sop/progress.md",
    ]);
  });

  it("fails closed with PROJECT_NOT_FOUND for an unknown project", async () => {
    await expect(projectSopState("missing-project")).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });
});

describe("GET /api/projects/:projectId/sop-state", () => {
  it("returns a stable sanitized 404 envelope for a missing project", async () => {
    const response = await getSopState(
      new Request("http://localhost/api/projects/missing-project/sop-state"),
      routeContext("missing-project"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project was not found." },
    });
  });

  it("rejects query parameters with INVALID_INPUT", async () => {
    const { project } = createProjectMission("Route query");

    const response = await getSopState(
      new Request(`http://localhost/api/projects/${project.id}/sop-state?verbose=true`),
      routeContext(project.id),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("returns JSON without host path substrings or file bodies", async () => {
    const { project } = createProjectMission("Route leak");
    const root = temporaryRoot();
    writeProgress(root, "demo-sop", {
      title: "SOP 状态投影",
      stage: "implement",
      body: "HOST_BODY_MUST_STAY_PRIVATE",
    });
    await bindRoot(project.id, root);

    const response = await getSopState(
      new Request(`http://localhost/api/projects/${project.id}/sop-state`),
      routeContext(project.id),
    );

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain(root);
    expect(serialized.toLowerCase()).not.toContain(root.toLowerCase());
    expect(serialized).not.toContain("HOST_BODY_MUST_STAY_PRIVATE");
    expect(serialized).toContain("features/demo-sop/progress.md");
  });
});
