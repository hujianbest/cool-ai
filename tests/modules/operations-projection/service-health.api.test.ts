import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { CURRENT_SCHEMA } from "@/src/adapters/outbound/sqlite/current-schema";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type RouteModule = {
  GET(request: Request): Promise<Response>;
};

const routeModules = import.meta.glob<RouteModule>(
  "../../../app/api/health/route.ts",
);

async function route(): Promise<RouteModule> {
  const load = routeModules["../../../app/api/health/route.ts"];
  expect(load, "the service health route must exist").toBeTypeOf("function");
  return load();
}

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
});

describe("GET /api/health", () => {
  it("returns a no-store aggregate health DTO without a project", async () => {
    const databasePath = memoryDatabasePath();
    process.env.COCKPIT_DB_PATH = databasePath;
    const handler = await route();
    const response = await handler.GET(new Request("http://localhost/api/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      app: { schemaIdentity: CURRENT_SCHEMA.identity.userVersion, status: "ok" },
      execution: { status: "unknown" },
      memoryIndex: { status: "unknown" },
      providers: { status: "degraded", total: 0, verified: 0 },
    });
  });

  it("rejects extra query keys and unknown projects", async () => {
    const databasePath = memoryDatabasePath();
    process.env.COCKPIT_DB_PATH = databasePath;
    const handler = await route();
    const extra = await handler.GET(new Request("http://localhost/api/health?probe=1"));
    expect(extra.status).toBe(400);
    const missing = await handler.GET(
      new Request("http://localhost/api/health?projectId=missing-project"),
    );
    expect(missing.status).toBe(404);
    const project = createProject("Health API", databasePath);
    const scoped = await handler.GET(
      new Request(`http://localhost/api/health?projectId=${project.id}`),
    );
    expect(scoped.status).toBe(200);
    expect(await scoped.json()).toMatchObject({
      execution: { projectId: project.id, status: "ok" },
      memoryIndex: { projectId: project.id, status: "ok" },
    });
  });
});
