import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  applyThreadTagBatch,
  createThreadTag,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-tag-service";
import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { CollaborationError } from "@/src/modules/public-collaboration";
import type { ThreadTagBatchResponse } from "@/src/shared/collaboration-contracts";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-11T08:00:00.000Z";
const LATER = "2026-08-11T08:05:00.000Z";

let databasePath: string;
let threadA: string;
let threadB: string;
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

function edgeRows(): unknown[] {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw
      .prepare(
        "SELECT * FROM thread_tag_edges ORDER BY project_id,thread_id,tag_id",
      )
      .all();
  } finally {
    raw.close();
  }
}

function receiptRows(): unknown[] {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw
      .prepare("SELECT * FROM thread_tag_operations ORDER BY project_id,id")
      .all();
  } finally {
    raw.close();
  }
}

function storedReceipt(projectId: string, operationId: string) {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw
      .prepare(
        `SELECT id,project_id AS projectId,kind,request_hash AS requestHash,
                status,http_status AS httpStatus,response_json AS responseJson,
                created_at AS createdAt
         FROM thread_tag_operations
         WHERE project_id=? AND id=?`,
      )
      .get(projectId, operationId) as
      | {
          createdAt: string;
          httpStatus: number | null;
          id: string;
          kind: string;
          projectId: string;
          requestHash: string;
          responseJson: string | null;
          status: string;
        }
      | undefined;
  } finally {
    raw.close();
  }
}

function makeTag(projectId: string, name: string): string {
  return createThreadTag(databasePath, projectId, { name }).body.tag.id;
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

type ThreadTagBatchRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const threadTagBatchRoutes = import.meta.glob<ThreadTagBatchRoute>(
  "../../../app/api/projects/[projectId]/thread-tag-batch/route.ts",
);

async function threadTagBatchRoute(): Promise<ThreadTagBatchRoute> {
  const load =
    threadTagBatchRoutes[
      "../../../app/api/projects/[projectId]/thread-tag-batch/route.ts"
    ];
  expect(load, "thread-tag-batch route must exist").toBeTypeOf("function");
  return load!();
}

async function postThreadTagBatch(
  projectId: string,
  body: BodyInit,
  contentType = "application/json",
  urlSuffix = "",
): Promise<Response> {
  return (await threadTagBatchRoute()).POST(
    new Request(
      `http://localhost/api/projects/${projectId}/thread-tag-batch${urlSuffix}`,
      { body, headers: { "content-type": contentType }, method: "POST" },
    ),
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
  foreignThread = createSeededThread("project-b", "Foreign thread");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
});

describe("applyThreadTagBatch command seam", () => {
  it("applies adds and removes across threads in one transaction with a per-thread summary", () => {
    const alpha = makeTag("project-a", "alpha");
    const beta = makeTag("project-a", "beta");
    const stale = makeTag("project-a", "stale");
    applyThreadTagBatch(databasePath, "project-a", {
      addTagIds: [stale],
      operationId: nextOperationId(),
      removeTagIds: [],
      threadIds: [threadA, threadB],
    });

    vi.setSystemTime(new Date(LATER));
    const result = applyThreadTagBatch(databasePath, "project-a", {
      addTagIds: [alpha, beta],
      operationId: nextOperationId(),
      removeTagIds: [stale],
      threadIds: [threadA, threadB],
    });
    expect(result.status).toBe(200);
    expect(result.body.replayed).toBe(false);
    expect(result.body.applied).toEqual([
      { addedTagIds: [alpha, beta], removedTagIds: [stale], threadId: threadA },
      { addedTagIds: [alpha, beta], removedTagIds: [stale], threadId: threadB },
    ]);
    expect(edgeRows()).toHaveLength(4);
    expect(receiptRows()).toHaveLength(2);
  });

  it("reports idempotent reapplication honestly per thread", () => {
    const alpha = makeTag("project-a", "alpha");
    applyThreadTagBatch(databasePath, "project-a", {
      addTagIds: [alpha],
      operationId: nextOperationId(),
      removeTagIds: [],
      threadIds: [threadA],
    });

    // A tag in both lists is added then removed within the same batch, so the
    // net effect keeps only genuinely new assignments (threadB keeps alpha).
    const again = applyThreadTagBatch(databasePath, "project-a", {
      addTagIds: [alpha],
      operationId: nextOperationId(),
      removeTagIds: [alpha],
      threadIds: [threadA, threadB],
    });
    expect(again.body).toEqual({
      applied: [
        { addedTagIds: [], removedTagIds: [alpha], threadId: threadA },
        { addedTagIds: [alpha], removedTagIds: [alpha], threadId: threadB },
      ],
      operationId: expect.any(String),
      replayed: false,
    });
    expect(edgeRows()).toHaveLength(0);
  });

  it("replays a stored response for the same operationId and identical input without re-applying", () => {
    const alpha = makeTag("project-a", "alpha");
    const operationId = nextOperationId();
    const first = applyThreadTagBatch(databasePath, "project-a", {
      addTagIds: [alpha],
      operationId,
      removeTagIds: [],
      threadIds: [threadA],
    });
    expect(first.body.replayed).toBe(false);

    // Replay with different-but-equal key order: the canonical hash strips
    // operationId, so an identically-shaped body is the same operation.
    const replay = applyThreadTagBatch(databasePath, "project-a", {
      addTagIds: [alpha],
      operationId,
      removeTagIds: [],
      threadIds: [threadA],
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, replayed: true });
    expect(edgeRows()).toHaveLength(1);
    expect(receiptRows()).toHaveLength(1);

    // The persisted receipt is re-readable and carries the original response.
    const receipt = storedReceipt("project-a", operationId);
    expect(receipt).toMatchObject({
      httpStatus: 200,
      id: operationId,
      kind: "tag_batch",
      projectId: "project-a",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      status: "completed",
    });
    expect(JSON.parse(receipt!.responseJson!)).toEqual({
      applied: first.body.applied,
      operationId,
    });
  });

  it("rejects a reused operationId with different input as OPERATION_CONFLICT", () => {
    const alpha = makeTag("project-a", "alpha");
    const beta = makeTag("project-a", "beta");
    const operationId = nextOperationId();
    applyThreadTagBatch(databasePath, "project-a", {
      addTagIds: [alpha],
      operationId,
      removeTagIds: [],
      threadIds: [threadA],
    });

    const conflict = expectCode(
      () =>
        applyThreadTagBatch(databasePath, "project-a", {
          addTagIds: [beta],
          operationId,
          removeTagIds: [],
          threadIds: [threadA],
        }),
      "OPERATION_CONFLICT",
    );
    expect(conflict.httpStatus).toBe(409);
    expect(edgeRows()).toHaveLength(1);
    expect(receiptRows()).toHaveLength(1);
  });

  it("rolls back the whole batch when any thread or tag is outside the project tuple", () => {
    const alpha = makeTag("project-a", "alpha");
    const beta = makeTag("project-a", "beta");
    const foreignTag = makeTag("project-b", "foreign");
    applyThreadTagBatch(databasePath, "project-a", {
      addTagIds: [alpha],
      operationId: nextOperationId(),
      removeTagIds: [],
      threadIds: [threadA],
    });

    const attempts: Array<Record<string, unknown>> = [
      // Foreign thread mixed in as the last id: nothing may be applied or removed.
      {
        addTagIds: [beta],
        removeTagIds: [alpha],
        threadIds: [threadA, foreignThread],
      },
      // Foreign tag id referenced from project-a's batch.
      {
        addTagIds: [foreignTag],
        removeTagIds: [],
        threadIds: [threadA, threadB],
      },
      // Missing ids of either kind.
      {
        addTagIds: ["missing-tag"],
        removeTagIds: [],
        threadIds: [threadA],
      },
      {
        addTagIds: [],
        removeTagIds: [],
        threadIds: ["missing-thread"],
      },
    ];
    for (const attempt of attempts) {
      const error = expectCode(
        () =>
          applyThreadTagBatch(databasePath, "project-a", {
            addTagIds: [],
            operationId: nextOperationId(),
            removeTagIds: [],
            threadIds: [],
            ...attempt,
          } as never),
        "RESOURCE_NOT_FOUND",
      );
      expect(error.httpStatus).toBe(404);
    }
    // Exactly the pre-attempt edge remains; no receipts were written.
    expect(edgeRows()).toHaveLength(1);
    expect(receiptRows()).toHaveLength(1);
  });

  it("rejects a missing project with PROJECT_NOT_FOUND and writes nothing", () => {
    const error = expectCode(
      () =>
        applyThreadTagBatch(databasePath, "missing-project", {
          addTagIds: [],
          operationId: nextOperationId(),
          removeTagIds: [],
          threadIds: [threadA],
        }),
      "PROJECT_NOT_FOUND",
    );
    expect(error.httpStatus).toBe(404);
    expect(edgeRows()).toHaveLength(0);
    expect(receiptRows()).toHaveLength(0);
  });

  it("enforces input ceilings and dedupes ids before hashing and applying", () => {
    const alpha = makeTag("project-a", "alpha");
    const beta = makeTag("project-a", "beta");

    const overflowThreads = applyInvalidBatch({
      addTagIds: [alpha],
      threadIds: Array.from({ length: 101 }, (_, index) => `thread-${index}`),
    });
    expect(overflowThreads.details.fields).toEqual({ threadIds: "too_many" });

    const overflowTags = applyInvalidBatch({
      addTagIds: Array.from({ length: 11 }, (_, index) => `tag-${index}`),
      removeTagIds: Array.from({ length: 10 }, (_, index) => `rm-${index}`),
      threadIds: [threadA],
    });
    expect(overflowTags.details.fields).toEqual({ tagIds: "too_many" });

    expect(applyInvalidBatch({ operationId: "" }));
    expect(applyInvalidBatch({ operationId: "not a valid id" }));
    expect(applyInvalidBatch({ threadIds: [] }));
    expect(applyInvalidBatch({ addTagIds: [".."], threadIds: [threadA] }));
    expect(edgeRows()).toHaveLength(0);
    expect(receiptRows()).toHaveLength(0);

    // Exactly at the ceiling succeeds; duplicates are folded before counting.
    // beta sits in both lists, so it is added then removed (net zero) while
    // alpha sticks on both threads.
    const atCeiling = applyThreadTagBatch(databasePath, "project-a", {
      addTagIds: [alpha, alpha, beta],
      operationId: nextOperationId(),
      removeTagIds: [beta, beta],
      threadIds: [threadA, threadB],
    });
    expect(atCeiling.status).toBe(200);
    expect(atCeiling.body.applied).toEqual([
      { addedTagIds: [alpha, beta], removedTagIds: [beta], threadId: threadA },
      { addedTagIds: [alpha, beta], removedTagIds: [beta], threadId: threadB },
    ]);
    expect(edgeRows()).toHaveLength(2);
  });

  function applyInvalidBatch(
    overrides: Record<string, unknown>,
  ): CollaborationError {
    const error = expectCode(
      () =>
        applyThreadTagBatch(databasePath, "project-a", {
          addTagIds: [],
          operationId: nextOperationId(),
          removeTagIds: [],
          threadIds: [threadA],
          ...overrides,
        }),
      "INVALID_INPUT",
    );
    expect(error.httpStatus).toBe(400);
    return error;
  }

  it("keeps replayed receipts readable across an idempotent reopen", () => {
    const alpha = makeTag("project-a", "alpha");
    const operationId = nextOperationId();
    const first = applyThreadTagBatch(databasePath, "project-a", {
      addTagIds: [alpha],
      operationId,
      removeTagIds: [],
      threadIds: [threadA],
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = openDatabase(databasePath);
      try {
        expect(reopened.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 21,
        });
      } finally {
        reopened.close();
      }
    }

    const replay = applyThreadTagBatch(databasePath, "project-a", {
      addTagIds: [alpha],
      operationId,
      removeTagIds: [],
      threadIds: [threadA],
    });
    expect(replay.body).toEqual({ ...first.body, replayed: true });
    expect(storedReceipt("project-a", operationId)?.requestHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

describe("thread-tag-batch route seam", () => {
  it("applies a batch through POST with a strict no-store DTO and replays it", async () => {
    const alpha = makeTag("project-a", "alpha");
    const operationId = nextOperationId();
    const payload = JSON.stringify({
      addTagIds: [alpha],
      operationId,
      removeTagIds: [],
      threadIds: [threadA],
    });

    const applied = await postThreadTagBatch("project-a", payload);
    expect(applied.status).toBe(200);
    expect(applied.headers.get("cache-control")).toBe("no-store");
    const body = (await applied.json()) as ThreadTagBatchResponse;
    expect(body).toEqual({
      applied: [{ addedTagIds: [alpha], removedTagIds: [], threadId: threadA }],
      operationId,
      replayed: false,
    });

    const replay = await postThreadTagBatch("project-a", payload);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("cache-control")).toBe("no-store");
    expect(await replay.json()).toEqual({ ...body, replayed: true });
    expect(edgeRows()).toHaveLength(1);

    const conflict = await postThreadTagBatch(
      "project-a",
      JSON.stringify({
        addTagIds: [],
        operationId,
        removeTagIds: [alpha],
        threadIds: [threadA],
      }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("cache-control")).toBe("no-store");
    const conflictBody = (await conflict.json()) as {
      error: { code: string; message: string };
    };
    expect(conflictBody.error.code).toBe("OPERATION_CONFLICT");
    expect(JSON.stringify(conflictBody)).not.toContain(databasePath);
    expect(edgeRows()).toHaveLength(1);

    const crossTuple = await postThreadTagBatch(
      "project-a",
      JSON.stringify({
        addTagIds: [alpha],
        operationId: nextOperationId(),
        removeTagIds: [],
        threadIds: [foreignThread],
      }),
    );
    expect(crossTuple.status).toBe(404);
    expect(crossTuple.headers.get("cache-control")).toBe("no-store");
    const crossBody = (await crossTuple.json()) as { error: { code: string } };
    expect(crossBody.error.code).toBe("RESOURCE_NOT_FOUND");
    expect(JSON.stringify(crossBody)).not.toContain(databasePath);
    expect(edgeRows()).toHaveLength(1);
  });

  it("validates the POST body, media type, size, path, and URL strictly", async () => {
    const alpha = makeTag("project-a", "alpha");
    for (const body of [
      JSON.stringify({}),
      JSON.stringify({ operationId: nextOperationId() }),
      JSON.stringify({
        addTagIds: [],
        operationId: nextOperationId(),
        removeTagIds: [],
        threadIds: [threadA],
        extra: 1,
      }),
      JSON.stringify({
        addTagIds: "nope",
        operationId: nextOperationId(),
        removeTagIds: [],
        threadIds: [threadA],
      }),
      JSON.stringify({
        addTagIds: [],
        operationId: nextOperationId(),
        removeTagIds: [],
        threadIds: [],
      }),
      JSON.stringify({
        addTagIds: [".."],
        operationId: nextOperationId(),
        removeTagIds: [],
        threadIds: [threadA],
      }),
    ]) {
      const response = await postThreadTagBatch("project-a", body);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const envelope = (await response.json()) as {
        error: { code: string; fields?: Record<string, string> };
      };
      expect(envelope.error.code).toBe("INVALID_INPUT");
      expect(JSON.stringify(envelope)).not.toContain(databasePath);
    }

    const malformed = await postThreadTagBatch("project-a", "{not json");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "INVALID_JSON" } });

    const unsupported = await postThreadTagBatch(
      "project-a",
      JSON.stringify({
        addTagIds: [alpha],
        operationId: nextOperationId(),
        removeTagIds: [],
        threadIds: [threadA],
      }),
      "text/plain",
    );
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });

    const oversized = await postThreadTagBatch(
      "project-a",
      JSON.stringify({
        addTagIds: [alpha],
        operationId: nextOperationId(),
        removeTagIds: [],
        threadIds: [threadA],
      }) + `"${"b".repeat(65_536)}`,
    );
    expect([400, 413]).toContain(oversized.status);

    const suffixed = await postThreadTagBatch(
      "project-a",
      JSON.stringify({
        addTagIds: [alpha],
        operationId: nextOperationId(),
        removeTagIds: [],
        threadIds: [threadA],
      }),
      "application/json",
      "?unknown=1",
    );
    expect(suffixed.status).toBe(400);

    const badProject = await postThreadTagBatch(
      "..",
      JSON.stringify({
        addTagIds: [alpha],
        operationId: nextOperationId(),
        removeTagIds: [],
        threadIds: [threadA],
      }),
    );
    expect(badProject.status).toBe(400);

    const missingProject = await postThreadTagBatch(
      "missing-project",
      JSON.stringify({
        addTagIds: [alpha],
        operationId: nextOperationId(),
        removeTagIds: [],
        threadIds: [threadA],
      }),
    );
    expect(missingProject.status).toBe(404);
    expect(await missingProject.json()).toMatchObject({
      error: { code: "PROJECT_NOT_FOUND" },
    });
    expect(edgeRows()).toHaveLength(0);
    expect(receiptRows()).toHaveLength(0);
  });
});
