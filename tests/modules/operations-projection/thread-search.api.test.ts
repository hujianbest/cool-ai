import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getThreadSearch } from "@/app/api/projects/[projectId]/thread-search/route";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { upsertAuditCheckpoint } from "@/src/adapters/outbound/sqlite/operations-projection/audit-projection-store";
import {
  rebuildThreadSearchIndex,
  THREAD_SEARCH_INDEX_CONSUMER_ID,
} from "@/src/adapters/outbound/sqlite/operations-projection/thread-search-index-consumer";
import {
  createThread,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { seedSearchCollaborationGraph } from "@/tests/fixtures/collaboration/search-graph";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-10T03:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 13).toString("base64url");
const PROJECT_A = "search-api-project-a";
const PROJECT_B = "search-api-project-b";
const PROVIDER = "search-api-provider";
const AGENTS: [string, string] = ["search-api-agent-a", "search-api-agent-b"];

let operationSequence = 0;

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

let databasePath: string;
let database: DatabaseSync;
let clockMs: number;

beforeEach(() => {
  vi.useFakeTimers();
  clockMs = new Date(NOW).getTime();
  vi.setSystemTime(new Date(clockMs));
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  database = openDatabase(databasePath);
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  try {
    database.close();
  } catch {
    // Already closed by a failure-path test.
  }
  vi.useRealTimers();
});

function advanceClockSeconds(seconds: number): string {
  clockMs += seconds * 1000;
  vi.setSystemTime(new Date(clockMs));
  return new Date(clockMs).toISOString();
}

function seedGraph(projectIds: string[] = [PROJECT_A]): void {
  seedSearchCollaborationGraph(database, {
    agentIds: AGENTS,
    now: NOW,
    projectIds,
    providerId: PROVIDER,
  });
}

function seedThread(projectId: string, title: string): string {
  return createThread(databasePath, projectId, {
    memberAgentIds: [...AGENTS],
    operationId: operationId(),
    title,
  }).body.thread.id;
}

function writeMessage(projectId: string, threadId: string, content: string): string {
  const written = writeOwnerThreadMessage(databasePath, projectId, threadId, {
    content,
    operationId: operationId(),
  });
  expect(written.status).toBe(201);
  return written.body.message.id;
}

function projectContext(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function searchRequest(projectId: string, queryString: string): Request {
  const suffix = queryString.length > 0 ? `?${queryString}` : "";
  return new Request(
    `http://localhost/api/projects/${projectId}/thread-search${suffix}`,
  );
}

describe("GET /api/projects/:projectId/thread-search", () => {
  it("serves title and message hits with a no-store header", async () => {
    seedGraph();
    const threadId = seedThread(PROJECT_A, "部署计划讨论");
    const messageId = writeMessage(PROJECT_A, threadId, "Keyword rollout 正文内容");

    const titleResponse = await getThreadSearch(
      searchRequest(PROJECT_A, `q=${encodeURIComponent("部署")}`),
      projectContext(PROJECT_A),
    );
    expect(titleResponse.status).toBe(200);
    expect(titleResponse.headers.get("cache-control")).toBe("no-store");
    await expect(titleResponse.json()).resolves.toEqual({
      nextCursor: null,
      results: [
        {
          kind: "thread_title",
          messageId: null,
          occurredAt: NOW,
          snippet: "部署计划讨论",
          threadId,
          threadTitle: "部署计划讨论",
        },
      ],
    });

    const messageResponse = await getThreadSearch(
      searchRequest(PROJECT_A, "q=keyword"),
      projectContext(PROJECT_A),
    );
    expect(messageResponse.status).toBe(200);
    await expect(messageResponse.json()).resolves.toEqual({
      nextCursor: null,
      results: [
        {
          kind: "message",
          messageId,
          occurredAt: NOW,
          snippet: "Keyword rollout 正文内容",
          threadId,
          threadTitle: "部署计划讨论",
        },
      ],
    });
  });

  it("paginates through the limit and before query parameters", async () => {
    seedGraph();
    const threadA = seedThread(PROJECT_A, "分页 甲");
    advanceClockSeconds(1);
    const threadB = seedThread(PROJECT_A, "分页 乙");
    advanceClockSeconds(1);
    const threadC = seedThread(PROJECT_A, "分页 丙");
    rebuildThreadSearchIndex(databasePath);

    const page1 = await getThreadSearch(
      searchRequest(PROJECT_A, `q=${encodeURIComponent("分页")}&limit=2`),
      projectContext(PROJECT_A),
    );
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.results.map((row: { threadId: string }) => row.threadId)).toEqual([
      threadC,
      threadB,
    ]);
    expect(typeof body1.nextCursor).toBe("string");

    const page2 = await getThreadSearch(
      searchRequest(
        PROJECT_A,
        `q=${encodeURIComponent("分页")}&limit=2&before=${body1.nextCursor}`,
      ),
      projectContext(PROJECT_A),
    );
    expect(page2.status).toBe(200);
    const body2 = await page2.json();
    expect(body2.results.map((row: { threadId: string }) => row.threadId)).toEqual([threadA]);
    expect(body2.nextCursor).toBeNull();
  });

  it("serves an empty page when nothing matches", async () => {
    seedGraph();
    const threadId = seedThread(PROJECT_A, "普通线程");
    writeMessage(PROJECT_A, threadId, "普通内容");

    const response = await getThreadSearch(
      searchRequest(PROJECT_A, `q=${encodeURIComponent("缺词")}`),
      projectContext(PROJECT_A),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ nextCursor: null, results: [] });
  });

  it("never leaks another project's threads", async () => {
    seedGraph([PROJECT_A, PROJECT_B]);
    const threadB = seedThread(PROJECT_B, "乙项目 独特词乙");
    writeMessage(PROJECT_B, threadB, "正文 独特词乙");

    const response = await getThreadSearch(
      searchRequest(PROJECT_A, `q=${encodeURIComponent("独特词乙")}`),
      projectContext(PROJECT_A),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ nextCursor: null, results: [] });
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
    ["q=x&before=", "before", "required"],
    ["q=x&before=a&before=b", "before", "duplicate"],
    ["q=x&before=!!!", "before", "invalid_format"],
    ["q=x&bogus=1", "bogus", "unknown"],
  ])("rejects invalid query %s with a stable 400 envelope", async (queryString, field, code) => {
    seedGraph();
    const response = await getThreadSearch(
      searchRequest(PROJECT_A, queryString),
      projectContext(PROJECT_A),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toBe("Thread search query is invalid.");
    expect(body.error.fields).toContainEqual({ code, field });
  });

  it("rejects a missing q with 400", async () => {
    seedGraph();
    const response = await getThreadSearch(
      searchRequest(PROJECT_A, ""),
      projectContext(PROJECT_A),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.fields).toContainEqual({ code: "required", field: "q" });
  });

  it("rejects a structurally valid but undecodable cursor with 400", async () => {
    seedGraph();
    const cursor = Buffer.from("not-json").toString("base64url");
    const response = await getThreadSearch(
      searchRequest(PROJECT_A, `q=x&before=${cursor}`),
      projectContext(PROJECT_A),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.error).toEqual({
      code: "INVALID_INPUT",
      message: "Thread search query is invalid.",
    });
  });

  it("returns 404 PROJECT_NOT_FOUND for a missing project", async () => {
    const response = await getThreadSearch(
      searchRequest("missing", "q=x"),
      projectContext("missing"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project was not found." },
    });
  });

  it("rejects a malformed projectId with 400 before touching storage", async () => {
    const response = await getThreadSearch(
      searchRequest("..", "q=x"),
      projectContext(".."),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.fields).toContainEqual({
      code: "invalid_format",
      field: "projectId",
    });
  });

  it("returns 409 while the search index is rebuilding", async () => {
    seedGraph();
    const threadId = seedThread(PROJECT_A, "Rebuild gate");
    writeMessage(PROJECT_A, threadId, "Pending message");
    upsertAuditCheckpoint(database, {
      consumerId: THREAD_SEARCH_INDEX_CONSUMER_ID,
      lastOutboxSeq: 0,
      status: "rebuilding",
    });

    const response = await getThreadSearch(
      searchRequest(PROJECT_A, "q=x"),
      projectContext(PROJECT_A),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PROJECTION_REBUILD_IN_PROGRESS",
        message: "Thread search index is rebuilding.",
      },
    });
  });
});
