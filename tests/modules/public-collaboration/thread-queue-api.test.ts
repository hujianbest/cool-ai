import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type QueueRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

type QueueCancelRoute = {
  POST(
    request: Request,
    context: {
      params: Promise<{ projectId: string; threadId: string; queueItemId: string }>;
    },
  ): Promise<Response>;
};

const queueRoutes = import.meta.glob<QueueRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/queue/route.ts",
);
const cancelRoutes = import.meta.glob<QueueCancelRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/queue/[queueItemId]/cancel/route.ts",
);

const NOW = "2026-08-12T05:10:00.000Z";
let databasePath: string;
let threadId: string;

function seedProject(projectId: string): void {
  const database = openDatabase(databasePath);
  try {
    database.prepare(
      `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
       VALUES (?, ?, ?, NULL, NULL, 1)`,
    ).run(projectId, projectId, NOW);
    const providerId = `provider-${projectId}`;
    database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES (?, 'Provider', 'http://localhost/v1', 'model', 'cipher', 'iv', 'tag',
         1, 1, 'key', '***', ?, 1, ?, ?)`,
    ).run(providerId, NOW, NOW, NOW);
    const insertAgent = database.prepare(
      `INSERT INTO agents(
         id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
         can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
         updated_at,review_capable
       ) VALUES (?, ?, 'Peer', 'Prompt', ?, 'model', 'A', 'sage',
         1, 1, 0, 1000, 3, 1, ?, ?, 0)`,
    );
    const insertMember = database.prepare(
      `INSERT INTO project_memberships(project_id,agent_id,joined_at)
       VALUES (?, ?, ?)`,
    );
    insertAgent.run("agent-a", "Agent A", providerId, NOW, NOW);
    insertAgent.run("agent-b", "Agent B", providerId, NOW, NOW);
    insertMember.run(projectId, "agent-a", NOW);
    insertMember.run(projectId, "agent-b", NOW);
  } finally {
    database.close();
  }
}

async function queueRoute(): Promise<QueueRoute> {
  const load = queueRoutes[
    "../../../app/api/projects/[projectId]/threads/[threadId]/queue/route.ts"
  ];
  expect(load).toBeTypeOf("function");
  return load!();
}

async function queueCancelRoute(): Promise<QueueCancelRoute> {
  const load = cancelRoutes[
    "../../../app/api/projects/[projectId]/threads/[threadId]/queue/[queueItemId]/cancel/route.ts"
  ];
  expect(load).toBeTypeOf("function");
  return load!();
}

async function enqueue(projectId: string, thread: string, body: unknown, suffix = ""): Promise<Response> {
  return (await queueRoute()).POST(
    new Request(`http://localhost/api/projects/${projectId}/threads/${thread}/queue${suffix}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ projectId, threadId: thread }) },
  );
}

async function cancel(
  projectId: string,
  thread: string,
  queueItemId: string,
  body: unknown,
  suffix = "",
): Promise<Response> {
  return (await queueCancelRoute()).POST(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${thread}/queue/${queueItemId}/cancel${suffix}`,
      {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ),
    { params: Promise.resolve({ projectId, queueItemId, threadId: thread }) },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  seedProject("project-a");
  threadId = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000003431",
    title: "Queue API",
  }).body.thread.id;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
});

describe("thread queue command routes", () => {
  it("enqueues and cancels with strict no-store responses", async () => {
    const created = await enqueue("project-a", threadId, {
      content: "Queue me",
      expectedVersion: 1,
      operationId: "00000000-0000-4000-8000-000000003432",
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      created: true,
      item: { projectId: "project-a", status: "pending", threadId },
      threadVersion: 2,
    });

    const cancelled = await cancel("project-a", threadId, createdBody.item.id, {
      expectedVersion: 2,
      operationId: "00000000-0000-4000-8000-000000003433",
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.headers.get("cache-control")).toBe("no-store");
    expect(await cancelled.json()).toMatchObject({
      cancelled: true,
      item: { id: createdBody.item.id, status: "cancelled" },
      threadVersion: 3,
    });
  });

  it("rejects unknown URL suffix and strict input failures", async () => {
    const badQuery = await enqueue("project-a", threadId, {
      content: "Queue me",
      expectedVersion: 1,
      operationId: "00000000-0000-4000-8000-000000003434",
    }, "?extra=1");
    expect(badQuery.status).toBe(400);
    expect(await badQuery.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });

    const badBody = await enqueue("project-a", threadId, {
      content: "",
      expectedVersion: 1,
      operationId: "00000000-0000-4000-8000-000000003435",
    });
    expect(badBody.status).toBe(400);
    expect(await badBody.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });

    const missingTarget = await cancel("project-a", threadId, "missing", {
      expectedVersion: 1,
      operationId: "00000000-0000-4000-8000-000000003436",
    }, "#fragment");
    expect(missingTarget.status).toBe(400);
    expect(await missingTarget.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
});
