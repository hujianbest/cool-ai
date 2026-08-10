import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { upsertAuditCheckpoint } from "@/src/adapters/outbound/sqlite/operations-projection/audit-projection-store";
import {
  rebuildThreadSearchIndex,
  THREAD_SEARCH_INDEX_CONSUMER_ID,
} from "@/src/adapters/outbound/sqlite/operations-projection/thread-search-index-consumer";
import {
  searchProjectThreads,
  THREAD_SEARCH_DEFAULT_LIMIT,
} from "@/src/adapters/outbound/sqlite/operations-projection/thread-search-queries";
import {
  createThread,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { OperationsProjectionError } from "@/src/modules/operations-projection";
import { seedSearchCollaborationGraph } from "@/tests/fixtures/collaboration/search-graph";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-10T03:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 13).toString("base64url");
const PROJECT_A = "search-query-project-a";
const PROJECT_B = "search-query-project-b";
const PROVIDER = "search-query-provider";
const AGENTS: [string, string] = ["search-query-agent-a", "search-query-agent-b"];

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
  database = openDatabase(databasePath);
});

afterEach(() => {
  try {
    database.close();
  } catch {
    // Already closed by a failure-path test.
  }
  delete process.env.COCKPIT_MASTER_KEY;
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

function search(
  projectId: string,
  options: { before?: string; limit?: number; query: string },
) {
  return searchProjectThreads(databasePath, projectId, options);
}

function expectInvalidInput(options: { before?: string; limit?: number; query: string }): void {
  expect(() => search(PROJECT_A, options)).toThrowError(
    expect.objectContaining({
      code: "INVALID_INPUT",
      name: "OperationsProjectionError",
    }) as OperationsProjectionError,
  );
}

describe("searchProjectThreads", () => {
  it("catches up the index on the read path and returns title and message hits", () => {
    seedGraph();
    const threadId = seedThread(PROJECT_A, "部署计划讨论");
    const messageId = writeMessage(PROJECT_A, threadId, "Keyword rollout 正文内容");
    // No explicit catchUp/rebuild: the read path must synchronize the index.

    expect(search(PROJECT_A, { query: "部署" })).toEqual({
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

    expect(search(PROJECT_A, { query: "正文" })).toEqual({
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

  it("folds ASCII case on both sides and trims the query before matching", () => {
    seedGraph();
    const threadId = seedThread(PROJECT_A, "部署计划讨论");
    writeMessage(PROJECT_A, threadId, "Keyword rollout 正文内容");

    const folded = search(PROJECT_A, { query: "keyword" });
    expect(folded.results.map((row) => row.kind)).toEqual(["message"]);
    const upper = search(PROJECT_A, { query: "KEYWORD" });
    expect(upper.results.map((row) => row.kind)).toEqual(["message"]);
    const padded = search(PROJECT_A, { query: "  部署  " });
    expect(padded.results.map((row) => [row.kind, row.threadId])).toEqual([
      ["thread_title", threadId],
    ]);
  });

  it("orders mixed hits newest-first and breaks ties by thread id", () => {
    seedGraph();
    const occurredA = NOW;
    const threadA = seedThread(PROJECT_A, "Alpha 计划");
    const occurredB = advanceClockSeconds(1);
    const threadB = seedThread(PROJECT_A, "Beta 计划");
    const occurredMessage = advanceClockSeconds(1);
    const messageId = writeMessage(PROJECT_A, threadA, "计划 正文内容");
    // threadB's title row piggybacks on this non-matching event (A-171).
    writeMessage(PROJECT_A, threadB, "无关消息");

    const page = search(PROJECT_A, { query: "计划" });
    expect(page.nextCursor).toBeNull();
    expect(page.results.map((row) => [row.kind, row.occurredAt])).toEqual([
      ["message", occurredMessage],
      ["thread_title", occurredB],
      ["thread_title", occurredA],
    ]);
    expect(page.results.map((row) => row.threadId)).toEqual([threadA, threadB, threadA]);
    expect(page.results[0].messageId).toBe(messageId);

    // Same-timestamp title hits order by thread_id ascending.
    const threadC = seedThread(PROJECT_A, "决胜 甲");
    writeMessage(PROJECT_A, threadC, "无关");
    const threadD = seedThread(PROJECT_A, "决胜 乙");
    writeMessage(PROJECT_A, threadD, "无关");
    const tiePage = search(PROJECT_A, { query: "决胜" });
    expect(tiePage.results.map((row) => row.kind)).toEqual(["thread_title", "thread_title"]);
    expect(tiePage.results.map((row) => row.threadId)).toEqual([threadC, threadD].sort());
  });

  it("paginates the default limit over a same-timestamp tie without repeats or gaps", () => {
    seedGraph();
    const threadIds: string[] = [];
    for (let index = 1; index <= 22; index += 1) {
      threadIds.push(seedThread(PROJECT_A, `批量线程 ${index.toString().padStart(2, "0")}`));
    }
    // Zero-message threads are indexed by a rebuild (A-171).
    rebuildThreadSearchIndex(databasePath);

    const page1 = search(PROJECT_A, { query: "批量线程" });
    expect(page1.results).toHaveLength(THREAD_SEARCH_DEFAULT_LIMIT);
    expect(page1.nextCursor).not.toBeNull();
    const page1Ids = page1.results.map((row) => row.threadId);
    expect([...page1Ids].sort()).toEqual(page1Ids);

    const page2 = search(PROJECT_A, { before: page1.nextCursor ?? "", query: "批量线程" });
    expect(page2.results).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1Ids, ...page2.results.map((row) => row.threadId)];
    expect(new Set(allIds).size).toBe(22);
    expect([...allIds].sort()).toEqual([...threadIds].sort());
    expect(page2.results[0].threadId > page1Ids[page1Ids.length - 1]).toBe(true);
  });

  it("paginates an explicit limit with an exclusive cursor", () => {
    seedGraph();
    const occurredA = NOW;
    const threadA = seedThread(PROJECT_A, "分页 甲");
    const occurredB = advanceClockSeconds(1);
    const threadB = seedThread(PROJECT_A, "分页 乙");
    const occurredC = advanceClockSeconds(1);
    const threadC = seedThread(PROJECT_A, "分页 丙");
    rebuildThreadSearchIndex(databasePath);

    const page1 = search(PROJECT_A, { limit: 2, query: "分页" });
    expect(page1.results.map((row) => [row.threadId, row.occurredAt])).toEqual([
      [threadC, occurredC],
      [threadB, occurredB],
    ]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = search(PROJECT_A, {
      before: page1.nextCursor ?? "",
      limit: 2,
      query: "分页",
    });
    // The cursor row (threadB) is excluded, not repeated.
    expect(page2.results.map((row) => [row.threadId, row.occurredAt])).toEqual([
      [threadA, occurredA],
    ]);
    expect(page2.nextCursor).toBeNull();
  });

  it("windows message snippets around the match with ellipses on both sides", () => {
    seedGraph();
    const threadId = seedThread(PROJECT_A, "Snippet thread");
    writeMessage(PROJECT_A, threadId, `${"前".repeat(100)}关键字${"后".repeat(100)}`);

    const page = search(PROJECT_A, { query: "关键字" });
    expect(page.results).toHaveLength(1);
    expect(page.results[0].snippet).toBe(
      `…${"前".repeat(60)}关键字${"后".repeat(60)}…`,
    );
  });

  it("keeps the snippet head unelided when the match is at the start", () => {
    seedGraph();
    const threadId = seedThread(PROJECT_A, "Snippet thread");
    writeMessage(PROJECT_A, threadId, `开头命中${"尾".repeat(200)}`);

    const page = search(PROJECT_A, { query: "开头命中" });
    expect(page.results[0].snippet).toBe(`开头命中${"尾".repeat(60)}…`);
  });

  it("keeps the snippet tail unelided when the match is at the end", () => {
    seedGraph();
    const threadId = seedThread(PROJECT_A, "Snippet thread");
    writeMessage(PROJECT_A, threadId, `${"头".repeat(200)}结尾命中`);

    const page = search(PROJECT_A, { query: "结尾命中" });
    expect(page.results[0].snippet).toBe(`…${"头".repeat(60)}结尾命中`);
  });

  it("treats percent, underscore and backslash as literal characters", () => {
    seedGraph();
    const threadId = seedThread(PROJECT_A, "Wildcard thread");
    writeMessage(PROJECT_A, threadId, "rate 50% off_sale \\home");

    expect(search(PROJECT_A, { query: "50%" }).results).toHaveLength(1);
    // A bare % matches only a literal percent (the title has none).
    expect(search(PROJECT_A, { query: "%" }).results).toHaveLength(1);
    // r%t would match "rate…t" under wildcard semantics.
    expect(search(PROJECT_A, { query: "r%t" }).results).toHaveLength(0);
    // o_f would match "off" under wildcard semantics.
    expect(search(PROJECT_A, { query: "o_f" }).results).toHaveLength(0);
    expect(search(PROJECT_A, { query: "off_sale" }).results).toHaveLength(1);
    expect(search(PROJECT_A, { query: "\\home" }).results).toHaveLength(1);
  });

  it("returns an empty page when nothing matches", () => {
    seedGraph();
    const threadId = seedThread(PROJECT_A, "普通线程");
    writeMessage(PROJECT_A, threadId, "普通内容");

    expect(search(PROJECT_A, { query: "缺词" })).toEqual({
      nextCursor: null,
      results: [],
    });
  });

  it("isolates projects: hits never leak across project boundaries", () => {
    seedGraph([PROJECT_A, PROJECT_B]);
    const threadA = seedThread(PROJECT_A, "独特词甲 讨论");
    writeMessage(PROJECT_A, threadA, "正文 独特词甲");
    const threadB = seedThread(PROJECT_B, "独特词乙 讨论");
    writeMessage(PROJECT_B, threadB, "正文 独特词乙");

    const pageA = search(PROJECT_A, { query: "独特词" });
    expect(pageA.results).toHaveLength(2);
    expect(new Set(pageA.results.map((row) => row.threadId))).toEqual(new Set([threadA]));

    const pageB = search(PROJECT_B, { query: "独特词" });
    expect(pageB.results).toHaveLength(2);
    expect(new Set(pageB.results.map((row) => row.threadId))).toEqual(new Set([threadB]));

    expect(search(PROJECT_A, { query: "独特词乙" }).results).toEqual([]);
  });

  it("fails closed while the search index is rebuilding", () => {
    seedGraph();
    const threadId = seedThread(PROJECT_A, "Rebuild gate");
    writeMessage(PROJECT_A, threadId, "Pending message");
    upsertAuditCheckpoint(database, {
      consumerId: THREAD_SEARCH_INDEX_CONSUMER_ID,
      lastOutboxSeq: 0,
      status: "rebuilding",
    });

    expect(() => search(PROJECT_A, { query: "x" })).toThrowError(
      expect.objectContaining({
        code: "PROJECTION_REBUILD_IN_PROGRESS",
        name: "OperationsProjectionError",
      }) as OperationsProjectionError,
    );
  });
});

describe("searchProjectThreads options validation", () => {
  beforeEach(() => {
    seedGraph();
  });

  it("rejects an empty or whitespace-only query", () => {
    expectInvalidInput({ query: "" });
    expectInvalidInput({ query: "   " });
  });

  it("accepts a 200-grapheme query and rejects 201", () => {
    expect(search(PROJECT_A, { query: "字".repeat(200) })).toEqual({
      nextCursor: null,
      results: [],
    });
    expectInvalidInput({ query: "字".repeat(201) });
  });

  it("rejects out-of-range and non-integer limits", () => {
    expectInvalidInput({ limit: 0, query: "x" });
    expectInvalidInput({ limit: 51, query: "x" });
    expectInvalidInput({ limit: 1.5, query: "x" });
    expectInvalidInput({ limit: Number.NaN, query: "x" });
  });

  it("rejects malformed cursors", () => {
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    expectInvalidInput({ before: "!!!", query: "x" });
    expectInvalidInput({ before: encode("not-an-array"), query: "x" });
    expectInvalidInput({ before: encode(["2026-08-10T03:00:00.000Z"]), query: "x" });
    expectInvalidInput({ before: encode(["bad-date", "thread-1", null]), query: "x" });
    expectInvalidInput({
      before: encode(["2026-08-10T03:00:00.000Z", "", null]),
      query: "x",
    });
    expectInvalidInput({
      before: encode(["2026-08-10T03:00:00.000Z", "thread-1", 42]),
      query: "x",
    });
  });

  it("validates options before the project tuple check", () => {
    expect(() => search("missing-project", { query: "" })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }) as OperationsProjectionError,
    );
  });

  it("rejects an unknown project with PROJECT_NOT_FOUND", () => {
    expect(() => search("missing-project", { query: "x" })).toThrowError(
      expect.objectContaining({
        code: "PROJECT_NOT_FOUND",
        name: "OperationsProjectionError",
      }) as OperationsProjectionError,
    );
  });
});
