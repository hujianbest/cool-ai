import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { searchProjectThreads } from "@/src/adapters/outbound/sqlite/operations-projection/thread-search-queries";
import {
  readAttachmentContent,
  removeAttachment,
  uploadAttachment,
} from "@/src/adapters/outbound/sqlite/public-collaboration/attachment-service";
import {
  decideInline,
  readInlineOperation,
} from "@/src/adapters/outbound/sqlite/public-collaboration/inline-decision-service";
import { searchInputHistory } from "@/src/adapters/outbound/sqlite/public-collaboration/input-history-service";
import {
  answerThreadDecision,
  controlThreadRun,
} from "@/src/adapters/outbound/sqlite/public-collaboration/run-service";
import { readRunTimeline } from "@/src/adapters/outbound/sqlite/public-collaboration/run-timeline-service";
import {
  clearThreadDraft,
  readThreadDraft,
  saveThreadDraft,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-draft-service";
import { setThreadFavorite } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-favorite-service";
import {
  createThread,
  listThreads,
  readThreadDetail,
  readThreadFacts,
  readThreadMessages,
  readThreadOperation,
  startThreadRun,
  updateThreadPolicy,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import {
  applyThreadTagBatch,
  createThreadTag,
  listProjectTags,
  setThreadTagAssignment,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-tag-service";
import {
  CollaborationError,
  collaborationErrorBody,
} from "@/src/modules/public-collaboration";
import { seedSearchCollaborationGraph } from "@/tests/fixtures/collaboration/search-graph";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-11T08:00:00.000Z";
const DELETED_AT = "2026-08-11T09:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 23).toString("base64url");
const PROJECT_A = "recycle-exclusion-project-a";
const PROJECT_B = "recycle-exclusion-project-b";
const PROVIDER = "recycle-exclusion-provider";
const AGENTS: [string, string] = [
  "recycle-exclusion-agent-a",
  "recycle-exclusion-agent-b",
];
const KEYWORD = "北极星";
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04,
]);

let databasePath: string;
let attachmentsRoot: string;
let operationSequence = 0;
let threadA: string;
let threadB: string;
let tagId: string;
let messageBOperationId: string;

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function writeMessage(projectId: string, threadId: string, content: string): string {
  const written = writeOwnerThreadMessage(databasePath, projectId, threadId, {
    content,
    operationId: operationId(),
  });
  expect(written.status).toBe(201);
  return written.body.message.id;
}

function softDeleteThread(projectId: string, threadId: string): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `UPDATE collaboration_threads SET deleted_at=?
         WHERE project_id=? AND id=?`,
      )
      .run(DELETED_AT, projectId, threadId);
  } finally {
    database.close();
  }
}

function expectThreadDeleted(operation: () => unknown): CollaborationError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    const collaborationError = error as CollaborationError;
    expect(collaborationError.code).toBe("RESOURCE_NOT_FOUND");
    expect(collaborationError.httpStatus).toBe(404);
    expect(collaborationError.details.reason).toBe("thread_deleted");
    return collaborationError;
  }
  throw new Error("Expected RESOURCE_NOT_FOUND with reason thread_deleted");
}

function expectPlainNotFound(operation: () => unknown): CollaborationError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    const collaborationError = error as CollaborationError;
    expect(collaborationError.code).toBe("RESOURCE_NOT_FOUND");
    expect(collaborationError.details.reason).toBeUndefined();
    return collaborationError;
  }
  throw new Error("Expected plain RESOURCE_NOT_FOUND");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  databasePath = memoryDatabasePath();
  attachmentsRoot = mkdtempSync(join(tmpdir(), "recycle-exclusion-attachments-"));
  operationSequence = 0;
  const database = openDatabase(databasePath);
  try {
    seedSearchCollaborationGraph(database, {
      agentIds: AGENTS,
      now: NOW,
      projectIds: [PROJECT_A, PROJECT_B],
      providerId: PROVIDER,
    });
  } finally {
    database.close();
  }
  threadA = createThread(databasePath, PROJECT_A, {
    memberAgentIds: [...AGENTS],
    operationId: operationId(),
    title: "活跃线程 Alpha",
  }).body.thread.id;
  threadB = createThread(databasePath, PROJECT_A, {
    memberAgentIds: [...AGENTS],
    operationId: operationId(),
    title: `${KEYWORD} Beta 线程`,
  }).body.thread.id;
  writeMessage(PROJECT_A, threadA, `${KEYWORD} 正文 Alpha`);
  messageBOperationId = operationId();
  const writtenB = writeOwnerThreadMessage(databasePath, PROJECT_A, threadB, {
    content: `${KEYWORD} 正文 Beta`,
    operationId: messageBOperationId,
  });
  expect(writtenB.status).toBe(201);
  for (const threadId of [threadA, threadB]) {
    setThreadFavorite(databasePath, PROJECT_A, threadId, { favorite: true });
  }
  tagId = createThreadTag(databasePath, PROJECT_A, { name: "发布" }).body.tag.id;
  for (const threadId of [threadA, threadB]) {
    setThreadTagAssignment(databasePath, PROJECT_A, threadId, {
      assigned: true,
      tagId,
    });
  }
  saveThreadDraft(databasePath, PROJECT_A, threadB, {
    attachments: [],
    content: "回收线程草稿",
    replyToMessageId: null,
  });
});

afterEach(() => {
  rmSync(attachmentsRoot, { force: true, recursive: true });
  delete process.env.COCKPIT_MASTER_KEY;
  vi.useRealTimers();
});

describe("deleted thread exclusion matrix", () => {
  it("listThreads excludes the deleted thread in the default, favorites and tag variants", () => {
    softDeleteThread(PROJECT_A, threadB);
    const listed = listThreads(databasePath, PROJECT_A, {});
    const ids = listed.body.threads.map((thread) => thread.id);
    expect(ids).toContain(threadA);
    expect(ids).not.toContain(threadB);
    const favorites = listThreads(databasePath, PROJECT_A, {
      favoritesOnly: true,
    });
    expect(favorites.body.threads.map((thread) => thread.id)).not.toContain(threadB);
    const tagged = listThreads(databasePath, PROJECT_A, { tagId });
    expect(tagged.body.threads.map((thread) => thread.id)).not.toContain(threadB);
  });

  it("searchProjectThreads excludes deleted-thread title and message hits", () => {
    softDeleteThread(PROJECT_A, threadB);
    const page = searchProjectThreads(databasePath, PROJECT_A, {
      query: KEYWORD,
    });
    expect(page.results.length).toBeGreaterThan(0);
    expect(page.results.some((hit) => hit.threadId === threadA)).toBe(true);
    expect(page.results.every((hit) => hit.threadId !== threadB)).toBe(true);
  });

  it("searchInputHistory excludes deleted-thread entries", () => {
    softDeleteThread(PROJECT_A, threadB);
    const result = searchInputHistory(databasePath, PROJECT_A, KEYWORD);
    expect(result.body.entries.length).toBeGreaterThan(0);
    expect(result.body.entries.some((entry) => entry.threadId === threadA)).toBe(true);
    expect(result.body.entries.every((entry) => entry.threadId !== threadB)).toBe(true);
  });

  it("listProjectTags counts only active threads", () => {
    softDeleteThread(PROJECT_A, threadB);
    const result = listProjectTags(databasePath, PROJECT_A, {});
    const tag = result.body.tags.find((row) => row.id === tagId);
    expect(tag?.threadCount).toBe(1);
  });

  it("read seams reject a deleted thread with the thread_deleted reason", () => {
    softDeleteThread(PROJECT_A, threadB);
    const error = expectThreadDeleted(() =>
      readThreadDetail(databasePath, PROJECT_A, threadB, null),
    );
    expect(collaborationErrorBody(error).error.reason).toBe("thread_deleted");
    expectThreadDeleted(() => readThreadMessages(databasePath, PROJECT_A, threadB, {}));
    expectThreadDeleted(() => readThreadFacts(databasePath, PROJECT_A, threadB, {}));
    expectThreadDeleted(() =>
      readThreadOperation(databasePath, PROJECT_A, threadB, messageBOperationId),
    );
    expectThreadDeleted(() => readThreadDraft(databasePath, PROJECT_A, threadB));
    expectThreadDeleted(() =>
      readAttachmentContent(databasePath, attachmentsRoot, PROJECT_A, threadB, "att-x"),
    );
  });

  it("write commands reject a deleted thread with the thread_deleted reason", () => {
    softDeleteThread(PROJECT_A, threadB);
    expectThreadDeleted(() =>
      updateThreadPolicy(databasePath, PROJECT_A, threadB, {
        expectedVersion: 1,
        memberAgentIds: [...AGENTS],
        operationId: operationId(),
      }),
    );
    expectThreadDeleted(() =>
      writeOwnerThreadMessage(databasePath, PROJECT_A, threadB, {
        content: "泄漏检查",
        operationId: operationId(),
      }),
    );
    expectThreadDeleted(() =>
      startThreadRun(databasePath, PROJECT_A, threadB, {
        message: "泄漏检查",
        operationId: operationId(),
      }),
    );
  });

  it("preference and tag commands reject a deleted thread with the thread_deleted reason", () => {
    softDeleteThread(PROJECT_A, threadB);
    expectThreadDeleted(() =>
      setThreadFavorite(databasePath, PROJECT_A, threadB, { favorite: false }),
    );
    expectThreadDeleted(() =>
      setThreadTagAssignment(databasePath, PROJECT_A, threadB, {
        assigned: false,
        tagId,
      }),
    );
    expectPlainNotFound(() =>
      applyThreadTagBatch(databasePath, PROJECT_A, {
        addTagIds: [],
        operationId: operationId(),
        removeTagIds: [tagId],
        threadIds: [threadB],
      }),
    );
  });

  it("draft commands reject a deleted thread with the thread_deleted reason", () => {
    softDeleteThread(PROJECT_A, threadB);
    expectThreadDeleted(() =>
      saveThreadDraft(databasePath, PROJECT_A, threadB, {
        attachments: [],
        content: "重写草稿",
        replyToMessageId: null,
      }),
    );
    expectThreadDeleted(() => clearThreadDraft(databasePath, PROJECT_A, threadB));
  });

  it("attachment commands reject a deleted thread with the thread_deleted reason", () => {
    softDeleteThread(PROJECT_A, threadB);
    expectThreadDeleted(() =>
      uploadAttachment(databasePath, attachmentsRoot, PROJECT_A, threadB, {
        bytes: PNG_BYTES,
        fileName: "pixel.png",
      }),
    );
    expectThreadDeleted(() =>
      removeAttachment(databasePath, attachmentsRoot, PROJECT_A, threadB, "att-x"),
    );
  });

  it("run seams reject a deleted thread with the thread_deleted reason", () => {
    const runId = startThreadRun(databasePath, PROJECT_A, threadB, {
      message: "启动运行",
      operationId: operationId(),
    }).body.run.id;
    softDeleteThread(PROJECT_A, threadB);
    expectThreadDeleted(() =>
      controlThreadRun(databasePath, PROJECT_A, threadB, runId, {
        action: "pause",
        expectedVersion: 1,
        operationId: operationId(),
      }),
    );
    expectThreadDeleted(() =>
      answerThreadDecision(databasePath, PROJECT_A, threadB, runId, "decision-x", {
        answer: "Yes",
        expectedVersion: 1,
        operationId: operationId(),
      }),
    );
    expectThreadDeleted(() =>
      readRunTimeline(databasePath, PROJECT_A, threadB, runId, {
        after: 0,
        limit: 10,
      }),
    );
  });

  it("inline decision seams reject a deleted thread with the thread_deleted reason", () => {
    const runId = startThreadRun(databasePath, PROJECT_A, threadB, {
      message: "启动运行",
      operationId: operationId(),
    }).body.run.id;
    softDeleteThread(PROJECT_A, threadB);
    expectThreadDeleted(() =>
      decideInline(
        databasePath,
        {
          blockId: "block-x",
          messageId: "message-x",
          projectId: PROJECT_A,
          runId,
          threadId: threadB,
        },
        JSON.stringify({
          action: "accept",
          expectedStateVersion: 1,
          operationId: operationId(),
        }),
      ),
    );
    expectThreadDeleted(() =>
      readInlineOperation(
        databasePath,
        { projectId: PROJECT_A, runId, threadId: threadB },
        messageBOperationId,
      ),
    );
  });

  it("keeps the plain unmarked 404 for cross-tuple and missing threads", () => {
    softDeleteThread(PROJECT_A, threadB);
    expectPlainNotFound(() =>
      readThreadDetail(databasePath, PROJECT_B, threadA, null),
    );
    expectPlainNotFound(() =>
      readThreadMessages(databasePath, PROJECT_B, threadA, {}),
    );
    expectPlainNotFound(() =>
      setThreadFavorite(databasePath, PROJECT_B, threadA, { favorite: true }),
    );
    expectPlainNotFound(() =>
      readThreadDetail(databasePath, PROJECT_A, "missing-thread", null),
    );
  });

  it("keeps active-thread seams working after another thread is deleted", () => {
    softDeleteThread(PROJECT_A, threadB);
    const detail = readThreadDetail(databasePath, PROJECT_A, threadA, null);
    expect(detail.status).toBe(200);
    expect(detail.body.thread.id).toBe(threadA);
    const messages = readThreadMessages(databasePath, PROJECT_A, threadA, {});
    expect(messages.status).toBe(200);
    const draft = saveThreadDraft(databasePath, PROJECT_A, threadA, {
      attachments: [],
      content: "活跃线程草稿",
      replyToMessageId: null,
    });
    expect(draft.status).toBe(200);
    const favorite = setThreadFavorite(databasePath, PROJECT_A, threadA, {
      favorite: false,
    });
    expect(favorite.status).toBe(200);
  });
});
