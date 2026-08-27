import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type RouteModule = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<RouteModule>(
  "../../../app/api/projects/[projectId]/replay/route.ts",
);

async function route(): Promise<RouteModule> {
  const load = routeModules["../../../app/api/projects/[projectId]/replay/route.ts"];
  expect(load, "the delivery replay route must exist").toBeTypeOf("function");
  return load();
}

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
});

describe("GET /api/projects/:projectId/replay", () => {
  it("returns a no-store replay package for a required runId", async () => {
    const databasePath = memoryDatabasePath();
    process.env.COCKPIT_DB_PATH = databasePath;
    const project = createProject("Replay API", databasePath);
    const handler = await route();
    const response = await handler.GET(
      new Request(`http://localhost/api/projects/${project.id}/replay?runId=run-missing`),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      formatVersion: 1,
      items: [],
      scope: { projectId: project.id, runId: "run-missing", detail: "只读回放" },
    });
  });

  it("rejects missing runId, extra query keys, and unknown projects", async () => {
    const databasePath = memoryDatabasePath();
    process.env.COCKPIT_DB_PATH = databasePath;
    const handler = await route();
    const missingKey = await handler.GET(
      new Request("http://localhost/api/projects/project-1/replay"),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );
    expect(missingKey.status).toBe(400);
    const extra = await handler.GET(
      new Request("http://localhost/api/projects/project-1/replay?runId=run-a&probe=1"),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );
    expect(extra.status).toBe(400);
    const missing = await handler.GET(
      new Request("http://localhost/api/projects/missing-project/replay?runId=run-a"),
      { params: Promise.resolve({ projectId: "missing-project" }) },
    );
    expect(missing.status).toBe(404);
  });
});
