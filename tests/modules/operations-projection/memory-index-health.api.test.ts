import { afterEach, describe, expect, it } from "vitest";

import { createMemory } from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type RouteModule = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
  POST?(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<RouteModule>(
  "../../../app/api/projects/[projectId]/memory-index/health/route.ts",
);
const rebuildRouteModules = import.meta.glob<RouteModule>(
  "../../../app/api/projects/[projectId]/memory-index/rebuild/route.ts",
);

async function route(): Promise<RouteModule> {
  const load = routeModules[
    "../../../app/api/projects/[projectId]/memory-index/health/route.ts"
  ];
  expect(load, "the memory index health route must exist").toBeTypeOf("function");
  return load();
}

async function rebuildRoute(): Promise<RouteModule> {
  const load = rebuildRouteModules[
    "../../../app/api/projects/[projectId]/memory-index/rebuild/route.ts"
  ];
  expect(load, "the memory index rebuild route must exist").toBeTypeOf("function");
  return load();
}

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
});

describe("GET /api/projects/:projectId/memory-index/health", () => {
  it("returns a no-store redacted project health DTO", async () => {
    const databasePath = memoryDatabasePath();
    process.env.COCKPIT_DB_PATH = databasePath;
    const project = createProject("Memory health API", databasePath);
    createMemory(databasePath, project.id, {
      content: "Private health source",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "fact",
    });

    const handler = await route();
    const response = await handler.GET(
      new Request(`http://localhost/api/projects/${project.id}/memory-index/health`),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain("Private health source");
    expect(JSON.parse(text)).toMatchObject({
      coverage: { active: 1, indexed: 1, ratio: 1, valid: 1 },
      projectId: project.id,
      status: "caught_up",
    });
  });

  it("requires a strict confirmed rebuild request and returns its receipt", async () => {
    const databasePath = memoryDatabasePath();
    process.env.COCKPIT_DB_PATH = databasePath;
    const project = createProject("Memory rebuild API", databasePath);
    createMemory(databasePath, project.id, {
      content: "Rebuild source",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "fact",
    });
    const healthHandler = await route();
    await healthHandler.GET(
      new Request(`http://localhost/api/projects/${project.id}/memory-index/health`),
      { params: Promise.resolve({ projectId: project.id }) },
    );

    const handler = await rebuildRoute();
    expect(handler.POST).toBeTypeOf("function");
    const response = await handler.POST!(
      new Request(`http://localhost/api/projects/${project.id}/memory-index/rebuild`, {
        body: JSON.stringify({
          confirmation: "重建记忆索引",
          expectedVersion: 1,
          operationId: "00000000-0000-4000-8000-000000000002",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      replayed: 1,
      status: "caught_up",
      version: 2,
    });
  });
});
