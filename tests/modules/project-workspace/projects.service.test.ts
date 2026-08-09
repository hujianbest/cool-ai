

import { afterEach, describe, expect, it } from "vitest";

import { createProject, listProjects } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

function databasePath() {
  return memoryDatabasePath();
}

afterEach(() => {
});

describe("project service", () => {
  it("creates and reloads a trimmed project from SQLite", () => {
    const path = databasePath();

    const created = createProject("  Launch plan  ", path);
    const reloaded = listProjects(path);

    expect(created).toMatchObject({ name: "Launch plan" });
    expect(created.id).toEqual(expect.any(String));
    expect(reloaded).toEqual([created]);
  });

  it("rejects an empty project name without persisting", () => {
    const path = databasePath();

    expect(() => createProject("   ", path)).toThrowError("Project name is required.");
    expect(listProjects(path)).toEqual([]);
  });
});
