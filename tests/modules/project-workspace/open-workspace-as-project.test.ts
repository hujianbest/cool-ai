import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  ensureDirectProject,
  listProjects,
} from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { openWorkspaceAsProject } from "@/src/adapters/outbound/sqlite/project-workspace/workspace-service";
import { getWorkspace } from "@/src/adapters/outbound/sqlite/project-workspace/workspace-service";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const temporaryDirectories: string[] = [];

function temporaryWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "cool-ai-open-workspace-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("openWorkspaceAsProject", () => {
  it("creates a bound basename project and resumes it on the second open", async () => {
    const databasePath = memoryDatabasePath();
    const workspacePath = temporaryWorkspace();

    const first = await openWorkspaceAsProject(databasePath, workspacePath);
    const second = await openWorkspaceAsProject(databasePath, workspacePath);

    expect(first).toEqual({
      created: true,
      project: expect.objectContaining({ name: basename(workspacePath) }),
    });
    expect(getWorkspace(databasePath, first.project.id)).toMatchObject({
      projectVersion: 2,
      workspace: { status: "ready" },
    });
    expect(second).toEqual({ created: false, project: first.project });

    const database = openDatabase(databasePath);
    const eventTypes = database
      .prepare(
        `SELECT event_type AS eventType
         FROM audit_event_outbox
         WHERE project_id = ?
         ORDER BY outbox_seq`,
      )
      .all(first.project.id) as Array<{ eventType: string }>;
    database.close();
    expect(eventTypes.map(({ eventType }) => eventType)).toEqual([
      "project_created",
      "workspace_bound",
    ]);
  });

  it.each([
    ["relative/workspace", "WORKSPACE_INVALID"],
    [join(tmpdir(), `cool-ai-missing-${process.pid}-${Date.now()}`), "WORKSPACE_NOT_FOUND"],
  ])("rejects %s without creating a project", async (workspacePath, code) => {
    const databasePath = memoryDatabasePath();

    await expect(
      openWorkspaceAsProject(databasePath, workspacePath),
    ).rejects.toMatchObject({ code });
    expect(listProjects(databasePath)).toEqual([]);
  });

  it("creates a folder project without hijacking the personal conversation", async () => {
    const databasePath = memoryDatabasePath();
    const directProject = ensureDirectProject(databasePath);
    const workspacePath = temporaryWorkspace();

    const opened = await openWorkspaceAsProject(databasePath, workspacePath);

    expect(opened.project.id).not.toBe(directProject.id);
    expect(getWorkspace(databasePath, directProject.id).workspace).toBeNull();
    expect(listProjects(databasePath)).toEqual([directProject, opened.project]);
  });
});
