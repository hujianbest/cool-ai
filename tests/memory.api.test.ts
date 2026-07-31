import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "@/src/server/projects";

type MemoryRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const routeModules =
  import.meta.glob<MemoryRoute>("../app/api/projects/[projectId]/memories/route.ts");

let directory: string;
let databasePath: string;

async function route(): Promise<MemoryRoute> {
  const load =
    routeModules["../app/api/projects/[projectId]/memories/route.ts"];
  expect(load, "the sourced memory route must exist").toBeTypeOf("function");
  return load();
}

function request(url: string, body: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-memory-api-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("sourced memory API", () => {
  it("creates, lists active, and optionally lists inactive entries", async () => {
    const memoryRoute = await route();
    const project = createProject("Memory API", databasePath);
    const context = { params: Promise.resolve({ projectId: project.id }) };
    const url = `http://localhost/api/projects/${project.id}/memories`;

    const empty = await memoryRoute.GET(new Request(url), context);
    await expect(empty.json()).resolves.toEqual({ memories: [] });

    const baseResponse = await memoryRoute.POST(
      request(url, {
        type: "goal",
        content: "  Original goal  ",
        sourceType: "owner_input",
        sourceRef: "  Owner brief  ",
      }),
      context,
    );
    expect(baseResponse.status).toBe(201);
    const { memory: base } = await baseResponse.json();
    expect(base).toMatchObject({
      content: "Original goal",
      sourceRef: "Owner brief",
      active: true,
      createdBy: "owner",
    });

    const childResponse = await memoryRoute.POST(
      request(url, {
        type: "goal",
        content: "Replacement goal",
        sourceType: "owner_input",
        sourceRef: "Owner brief",
        supersedesId: base.id,
      }),
      context,
    );
    expect(childResponse.status).toBe(201);
    const { memory: child } = await childResponse.json();

    const active = await memoryRoute.GET(new Request(url), context);
    await expect(active.json()).resolves.toEqual({ memories: [child] });
    const all = await memoryRoute.GET(new Request(`${url}?includeInactive=1`), context);
    const allPayload = await all.json();
    expect(allPayload.memories).toHaveLength(2);
    expect(allPayload.memories.find(({ id }: { id: string }) => id === base.id)).toMatchObject({
      active: false,
    });
  });

  it("returns stable JSON, source, project, and supersede errors", async () => {
    const memoryRoute = await route();
    const project = createProject("Memory errors", databasePath);
    const context = { params: Promise.resolve({ projectId: project.id }) };
    const url = `http://localhost/api/projects/${project.id}/memories`;

    const invalidJson = await memoryRoute.POST(
      new Request(url, {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      context,
    );
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toEqual({
      error: {
        code: "INVALID_JSON",
        message: "Request body must be valid JSON.",
      },
    });

    const invalidSource = await memoryRoute.POST(
      request(url, {
        type: "artifact",
        content: "Secret",
        sourceType: "artifact_path",
        sourceRef: "../secret",
      }),
      context,
    );
    expect(invalidSource.status).toBe(400);
    await expect(invalidSource.json()).resolves.toEqual({
      error: {
        code: "INVALID_SOURCE",
        fields: [{ code: "invalid_format", field: "sourceRef" }],
        message: "Memory source is invalid.",
      },
    });

    const missingMemory = await memoryRoute.POST(
      request(url, {
        type: "fact",
        content: "Replacement",
        sourceType: "owner_input",
        sourceRef: "Owner",
        supersedesId: "missing",
      }),
      context,
    );
    expect(missingMemory.status).toBe(404);
    await expect(missingMemory.json()).resolves.toEqual({
      error: {
        code: "MEMORY_NOT_FOUND",
        message: "Memory entry was not found.",
      },
    });

    const missingProject = await memoryRoute.GET(
      new Request("http://localhost/api/projects/missing/memories"),
      { params: Promise.resolve({ projectId: "missing" }) },
    );
    expect(missingProject.status).toBe(404);
    await expect(missingProject.json()).resolves.toEqual({
      error: {
        code: "PROJECT_NOT_FOUND",
        message: "Project was not found.",
      },
    });
  });
});
