import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  createThreadTag,
  deleteThreadTag,
  listProjectTags,
  setThreadTagAssignment,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-tag-service";
import {
  createThread,
  listThreads,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { CollaborationError } from "@/src/modules/public-collaboration";
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

function tagRows(): unknown[] {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw
      .prepare("SELECT * FROM thread_tags ORDER BY project_id,name_key")
      .all();
  } finally {
    raw.close();
  }
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

function storedTag(projectId: string, tagId: string) {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw
      .prepare(
        `SELECT id,project_id AS projectId,name,name_key AS nameKey,
                created_at AS createdAt
         FROM thread_tags WHERE project_id=? AND id=?`,
      )
      .get(projectId, tagId) as
      | {
          createdAt: string;
          id: string;
          name: string;
          nameKey: string;
          projectId: string;
        }
      | undefined;
  } finally {
    raw.close();
  }
}

function storedEdge(projectId: string, threadId: string, tagId: string) {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw
      .prepare(
        `SELECT project_id AS projectId,thread_id AS threadId,tag_id AS tagId,
                created_at AS createdAt
         FROM thread_tag_edges
         WHERE project_id=? AND thread_id=? AND tag_id=?`,
      )
      .get(projectId, threadId, tagId) as
      | { createdAt: string; projectId: string; tagId: string; threadId: string }
      | undefined;
  } finally {
    raw.close();
  }
}

function insertEdge(projectId: string, threadId: string, tagId: string): void {
  const raw = new DatabaseSync(databasePath);
  try {
    raw
      .prepare(
        `INSERT INTO thread_tag_edges(project_id,thread_id,tag_id,created_at)
         VALUES (?,?,?,?)`,
      )
      .run(projectId, threadId, tagId, NOW);
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

type ThreadTagsRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

type ThreadTagRoute = {
  DELETE(
    request: Request,
    context: { params: Promise<{ projectId: string; tagId: string }> },
  ): Promise<Response>;
};

type ThreadTagAssignmentRoute = {
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

const threadTagsRoutes = import.meta.glob<ThreadTagsRoute>(
  "../../../app/api/projects/[projectId]/thread-tags/route.ts",
);
const threadTagRoutes = import.meta.glob<ThreadTagRoute>(
  "../../../app/api/projects/[projectId]/thread-tags/[tagId]/route.ts",
);
const threadTagAssignmentRoutes = import.meta.glob<ThreadTagAssignmentRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/tags/route.ts",
);
const threadsRoutes = import.meta.glob<ThreadsRoute>(
  "../../../app/api/projects/[projectId]/threads/route.ts",
);

async function threadTagsRoute(): Promise<ThreadTagsRoute> {
  const load =
    threadTagsRoutes["../../../app/api/projects/[projectId]/thread-tags/route.ts"];
  expect(load, "thread-tags route must exist").toBeTypeOf("function");
  return load!();
}

async function threadTagRoute(): Promise<ThreadTagRoute> {
  const load =
    threadTagRoutes[
      "../../../app/api/projects/[projectId]/thread-tags/[tagId]/route.ts"
    ];
  expect(load, "thread-tag delete route must exist").toBeTypeOf("function");
  return load!();
}

async function getThreadTags(projectId: string, query = ""): Promise<Response> {
  return (await threadTagsRoute()).GET(
    new Request(`http://localhost/api/projects/${projectId}/thread-tags${query}`),
    { params: Promise.resolve({ projectId }) },
  );
}

async function postThreadTag(
  projectId: string,
  body: BodyInit,
  contentType = "application/json",
  urlSuffix = "",
): Promise<Response> {
  return (await threadTagsRoute()).POST(
    new Request(
      `http://localhost/api/projects/${projectId}/thread-tags${urlSuffix}`,
      { body, headers: { "content-type": contentType }, method: "POST" },
    ),
    { params: Promise.resolve({ projectId }) },
  );
}

async function deleteThreadTagRequest(
  projectId: string,
  tagId: string,
  urlSuffix = "",
): Promise<Response> {
  return (await threadTagRoute()).DELETE(
    new Request(
      `http://localhost/api/projects/${projectId}/thread-tags/${tagId}${urlSuffix}`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ projectId, tagId }) },
  );
}

async function threadTagAssignmentRoute(): Promise<ThreadTagAssignmentRoute> {
  const load =
    threadTagAssignmentRoutes[
      "../../../app/api/projects/[projectId]/threads/[threadId]/tags/route.ts"
    ];
  expect(load, "thread tag assignment route must exist").toBeTypeOf("function");
  return load!();
}

async function putThreadTagAssignment(
  projectId: string,
  threadId: string,
  body: BodyInit,
  contentType = "application/json",
  urlSuffix = "",
): Promise<Response> {
  return (await threadTagAssignmentRoute()).PUT(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/tags${urlSuffix}`,
      { body, headers: { "content-type": contentType }, method: "PUT" },
    ),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

async function threadsRoute(): Promise<ThreadsRoute> {
  const load = threadsRoutes["../../../app/api/projects/[projectId]/threads/route.ts"];
  expect(load, "threads route must exist").toBeTypeOf("function");
  return load!();
}

async function getThreads(projectId: string, query = ""): Promise<Response> {
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
  foreignThread = createSeededThread("project-b", "Foreign thread");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
});

describe("thread tag schema seam", () => {
  it("bootstraps identity 18 with the tag tables and edges-by-tag index", () => {
    const databasePath = memoryDatabasePath();
    const raw = new DatabaseSync(databasePath);
    try {
      expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 25 });
      const objects = raw
        .prepare(
          `SELECT type,name FROM sqlite_master
           WHERE name IN (
             'thread_tags','thread_tag_edges','thread_tag_operations',
             'thread_tag_edges_by_tag'
           )
           ORDER BY name`,
        )
        .all();
      expect(objects).toEqual([
        { name: "thread_tag_edges", type: "table" },
        { name: "thread_tag_edges_by_tag", type: "index" },
        { name: "thread_tag_operations", type: "table" },
        { name: "thread_tags", type: "table" },
      ]);
    } finally {
      raw.close();
    }
  });
});

describe("createThreadTag command seam", () => {
  it("creates a tag with a trimmed name and a folded persisted name_key", () => {
    const result = createThreadTag(databasePath, "project-a", {
      name: "  发布计划  ",
    });
    expect(result.status).toBe(200);
    expect(result.body.created).toBe(true);
    expect(result.body.tag).toEqual({
      createdAt: NOW,
      id: expect.any(String),
      name: "发布计划",
      projectId: "project-a",
    });
    expect(tagRows()).toHaveLength(1);
    expect(storedTag("project-a", result.body.tag.id)).toEqual({
      createdAt: NOW,
      id: result.body.tag.id,
      name: "发布计划",
      nameKey: "发布计划",
      projectId: "project-a",
    });
  });

  it("returns the existing tag idempotently on folded-name conflicts", () => {
    const first = createThreadTag(databasePath, "project-a", { name: "Release" });
    expect(first.body.created).toBe(true);

    vi.setSystemTime(new Date(LATER));
    for (const synonym of ["release", "RELEASE", "  Release  "]) {
      const again = createThreadTag(databasePath, "project-a", { name: synonym });
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ created: false, tag: first.body.tag });
    }
    expect(tagRows()).toHaveLength(1);
    expect(storedTag("project-a", first.body.tag.id)?.createdAt).toBe(NOW);

    const precomposed = createThreadTag(databasePath, "project-a", {
      name: "café",
    });
    const decomposed = createThreadTag(databasePath, "project-a", {
      name: "café",
    });
    expect(decomposed.body).toEqual({
      created: false,
      tag: precomposed.body.tag,
    });
    expect(tagRows()).toHaveLength(2);
  });

  it("scopes folded uniqueness to the owning project", () => {
    const own = createThreadTag(databasePath, "project-a", { name: "Release" });
    const foreign = createThreadTag(databasePath, "project-b", { name: "release" });
    expect(own.body.created).toBe(true);
    expect(foreign.body.created).toBe(true);
    expect(foreign.body.tag.id).not.toBe(own.body.tag.id);
    expect(foreign.body.tag.projectId).toBe("project-b");
    expect(tagRows()).toHaveLength(2);
  });

  it("validates the create input strictly with a grapheme ceiling", () => {
    const invalidInputs: Array<unknown> = [
      null,
      [],
      {},
      { name: 1 },
      { name: null },
      { name: "" },
      { name: "   " },
      { name: "缺".repeat(41) },
      { name: "ok", extra: true },
    ];
    for (const input of invalidInputs) {
      const error = expectCode(
        () => createThreadTag(databasePath, "project-a", input),
        "INVALID_INPUT",
      );
      expect(error.httpStatus).toBe(400);
    }
    expect(tagRows()).toHaveLength(0);

    const forty = createThreadTag(databasePath, "project-a", {
      name: "缺".repeat(40),
    });
    expect(forty.body.created).toBe(true);
    const emoji = createThreadTag(databasePath, "project-a", {
      name: "👨‍👩‍👧‍👦".repeat(40),
    });
    expect(emoji.body.created).toBe(true);
    expectCode(
      () =>
        createThreadTag(databasePath, "project-a", {
          name: "👨‍👩‍👧‍👦".repeat(41),
        }),
      "INVALID_INPUT",
    );
  });

  it("rejects a missing project with PROJECT_NOT_FOUND and writes nothing", () => {
    const error = expectCode(
      () => createThreadTag(databasePath, "missing-project", { name: "Release" }),
      "PROJECT_NOT_FOUND",
    );
    expect(error.httpStatus).toBe(404);
    expect(tagRows()).toHaveLength(0);
  });
});

describe("listProjectTags query seam", () => {
  it("lists tags with usage counts in code-unit name order", () => {
    expect(listProjectTags(databasePath, "project-a", {}).body).toEqual({
      tags: [],
    });

    const beta = createThreadTag(databasePath, "project-a", { name: "beta" }).body.tag;
    const alpha = createThreadTag(databasePath, "project-a", { name: "Alpha" }).body.tag;
    const chinese = createThreadTag(databasePath, "project-a", { name: "发布" }).body.tag;
    insertEdge("project-a", threadA, beta.id);
    insertEdge("project-a", threadB, beta.id);
    insertEdge("project-a", threadA, alpha.id);

    const result = listProjectTags(databasePath, "project-a", {});
    expect(result.status).toBe(200);
    expect(result.body.tags).toEqual([
      { ...alpha, threadCount: 1 },
      { ...beta, threadCount: 2 },
      { ...chinese, threadCount: 0 },
    ]);
  });

  it("filters by folded literal contains without wildcard semantics", () => {
    createThreadTag(databasePath, "project-a", { name: "Release train" });
    createThreadTag(databasePath, "project-a", { name: "发布计划" });
    createThreadTag(databasePath, "project-a", { name: "缺陷修复" });

    const folded = listProjectTags(databasePath, "project-a", { query: "RELEASE" });
    expect(folded.body.tags.map(({ name }) => name)).toEqual(["Release train"]);
    const trimmed = listProjectTags(databasePath, "project-a", {
      query: "  发布  ",
    });
    expect(trimmed.body.tags.map(({ name }) => name)).toEqual(["发布计划"]);
    const wildcard = listProjectTags(databasePath, "project-a", { query: "%" });
    expect(wildcard.body.tags).toEqual([]);
    const blank = listProjectTags(databasePath, "project-a", { query: "missing" });
    expect(blank.body.tags).toEqual([]);
  });

  it("applies the default limit of 50 and validates limit and query strictly", () => {
    for (let index = 0; index < 55; index += 1) {
      createThreadTag(databasePath, "project-a", {
        name: `tag-${String(index).padStart(2, "0")}`,
      });
    }
    expect(listProjectTags(databasePath, "project-a", {}).body.tags).toHaveLength(50);
    expect(
      listProjectTags(databasePath, "project-a", { limit: 100 }).body.tags,
    ).toHaveLength(55);
    expect(
      listProjectTags(databasePath, "project-a", { limit: 10 }).body.tags,
    ).toHaveLength(10);

    for (const input of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: "10" },
      { query: 1 },
      { query: "" },
      { query: "   " },
      { query: "长".repeat(101) },
      { unknown: true },
    ]) {
      const error = expectCode(
        () => listProjectTags(databasePath, "project-a", input),
        "INVALID_INPUT",
      );
      expect(error.httpStatus).toBe(400);
    }
  });

  it("isolates tags per project and rejects a missing project", () => {
    createThreadTag(databasePath, "project-a", { name: "own" });
    createThreadTag(databasePath, "project-b", { name: "foreign" });

    const own = listProjectTags(databasePath, "project-a", {});
    expect(own.body.tags.map(({ name }) => name)).toEqual(["own"]);
    const error = expectCode(
      () => listProjectTags(databasePath, "missing-project", {}),
      "PROJECT_NOT_FOUND",
    );
    expect(error.httpStatus).toBe(404);
  });
});

describe("deleteThreadTag command seam", () => {
  it("deletes a tag and its edges in one transaction with an honest count", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "Release" }).body.tag;
    const other = createThreadTag(databasePath, "project-a", { name: "other" }).body.tag;
    insertEdge("project-a", threadA, tag.id);
    insertEdge("project-a", threadB, tag.id);
    insertEdge("project-a", threadA, other.id);

    const result = deleteThreadTag(databasePath, "project-a", tag.id);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ removedEdgeCount: 2, tagId: tag.id });
    expect(storedTag("project-a", tag.id)).toBeUndefined();
    expect(edgeRows()).toHaveLength(1);
    expect(
      listProjectTags(databasePath, "project-a", {}).body.tags.map(({ name }) => name),
    ).toEqual(["other"]);

    const raw = new DatabaseSync(databasePath);
    try {
      expect(
        raw
          .prepare("SELECT count(*) AS count FROM collaboration_threads")
          .get(),
      ).toEqual({ count: 3 });
    } finally {
      raw.close();
    }
  });

  it("deletes an edge-free tag with a zero count and rejects a second delete", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "Release" }).body.tag;
    const result = deleteThreadTag(databasePath, "project-a", tag.id);
    expect(result.body).toEqual({ removedEdgeCount: 0, tagId: tag.id });

    const again = expectCode(
      () => deleteThreadTag(databasePath, "project-a", tag.id),
      "RESOURCE_NOT_FOUND",
    );
    expect(again.httpStatus).toBe(404);
  });

  it("rejects cross-project and missing targets with a stable 404 and writes nothing", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "Release" }).body.tag;
    insertEdge("project-a", threadA, tag.id);

    for (const [projectId, tagId] of [
      ["project-b", tag.id],
      ["missing-project", tag.id],
      ["project-a", "missing-tag"],
    ] as const) {
      const error = expectCode(
        () => deleteThreadTag(databasePath, projectId, tagId),
        "RESOURCE_NOT_FOUND",
      );
      expect(error.httpStatus).toBe(404);
    }
    expect(tagRows()).toHaveLength(1);
    expect(edgeRows()).toHaveLength(1);
  });

  it("cascades tags and edges away when the owning project is deleted", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "Release" }).body.tag;
    const foreign = createThreadTag(databasePath, "project-b", { name: "foreign" })
      .body.tag;
    insertEdge("project-a", threadA, tag.id);
    insertEdge("project-a", threadB, tag.id);
    insertEdge("project-b", foreignThread, foreign.id);

    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec("PRAGMA foreign_keys=ON");
      raw.prepare("DELETE FROM projects WHERE id='project-a'").run();
    } finally {
      raw.close();
    }

    expect(tagRows()).toHaveLength(1);
    expect(edgeRows()).toHaveLength(1);
    expect(storedTag("project-b", foreign.id)?.name).toBe("foreign");
  });
});

describe("thread tag assignment command seam", () => {
  it("assigns a tag idempotently and freezes the first edge timestamp", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "Release" }).body.tag;
    const first = setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: true,
      tagId: tag.id,
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      assigned: true,
      projectId: "project-a",
      tagId: tag.id,
      threadId: threadA,
    });
    expect(edgeRows()).toHaveLength(1);

    vi.setSystemTime(new Date(LATER));
    const second = setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: true,
      tagId: tag.id,
    });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(edgeRows()).toHaveLength(1);
    expect(storedEdge("project-a", threadA, tag.id)?.createdAt).toBe(NOW);
  });

  it("unassigns a tag idempotently, including when no edge exists", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "Release" }).body.tag;
    const missing = setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: false,
      tagId: tag.id,
    });
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual({
      assigned: false,
      projectId: "project-a",
      tagId: tag.id,
      threadId: threadA,
    });
    expect(edgeRows()).toHaveLength(0);

    setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: true,
      tagId: tag.id,
    });
    const cleared = setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: false,
      tagId: tag.id,
    });
    expect(cleared.body).toEqual(missing.body);
    expect(edgeRows()).toHaveLength(0);
  });

  it("records a fresh timestamp when a tag is assigned again after unassign", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "Release" }).body.tag;
    setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: true,
      tagId: tag.id,
    });
    setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: false,
      tagId: tag.id,
    });
    vi.setSystemTime(new Date(LATER));
    const again = setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: true,
      tagId: tag.id,
    });
    expect(again.body.assigned).toBe(true);
    expect(storedEdge("project-a", threadA, tag.id)?.createdAt).toBe(LATER);
  });

  it("rejects cross-tuple and missing targets with a stable 404 and writes nothing", () => {
    const ownTag = createThreadTag(databasePath, "project-a", { name: "own" }).body.tag;
    const foreignTag = createThreadTag(databasePath, "project-b", { name: "foreign" })
      .body.tag;
    for (const [projectId, threadId, tagId] of [
      ["project-a", foreignThread, ownTag.id],
      ["project-a", threadA, foreignTag.id],
      ["project-b", threadA, ownTag.id],
      ["project-b", foreignThread, ownTag.id],
      ["missing-project", threadA, ownTag.id],
      ["project-a", "missing-thread", ownTag.id],
      ["project-a", threadA, "missing-tag"],
    ] as const) {
      for (const assigned of [true, false]) {
        const error = expectCode(
          () =>
            setThreadTagAssignment(databasePath, projectId, threadId, {
              assigned,
              tagId,
            }),
          "RESOURCE_NOT_FOUND",
        );
        expect(error.httpStatus).toBe(404);
      }
    }
    expect(edgeRows()).toHaveLength(0);
  });

  it("validates the assignment input strictly", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "own" }).body.tag;
    const invalidInputs: Array<unknown> = [
      null,
      [],
      {},
      { tagId: tag.id },
      { assigned: true },
      { tagId: 1, assigned: true },
      { tagId: "", assigned: true },
      { tagId: "..", assigned: true },
      { tagId: tag.id, assigned: "yes" },
      { tagId: tag.id, assigned: 1 },
      { tagId: tag.id, assigned: null },
      { tagId: tag.id, assigned: true, extra: true },
    ];
    for (const input of invalidInputs) {
      const error = expectCode(
        () => setThreadTagAssignment(databasePath, "project-a", threadA, input),
        "INVALID_INPUT",
      );
      expect(error.httpStatus).toBe(400);
    }
    expect(edgeRows()).toHaveLength(0);
  });
});

describe("thread tag reopen seam", () => {
  it("keeps tags and edges across an idempotent reopen", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "Release" }).body.tag;
    insertEdge("project-a", threadA, tag.id);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = openDatabase(databasePath);
      try {
        expect(reopened.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 25,
        });
      } finally {
        reopened.close();
      }
    }
    expect(listProjectTags(databasePath, "project-a", {}).body.tags).toEqual([
      { ...tag, threadCount: 1 },
    ]);
  });

  it("rejects an edge row pointing at a missing thread on reopen", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "Release" }).body.tag;
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec("PRAGMA foreign_keys=OFF");
      raw
        .prepare(
          `INSERT INTO thread_tag_edges(project_id,thread_id,tag_id,created_at)
           VALUES ('project-a','missing-thread',?,?)`,
        )
        .run(tag.id, NOW);
    } finally {
      raw.close();
    }
    expect(() => openDatabase(databasePath).close()).toThrowError(
      expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }),
    );
  });

  it("rejects an edge row pointing at a missing tag on reopen", () => {
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec("PRAGMA foreign_keys=OFF");
      raw
        .prepare(
          `INSERT INTO thread_tag_edges(project_id,thread_id,tag_id,created_at)
           VALUES ('project-a',?,'missing-tag',?)`,
        )
        .run(threadA, NOW);
    } finally {
      raw.close();
    }
    expect(() => openDatabase(databasePath).close()).toThrowError(
      expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }),
    );
  });
});

describe("thread-tags route seam", () => {
  it("creates and lists tags through POST and GET with no-store responses", async () => {
    const created = await postThreadTag(
      "project-a",
      JSON.stringify({ name: "  Release  " }),
    );
    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const createdBody = (await created.json()) as {
      created: boolean;
      tag: { createdAt: string; id: string; name: string; projectId: string };
    };
    expect(createdBody).toEqual({
      created: true,
      tag: {
        createdAt: NOW,
        id: expect.any(String),
        name: "Release",
        projectId: "project-a",
      },
    });

    const synonym = await postThreadTag("project-a", JSON.stringify({ name: "release" }));
    expect(await synonym.json()).toEqual({
      created: false,
      tag: createdBody.tag,
    });

    const listed = await getThreadTags("project-a");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toEqual({
      tags: [{ ...createdBody.tag, threadCount: 0 }],
    });

    const filtered = await getThreadTags("project-a", "?q=REL");
    expect(filtered.status).toBe(200);
    expect(
      ((await filtered.json()) as { tags: Array<{ name: string }> }).tags.map(
        ({ name }) => name,
      ),
    ).toEqual(["Release"]);
    const missed = await getThreadTags("project-a", "?q=missing");
    expect(await missed.json()).toEqual({ tags: [] });
  });

  it("validates the POST body, media type, size, and URL strictly", async () => {
    for (const body of [
      JSON.stringify({}),
      JSON.stringify({ name: 1 }),
      JSON.stringify({ name: "" }),
      JSON.stringify({ name: "   " }),
      JSON.stringify({ name: "缺".repeat(41) }),
      JSON.stringify({ name: "ok", extra: true }),
    ]) {
      const response = await postThreadTag("project-a", body);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const envelope = (await response.json()) as {
        error: { code: string; fields?: Record<string, string> };
      };
      expect(envelope.error.code).toBe("INVALID_INPUT");
      expect(JSON.stringify(envelope)).not.toContain(databasePath);
    }

    const malformed = await postThreadTag("project-a", "{not json");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "INVALID_JSON" } });

    const unsupported = await postThreadTag(
      "project-a",
      JSON.stringify({ name: "ok" }),
      "text/plain",
    );
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });

    const oversized = await postThreadTag(
      "project-a",
      JSON.stringify({ name: `a${"b".repeat(65_536)}` }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });

    const suffixed = await postThreadTag(
      "project-a",
      JSON.stringify({ name: "ok" }),
      "application/json",
      "?unknown=1",
    );
    expect(suffixed.status).toBe(400);

    const missingProject = await postThreadTag(
      "missing-project",
      JSON.stringify({ name: "ok" }),
    );
    expect(missingProject.status).toBe(404);
    expect(await missingProject.json()).toMatchObject({
      error: { code: "PROJECT_NOT_FOUND" },
    });

    const badProject = await postThreadTag(
      "..",
      JSON.stringify({ name: "ok" }),
    );
    expect(badProject.status).toBe(400);
    expect(tagRows()).toHaveLength(0);
  });

  it("validates the GET query strictly with single-value whitelisted params", async () => {
    await postThreadTag("project-a", JSON.stringify({ name: "Release" }));

    for (const query of [
      "?unknown=1",
      "?q=a&q=b",
      "?limit=1&limit=2",
      "?q=",
      "?q=%20%20",
      `?q=${encodeURIComponent("长".repeat(101))}`,
      "?limit=",
      "?limit=abc",
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
    ]) {
      const response = await getThreadTags("project-a", query);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(((await response.json()) as { error: { code: string } }).error.code)
        .toBe("INVALID_INPUT");
    }

    const limited = await getThreadTags("project-a", "?limit=1");
    expect(limited.status).toBe(200);

    const missingProject = await getThreadTags("missing-project");
    expect(missingProject.status).toBe(404);
    expect(await missingProject.json()).toMatchObject({
      error: { code: "PROJECT_NOT_FOUND" },
    });
  });

  it("deletes a tag through DELETE with an honest edge count and a sanitized 404", async () => {
    const created = await postThreadTag("project-a", JSON.stringify({ name: "Release" }));
    const { tag } = (await created.json()) as {
      tag: { id: string; name: string };
    };
    insertEdge("project-a", threadA, tag.id);
    insertEdge("project-a", threadB, tag.id);

    const deleted = await deleteThreadTagRequest("project-a", tag.id);
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("cache-control")).toBe("no-store");
    expect(await deleted.json()).toEqual({ removedEdgeCount: 2, tagId: tag.id });
    expect(edgeRows()).toHaveLength(0);

    const listed = await getThreadTags("project-a");
    expect(await listed.json()).toEqual({ tags: [] });

    const recreated = await postThreadTag("project-a", JSON.stringify({ name: "Release" }));
    const { tag: crossTarget } = (await recreated.json()) as { tag: { id: string } };
    const crossProject = await deleteThreadTagRequest("project-b", crossTarget.id);
    expect(crossProject.status).toBe(404);
    expect(crossProject.headers.get("cache-control")).toBe("no-store");
    const crossBody = (await crossProject.json()) as { error: { code: string } };
    expect(crossBody.error.code).toBe("RESOURCE_NOT_FOUND");
    expect(JSON.stringify(crossBody)).not.toContain(databasePath);

    const missingProject = await deleteThreadTagRequest("missing-project", crossTarget.id);
    expect(missingProject.status).toBe(404);

    const badTag = await deleteThreadTagRequest("project-a", "..");
    expect(badTag.status).toBe(400);

    const suffixed = await deleteThreadTagRequest("project-a", crossTarget.id, "?x=1");
    expect(suffixed.status).toBe(400);
    expect(tagRows()).toHaveLength(1);
  });
});

describe("thread tag assignment route seam", () => {
  it("assigns and unassigns through PUT with a strict no-store DTO", async () => {
    const created = await postThreadTag("project-a", JSON.stringify({ name: "Release" }));
    const { tag } = (await created.json()) as { tag: { id: string; name: string } };

    const assigned = await putThreadTagAssignment(
      "project-a",
      threadA,
      JSON.stringify({ assigned: true, tagId: tag.id }),
    );
    expect(assigned.status).toBe(200);
    expect(assigned.headers.get("cache-control")).toBe("no-store");
    expect(await assigned.json()).toEqual({
      assigned: true,
      projectId: "project-a",
      tagId: tag.id,
      threadId: threadA,
    });

    const replay = await putThreadTagAssignment(
      "project-a",
      threadA,
      JSON.stringify({ assigned: true, tagId: tag.id }),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      assigned: true,
      projectId: "project-a",
      tagId: tag.id,
      threadId: threadA,
    });
    expect(edgeRows()).toHaveLength(1);

    const cleared = await putThreadTagAssignment(
      "project-a",
      threadA,
      JSON.stringify({ assigned: false, tagId: tag.id }),
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      assigned: false,
      projectId: "project-a",
      tagId: tag.id,
      threadId: threadA,
    });
    expect(edgeRows()).toHaveLength(0);

    const crossTuple = await putThreadTagAssignment(
      "project-a",
      foreignThread,
      JSON.stringify({ assigned: true, tagId: tag.id }),
    );
    expect(crossTuple.status).toBe(404);
    expect(crossTuple.headers.get("cache-control")).toBe("no-store");
    const crossBody = (await crossTuple.json()) as { error: { code: string } };
    expect(crossBody.error.code).toBe("RESOURCE_NOT_FOUND");
    expect(JSON.stringify(crossBody)).not.toContain(databasePath);
    expect(edgeRows()).toHaveLength(0);
  });

  it("validates the PUT body, media type, size, path, and URL strictly", async () => {
    const created = await postThreadTag("project-a", JSON.stringify({ name: "Release" }));
    const { tag } = (await created.json()) as { tag: { id: string } };

    for (const body of [
      JSON.stringify({}),
      JSON.stringify({ tagId: tag.id }),
      JSON.stringify({ assigned: true }),
      JSON.stringify({ tagId: 1, assigned: true }),
      JSON.stringify({ tagId: "..", assigned: true }),
      JSON.stringify({ assigned: "yes", tagId: tag.id }),
      JSON.stringify({ assigned: true, tagId: tag.id, extra: 1 }),
    ]) {
      const response = await putThreadTagAssignment("project-a", threadA, body);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const envelope = (await response.json()) as {
        error: { code: string; fields?: Record<string, string> };
      };
      expect(envelope.error.code).toBe("INVALID_INPUT");
      expect(JSON.stringify(envelope)).not.toContain(databasePath);
    }

    const malformed = await putThreadTagAssignment("project-a", threadA, "{not json");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "INVALID_JSON" } });

    const unsupported = await putThreadTagAssignment(
      "project-a",
      threadA,
      JSON.stringify({ assigned: true, tagId: tag.id }),
      "text/plain",
    );
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });

    const oversized = await putThreadTagAssignment(
      "project-a",
      threadA,
      JSON.stringify({ assigned: true, tagId: `a${"b".repeat(65_536)}` }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });

    const suffixed = await putThreadTagAssignment(
      "project-a",
      threadA,
      JSON.stringify({ assigned: true, tagId: tag.id }),
      "application/json",
      "?unknown=1",
    );
    expect(suffixed.status).toBe(400);

    const badProject = await putThreadTagAssignment(
      "..",
      threadA,
      JSON.stringify({ assigned: true, tagId: tag.id }),
    );
    expect(badProject.status).toBe(400);
    const badThread = await putThreadTagAssignment(
      "project-a",
      "..",
      JSON.stringify({ assigned: true, tagId: tag.id }),
    );
    expect(badThread.status).toBe(400);
    expect(edgeRows()).toHaveLength(0);
  });
});

describe("thread list tag filter and projection seam", () => {
  it("projects tags on every list item in name order, including empty arrays", () => {
    const empty = listThreads(databasePath, "project-a", {}).body;
    expect(empty.threads.map(({ id }) => id)).toEqual([threadB, threadA]);
    for (const thread of empty.threads) {
      expect(thread.tags).toEqual([]);
    }

    const beta = createThreadTag(databasePath, "project-a", { name: "beta" }).body.tag;
    const alpha = createThreadTag(databasePath, "project-a", { name: "Alpha" }).body.tag;
    setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: true,
      tagId: beta.id,
    });
    setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: true,
      tagId: alpha.id,
    });
    setThreadTagAssignment(databasePath, "project-a", threadB, {
      assigned: true,
      tagId: beta.id,
    });

    const body = listThreads(databasePath, "project-a", {}).body;
    expect(body.threads.map(({ id }) => id)).toEqual([threadB, threadA]);
    expect(body.threads[0]?.tags).toEqual([{ id: beta.id, name: "beta" }]);
    expect(body.threads[1]?.tags).toEqual([
      { id: alpha.id, name: "Alpha" },
      { id: beta.id, name: "beta" },
    ]);

    setThreadTagAssignment(databasePath, "project-a", threadB, {
      assigned: false,
      tagId: beta.id,
    });
    const cleared = listThreads(databasePath, "project-a", {}).body;
    expect(cleared.threads.find(({ id }) => id === threadB)?.tags).toEqual([]);
  });

  it("filters by tagId deterministically without changing the normal list order", () => {
    const beta = createThreadTag(databasePath, "project-a", { name: "beta" }).body.tag;
    const alpha = createThreadTag(databasePath, "project-a", { name: "Alpha" }).body.tag;
    setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: true,
      tagId: beta.id,
    });
    setThreadTagAssignment(databasePath, "project-a", threadB, {
      assigned: true,
      tagId: beta.id,
    });
    setThreadTagAssignment(databasePath, "project-a", threadB, {
      assigned: true,
      tagId: alpha.id,
    });
    const foreignTag = createThreadTag(databasePath, "project-b", { name: "foreign" })
      .body.tag;
    setThreadTagAssignment(databasePath, "project-b", foreignThread, {
      assigned: true,
      tagId: foreignTag.id,
    });

    const filtered = listThreads(databasePath, "project-a", { tagId: beta.id }).body;
    expect(filtered.threads.map(({ id }) => id)).toEqual([threadB, threadA]);
    expect(filtered.nextCursor).toBeNull();
    expect(filtered.threads[0]?.tags.map(({ id }) => id)).toEqual([
      alpha.id,
      beta.id,
    ]);

    const alphaOnly = listThreads(databasePath, "project-a", { tagId: alpha.id }).body;
    expect(alphaOnly.threads.map(({ id }) => id)).toEqual([threadB]);

    // Filter semantics, not tuple lookup: a foreign or missing tag id deterministically
    // yields an empty page without leaking the other project's assignments.
    expect(
      listThreads(databasePath, "project-a", { tagId: foreignTag.id }).body.threads,
    ).toEqual([]);
    expect(
      listThreads(databasePath, "project-a", { tagId: "missing-tag" }).body.threads,
    ).toEqual([]);

    const normal = listThreads(databasePath, "project-a", {}).body;
    expect(normal.threads.map(({ id }) => id)).toEqual([threadB, threadA]);
    expect(normal.nextCursor).toBeNull();
  });

  it("keeps cursor pagination compatible with the unchanged tag-filtered ordering", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "Release" }).body.tag;
    setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: true,
      tagId: tag.id,
    });
    setThreadTagAssignment(databasePath, "project-a", threadB, {
      assigned: true,
      tagId: tag.id,
    });

    const firstPage = listThreads(databasePath, "project-a", {
      limit: 1,
      tagId: tag.id,
    }).body;
    expect(firstPage.threads.map(({ id }) => id)).toEqual([threadB]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = listThreads(databasePath, "project-a", {
      cursor: firstPage.nextCursor!,
      tagId: tag.id,
    }).body;
    expect(secondPage.threads.map(({ id }) => id)).toEqual([threadA]);
    expect(secondPage.nextCursor).toBeNull();

    const plainFirst = listThreads(databasePath, "project-a", { limit: 1 }).body;
    expect(plainFirst.threads.map(({ id }) => id)).toEqual([threadB]);
    const plainSecond = listThreads(databasePath, "project-a", {
      cursor: plainFirst.nextCursor!,
    }).body;
    expect(plainSecond.threads.map(({ id }) => id)).toEqual([threadA]);
    expect(plainSecond.nextCursor).toBeNull();
  });

  it("rejects combining tagId with favoritesOnly and validates tagId strictly", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "Release" }).body.tag;
    setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: true,
      tagId: tag.id,
    });

    const conflict = expectCode(
      () =>
        listThreads(databasePath, "project-a", {
          favoritesOnly: true,
          tagId: tag.id,
        }),
      "INVALID_INPUT",
    );
    expect(conflict.httpStatus).toBe(400);
    expect(conflict.details.fields).toEqual({ tagId: "not_combinable" });

    const combined = listThreads(databasePath, "project-a", {
      favoritesOnly: false,
      tagId: tag.id,
    }).body;
    expect(combined.threads.map(({ id }) => id)).toEqual([threadA]);

    for (const input of [
      { tagId: 1 },
      { tagId: "" },
      { tagId: ".." },
      { tagId: "not a valid id" },
    ]) {
      const error = expectCode(
        () => listThreads(databasePath, "project-a", input),
        "INVALID_INPUT",
      );
      expect(error.httpStatus).toBe(400);
    }
  });

  it("keeps assignments, filter, and projection consistent across reopen", () => {
    const tag = createThreadTag(databasePath, "project-a", { name: "Release" }).body.tag;
    setThreadTagAssignment(databasePath, "project-a", threadA, {
      assigned: true,
      tagId: tag.id,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = openDatabase(databasePath);
      try {
        expect(reopened.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 25,
        });
      } finally {
        reopened.close();
      }
    }

    const filtered = listThreads(databasePath, "project-a", { tagId: tag.id }).body;
    expect(filtered.threads.map(({ id }) => id)).toEqual([threadA]);
    expect(filtered.threads[0]?.tags).toEqual([{ id: tag.id, name: "Release" }]);
    const normal = listThreads(databasePath, "project-a", {}).body;
    expect(normal.threads.find(({ id }) => id === threadB)?.tags).toEqual([]);
  });

  it("serves the tagId filter through GET /threads with strict single-value parsing", async () => {
    const created = await postThreadTag("project-a", JSON.stringify({ name: "Release" }));
    const { tag } = (await created.json()) as { tag: { id: string; name: string } };
    await putThreadTagAssignment(
      "project-a",
      threadA,
      JSON.stringify({ assigned: true, tagId: tag.id }),
    );

    const filtered = await getThreads("project-a", `?tagId=${tag.id}`);
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as {
      threads: Array<{ id: string; tags: Array<{ id: string; name: string }> }>;
    };
    expect(filteredBody.threads.map(({ id }) => id)).toEqual([threadA]);
    expect(filteredBody.threads[0]?.tags).toEqual([{ id: tag.id, name: "Release" }]);

    const all = await getThreads("project-a");
    const allBody = (await all.json()) as {
      threads: Array<{ id: string; tags: unknown[] }>;
    };
    expect(allBody.threads.map(({ id }) => id)).toEqual([threadB, threadA]);
    expect(allBody.threads.find(({ id }) => id === threadB)?.tags).toEqual([]);

    const combined = await getThreads("project-a", `?tagId=${tag.id}&favorites=false`);
    expect(combined.status).toBe(200);

    for (const query of [
      "?tagId=a&tagId=b",
      "?tagId=",
      "?tagId=..",
      "?tagId=not%20a%20valid%20id",
      `?tagId=${tag.id}&favorites=true`,
      `?tagId=${tag.id}&unknown=1`,
    ]) {
      const response = await getThreads("project-a", query);
      expect(response.status).toBe(400);
      const envelope = (await response.json()) as { error: { code: string } };
      expect(envelope.error.code).toBe("INVALID_INPUT");
      expect(JSON.stringify(envelope)).not.toContain(databasePath);
    }
  });
});
