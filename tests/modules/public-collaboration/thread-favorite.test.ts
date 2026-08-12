import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { setThreadFavorite } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-favorite-service";
import {
  createThread,
  listThreads,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { CollaborationError } from "@/src/modules/public-collaboration";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type FavoriteRoute = {
  PUT(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

type ThreadsRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const favoriteRoutes = import.meta.glob<FavoriteRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/favorite/route.ts",
);
const threadsRoutes = import.meta.glob<ThreadsRoute>(
  "../../../app/api/projects/[projectId]/threads/route.ts",
);

const NOW = "2026-08-10T08:00:00.000Z";
const LATER = "2026-08-10T08:05:00.000Z";

let databasePath: string;
let threadA: string;
let threadB: string;
let threadC: string;
let foreignThread: string;

let operationCounter = 0;

function nextOperationId(): string {
  operationCounter += 1;
  return `00000000-0000-4000-8000-${String(operationCounter).padStart(12, "0")}`;
}

function seedProject(
  projectId: string,
  agentIds: [string, string, ...string[]],
): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
         VALUES (?,?,?,NULL,NULL,1)`,
      )
      .run(projectId, projectId, NOW);
    const providerId = `provider-${projectId}`;
    database
      .prepare(
        `INSERT INTO providers(
           id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
           credential_version,credential_generation,key_id,api_key_mask,verified_at,
           version,created_at,updated_at
         ) VALUES (?,'Provider','http://localhost/v1','model','cipher','iv','tag',
           1,1,'key','***',?,1,?,?)`,
      )
      .run(providerId, NOW, NOW, NOW);
    const insertAgent = database.prepare(
      `INSERT INTO agents(
         id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
         can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
         updated_at,review_capable
       ) VALUES (?,?,'Peer','Prompt',?,'model','A','sage',
         1,1,0,1000,3,1,?,?,0)`,
    );
    const insertMember = database.prepare(
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
    );
    for (const agentId of agentIds) {
      insertAgent.run(agentId, `Agent ${agentId}`, providerId, NOW, NOW);
      insertMember.run(projectId, agentId, NOW);
    }
  } finally {
    database.close();
  }
}

function createSeededThread(projectId: string, title: string): string {
  return createThread(databasePath, projectId, {
    memberAgentIds: [`agent-${projectId}-a`, `agent-${projectId}-b`],
    operationId: nextOperationId(),
    title,
  }).body.thread.id;
}

function favoriteRows(): unknown[] {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw
      .prepare("SELECT * FROM thread_favorites ORDER BY project_id,thread_id")
      .all();
  } finally {
    raw.close();
  }
}

function storedFavorite(projectId: string, threadId: string) {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw
      .prepare(
        `SELECT project_id AS projectId,thread_id AS threadId,
                created_at AS createdAt
         FROM thread_favorites WHERE project_id=? AND thread_id=?`,
      )
      .get(projectId, threadId) as
      | { createdAt: string; projectId: string; threadId: string }
      | undefined;
  } finally {
    raw.close();
  }
}

function expectCode(operation: () => unknown, code: string): CollaborationError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
    return error as CollaborationError;
  }
  throw new Error(`Expected ${code}`);
}

async function favoriteRoute(): Promise<FavoriteRoute> {
  const load =
    favoriteRoutes[
      "../../../app/api/projects/[projectId]/threads/[threadId]/favorite/route.ts"
    ];
  expect(load, "thread favorite route must exist").toBeTypeOf("function");
  return load!();
}

async function threadsRoute(): Promise<ThreadsRoute> {
  const load =
    threadsRoutes["../../../app/api/projects/[projectId]/threads/route.ts"];
  expect(load, "threads route must exist").toBeTypeOf("function");
  return load!();
}

async function putFavorite(
  projectId: string,
  threadId: string,
  body: BodyInit,
  contentType = "application/json",
  urlSuffix = "",
): Promise<Response> {
  return (await favoriteRoute()).PUT(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/favorite${urlSuffix}`,
      { body, headers: { "content-type": contentType }, method: "PUT" },
    ),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

async function getThreads(
  projectId: string,
  query = "",
): Promise<Response> {
  return (await threadsRoute()).GET(
    new Request(`http://localhost/api/projects/${projectId}/threads${query}`),
    { params: Promise.resolve({ projectId }) },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  operationCounter = 0;
  seedProject("project-a", ["agent-project-a-a", "agent-project-a-b"]);
  seedProject("project-b", ["agent-project-b-a", "agent-project-b-b"]);
  threadA = createSeededThread("project-a", "Thread A");
  threadB = createSeededThread("project-a", "Thread B");
  threadC = createSeededThread("project-a", "Thread C");
  foreignThread = createSeededThread("project-b", "Foreign thread");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
});

describe("thread favorite command seam", () => {
  it("marks a thread favorite idempotently and freezes the first timestamp", () => {
    const first = setThreadFavorite(databasePath, "project-a", threadA, {
      favorite: true,
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      favoritedAt: NOW,
      isFavorite: true,
      projectId: "project-a",
      threadId: threadA,
    });
    expect(favoriteRows()).toHaveLength(1);

    vi.setSystemTime(new Date(LATER));
    const second = setThreadFavorite(databasePath, "project-a", threadA, {
      favorite: true,
    });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(favoriteRows()).toHaveLength(1);
    expect(storedFavorite("project-a", threadA)?.createdAt).toBe(NOW);
  });

  it("clears a favorite idempotently, including when none exists", () => {
    const missing = setThreadFavorite(databasePath, "project-a", threadA, {
      favorite: false,
    });
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual({
      favoritedAt: null,
      isFavorite: false,
      projectId: "project-a",
      threadId: threadA,
    });
    expect(favoriteRows()).toHaveLength(0);

    setThreadFavorite(databasePath, "project-a", threadA, { favorite: true });
    const cleared = setThreadFavorite(databasePath, "project-a", threadA, {
      favorite: false,
    });
    expect(cleared.body).toEqual(missing.body);
    expect(favoriteRows()).toHaveLength(0);
  });

  it("records a fresh timestamp when a thread is favorited again after clearing", () => {
    setThreadFavorite(databasePath, "project-a", threadA, { favorite: true });
    setThreadFavorite(databasePath, "project-a", threadA, { favorite: false });
    vi.setSystemTime(new Date(LATER));
    const again = setThreadFavorite(databasePath, "project-a", threadA, {
      favorite: true,
    });
    expect(again.body.favoritedAt).toBe(LATER);
    expect(storedFavorite("project-a", threadA)?.createdAt).toBe(LATER);
  });

  it("rejects cross-tuple and missing targets with a stable 404 and writes nothing", () => {
    for (const [projectId, threadId] of [
      ["project-a", foreignThread],
      ["project-b", threadA],
      ["missing-project", threadA],
      ["project-a", "missing-thread"],
    ] as const) {
      const error = expectCode(
        () => setThreadFavorite(databasePath, projectId, threadId, { favorite: true }),
        "RESOURCE_NOT_FOUND",
      );
      expect(error.httpStatus).toBe(404);
      const cleared = expectCode(
        () => setThreadFavorite(databasePath, projectId, threadId, { favorite: false }),
        "RESOURCE_NOT_FOUND",
      );
      expect(cleared.httpStatus).toBe(404);
    }
    expect(favoriteRows()).toHaveLength(0);
  });

  it("validates the favorite input strictly", () => {
    const invalidInputs: Array<unknown> = [
      null,
      [],
      {},
      { favorite: "yes" },
      { favorite: 1 },
      { favorite: null },
      { favorite: true, extra: true },
    ];
    for (const input of invalidInputs) {
      const error = expectCode(
        () => setThreadFavorite(databasePath, "project-a", threadA, input),
        "INVALID_INPUT",
      );
      expect(error.httpStatus).toBe(400);
    }
    expect(favoriteRows()).toHaveLength(0);
  });
});

describe("thread list favorite projection seam", () => {
  it("projects isFavorite/favoritedAt on every item without changing the normal order", () => {
    const before = listThreads(databasePath, "project-a", {}).body;
    expect(before.threads.map(({ id }) => id)).toEqual([threadC, threadB, threadA]);
    for (const thread of before.threads) {
      expect(thread.isFavorite).toBe(false);
      expect(thread.favoritedAt).toBeNull();
    }

    setThreadFavorite(databasePath, "project-a", threadA, { favorite: true });

    const after = listThreads(databasePath, "project-a", {}).body;
    expect(after.threads.map(({ id }) => id)).toEqual([threadC, threadB, threadA]);
    expect(after.nextCursor).toBeNull();
    const favorite = after.threads.find(({ id }) => id === threadA);
    expect(favorite?.isFavorite).toBe(true);
    expect(favorite?.favoritedAt).toBe(NOW);
    for (const thread of after.threads.filter(({ id }) => id !== threadA)) {
      expect(thread.isFavorite).toBe(false);
      expect(thread.favoritedAt).toBeNull();
    }
  });

  it("filters the favorites view with favorited_at DESC and thread_id ASC tie-break", () => {
    setThreadFavorite(databasePath, "project-a", threadA, { favorite: true });
    setThreadFavorite(databasePath, "project-a", threadC, { favorite: true });
    vi.setSystemTime(new Date(LATER));
    setThreadFavorite(databasePath, "project-a", threadB, { favorite: true });
    setThreadFavorite(databasePath, "project-b", foreignThread, { favorite: true });

    const view = listThreads(databasePath, "project-a", {
      favoritesOnly: true,
    }).body;
    const sameTimeTie = [threadA, threadC].sort();
    expect(view.threads.map(({ id }) => id)).toEqual([threadB, ...sameTimeTie]);
    expect(view.nextCursor).toBeNull();
    expect(view.threads.map(({ isFavorite }) => isFavorite)).toEqual([
      true,
      true,
      true,
    ]);
    expect(view.threads.map(({ favoritedAt }) => favoritedAt)).toEqual([
      LATER,
      NOW,
      NOW,
    ]);

    setThreadFavorite(databasePath, "project-a", threadB, { favorite: false });
    const afterClear = listThreads(databasePath, "project-a", {
      favoritesOnly: true,
    }).body;
    expect(afterClear.threads.map(({ id }) => id)).toEqual(sameTimeTie);

    const normal = listThreads(databasePath, "project-a", {}).body;
    expect(normal.threads.map(({ id }) => id)).toEqual([threadC, threadB, threadA]);
  });

  it("rejects cursor pagination and invalid flags in the favorites view", () => {
    setThreadFavorite(databasePath, "project-a", threadA, { favorite: true });
    const firstPage = listThreads(databasePath, "project-a", { limit: 1 }).body;
    expect(firstPage.nextCursor).not.toBeNull();

    const withCursor = expectCode(
      () =>
        listThreads(databasePath, "project-a", {
          cursor: firstPage.nextCursor!,
          favoritesOnly: true,
        }),
      "INVALID_INPUT",
    );
    expect(withCursor.httpStatus).toBe(400);

    for (const query of [{ favoritesOnly: "yes" }, { favoritesOnly: 1 }]) {
      expectCode(() => listThreads(databasePath, "project-a", query), "INVALID_INPUT");
    }

    const limited = listThreads(databasePath, "project-a", {
      favoritesOnly: true,
      limit: 1,
    }).body;
    expect(limited.threads).toHaveLength(1);
    expect(limited.nextCursor).toBeNull();
  });

  it("keeps favorites across reopen and rejects a dangling favorite row", () => {
    setThreadFavorite(databasePath, "project-a", threadA, { favorite: true });

    const reopened = openDatabase(databasePath);
    try {
      expect(reopened.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 21,
      });
    } finally {
      reopened.close();
    }
    const view = listThreads(databasePath, "project-a", { favoritesOnly: true }).body;
    expect(view.threads.map(({ id }) => id)).toEqual([threadA]);

    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec("PRAGMA foreign_keys=OFF");
      raw
        .prepare(
          `INSERT INTO thread_favorites(project_id,thread_id,created_at)
           VALUES ('project-a','missing-thread',?)`,
        )
        .run(NOW);
    } finally {
      raw.close();
    }
    expect(() => openDatabase(databasePath).close()).toThrowError(
      expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }),
    );
  });
});

describe("thread favorite route seam", () => {
  it("writes a favorite through PUT with a strict DTO", async () => {
    const response = await putFavorite(
      "project-a",
      threadA,
      JSON.stringify({ favorite: true }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      favoritedAt: NOW,
      isFavorite: true,
      projectId: "project-a",
      threadId: threadA,
    });

    expect(
      (await putFavorite("project-a", threadA, JSON.stringify({ favorite: "yes" }))).status,
    ).toBe(400);
    expect(
      (await putFavorite("project-a", threadA, JSON.stringify({ favorite: true, extra: 1 })))
        .status,
    ).toBe(400);
    expect(
      (await putFavorite("project-a", threadA, "{not json")).status,
    ).toBe(400);
    expect(
      (await putFavorite(
        "project-a",
        threadA,
        JSON.stringify({ favorite: true }),
        "text/plain",
      )).status,
    ).toBe(415);
    expect(
      (await putFavorite(
        "project-a",
        threadA,
        JSON.stringify({ favorite: true }),
        "application/json",
        "?unknown=1",
      )).status,
    ).toBe(400);

    const crossTuple = await putFavorite(
      "project-a",
      foreignThread,
      JSON.stringify({ favorite: true }),
    );
    expect(crossTuple.status).toBe(404);
    const body = (await crossTuple.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
    expect(JSON.stringify(body)).not.toContain(databasePath);
  });

  it("serves the favorites filter through GET with strict query parsing", async () => {
    await putFavorite("project-a", threadA, JSON.stringify({ favorite: true }));

    const all = await getThreads("project-a");
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as {
      threads: Array<{ favoritedAt: string | null; id: string; isFavorite: boolean }>;
    };
    expect(allBody.threads.map(({ id }) => id)).toEqual([threadC, threadB, threadA]);
    for (const thread of allBody.threads) {
      expect(typeof thread.isFavorite).toBe("boolean");
      expect(thread.favoritedAt === null || typeof thread.favoritedAt === "string")
        .toBe(true);
    }

    const favorites = await getThreads("project-a", "?favorites=true");
    expect(favorites.status).toBe(200);
    const favoritesBody = (await favorites.json()) as {
      threads: Array<{ id: string }>;
    };
    expect(favoritesBody.threads.map(({ id }) => id)).toEqual([threadA]);

    const explicitFalse = await getThreads("project-a", "?favorites=false");
    expect(explicitFalse.status).toBe(200);
    const explicitFalseBody = (await explicitFalse.json()) as {
      threads: Array<{ id: string }>;
    };
    expect(explicitFalseBody.threads.map(({ id }) => id)).toEqual([
      threadC,
      threadB,
      threadA,
    ]);

    expect((await getThreads("project-a", "?favorites=yes")).status).toBe(400);
    expect((await getThreads("project-a", "?favorites=true&favorites=false")).status)
      .toBe(400);
    expect((await getThreads("project-a", "?favorites")).status).toBe(400);
    expect((await getThreads("project-a", "?favorites=true&unknown=1")).status)
      .toBe(400);
  });
});
