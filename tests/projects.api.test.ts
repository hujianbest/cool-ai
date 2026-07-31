import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/projects/route";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-api-"));
  process.env.COCKPIT_DB_PATH = join(directory, "cockpit.sqlite");
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("/api/projects", () => {
  it("creates a project and returns it from the collection", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects", {
        body: JSON.stringify({ name: "Launch plan" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(201);
    const { project } = await response.json();
    expect(project).toMatchObject({ name: "Launch plan" });

    const collection = await GET();
    await expect(collection.json()).resolves.toEqual({ projects: [project] });
  });

  it("returns the stable empty-name error contract", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects", {
        body: JSON.stringify({ name: "  " }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "EMPTY_PROJECT_NAME",
        message: "Project name is required.",
      },
    });
  });
});
