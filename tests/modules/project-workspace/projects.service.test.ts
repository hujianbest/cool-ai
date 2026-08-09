import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProject, listProjects } from "@/src/adapters/outbound/sqlite/project-workspace/projects";

const temporaryDirectories: string[] = [];

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-projects-"));
  temporaryDirectories.push(directory);
  return join(directory, "cockpit.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
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
