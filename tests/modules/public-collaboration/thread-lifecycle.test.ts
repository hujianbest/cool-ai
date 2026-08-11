import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { uploadAttachment } from "@/src/adapters/outbound/sqlite/public-collaboration/attachment-service";
import { searchProjectThreads } from "@/src/adapters/outbound/sqlite/operations-projection/thread-search-queries";
import {
  readThreadDraft,
  saveThreadDraft,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-draft-service";
import { setThreadFavorite } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-favorite-service";
import {
  deleteThread,
  purgeThread,
  restoreThread,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-lifecycle-service";
import {
  createThread,
  listThreads,
  readThreadDetail,
  startThreadRun,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import {
  createThreadTag,
  setThreadTagAssignment,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-tag-service";
import { CollaborationError } from "@/src/modules/public-collaboration";
import { seedSearchCollaborationGraph } from "@/tests/fixtures/collaboration/search-graph";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type ThreadRoute = {
  DELETE(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

type RestoreRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

type PurgeRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

const threadRoutes = import.meta.glob<ThreadRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/route.ts",
);
const restoreRoutes = import.meta.glob<RestoreRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/restore/route.ts",
);
const purgeRoutes = import.meta.glob<PurgeRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/purge/route.ts",
);

async function threadRoute(): Promise<ThreadRoute> {
  const load =
    threadRoutes["../../../app/api/projects/[projectId]/threads/[threadId]/route.ts"];
  expect(load, "thread route must exist").toBeTypeOf("function");
  const route = await load!();
  expect(route.DELETE, "thread DELETE handler must exist").toBeTypeOf("function");
  return route;
}

async function restoreRoute(): Promise<RestoreRoute> {
  const load =
    restoreRoutes[
      "../../../app/api/projects/[projectId]/threads/[threadId]/restore/route.ts"
    ];
  expect(load, "thread restore route must exist").toBeTypeOf("function");
  const route = await load!();
  expect(route.POST, "thread restore POST handler must exist").toBeTypeOf("function");
  return route;
}

async function purgeRoute(): Promise<PurgeRoute> {
  const load =
    purgeRoutes["../../../app/api/projects/[projectId]/threads/[threadId]/purge/route.ts"];
  expect(load, "thread purge route must exist").toBeTypeOf("function");
  const route = await load!();
  expect(route.POST, "thread purge POST handler must exist").toBeTypeOf("function");
  return route;
}

async function deleteThreadRequest(
  projectId: string,
  threadId: string,
  urlSuffix = "",
): Promise<Response> {
  return (await threadRoute()).DELETE(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}${urlSuffix}`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

async function restoreThreadRequest(
  projectId: string,
  threadId: string,
  body: BodyInit | null = "{}",
  contentType: string | null = "application/json",
  urlSuffix = "",
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (contentType !== null) headers["content-type"] = contentType;
  return (await restoreRoute()).POST(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/restore${urlSuffix}`,
      { body, headers, method: "POST" },
    ),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

async function purgeThreadRequest(
  projectId: string,
  threadId: string,
  body: BodyInit | null = "{}",
  contentType: string | null = "application/json",
  urlSuffix = "",
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (contentType !== null) headers["content-type"] = contentType;
  return (await purgeRoute()).POST(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/purge${urlSuffix}`,
      { body, headers, method: "POST" },
    ),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

const NOW = "2026-08-11T08:00:00.000Z";
const LATER = "2026-08-11T09:30:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 31).toString("base64url");
const PROJECT_A = "lifecycle-project-a";
const PROJECT_B = "lifecycle-project-b";
const PROVIDER = "lifecycle-provider";
const AGENTS: [string, string] = ["lifecycle-agent-a", "lifecycle-agent-b"];
const NON_TERMINAL_RUN_STATUSES = ["running", "waiting_owner", "paused", "planned"] as const;
const TERMINAL_RUN_STATUSES = ["failed", "stopped"] as const;
const GUARD_PROJECTS = [...NON_TERMINAL_RUN_STATUSES, ...TERMINAL_RUN_STATUSES].map(
  (status) => `${PROJECT_A}-guard-${status}`,
);
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const SECOND_PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x01, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

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

type OutboxRow = {
  eventType: string;
  id: string;
  occurredAt: string;
  payloadJson: string;
  projectId: string;
  seq: number;
  source: string;
};

function outboxRows(eventType: string): OutboxRow[] {
  const reader = openDatabase(databasePath);
  try {
    return reader
      .prepare(
        `SELECT id,project_id AS projectId,source,event_type AS eventType,
                payload_json AS payloadJson,occurred_at AS occurredAt,outbox_seq AS seq
         FROM audit_event_outbox WHERE event_type=? ORDER BY outbox_seq`,
      )
      .all(eventType) as OutboxRow[];
  } finally {
    reader.close();
  }
}

type StoredThreadRow = {
  deletedAt: string | null;
  lastActivitySequence: number;
  title: string;
  updatedAt: string;
  version: number;
};

function storedThread(projectId: string, threadId: string): StoredThreadRow | undefined {
  const reader = openDatabase(databasePath);
  try {
    return reader
      .prepare(
        `SELECT title,deleted_at AS deletedAt,updated_at AS updatedAt,version,
                last_activity_sequence AS lastActivitySequence
         FROM collaboration_threads WHERE project_id=? AND id=?`,
      )
      .get(projectId, threadId) as StoredThreadRow | undefined;
  } finally {
    reader.close();
  }
}

function setRunStatus(
  projectId: string,
  threadId: string,
  runId: string,
  status: string,
): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `UPDATE collaboration_runs SET status=?
         WHERE project_id=? AND thread_id=? AND id=?`,
      )
      .run(status, projectId, threadId, runId);
  } finally {
    database.close();
  }
}

function attachmentPath(projectId: string, attachmentId: string): string {
  return join(attachmentsRoot, projectId, attachmentId);
}

function addMessage(
  projectId: string,
  threadId: string,
  content: string,
  attachmentIds: string[] = [],
): void {
  writeOwnerThreadMessage(databasePath, projectId, threadId, {
    attachmentIds,
    content,
    operationId: operationId(),
    recordInputHistory: true,
  });
}

function insertExecutionReference(projectId: string, threadId: string, runId: string): void {
  const database = openDatabase(databasePath);
  try {
    const missionRow = database.prepare(
      "SELECT id FROM missions WHERE project_id=? ORDER BY id LIMIT 1",
    ).get(projectId) as { id: string } | undefined;
    const missionId = missionRow?.id ?? `mission-${projectId}`;
    if (!missionRow) {
      database.prepare(
        `INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
         VALUES (?,?,?,?,1,?,?)`,
      ).run(missionId, projectId, "Execution Mission", "Execution Goal", NOW, NOW);
    }
    const workItemRow = database.prepare(
      "SELECT id FROM work_items WHERE mission_id=? ORDER BY id LIMIT 1",
    ).get(missionId) as { id: string } | undefined;
    const workItemId = workItemRow?.id ?? `work-item-${projectId}`;
    if (!workItemRow) {
      database.prepare(
        `INSERT INTO work_items(
           id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
         ) VALUES (?,?,?,?, 'todo',NULL,1,?,?)`,
      ).run(workItemId, missionId, "Execution Work Item", "Execution Work Item", NOW, NOW);
    }
    const agentRow = database.prepare(
      "SELECT agent_id AS id FROM project_memberships WHERE project_id=? ORDER BY agent_id LIMIT 1",
    ).get(projectId) as { id: string } | undefined;
    let policyRow = database.prepare(
      `SELECT active_revision_id AS id
       FROM project_validation_policies
       WHERE project_id=?`,
    ).get(projectId) as { id: string } | undefined;
    if (!policyRow) {
      const revisionId = `policy-revision-${projectId}`;
      database.prepare(
        `INSERT INTO project_validation_policy_revisions(
           id,project_id,created_operation_id,created_actor_type,revision_no,
           policy_hash,classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
         ) VALUES (?,?,NULL,'system',1,?,1,0,2,0,?)`,
      ).run(revisionId, projectId, "a".repeat(64), NOW);
      database.prepare(
        `INSERT INTO project_validation_policies(
           project_id,active_revision_id,version,updated_at
         ) VALUES (?,?,1,?)`,
      ).run(projectId, revisionId, NOW);
      policyRow = { id: revisionId };
    }
    expect(agentRow && policyRow).toBeTruthy();
    database.prepare(`
      INSERT INTO executions(
        id,project_id,source_collaboration_thread_id,source_collaboration_run_id,
        mission_id,work_item_id,agent_id,current_policy_revision_id,status,
        resume_target,reason_code,manual_recovery_required,recovery_resolution,
        current_attempt_no,business_round_count,tool_call_count,next_event_sequence,
        version,created_at,business_deadline_at,first_running_at,updated_at,merged_at
      ) VALUES (
        ?,?,?,?,?,?,?,?,'stopped',
        NULL,NULL,0,NULL,
        1,0,0,1,
        1,?,NULL,NULL,?,NULL
      )
    `).run(
      `execution-${operationId()}`,
      projectId,
      threadId,
      runId,
      missionId,
      workItemId,
      agentRow!.id,
      policyRow!.id,
      NOW,
      NOW,
    );
  } finally {
    database.close();
  }
}

function rewriteThreadTitle(projectId: string, threadId: string, title: string): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare("UPDATE collaboration_threads SET title=? WHERE project_id=? AND id=?")
      .run(title, projectId, threadId);
  } finally {
    database.close();
  }
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
  attachmentsRoot = mkdtempSync(join(tmpdir(), "thread-purge-attachments-"));
  temporaryDirectories.push(attachmentsRoot);
  operationSequence = 0;
  const database = openDatabase(databasePath);
  try {
    seedSearchCollaborationGraph(database, {
      agentIds: AGENTS,
      now: NOW,
      projectIds: [PROJECT_A, PROJECT_B, ...GUARD_PROJECTS],
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

describe("thread delete command seam", () => {
  it("soft-deletes a thread in one transaction and appends a sanitized thread_deleted audit event", () => {
    const threadId = createSeededThread(PROJECT_A, "回收站甲");
    expect(storedThread(PROJECT_A, threadId)).toMatchObject({
      deletedAt: null,
      version: 1,
    });

    const result = deleteThread(databasePath, PROJECT_A, threadId);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ deleted: true, deletedAt: NOW, threadId });
    expect(storedThread(PROJECT_A, threadId)).toMatchObject({
      deletedAt: NOW,
      updatedAt: NOW,
      version: 2,
    });
    // The deleted thread disappears from the existing seams (T-01 exclusion).
    expect(
      listThreads(databasePath, PROJECT_A, {}).body.threads.map(({ id }) => id),
    ).not.toContain(threadId);
    expectCode(
      () => readThreadDetail(databasePath, PROJECT_A, threadId, null),
      "RESOURCE_NOT_FOUND",
    );

    const rows = outboxRows("thread_deleted");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      occurredAt: NOW,
      projectId: PROJECT_A,
      seq: 1,
      source: "public_collaboration",
    });
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      occurredAt: NOW,
      runId: null,
      threadId,
      title: "回收站甲",
      type: "thread_deleted",
    });
  });

  it("freezes the first delete timestamp and writes no second audit event on repeat", () => {
    const threadId = createSeededThread(PROJECT_A, "幂等删除");
    const first = deleteThread(databasePath, PROJECT_A, threadId);
    expect(first.body).toEqual({ deleted: true, deletedAt: NOW, threadId });

    vi.setSystemTime(new Date(LATER));
    const second = deleteThread(databasePath, PROJECT_A, threadId);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ deleted: false, deletedAt: NOW, threadId });

    expect(storedThread(PROJECT_A, threadId)).toMatchObject({
      deletedAt: NOW,
      updatedAt: NOW,
      version: 2,
    });
    expect(outboxRows("thread_deleted")).toHaveLength(1);
  });

  it.each(NON_TERMINAL_RUN_STATUSES)(
    "rejects deletion with 409 while a %s run exists",
    (status) => {
      const projectId = `${PROJECT_A}-guard-${status}`;
      const threadId = createSeededThread(projectId, "运行守卫线程");
      const runId = startThreadRun(databasePath, projectId, threadId, {
        message: "启动被守卫的运行",
        operationId: operationId(),
      }).body.run.id;
      setRunStatus(projectId, threadId, runId, status);

      const error = expectCode(
        () => deleteThread(databasePath, projectId, threadId),
        "OPERATION_CONFLICT",
      );
      expect(error.httpStatus).toBe(409);
      expect(error.details.fields).toEqual({ threadId: "has_active_run" });
      expect(storedThread(projectId, threadId)?.deletedAt).toBeNull();
      expect(outboxRows("thread_deleted")).toEqual([]);
    },
  );

  it.each(TERMINAL_RUN_STATUSES)(
    "allows deletion when the thread's runs are terminal (%s)",
    (status) => {
      const projectId = `${PROJECT_A}-guard-${status}`;
      const threadId = createSeededThread(projectId, "终态运行线程");
      const runId = startThreadRun(databasePath, projectId, threadId, {
        message: "启动将终止的运行",
        operationId: operationId(),
      }).body.run.id;
      setRunStatus(projectId, threadId, runId, status);

      const result = deleteThread(databasePath, projectId, threadId);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ deleted: true, deletedAt: NOW, threadId });
      expect(outboxRows("thread_deleted")).toHaveLength(1);
    },
  );

  it("returns a plain unmarked 404 for cross-tuple and missing threads and writes nothing", () => {
    const threadId = createSeededThread(PROJECT_A, "隔离线程");
    for (const [projectId, targetId] of [
      [PROJECT_B, threadId],
      [PROJECT_A, "missing-thread"],
      ["missing-project", threadId],
    ] as const) {
      const error = expectCode(
        () => deleteThread(databasePath, projectId, targetId),
        "RESOURCE_NOT_FOUND",
      );
      expect(error.httpStatus).toBe(404);
      expect(error.details.reason).toBeUndefined();
    }
    expect(storedThread(PROJECT_A, threadId)?.deletedAt).toBeNull();
    expect(outboxRows("thread_deleted")).toEqual([]);
  });

  it("withholds a credential-bearing title from the audit payload", () => {
    const threadId = createSeededThread(PROJECT_A, "密钥 provider-key 不可入审计");
    const result = deleteThread(databasePath, PROJECT_A, threadId);
    expect(result.status).toBe(200);

    const rows = outboxRows("thread_deleted");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.title).toBe("[redacted]");
    expect(rows[0]!.payloadJson).not.toContain("provider-key");
  });

  it("truncates the audit title excerpt at 200 graphemes", () => {
    const threadId = createSeededThread(PROJECT_A, "长标题线程");
    rewriteThreadTitle(PROJECT_A, threadId, "标".repeat(250));
    const result = deleteThread(databasePath, PROJECT_A, threadId);
    expect(result.status).toBe(200);

    const rows = outboxRows("thread_deleted");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as { title: string };
    expect([...payload.title]).toHaveLength(201);
    expect(payload.title.startsWith("标".repeat(200))).toBe(true);
    expect(payload.title.endsWith("…")).toBe(true);
  });
});

describe("thread restore command seam", () => {
  it("restores a deleted thread in one transaction and appends thread_restored", () => {
    const threadId = createSeededThread(PROJECT_A, "待恢复线程");
    deleteThread(databasePath, PROJECT_A, threadId);
    const deletedSnapshot = storedThread(PROJECT_A, threadId);
    expect(deletedSnapshot).toBeDefined();
    const frozenUpdatedAt = deletedSnapshot?.updatedAt ?? NOW;
    vi.setSystemTime(new Date(LATER));

    const result = restoreThread(databasePath, PROJECT_A, threadId);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ restored: true, threadId });
    expect(storedThread(PROJECT_A, threadId)).toMatchObject({
      deletedAt: null,
      updatedAt: frozenUpdatedAt,
      version: 3,
    });
    // The thread is visible on the existing seams again.
    expect(
      listThreads(databasePath, PROJECT_A, {}).body.threads.map(({ id }) => id),
    ).toContain(threadId);
    expect(
      readThreadDetail(databasePath, PROJECT_A, threadId, null).body.thread.id,
    ).toBe(threadId);

    const rows = outboxRows("thread_restored");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      occurredAt: LATER,
      projectId: PROJECT_A,
      seq: 2,
      source: "public_collaboration",
    });
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      occurredAt: LATER,
      runId: null,
      threadId,
      title: "待恢复线程",
      type: "thread_restored",
    });
  });

  it("is idempotent on an active thread with no state change or audit event", () => {
    const threadId = createSeededThread(PROJECT_A, "活跃线程");

    const result = restoreThread(databasePath, PROJECT_A, threadId);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ restored: false, threadId });
    expect(storedThread(PROJECT_A, threadId)).toMatchObject({
      deletedAt: null,
      updatedAt: NOW,
      version: 1,
    });
    expect(outboxRows("thread_restored")).toEqual([]);
  });

  it("returns a plain unmarked 404 for cross-tuple and missing threads and writes nothing", () => {
    const threadId = createSeededThread(PROJECT_A, "隔离恢复");
    deleteThread(databasePath, PROJECT_A, threadId);
    for (const [projectId, targetId] of [
      [PROJECT_B, threadId],
      [PROJECT_A, "missing-thread"],
      ["missing-project", threadId],
    ] as const) {
      const error = expectCode(
        () => restoreThread(databasePath, projectId, targetId),
        "RESOURCE_NOT_FOUND",
      );
      expect(error.httpStatus).toBe(404);
      expect(error.details.reason).toBeUndefined();
    }
    expect(storedThread(PROJECT_A, threadId)?.deletedAt).toBe(NOW);
    expect(outboxRows("thread_restored")).toEqual([]);
  });

  it("restores the list order position and favorite/tag/draft organization facts", () => {
    const first = createSeededThread(PROJECT_A, "排序甲");
    const second = createSeededThread(PROJECT_A, "排序乙");
    const third = createSeededThread(PROJECT_A, "排序丙");
    setThreadFavorite(databasePath, PROJECT_A, second, { favorite: true });
    const tagId = createThreadTag(databasePath, PROJECT_A, { name: "回收标签" })
      .body.tag.id;
    setThreadTagAssignment(databasePath, PROJECT_A, second, {
      assigned: true,
      tagId,
    });
    saveThreadDraft(databasePath, PROJECT_A, second, {
      attachments: [],
      content: "未发出的草稿",
      replyToMessageId: null,
    });
    const orderBefore = listThreads(databasePath, PROJECT_A, {}).body.threads.map(
      ({ id }) => id,
    );
    expect(orderBefore).toEqual([third, second, first]);

    deleteThread(databasePath, PROJECT_A, second);
    expect(
      listThreads(databasePath, PROJECT_A, {}).body.threads.map(({ id }) => id),
    ).toEqual([third, first]);

    const result = restoreThread(databasePath, PROJECT_A, second);
    expect(result.body).toEqual({ restored: true, threadId: second });

    expect(
      listThreads(databasePath, PROJECT_A, {}).body.threads.map(({ id }) => id),
    ).toEqual(orderBefore);
    expect(
      listThreads(databasePath, PROJECT_A, { favoritesOnly: true }).body.threads.map(
        ({ id }) => id,
      ),
    ).toEqual([second]);
    expect(
      listThreads(databasePath, PROJECT_A, { tagId }).body.threads.map(({ id }) => id),
    ).toEqual([second]);
    expect(readThreadDraft(databasePath, PROJECT_A, second).body.draft?.content).toBe(
      "未发出的草稿",
    );
  });
});

describe("thread delete route seam", () => {
  it("soft-deletes through DELETE with no-store and replays the same body idempotently", async () => {
    const threadId = createSeededThread(PROJECT_A, "路由删除");

    const response = await deleteThreadRequest(PROJECT_A, threadId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      deleted: true,
      deletedAt: NOW,
      threadId,
    });

    vi.setSystemTime(new Date(LATER));
    const repeat = await deleteThreadRequest(PROJECT_A, threadId);
    expect(repeat.status).toBe(200);
    expect(repeat.headers.get("cache-control")).toBe("no-store");
    expect(await repeat.json()).toEqual({
      deleted: false,
      deletedAt: NOW,
      threadId,
    });
    expect(outboxRows("thread_deleted")).toHaveLength(1);
  });

  it("rejects query, fragment and malformed path ids before touching storage", async () => {
    const threadId = createSeededThread(PROJECT_A, "严格校验删除");
    for (const suffix of ["?unknown=1", "#fragment"]) {
      const response = await deleteThreadRequest(PROJECT_A, threadId, suffix);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_INPUT");
    }
    for (const [projectId, targetId] of [
      ["..", threadId],
      [PROJECT_A, ".."],
      [PROJECT_A, "a%2Fb"],
    ] as const) {
      const response = await deleteThreadRequest(projectId, targetId);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_INPUT");
    }
    expect(storedThread(PROJECT_A, threadId)?.deletedAt).toBeNull();
    expect(outboxRows("thread_deleted")).toEqual([]);
  });

  it("maps the run guard to 409 and cross-tuple targets to a sanitized unmarked 404", async () => {
    const guardedThread = createSeededThread(PROJECT_A, "路由守卫");
    startThreadRun(databasePath, PROJECT_A, guardedThread, {
      message: "占住运行",
      operationId: operationId(),
    });

    const conflict = await deleteThreadRequest(PROJECT_A, guardedThread);
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("cache-control")).toBe("no-store");
    const conflictBody = (await conflict.json()) as {
      error: { code: string; fields?: Record<string, string> };
    };
    expect(conflictBody.error.code).toBe("OPERATION_CONFLICT");
    expect(conflictBody.error.fields).toEqual({ threadId: "has_active_run" });
    expect(JSON.stringify(conflictBody)).not.toContain(databasePath);

    const foreignThread = createSeededThread(PROJECT_B, "他项目线程");
    for (const [projectId, targetId] of [
      [PROJECT_A, foreignThread],
      ["missing-project", guardedThread],
      [PROJECT_A, "missing-thread"],
    ] as const) {
      const response = await deleteThreadRequest(projectId, targetId);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as {
        error: { code: string; reason?: string };
      };
      expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
      expect(body.error.reason).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(databasePath);
    }
  });
});

describe("thread restore route seam", () => {
  it("restores through POST with a strict empty JSON body and no-store", async () => {
    const threadId = createSeededThread(PROJECT_A, "路由恢复");
    await deleteThreadRequest(PROJECT_A, threadId);

    const response = await restoreThreadRequest(PROJECT_A, threadId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ restored: true, threadId });

    const repeat = await restoreThreadRequest(PROJECT_A, threadId);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ restored: false, threadId });
    expect(outboxRows("thread_restored")).toHaveLength(1);
  });

  it("rejects non-empty or malformed bodies, wrong media type and url suffixes", async () => {
    const threadId = createSeededThread(PROJECT_A, "严格校验恢复");
    await deleteThreadRequest(PROJECT_A, threadId);

    const invalidBodies: Array<[BodyInit | null, string | null]> = [
      [JSON.stringify({ extra: 1 }), "application/json"],
      ["[]", "application/json"],
      ["null", "application/json"],
      ['"text"', "application/json"],
      ["{bad json", "application/json"],
      [null, null],
      ["{}", "text/plain"],
    ];
    for (const [body, contentType] of invalidBodies) {
      const response = await restoreThreadRequest(
        PROJECT_A,
        threadId,
        body,
        contentType,
      );
      expect([400, 415]).toContain(response.status);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    for (const suffix of ["?unknown=1", "#fragment"]) {
      const response = await restoreThreadRequest(
        PROJECT_A,
        threadId,
        "{}",
        "application/json",
        suffix,
      );
      expect(response.status).toBe(400);
    }
    // Nothing observed the rejected requests: the thread is still deleted and
    // no restore audit row exists.
    expect(storedThread(PROJECT_A, threadId)?.deletedAt).toBe(NOW);
    expect(outboxRows("thread_restored")).toEqual([]);
  });

  it("maps cross-tuple and missing targets to a sanitized unmarked 404", async () => {
    const foreignThread = createSeededThread(PROJECT_B, "他项目恢复");
    for (const [projectId, targetId] of [
      [PROJECT_A, foreignThread],
      ["missing-project", foreignThread],
      [PROJECT_A, "missing-thread"],
    ] as const) {
      const response = await restoreThreadRequest(projectId, targetId);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as {
        error: { code: string; reason?: string };
      };
      expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
      expect(body.error.reason).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(databasePath);
    }
    expect(outboxRows("thread_restored")).toEqual([]);
  });
});

describe("thread purge command seam", () => {
  it("rejects direct fact deletion without a purge marker (trigger gate)", () => {
    const threadId = createSeededThread(PROJECT_A, "触发器门");
    addMessage(PROJECT_A, threadId, "事实门检查");
    const database = openDatabase(databasePath);
    try {
      expect(() => {
        database.prepare(
          "DELETE FROM collaboration_thread_facts WHERE project_id=? AND thread_id=?",
        ).run(PROJECT_A, threadId);
      }).toThrowError(/IMMUTABLE_THREAD_FACT/);
    } finally {
      database.close();
    }
  });

  it("purges a deleted thread atomically, unlinks attachment bytes and leaves zero residual rows", () => {
    const threadId = createSeededThread(PROJECT_A, "可永久删除");
    const linkedAttachmentId = uploadAttachment(
      databasePath,
      attachmentsRoot,
      PROJECT_A,
      threadId,
      { bytes: PNG_BYTES, fileName: "linked.png" },
    ).body.attachment.id;
    addMessage(PROJECT_A, threadId, "purge-search-needle", [linkedAttachmentId]);
    const uploadedOnlyAttachmentId = uploadAttachment(
      databasePath,
      attachmentsRoot,
      PROJECT_A,
      threadId,
      { bytes: SECOND_PNG_BYTES, fileName: "uploaded-only.png" },
    ).body.attachment.id;
    const runId = startThreadRun(databasePath, PROJECT_A, threadId, {
      message: "用于生成运行图",
      operationId: operationId(),
    }).body.run.id;
    setRunStatus(PROJECT_A, threadId, runId, "stopped");
    const hitBeforeDelete = searchProjectThreads(databasePath, PROJECT_A, {
      limit: 10,
      query: "purge-search-needle",
    }).results.map((item) => item.threadId);
    expect(hitBeforeDelete).toContain(threadId);
    deleteThread(databasePath, PROJECT_A, threadId);
    expect(existsSync(attachmentPath(PROJECT_A, linkedAttachmentId))).toBe(true);
    expect(existsSync(attachmentPath(PROJECT_A, uploadedOnlyAttachmentId))).toBe(true);

    const result = purgeThread(databasePath, attachmentsRoot, PROJECT_A, threadId);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      purged: true,
      removedAttachmentCount: 2,
      removedMessageCount: 2,
      threadId,
    });
    expect(existsSync(attachmentPath(PROJECT_A, linkedAttachmentId))).toBe(false);
    expect(existsSync(attachmentPath(PROJECT_A, uploadedOnlyAttachmentId))).toBe(false);
    expectCode(
      () => readThreadDetail(databasePath, PROJECT_A, threadId, null),
      "RESOURCE_NOT_FOUND",
    );
    expectCode(
      () => purgeThread(databasePath, attachmentsRoot, PROJECT_A, threadId),
      "RESOURCE_NOT_FOUND",
    );
    expect(
      searchProjectThreads(databasePath, PROJECT_A, {
        limit: 10,
        query: "purge-search-needle",
      }).results.map((item) => item.threadId),
    ).not.toContain(threadId);
    openDatabase(databasePath).close();

    const reader = openDatabase(databasePath);
    try {
      const tables = {
        attachment_events: "thread_id",
        business_action_receipts: "thread_id",
        collaboration_attempts: "thread_id",
        collaboration_events: "thread_id",
        collaboration_messages: "thread_id",
        collaboration_operations: "thread_id",
        collaboration_runs: "thread_id",
        collaboration_thread_facts: "thread_id",
        collaboration_thread_policy_members: "thread_id",
        collaboration_thread_policy_revisions: "thread_id",
        collaboration_threads: "id",
        input_history_entries: "thread_id",
        inline_decisions: "thread_id",
        message_attachments: "thread_id",
        structured_message_blocks: "thread_id",
        structured_message_state_heads: "thread_id",
        structured_message_state_revisions: "thread_id",
        thread_drafts: "thread_id",
        thread_favorites: "thread_id",
        thread_search_index: "thread_id",
        thread_tag_edges: "thread_id",
      } as const;
      for (const [table, key] of Object.entries(tables)) {
        const row = reader.prepare(
          `SELECT count(*) AS count FROM ${table} WHERE project_id=? AND ${key}=?`,
        ).get(PROJECT_A, threadId) as { count: number };
        expect(row.count, `${table} should be empty`).toBe(0);
      }
      const sequence = reader.prepare(
        "SELECT next_activity_sequence AS value FROM collaboration_project_thread_sequences WHERE project_id=?",
      ).get(PROJECT_A) as { value: number };
      const maxRemaining = reader.prepare(
        "SELECT COALESCE(MAX(activity_sequence),0) AS value FROM collaboration_thread_facts WHERE project_id=?",
      ).get(PROJECT_A) as { value: number };
      expect(sequence.value).toBe(maxRemaining.value + 1);
      const markerCount = reader.prepare(
        "SELECT count(*) AS count FROM thread_purge_markers WHERE project_id=?",
      ).get(PROJECT_A) as { count: number };
      expect(markerCount.count).toBe(0);
    } finally {
      reader.close();
    }
    const rows = outboxRows("thread_purged");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payloadJson)).toMatchObject({
      threadId,
      type: "thread_purged",
    });
  });

  it("returns 409 when execution provenance exists and FK still blocks direct delete", () => {
    const threadId = createSeededThread(PROJECT_A, "执行引用保护");
    addMessage(PROJECT_A, threadId, "有执行引用");
    const runId = startThreadRun(databasePath, PROJECT_A, threadId, {
      message: "先创建运行",
      operationId: operationId(),
    }).body.run.id;
    setRunStatus(PROJECT_A, threadId, runId, "stopped");
    insertExecutionReference(PROJECT_A, threadId, runId);
    deleteThread(databasePath, PROJECT_A, threadId);

    const error = expectCode(
      () => purgeThread(databasePath, attachmentsRoot, PROJECT_A, threadId),
      "OPERATION_CONFLICT",
    );
    expect(error.httpStatus).toBe(409);
    expect(error.details.fields).toEqual({ threadId: "has_executions" });

    const db = openDatabase(databasePath);
    try {
      expect(() => {
        db.prepare("DELETE FROM collaboration_threads WHERE project_id=? AND id=?").run(
          PROJECT_A,
          threadId,
        );
      }).toThrowError();
    } finally {
      db.close();
    }
  });

  it("returns plain unmarked 404 for active, missing and cross-tuple targets", () => {
    const threadId = createSeededThread(PROJECT_A, "活跃不能 purge");
    const foreign = createSeededThread(PROJECT_B, "跨项目");
    for (const [projectId, targetId] of [
      [PROJECT_A, threadId],
      [PROJECT_A, "missing-thread"],
      [PROJECT_A, foreign],
      ["missing-project", threadId],
    ] as const) {
      const error = expectCode(
        () => purgeThread(databasePath, attachmentsRoot, projectId, targetId),
        "RESOURCE_NOT_FOUND",
      );
      expect(error.httpStatus).toBe(404);
      expect(error.details.reason).toBeUndefined();
    }
    expect(outboxRows("thread_purged")).toEqual([]);
  });
});

describe("thread purge route seam", () => {
  it("purges through POST with strict empty JSON and no-store", async () => {
    const threadId = createSeededThread(PROJECT_A, "路由永久删除");
    addMessage(PROJECT_A, threadId, "路由线程消息");
    await deleteThreadRequest(PROJECT_A, threadId);

    const response = await purgeThreadRequest(PROJECT_A, threadId);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      purged: true,
      removedAttachmentCount: 0,
      removedMessageCount: 1,
      threadId,
    });
  });

  it("rejects non-empty body, malformed payload and suffixes", async () => {
    const threadId = createSeededThread(PROJECT_A, "路由严格校验");
    await deleteThreadRequest(PROJECT_A, threadId);
    const invalidBodies: Array<[BodyInit | null, string | null]> = [
      [JSON.stringify({ extra: 1 }), "application/json"],
      ["[]", "application/json"],
      ["null", "application/json"],
      ['"text"', "application/json"],
      ["{bad json", "application/json"],
      [null, null],
      ["{}", "text/plain"],
    ];
    for (const [body, contentType] of invalidBodies) {
      const response = await purgeThreadRequest(PROJECT_A, threadId, body, contentType);
      expect([400, 415]).toContain(response.status);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    for (const suffix of ["?unknown=1", "#fragment"]) {
      const response = await purgeThreadRequest(
        PROJECT_A,
        threadId,
        "{}",
        "application/json",
        suffix,
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("maps execution guard to 409 and cross-tuple to sanitized 404", async () => {
    const guarded = createSeededThread(PROJECT_A, "路由执行守卫");
    const runId = startThreadRun(databasePath, PROJECT_A, guarded, {
      message: "route guard run",
      operationId: operationId(),
    }).body.run.id;
    setRunStatus(PROJECT_A, guarded, runId, "stopped");
    insertExecutionReference(PROJECT_A, guarded, runId);
    await deleteThreadRequest(PROJECT_A, guarded);

    const conflict = await purgeThreadRequest(PROJECT_A, guarded);
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("cache-control")).toBe("no-store");
    const conflictBody = (await conflict.json()) as {
      error: { code: string; fields?: Record<string, string> };
    };
    expect(conflictBody.error.code).toBe("OPERATION_CONFLICT");
    expect(conflictBody.error.fields).toEqual({ threadId: "has_executions" });
    expect(JSON.stringify(conflictBody)).not.toContain(databasePath);

    const foreign = createSeededThread(PROJECT_B, "路由跨 tuple");
    for (const [projectId, targetId] of [
      [PROJECT_A, foreign],
      [PROJECT_A, "missing-thread"],
      ["missing-project", guarded],
    ] as const) {
      const response = await purgeThreadRequest(projectId, targetId);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as {
        error: { code: string; reason?: string };
      };
      expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
      expect(body.error.reason).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(databasePath);
    }
  });
});
