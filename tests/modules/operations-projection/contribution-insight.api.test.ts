import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type RouteModule = {
  GET(request: Request): Promise<Response>;
};

const routeModules = import.meta.glob<RouteModule>(
  "../../../app/api/contribution/route.ts",
);

async function route(): Promise<RouteModule> {
  const load = routeModules["../../../app/api/contribution/route.ts"];
  expect(load, "the contribution insight route must exist").toBeTypeOf("function");
  return load();
}

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
});

describe("GET /api/contribution", () => {
  it("returns a no-store contribution DTO that is not a ranking", async () => {
    const databasePath = memoryDatabasePath();
    process.env.COCKPIT_DB_PATH = databasePath;
    const handler = await route();
    const response = await handler.GET(new Request("http://localhost/api/contribution"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      disclaimer: "not_ranking",
      project: { detail: "需要打开项目", projectId: null },
      roles: [],
    });
  });

  it("rejects extra query keys and unknown projects", async () => {
    const databasePath = memoryDatabasePath();
    process.env.COCKPIT_DB_PATH = databasePath;
    const handler = await route();
    const extra = await handler.GET(new Request("http://localhost/api/contribution?probe=1"));
    expect(extra.status).toBe(400);
    const missing = await handler.GET(
      new Request("http://localhost/api/contribution?projectId=missing-project"),
    );
    expect(missing.status).toBe(404);
    const project = createProject("Contribution API", databasePath);
    const scoped = await handler.GET(
      new Request(`http://localhost/api/contribution?projectId=${project.id}`),
    );
    expect(scoped.status).toBe(200);
    expect(await scoped.json()).toMatchObject({
      disclaimer: "not_ranking",
      project: { projectId: project.id },
    });
  });
});
