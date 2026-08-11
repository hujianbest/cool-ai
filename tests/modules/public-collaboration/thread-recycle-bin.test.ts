import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { uploadAttachment } from "@/src/adapters/outbound/sqlite/public-collaboration/attachment-service";
import {
  deleteThread,
  listDeletedThreads,
  restoreThread,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-lifecycle-service";
import {
  createThread,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { CollaborationError } from "@/src/modules/public-collaboration";
import { seedSearchCollaborationGraph } from "@/tests/fixtures/collaboration/search-graph";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-11T08:00:00.000Z";
const LATER = "2026-08-11T09:30:00.000Z";
const LATEST = "2026-08-11T10:45:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 31).toString("base64url");
const PROJECT_A = "recycle-bin-project-a";
const PROJECT_B = "recycle-bin-project-b";
const PROJECT_EMPTY = "recycle-bin-project-empty";
const PROVIDER = "recycle-bin-provider";
const AGENTS: [string, string] = ["recycle-bin-agent-a", "recycle-bin-agent-b"];

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

type RecycleBinRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const recycleBinRoutes = import.meta.glob<RecycleBinRoute>(
  "../../../app/api/projects/[projectId]/thread-recycle-bin/route.ts",
);

async function recycleBinRoute(): Promise<RecycleBinRoute> {
  const load =
    recycleBinRoutes[
      "../../../app/api/projects/[projectId]/thread-recycle-bin/route.ts"
    ];
  expect(load, "thread recycle bin route must exist").toBeTypeOf("function");
  const route = await load!();
  expect(route.GET, "thread recycle bin GET handler must exist").toBeTypeOf(
    "function",
  );
  return route;
}

async function recycleBinRequest(
  projectId: string,
  urlSuffix = "",
): Promise<Response> {
  return (await recycleBinRoute()).GET(
    new Request(
      `http://localhost/api/projects/${projectId}/thread-recycle-bin${urlSuffix}`,
    ),
    { params: Promise.resolve({ projectId }) },
  );
}

let databasePath: string;
let attachmentsRoot: string;
let operationSequence = 0;
const temporaryDirectories: string[] = [];

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function createSeededThread(projectId: string, title: string): string {
  return createThread(databasePath, projectId, {
    memberAgentIds: [...AGENTS],
    operationId: operationId(),
    title,
  }).body.thread.id;
}

function writeMessage(projectId: string, threadId: string, content: string): void {
  writeOwnerThreadMessage(databasePath, projectId, threadId, {
    attachmentIds: [],
    content,
    operationId: operationId(),
    recordInputHistory: true,
  });
}

function uploadPng(projectId: string, threadId: string, fileName: string): string {
  return uploadAttachment(databasePath, attachmentsRoot, projectId, threadId, {
    bytes: PNG_BYTES,
    fileName,
  }).body.attachment.id;
}

function deleteAt(projectId: string, threadId: string, timestamp: string): void {
  vi.setSystemTime(new Date(timestamp));
  deleteThread(databasePath, projectId, threadId);
}

function binIds(projectId: string, rawInput: unknown = {}): string[] {
  return listDeletedThreads(databasePath, projectId, rawInput).body.threads.map(
    ({ id }) => id,
  );
}

function expectCode(operation: () => unknown, code: string): CollaborationError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    const collaborationError = error as CollaborationError;
    expect(collaborationError.code).toBe(code);
    return collaborationError;
  }
  throw new Error(`Expected ${code}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  attachmentsRoot = mkdtempSync(join(tmpdir(), "recycle-bin-attachments-"));
  temporaryDirectories.push(attachmentsRoot);
  operationSequence = 0;
  const database = openDatabase(databasePath);
  try {
    seedSearchCollaborationGraph(database, {
      agentIds: AGENTS,
      now: NOW,
      projectIds: [PROJECT_A, PROJECT_B, PROJECT_EMPTY],
      providerId: PROVIDER,
    });
  } finally {
    database.close();
  }
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  vi.useRealTimers();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
  }
});

describe("recycle bin query seam", () => {
  it("lists deleted threads newest-first with id tiebreak and exact item projection", () => {
    const first = createSeededThread(PROJECT_A, "回收站甲");
    const second = createSeededThread(PROJECT_A, "回收站乙");
    const third = createSeededThread(PROJECT_A, "回收站丙");
    deleteAt(PROJECT_A, first, NOW);
    deleteAt(PROJECT_A, second, LATER);
    deleteAt(PROJECT_A, third, LATER);

    const result = listDeletedThreads(databasePath, PROJECT_A, {});
    expect(result.status).toBe(200);
    const [tieA, tieB] = [second, third].sort();
    expect(result.body.nextCursor).toBeNull();
    expect(result.body.threads).toEqual([
      {
        attachmentCount: 0,
        deletedAt: LATER,
        id: tieA,
        messageCount: 0,
        projectId: PROJECT_A,
        title: tieA === second ? "回收站乙" : "回收站丙",
      },
      {
        attachmentCount: 0,
        deletedAt: LATER,
        id: tieB,
        messageCount: 0,
        projectId: PROJECT_A,
        title: tieB === second ? "回收站乙" : "回收站丙",
      },
      {
        attachmentCount: 0,
        deletedAt: NOW,
        id: first,
        messageCount: 0,
        projectId: PROJECT_A,
        title: "回收站甲",
      },
    ]);
  });

  it("reports honest message and attachment counts from batched page queries", () => {
    const rich = createSeededThread(PROJECT_A, "富内容线程");
    const linkedId = uploadPng(PROJECT_A, rich, "linked.png");
    writeOwnerThreadMessage(databasePath, PROJECT_A, rich, {
      attachmentIds: [linkedId],
      content: "带附件的消息",
      operationId: operationId(),
      recordInputHistory: true,
    });
    writeMessage(PROJECT_A, rich, "纯文本消息");
    const uploadOnly = createSeededThread(PROJECT_A, "仅附件线程");
    uploadPng(PROJECT_A, uploadOnly, "unlinked.png");
    const bare = createSeededThread(PROJECT_A, "空线程");
    deleteAt(PROJECT_A, rich, NOW);
    deleteAt(PROJECT_A, uploadOnly, LATER);
    deleteAt(PROJECT_A, bare, LATEST);

    const { body } = listDeletedThreads(databasePath, PROJECT_A, {});
    expect(body.threads.map(({ id }) => id)).toEqual([bare, uploadOnly, rich]);
    expect(body.threads[0]).toMatchObject({
      attachmentCount: 0,
      id: bare,
      messageCount: 0,
    });
    expect(body.threads[1]).toMatchObject({
      attachmentCount: 1,
      id: uploadOnly,
      messageCount: 0,
    });
    expect(body.threads[2]).toMatchObject({
      attachmentCount: 1,
      id: rich,
      messageCount: 2,
    });
  });

  it("paginates with an opaque cursor identical to walking the full list", () => {
    const threadIds = ["分页甲", "分页乙", "分页丙", "分页丁", "分页戊"].map((title) =>
      createSeededThread(PROJECT_A, title),
    );
    const timestamps = [NOW, "2026-08-11T08:30:00.000Z", LATER, "2026-08-11T10:00:00.000Z", LATEST];
    threadIds.forEach((threadId, index) => {
      deleteAt(PROJECT_A, threadId, timestamps[index]!);
    });
    const full = binIds(PROJECT_A);
    expect(full).toHaveLength(5);

    const walked: string[] = [];
    let cursor: string | null = null;
    const cursors: Array<string | null> = [];
    for (let page = 0; page < 3; page += 1) {
      const result: { body: { nextCursor: string | null; threads: Array<{ id: string }> } } =
        listDeletedThreads(
          databasePath,
          PROJECT_A,
          cursor === null ? { limit: 2 } : { cursor, limit: 2 },
        );
      walked.push(...result.body.threads.map(({ id }) => id));
      cursors.push(result.body.nextCursor);
      cursor = result.body.nextCursor;
    }
    expect(cursors[0]).not.toBeNull();
    expect(cursors[1]).not.toBeNull();
    expect(cursors[2]).toBeNull();
    expect(walked).toEqual(full);
    expect(new Set(walked).size).toBe(5);
  });

  it("returns an empty page with 200 when nothing is deleted", () => {
    createSeededThread(PROJECT_EMPTY, "活跃线程");
    const result = listDeletedThreads(databasePath, PROJECT_EMPTY, {});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ nextCursor: null, threads: [] });
  });

  it("only contains deleted threads; a restored thread leaves the bin", () => {
    const active = createSeededThread(PROJECT_A, "保持活跃");
    const gone = createSeededThread(PROJECT_A, "进回收站");
    deleteAt(PROJECT_A, gone, NOW);

    expect(binIds(PROJECT_A)).toEqual([gone]);
    expect(binIds(PROJECT_A)).not.toContain(active);

    vi.setSystemTime(new Date(LATER));
    restoreThread(databasePath, PROJECT_A, gone);
    expect(binIds(PROJECT_A)).toEqual([]);
  });

  it("isolates the bin per project and rejects a missing project", () => {
    const foreign = createSeededThread(PROJECT_A, "他项目回收");
    deleteAt(PROJECT_A, foreign, NOW);
    const own = createSeededThread(PROJECT_B, "本项目回收");
    deleteAt(PROJECT_B, own, LATER);

    expect(binIds(PROJECT_B)).toEqual([own]);
    expect(binIds(PROJECT_A)).toEqual([foreign]);

    const error = expectCode(
      () => listDeletedThreads(databasePath, "missing-project", {}),
      "PROJECT_NOT_FOUND",
    );
    expect(error.httpStatus).toBe(404);
  });

  it("is consistent across fresh reopen connections", () => {
    const threadId = createSeededThread(PROJECT_A, "重启一致");
    writeMessage(PROJECT_A, threadId, "重启前的消息");
    deleteAt(PROJECT_A, threadId, NOW);

    const first = listDeletedThreads(databasePath, PROJECT_A, {});
    const reopened = listDeletedThreads(databasePath, PROJECT_A, {});
    expect(reopened.body).toEqual(first.body);
    expect(reopened.body.threads[0]).toMatchObject({
      deletedAt: NOW,
      id: threadId,
      messageCount: 1,
    });
  });

  it("rejects malformed list input with stable field markers", () => {
    const unknownKey = expectCode(
      () => listDeletedThreads(databasePath, PROJECT_A, { unknown: 1 }),
      "INVALID_INPUT",
    );
    expect(unknownKey.details.fields).toEqual({ unknown: "unknown" });

    for (const limit of [0, 101, 1.5, "2"]) {
      const error = expectCode(
        () => listDeletedThreads(databasePath, PROJECT_A, { limit }),
        "INVALID_INPUT",
      );
      expect(error.details.fields).toEqual({ limit: "invalid_range" });
    }

    const nonStringCursor = expectCode(
      () => listDeletedThreads(databasePath, PROJECT_A, { cursor: 123 }),
      "INVALID_INPUT",
    );
    expect(nonStringCursor.details.fields).toEqual({ cursor: "invalid_format" });

    for (const cursor of [
      "!!!",
      Buffer.from(JSON.stringify({ v: 1, d: "not-a-timestamp", id: "x" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 2, d: NOW, id: "x" }), "utf8").toString("base64url"),
    ]) {
      const error = expectCode(
        () => listDeletedThreads(databasePath, PROJECT_A, { cursor }),
        "INVALID_INPUT",
      );
      expect(error.details.fields).toEqual({ cursor: "invalid_format" });
    }

    const notObject = expectCode(
      () => listDeletedThreads(databasePath, PROJECT_A, null),
      "INVALID_INPUT",
    );
    expect(notObject.details.fields).toEqual({ input: "invalid_format" });
  });
});

describe("thread recycle bin route seam", () => {
  it("returns the bin through GET with no-store and the exact projection", async () => {
    const active = createSeededThread(PROJECT_A, "路由活跃线程");
    const gone = createSeededThread(PROJECT_A, "路由回收线程");
    writeMessage(PROJECT_A, gone, "被删线程的消息");
    deleteAt(PROJECT_A, gone, NOW);

    const response = await recycleBinRequest(PROJECT_A);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      nextCursor: string | null;
      threads: Array<{ id: string }>;
    };
    expect(body).toEqual({
      nextCursor: null,
      threads: [
        {
          attachmentCount: 0,
          deletedAt: NOW,
          id: gone,
          messageCount: 1,
          projectId: PROJECT_A,
          title: "路由回收线程",
        },
      ],
    });
    expect(body.threads.map(({ id }) => id)).not.toContain(active);
  });

  it("paginates through the route with cursor and limit query params", async () => {
    const threadIds = ["路由分页甲", "路由分页乙", "路由分页丙"].map((title) =>
      createSeededThread(PROJECT_A, title),
    );
    threadIds.forEach((threadId, index) => {
      deleteAt(PROJECT_A, threadId, [NOW, LATER, LATEST][index]!);
    });

    const firstPage = await recycleBinRequest(PROJECT_A, "?limit=2");
    expect(firstPage.status).toBe(200);
    const firstBody = (await firstPage.json()) as {
      nextCursor: string | null;
      threads: Array<{ id: string }>;
    };
    expect(firstBody.threads.map(({ id }) => id)).toEqual([
      threadIds[2],
      threadIds[1],
    ]);
    expect(firstBody.nextCursor).not.toBeNull();

    const secondPage = await recycleBinRequest(
      PROJECT_A,
      `?limit=2&cursor=${firstBody.nextCursor}`,
    );
    expect(secondPage.status).toBe(200);
    const secondBody = (await secondPage.json()) as {
      nextCursor: string | null;
      threads: Array<{ id: string }>;
    };
    expect(secondBody).toEqual({
      nextCursor: null,
      threads: [
        {
          attachmentCount: 0,
          deletedAt: NOW,
          id: threadIds[0],
          messageCount: 0,
          projectId: PROJECT_A,
          title: "路由分页甲",
        },
      ],
    });
  });

  it("rejects unknown, duplicated and fragment URL parts before touching storage", async () => {
    for (const suffix of [
      "?unknown=1",
      "?cursor=a&cursor=b",
      "?limit=1&limit=2",
      "#fragment",
    ]) {
      const response = await recycleBinRequest(PROJECT_A, suffix);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects malformed limit and cursor values with stable field markers", async () => {
    const expectations: Array<[string, Record<string, string>]> = [
      ["?limit=", { limit: "required" }],
      ["?limit=abc", { limit: "invalid_format" }],
      ["?limit=0", { limit: "invalid_range" }],
      ["?limit=101", { limit: "invalid_range" }],
      ["?cursor=", { cursor: "required" }],
      ["?cursor=!!!", { cursor: "invalid_format" }],
    ];
    for (const [suffix, fields] of expectations) {
      const response = await recycleBinRequest(PROJECT_A, suffix);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as {
        error: { code: string; fields?: Record<string, string> };
      };
      expect(body.error.code).toBe("INVALID_INPUT");
      expect(body.error.fields).toEqual(fields);
    }
  });

  it("rejects malformed path ids before touching storage", async () => {
    for (const projectId of ["..", "a%2Fb"]) {
      const response = await recycleBinRequest(projectId);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_INPUT");
    }
  });

  it("maps a missing project to a sanitized 404 and keeps bins isolated per project", async () => {
    const foreign = createSeededThread(PROJECT_A, "他项目路由回收");
    deleteAt(PROJECT_A, foreign, NOW);

    const missing = await recycleBinRequest("missing-project");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    const missingBody = (await missing.json()) as { error: { code: string } };
    expect(missingBody.error.code).toBe("PROJECT_NOT_FOUND");
    expect(JSON.stringify(missingBody)).not.toContain(databasePath);

    const crossProject = await recycleBinRequest(PROJECT_B);
    expect(crossProject.status).toBe(200);
    expect(await crossProject.json()).toEqual({ nextCursor: null, threads: [] });
  });
});
