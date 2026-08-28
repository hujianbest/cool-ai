import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type RootRoute = {
  GET(request: Request, context: ProjectContext): Promise<Response>;
  POST(request: Request, context: ProjectContext): Promise<Response>;
};
type DecisionRoute = {
  POST(request: Request, context: CandidateContext): Promise<Response>;
};
type ProjectContext = { params: Promise<{ projectId: string }> };
type CandidateContext = {
  params: Promise<{ candidateId: string; projectId: string }>;
};

const rootRouteModules = import.meta.glob<RootRoute>(
  "../../../app/api/projects/[projectId]/memory-curation-candidates/route.ts",
);
const publishRouteModules = import.meta.glob<DecisionRoute>(
  "../../../app/api/projects/[projectId]/memory-curation-candidates/[candidateId]/publish/route.ts",
);
const rejectRouteModules = import.meta.glob<DecisionRoute>(
  "../../../app/api/projects/[projectId]/memory-curation-candidates/[candidateId]/reject/route.ts",
);

let databasePath: string;

async function rootRoute(): Promise<RootRoute> {
  const load = rootRouteModules[
    "../../../app/api/projects/[projectId]/memory-curation-candidates/route.ts"
  ];
  expect(load, "the memory curation collection route must exist").toBeTypeOf("function");
  return load();
}

async function publishRoute(): Promise<DecisionRoute> {
  const load = publishRouteModules[
    "../../../app/api/projects/[projectId]/memory-curation-candidates/[candidateId]/publish/route.ts"
  ];
  expect(load, "the memory curation publish route must exist").toBeTypeOf("function");
  return load();
}

async function rejectRoute(): Promise<DecisionRoute> {
  const load = rejectRouteModules[
    "../../../app/api/projects/[projectId]/memory-curation-candidates/[candidateId]/reject/route.ts"
  ];
  expect(load, "the memory curation reject route must exist").toBeTypeOf("function");
  return load();
}

function seedMember(projectId: string): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv, api_key_tag,
        credential_version, credential_generation, key_id, api_key_mask, verified_at,
        version, created_at, updated_at
      ) VALUES (
        'provider-curation-api', 'Provider', 'https://example.invalid', 'model-api',
        'cipher', 'iv', 'tag', 1, 1, 'key', '****', 'now', 1, 'now', 'now'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
        can_read, can_write, can_execute, max_tokens, max_handoffs, version,
        created_at, updated_at
      ) VALUES (
        'agent-curation-api', 'API Agent', 'Plans', 'private',
        'provider-curation-api', 'model-api', 'A', 'sage',
        1, 1, 0, 1000, 1, 1, 'now', 'now'
      );
    `);
    database.prepare(`
      INSERT INTO project_memberships(project_id,agent_id,joined_at)
      VALUES (?,'agent-curation-api','2026-08-27T00:00:00.000Z')
    `).run(projectId);
  } finally {
    database.close();
  }
}

function request(url: string, body: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
});

describe("memory curation API", () => {
  it("gets an empty list and creates a sourced candidate", async () => {
    const route = await rootRoute();
    const project = createProject("Curation API", databasePath);
    seedMember(project.id);
    const url = `http://localhost/api/projects/${project.id}/memory-curation-candidates`;
    const context = { params: Promise.resolve({ projectId: project.id }) };

    const empty = await route.GET(new Request(url), context);
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toBe("no-store");
    await expect(empty.json()).resolves.toEqual({ candidates: [] });

    const created = await route.POST(request(url, {
      agentId: "agent-curation-api",
      content: "API candidate",
      operationId: "63000000-0000-4000-8000-000000000101",
      sources: [{ id: "Owner API source", type: "owner_input" }],
      type: "fact",
    }), context);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const createdBody = await created.json() as { candidate: { id: string; status: string } };
    expect(createdBody.candidate).toMatchObject({ status: "pending" });

    const listed = await route.GET(new Request(url), context);
    const listedBody = await listed.json() as { candidates: Array<{ id: string }> };
    expect(listedBody.candidates.map(({ id }) => id)).toEqual([createdBody.candidate.id]);
  });

  it("publishes and rejects candidates through strict no-store decision routes", async () => {
    const collection = await rootRoute();
    const publish = await publishRoute();
    const reject = await rejectRoute();
    const project = createProject("Curation decision API", databasePath);
    seedMember(project.id);
    const baseUrl = `http://localhost/api/projects/${project.id}/memory-curation-candidates`;
    const projectContext = { params: Promise.resolve({ projectId: project.id }) };
    const propose = async (content: string, operationId: string): Promise<string> => {
      const response = await collection.POST(request(baseUrl, {
        agentId: "agent-curation-api",
        content,
        operationId,
        sources: [{ id: "Owner API source", type: "owner_input" }],
        type: "fact",
      }), projectContext);
      const body = await response.json() as { candidate: { id: string } };
      return body.candidate.id;
    };

    const publishId = await propose(
      "Publish through API",
      "63000000-0000-4000-8000-000000000102",
    );
    const published = await publish.POST(
      request(`${baseUrl}/${publishId}/publish`, {
        operationId: "63000000-0000-4000-8000-000000000103",
      }),
      { params: Promise.resolve({ candidateId: publishId, projectId: project.id }) },
    );
    expect(published.status).toBe(200);
    expect(published.headers.get("cache-control")).toBe("no-store");
    await expect(published.json()).resolves.toMatchObject({
      candidate: { id: publishId, status: "published" },
      memory: { actor: { confirmer: null, proposerType: "agent" } },
    });

    const rejectId = await propose(
      "Reject through API",
      "63000000-0000-4000-8000-000000000104",
    );
    const rejected = await reject.POST(
      request(`${baseUrl}/${rejectId}/reject`, {
        operationId: "63000000-0000-4000-8000-000000000105",
      }),
      { params: Promise.resolve({ candidateId: rejectId, projectId: project.id }) },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    await expect(rejected.json()).resolves.toMatchObject({
      candidate: { id: rejectId, status: "rejected" },
      memory: null,
    });
  });

  it("fails closed for unknown projects, query extras, and non-strict bodies", async () => {
    const route = await rootRoute();
    const missingUrl =
      "http://localhost/api/projects/missing-project/memory-curation-candidates";
    const missingContext = { params: Promise.resolve({ projectId: "missing-project" }) };

    const missing = await route.GET(new Request(missingUrl), missingContext);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "PROJECT_NOT_FOUND" },
    });

    const extraQuery = await route.GET(new Request(`${missingUrl}?unexpected=1`), missingContext);
    expect(extraQuery.status).toBe(400);
    expect(extraQuery.headers.get("cache-control")).toBe("no-store");

    const extraBody = await route.POST(request(missingUrl, {
      agentId: "agent-curation-api",
      content: "Invalid",
      operationId: "63000000-0000-4000-8000-000000000106",
      sources: [{ id: "Owner source", type: "owner_input" }],
      type: "fact",
      unexpected: true,
    }), missingContext);
    expect(extraBody.status).toBe(400);
    expect(extraBody.headers.get("cache-control")).toBe("no-store");
  });

  it("requires application/json before accepting a curation POST body", async () => {
    const route = await rootRoute();
    const project = createProject("Curation media type", databasePath);
    seedMember(project.id);
    const url = `http://localhost/api/projects/${project.id}/memory-curation-candidates`;
    const response = await route.POST(new Request(url, {
      body: JSON.stringify({
        agentId: "agent-curation-api",
        content: "Must declare JSON",
        operationId: "63000000-0000-4000-8000-000000000107",
        sources: [{ id: "Owner source", type: "owner_input" }],
        type: "fact",
      }),
      method: "POST",
    }), {
      params: Promise.resolve({ projectId: project.id }),
    });

    expect(response.status).toBe(415);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });
  });

  it("rejects oversized bodies, unsafe resource ids, and more than eight sources", async () => {
    const route = await rootRoute();
    const project = createProject("Curation HTTP bounds", databasePath);
    seedMember(project.id);
    const url = `http://localhost/api/projects/${project.id}/memory-curation-candidates`;
    const context = { params: Promise.resolve({ projectId: project.id }) };

    const oversized = await route.POST(new Request(url, {
      body: JSON.stringify({ content: "x".repeat(65_536) }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), context);
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "BODY_TOO_LARGE" },
    });

    const unsafeId = await route.GET(new Request(url), {
      params: Promise.resolve({ projectId: "../unsafe" }),
    });
    expect(unsafeId.status).toBe(400);
    await expect(unsafeId.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });

    const tooManySources = await route.POST(request(url, {
      agentId: "agent-curation-api",
      content: "Too many API sources",
      operationId: "63000000-0000-4000-8000-000000000108",
      sources: Array.from({ length: 9 }, (_, index) => ({
        id: `Owner source ${index}`,
        type: "owner_input",
      })),
      type: "fact",
    }), context);
    expect(tooManySources.status).toBe(400);
  });
});
