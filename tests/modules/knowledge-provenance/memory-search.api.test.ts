import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemory } from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type MemorySearchRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<MemorySearchRoute>(
  "../../../app/api/projects/[projectId]/memories/search/route.ts",
);

let databasePath: string;

async function route(): Promise<MemorySearchRoute> {
  const load =
    routeModules["../../../app/api/projects/[projectId]/memories/search/route.ts"];
  expect(load, "the memory search route must exist").toBeTypeOf("function");
  return load();
}

function projectContext(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function searchRequest(projectId: string, queryString: string): Request {
  const suffix = queryString.length > 0 ? `?${queryString}` : "";
  return new Request(
    `http://localhost/api/projects/${projectId}/memories/search${suffix}`,
  );
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
});

describe("GET /api/projects/:projectId/memories/search", () => {
  it("returns matching memories with snippets and a no-store header", async () => {
    const searchRoute = await route();
    const project = createProject("Memory search API", databasePath);
    const memory = createMemory(databasePath, project.id, {
      content: "Hello World Goal",
      sourceRef: "Owner brief",
      sourceType: "owner_input",
      type: "goal",
    });

    const response = await searchRoute.GET(
      searchRequest(project.id, "q=hello"),
      projectContext(project.id),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      results: [
        {
          memory: expect.objectContaining({
            active: true,
            content: "Hello World Goal",
            id: memory.id,
            projectId: project.id,
            type: "goal",
          }),
          snippet: "Hello World Goal",
        },
      ],
    });
  });

  it("applies type, sourceType, version, and limit filters", async () => {
    const searchRoute = await route();
    const project = createProject("Memory search filters", databasePath);
    createMemory(databasePath, project.id, {
      content: "Shared keyword goal",
      sourceRef: "Owner",
      sourceType: "owner_input",
      type: "goal",
    });
    createMemory(databasePath, project.id, {
      content: "Shared keyword fact",
      sourceRef: "Owner",
      sourceType: "owner_input",
      type: "fact",
    });
    const artifact = createMemory(databasePath, project.id, {
      content: "Shared keyword artifact",
      sourceRef: "docs/note.md",
      sourceType: "artifact_path",
      type: "artifact",
    });
    const original = createMemory(databasePath, project.id, {
      content: "Versioned original search",
      sourceRef: "Owner",
      sourceType: "owner_input",
      type: "decision",
    });
    const replacement = createMemory(databasePath, project.id, {
      content: "Versioned replacement search",
      sourceRef: "Owner",
      sourceType: "owner_input",
      supersedesId: original.id,
      type: "decision",
    });

    const typeHits = await (
      await searchRoute.GET(
        searchRequest(project.id, "q=Shared+keyword&type=goal"),
        projectContext(project.id),
      )
    ).json();
    expect(typeHits.results.map((hit: { memory: { content: string } }) => hit.memory.content))
      .toEqual(["Shared keyword goal"]);

    const sourceHits = await (
      await searchRoute.GET(
        searchRequest(project.id, "q=Shared+keyword&sourceType=artifact_path"),
        projectContext(project.id),
      )
    ).json();
    expect(sourceHits.results.map((hit: { memory: { id: string } }) => hit.memory.id))
      .toEqual([artifact.id]);

    const versionHits = await (
      await searchRoute.GET(
        searchRequest(project.id, `q=Versioned&version=${replacement.version}`),
        projectContext(project.id),
      )
    ).json();
    expect(versionHits.results.map((hit: { memory: { id: string } }) => hit.memory.id))
      .toEqual([replacement.id]);

    const limited = await (
      await searchRoute.GET(
        searchRequest(project.id, "q=Shared+keyword&limit=1"),
        projectContext(project.id),
      )
    ).json();
    expect(limited.results).toHaveLength(1);
  });

  it("excludes superseded parents and returns an empty page for unmatched q", async () => {
    const searchRoute = await route();
    const project = createProject("Memory search empty", databasePath);
    const parent = createMemory(databasePath, project.id, {
      content: "Initial context goal",
      sourceRef: "Owner",
      sourceType: "owner_input",
      type: "goal",
    });
    createMemory(databasePath, project.id, {
      content: "Current context goal",
      sourceRef: "Owner",
      sourceType: "owner_input",
      supersedesId: parent.id,
      type: "goal",
    });

    const superseded = await (
      await searchRoute.GET(
        searchRequest(project.id, "q=context+goal"),
        projectContext(project.id),
      )
    ).json();
    expect(
      superseded.results.map((hit: { memory: { content: string } }) => hit.memory.content),
    ).toEqual(["Current context goal"]);

    const empty = await searchRoute.GET(
      searchRequest(project.id, "q=zzz-no-match"),
      projectContext(project.id),
    );
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({ results: [] });
  });

  it.each([
    ["q=", "q", "required"],
    ["q=%20%20", "q", "required"],
    [`q=${encodeURIComponent("字".repeat(201))}`, "q", "too_long"],
    ["q=a&q=b", "q", "duplicate"],
    ["q=x&limit=0", "limit", "invalid_range"],
    ["q=x&limit=51", "limit", "invalid_range"],
    ["q=x&limit=abc", "limit", "invalid_format"],
    ["q=x&limit=", "limit", "required"],
    ["q=x&limit=1&limit=2", "limit", "duplicate"],
    ["q=x&type=not-a-type", "type", "invalid_format"],
    ["q=x&type=goal&type=fact", "type", "duplicate"],
    ["q=x&sourceType=nope", "sourceType", "invalid_format"],
    ["q=x&sourceType=owner_input&sourceType=work_item", "sourceType", "duplicate"],
    ["q=x&version=0", "version", "invalid_range"],
    ["q=x&version=abc", "version", "invalid_format"],
    ["q=x&version=", "version", "required"],
    ["q=x&version=1&version=2", "version", "duplicate"],
    ["q=x&bogus=1", "bogus", "unknown"],
  ])("rejects invalid query %s with a stable 400 envelope", async (queryString, field, code) => {
    const searchRoute = await route();
    const project = createProject("Memory search invalid", databasePath);

    const response = await searchRoute.GET(
      searchRequest(project.id, queryString),
      projectContext(project.id),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toBe("Memory search query is invalid.");
    expect(body.error.fields).toContainEqual({ code, field });
  });

  it("rejects a missing q with 400", async () => {
    const searchRoute = await route();
    const project = createProject("Memory search missing q", databasePath);

    const response = await searchRoute.GET(
      searchRequest(project.id, ""),
      projectContext(project.id),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.fields).toContainEqual({ code: "required", field: "q" });
  });

  it("returns 404 PROJECT_NOT_FOUND for a missing project", async () => {
    const searchRoute = await route();

    const response = await searchRoute.GET(
      searchRequest("missing", "q=x"),
      projectContext("missing"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PROJECT_NOT_FOUND",
        message: "Project was not found.",
      },
    });
  });
});
