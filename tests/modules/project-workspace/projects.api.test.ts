import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/projects/route";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  process.env.COCKPIT_DB_PATH = memoryDatabasePath();
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("/api/projects", () => {
  it("opens a folder project, resumes it, and returns it from the collection", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "cool-ai-projects-api-"));
    temporaryDirectories.push(workspacePath);
    const response = await POST(
      new Request("http://localhost/api/projects", {
        body: JSON.stringify({ path: workspacePath }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(201);
    const { project } = await response.json();
    expect(project).toMatchObject({ name: basename(workspacePath) });

    const resumed = await POST(
      new Request("http://localhost/api/projects", {
        body: JSON.stringify({ path: workspacePath }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toEqual({ project });

    const collection = await GET();
    await expect(collection.json()).resolves.toEqual({ projects: [project] });
  });

  it.each([
    [{ name: "Launch plan" }, [{ code: "required", field: "path" }]],
    [{}, [{ code: "required", field: "path" }]],
    [{ path: 42 }, [{ code: "invalid_type", field: "path" }]],
    [{ extra: true, path: "D:\\work" }, [{ code: "unexpected", field: "extra" }]],
  ])("rejects invalid open input %#", async (body, fields) => {
    const response = await POST(
      new Request("http://localhost/api/projects", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields,
        message: "Project input is invalid.",
      },
    });
  });

  it("maps workspace validation errors through the stable envelope", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects", {
        body: JSON.stringify({ path: "relative/workspace" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "WORKSPACE_INVALID",
        message: "Workspace path must be an absolute path.",
      },
    });
  });
});
