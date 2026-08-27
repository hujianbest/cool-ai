import { afterEach, describe, expect, it } from "vitest";

import { createMemory } from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type RouteModule = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<RouteModule>(
  "../../../app/api/projects/[projectId]/knowledge-graph/route.ts",
);

async function route(): Promise<RouteModule> {
  const load = routeModules["../../../app/api/projects/[projectId]/knowledge-graph/route.ts"];
  expect(load, "the knowledge graph route must exist").toBeTypeOf("function");
  return load();
}

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
});

describe("GET /api/projects/:projectId/knowledge-graph", () => {
  it("returns a no-store sourced graph for the current project", async () => {
    const databasePath = memoryDatabasePath();
    process.env.COCKPIT_DB_PATH = databasePath;
    const project = createProject("Graph API", databasePath);
    const first = createMemory(databasePath, project.id, {
      content: "Use HMAC",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "decision",
    });
    const second = createMemory(databasePath, project.id, {
      content: "Use RS256",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      supersedesId: first.id,
      type: "decision",
    });
    const handler = await route();
    const response = await handler.GET(
      new Request(`http://localhost/api/projects/${project.id}/knowledge-graph`),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      edges: [{ fromId: second.id, kind: "supersedes", toId: first.id }],
    });
  });

  it("rejects extra query keys and unknown projects", async () => {
    const databasePath = memoryDatabasePath();
    process.env.COCKPIT_DB_PATH = databasePath;
    const handler = await route();
    const extra = await handler.GET(
      new Request("http://localhost/api/projects/project-1/knowledge-graph?probe=1"),
      { params: Promise.resolve({ projectId: "project-1" }) },
    );
    expect(extra.status).toBe(400);
    const missing = await handler.GET(
      new Request("http://localhost/api/projects/missing-project/knowledge-graph"),
      { params: Promise.resolve({ projectId: "missing-project" }) },
    );
    expect(missing.status).toBe(404);
  });
});
