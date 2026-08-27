import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type RouteModule = {
  GET(request: Request): Promise<Response>;
};

const routeModules = import.meta.glob<RouteModule>(
  "../../../app/api/usage/route.ts",
);

async function route(): Promise<RouteModule> {
  const load = routeModules["../../../app/api/usage/route.ts"];
  expect(load, "the usage quota route must exist").toBeTypeOf("function");
  return load();
}

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
});

describe("GET /api/usage", () => {
  it("returns a no-store usage DTO that is labeled not an invoice", async () => {
    const databasePath = memoryDatabasePath();
    process.env.COCKPIT_DB_PATH = databasePath;
    const handler = await route();
    const response = await handler.GET(new Request("http://localhost/api/usage"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      budgets: [],
      disclaimer: "not_invoice",
      project: {
        detail: "需要打开项目",
        projectId: null,
        totals: {
          completionTokens: 0,
          invalidCalls: 0,
          promptTokens: 0,
          totalTokens: 0,
          unreportedCalls: 0,
        },
      },
      providers: [],
      runs: [],
    });
  });

  it("rejects extra query keys and unknown projects", async () => {
    const databasePath = memoryDatabasePath();
    process.env.COCKPIT_DB_PATH = databasePath;
    const handler = await route();
    const extra = await handler.GET(new Request("http://localhost/api/usage?probe=1"));
    expect(extra.status).toBe(400);
    expect(await extra.json()).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
    const missing = await handler.GET(
      new Request("http://localhost/api/usage?projectId=missing-project"),
    );
    expect(missing.status).toBe(404);
    const project = createProject("Usage API", databasePath);
    const scoped = await handler.GET(
      new Request(`http://localhost/api/usage?projectId=${project.id}`),
    );
    expect(scoped.status).toBe(200);
    expect(scoped.headers.get("cache-control")).toBe("no-store");
    expect(await scoped.json()).toMatchObject({
      disclaimer: "not_invoice",
      project: { projectId: project.id, detail: "尚无已报告用量" },
    });
  });
});
