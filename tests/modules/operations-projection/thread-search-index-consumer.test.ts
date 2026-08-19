import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { upsertAuditCheckpoint } from "@/src/adapters/outbound/sqlite/operations-projection/audit-projection-store";
import {
  catchUpThreadSearchIndex,
  rebuildThreadSearchIndex,
  THREAD_SEARCH_INDEX_CONSUMER_ID,
} from "@/src/adapters/outbound/sqlite/operations-projection/thread-search-index-consumer";
import {
  createThread,
  startThreadRun,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import {
  acquireAdvance,
  finalizeAdvance,
} from "@/src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator";
import { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { OperationsProjectionError } from "@/src/modules/operations-projection";
import type { StructuredTurnResult } from "@/src/modules/public-collaboration";
import { seedCurrentAdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import { seedMissionInitialization } from "@/tests/fixtures/review/mission-initialization";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-10T03:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 13).toString("base64url");
const PROJECT_ID = "search-project";
const AGENT_A = "search-agent-a";
const AGENT_B = "search-agent-b";

const ADVANCE_PROJECT = "search-advance-project";
const ADVANCE_RUN = "search-advance-run";
const ADVANCE_MISSION = "search-advance-mission";
const ADVANCE_PROVIDER = "search-advance-provider";
const ADVANCE_AGENT_A = "search-advance-agent-a";
const ADVANCE_AGENT_B = "search-advance-agent-b";

let operationSequence = 0;

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

let databasePath: string;
let database: DatabaseSync;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
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

function seedProjectOnly(): void {
  database.prepare(
    "INSERT INTO projects(id,name,created_at,version) VALUES (?,?,?,1)",
  ).run(PROJECT_ID, "Search", NOW);
}

function seedCollaborationGraph(): void {
  database.prepare(
    `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
     VALUES (?,?,?,'D:\\workspace',?,1)`,
  ).run(PROJECT_ID, "Search", NOW, `d:/workspace/${PROJECT_ID}`);
  const encrypted = createCredentialVault().encrypt("search-provider", "provider-key");
  database.prepare(
    `INSERT INTO providers(
       id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
       credential_version,credential_generation,key_id,api_key_mask,verified_at,
       version,created_at,updated_at
     ) VALUES ('search-provider','Provider','http://localhost/v1','model',
       ?,?,?,1,1,?,'***',?,1,?,?)`,
  ).run(
    encrypted.apiKeyCipher,
    encrypted.apiKeyIv,
    encrypted.apiKeyTag,
    encrypted.keyId,
    NOW,
    NOW,
    NOW,
  );
  const insertAgent = database.prepare(
    `INSERT INTO agents(
       id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
       can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
       updated_at,review_capable
     ) VALUES (?,?,'Peer','Prompt','search-provider','model','A','sage',
       1,1,0,1000,3,1,?,?,0)`,
  );
  insertAgent.run(AGENT_A, "Agent A", NOW, NOW);
  insertAgent.run(AGENT_B, "Agent B", NOW, NOW);
  const insertMember = database.prepare(
    "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
  );
  insertMember.run(PROJECT_ID, AGENT_A, NOW);
  insertMember.run(PROJECT_ID, AGENT_B, NOW);
  database.prepare(
    `INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
     VALUES ('search-mission',?,'Mission','Goal',1,?,?)`,
  ).run(PROJECT_ID, NOW, NOW);
  seedMissionInitialization(database, {
    missionId: "search-mission",
    occurredAt: NOW,
    projectId: PROJECT_ID,
  });
}

function seedThread(title: string): string {
  return createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [AGENT_A, AGENT_B],
    operationId: operationId(),
    title,
  }).body.thread.id;
}

function writeMessage(threadId: string, content: string): string {
  const written = writeOwnerThreadMessage(databasePath, PROJECT_ID, threadId, {
    content,
    operationId: operationId(),
  });
  expect(written.status).toBe(201);
  return written.body.message.id;
}

let advanceUuidSequence = 0;

function advanceDependencies(): { clock: () => Date; randomUUID: () => string } {
  return {
    clock: () => new Date(NOW),
    randomUUID: () => {
      advanceUuidSequence += 1;
      return `33000000-0000-4000-8000-${advanceUuidSequence.toString().padStart(12, "0")}`;
    },
  };
}

function seedAdvanceThread(options?: { realProviderKey?: string }): string {
  advanceUuidSequence = 0;
  const threadId = seedCurrentAdvanceFixture(databasePath, {
    agentId: ADVANCE_AGENT_A,
    agentPrompt: "private-prompt-a",
    missionId: ADVANCE_MISSION,
    now: NOW,
    ownerMessage: null,
    projectId: ADVANCE_PROJECT,
    projectName: "SearchAdvance",
    providerId: ADVANCE_PROVIDER,
    runId: ADVANCE_RUN,
    secondAgentId: ADVANCE_AGENT_B,
    secondAgentPrompt: "private-prompt-b",
    threadCreateOperationId: operationId(),
  });
  if (options?.realProviderKey !== undefined) {
    // The shared fixture stores an undecryptable provider credential; replace
    // it with a real envelope so the public-text classifier can see the key.
    const encrypted = createCredentialVault().encrypt(
      ADVANCE_PROVIDER,
      options.realProviderKey,
    );
    database.prepare(
      `UPDATE providers
       SET api_key_cipher=?,api_key_iv=?,api_key_tag=?,key_id=?,api_key_mask=?
       WHERE id=?`,
    ).run(
      encrypted.apiKeyCipher,
      encrypted.apiKeyIv,
      encrypted.apiKeyTag,
      encrypted.keyId,
      encrypted.apiKeyMask,
      ADVANCE_PROVIDER,
    );
  }
  return threadId;
}

function driveAgentTurn(message: string): void {
  const thread = database
    .prepare("SELECT id FROM collaboration_threads WHERE project_id=?")
    .get(ADVANCE_PROJECT) as { id: string };
  const tuple = { projectId: ADVANCE_PROJECT, runId: ADVANCE_RUN, threadId: thread.id };
  const acquired = acquireAdvance(
    databasePath,
    tuple,
    { operationId: operationId() },
    advanceDependencies(),
  );
  expect(acquired.kind).toBe("acquired");
  if (acquired.kind !== "acquired") return;
  const usage = { completionTokens: 3, promptTokens: 7, totalTokens: 10 };
  const result: StructuredTurnResult = {
    calls: [
      {
        kind: "primary",
        result: {
          content: "{}",
          error: null,
          httpStatus: 200,
          status: "succeeded",
          usage,
          usageReported: true,
        },
      },
    ],
    pauseCategory: null,
    status: "completed",
    turn: {
      claim: null,
      disposition: {
        reason: "Beta owns the next step",
        summary: "Handing off",
        targetAgentId: ADVANCE_AGENT_B,
        type: "handoff",
      },
      message,
      tasks: [],
    },
    usage: [{ kind: "primary", usage, usageReported: true }],
  };
  const response = finalizeAdvance(
    databasePath,
    tuple,
    {
      attemptId: acquired.attempt.id,
      leaseToken: acquired.attempt.leaseToken,
      result,
    },
    advanceDependencies(),
  );
  expect(response.status).toBe(200);
}

type IndexRow = {
  content: string;
  kind: string;
  message_id: string | null;
  occurred_at: string;
  project_id: string;
  source_seq: number;
  thread_id: string;
};

const INDEX_ROW_SELECT = `
  SELECT project_id,thread_id,kind,message_id,content,occurred_at,source_seq
  FROM thread_search_index
  ORDER BY project_id,thread_id,
           CASE kind WHEN 'thread_title' THEN 0 ELSE 1 END,source_seq
`;

function indexRows(path: string = databasePath): IndexRow[] {
  const reader = openDatabase(path);
  try {
    return reader.prepare(INDEX_ROW_SELECT).all() as IndexRow[];
  } finally {
    reader.close();
  }
}

// Reads through the already-open test connection, for failure-path tests where
// the persisted state intentionally no longer passes reopen validation.
function indexRowsLocal(): IndexRow[] {
  return database.prepare(INDEX_ROW_SELECT).all() as IndexRow[];
}

function insertIndexRow(input: {
  content: string;
  kind: string;
  messageId?: string | null;
  occurredAt?: string;
  projectId?: string;
  sourceSeq?: number;
  threadId: string;
}): void {
  database.prepare(`
    INSERT INTO thread_search_index(
      project_id,thread_id,kind,message_id,content,occurred_at,source_seq
    ) VALUES (?,?,?,?,?,?,?)
  `).run(
    input.projectId ?? PROJECT_ID,
    input.threadId,
    input.kind,
    input.messageId ?? null,
    input.content,
    input.occurredAt ?? NOW,
    input.sourceSeq ?? 0,
  );
}

function checkpointRow(): { lastOutboxSeq: number; status: string } | undefined {
  return database.prepare(`
    SELECT last_outbox_seq AS lastOutboxSeq, status
    FROM audit_projection_checkpoints WHERE consumer_id=?
  `).get(THREAD_SEARCH_INDEX_CONSUMER_ID) as
    | { lastOutboxSeq: number; status: string }
    | undefined;
}

describe("thread search index schema", () => {
  it("bootstraps identity 17 with the thread_search_index table and its constraints", () => {
    seedProjectOnly();
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });

    insertIndexRow({ content: "部署计划讨论", kind: "thread_title", threadId: "thread-1" });
    insertIndexRow({
      content: "Keyword body 正文",
      kind: "message",
      messageId: "m-1",
      sourceSeq: 3,
      threadId: "thread-1",
    });

    // Unknown kinds are rejected.
    expect(() => insertIndexRow({
      content: "x",
      kind: "note",
      threadId: "thread-1",
    })).toThrow();
    // A title row must not carry a message id or a cursor position.
    expect(() => insertIndexRow({
      content: "x",
      kind: "thread_title",
      messageId: "m-2",
      threadId: "thread-2",
    })).toThrow();
    expect(() => insertIndexRow({
      content: "x",
      kind: "thread_title",
      sourceSeq: 1,
      threadId: "thread-2",
    })).toThrow();
    // A message row must carry a message id and the event cursor position.
    expect(() => insertIndexRow({
      content: "x",
      kind: "message",
      threadId: "thread-2",
    })).toThrow();
    expect(() => insertIndexRow({
      content: "x",
      kind: "message",
      messageId: "m-3",
      sourceSeq: 0,
      threadId: "thread-2",
    })).toThrow();
    // One title row per thread (partial unique index; NULL message_id would
    // otherwise be distinct under the four-column UNIQUE).
    expect(() => insertIndexRow({
      content: "second title",
      kind: "thread_title",
      threadId: "thread-1",
    })).toThrow();
    // One index row per message.
    expect(() => insertIndexRow({
      content: "duplicate",
      kind: "message",
      messageId: "m-1",
      sourceSeq: 4,
      threadId: "thread-1",
    })).toThrow();
    // Empty content is never indexed.
    expect(() => insertIndexRow({
      content: "",
      kind: "thread_title",
      threadId: "thread-9",
    })).toThrow();
  });
});

describe("catchUpThreadSearchIndex", () => {
  it("indexes the thread title and the full owner message body from outbox events", () => {
    seedCollaborationGraph();
    const threadId = seedThread("部署计划讨论");
    const messageId = writeMessage(threadId, "Keyword rollout 正文内容");

    expect(catchUpThreadSearchIndex(databasePath)).toEqual({
      applied: 2,
      batches: 1,
      lastOutboxSeq: 1,
    });

    expect(indexRows()).toEqual([
      {
        content: "部署计划讨论",
        kind: "thread_title",
        message_id: null,
        occurred_at: NOW,
        project_id: PROJECT_ID,
        source_seq: 0,
        thread_id: threadId,
      },
      {
        content: "Keyword rollout 正文内容",
        kind: "message",
        message_id: messageId,
        occurred_at: NOW,
        project_id: PROJECT_ID,
        source_seq: 1,
        thread_id: threadId,
      },
    ]);
    expect(checkpointRow()).toEqual({ lastOutboxSeq: 1, status: "idle" });
  });

  it("retrieves Chinese substrings and folds ASCII case with LIKE over the index", () => {
    seedCollaborationGraph();
    const threadId = seedThread("部署计划讨论");
    writeMessage(threadId, "Keyword rollout 正文内容");
    catchUpThreadSearchIndex(databasePath);

    const search = (projectId: string, term: string): IndexRow[] =>
      database.prepare(`
        SELECT project_id,thread_id,kind,message_id,content,occurred_at,source_seq
        FROM thread_search_index
        WHERE project_id=? AND content LIKE '%'||?||'%' ESCAPE '\\'
        ORDER BY occurred_at DESC, thread_id, kind
      `).all(projectId, term) as IndexRow[];

    expect(search(PROJECT_ID, "部署").map((row) => row.kind)).toEqual(["thread_title"]);
    // SQLite LIKE folds ASCII case only.
    expect(search(PROJECT_ID, "keyword").map((row) => row.kind)).toEqual(["message"]);
    expect(search(PROJECT_ID, "正文").map((row) => row.kind)).toEqual(["message"]);
    expect(search(PROJECT_ID, "缺词")).toEqual([]);
  });

  it("indexes agent_message events with the persisted full body", () => {
    const threadId = seedAdvanceThread();
    driveAgentTurn("Audit start committed 代理正文");

    expect(catchUpThreadSearchIndex(databasePath)).toEqual({
      applied: 2,
      batches: 1,
      lastOutboxSeq: 2,
    });

    const message = database.prepare(
      "SELECT id, content FROM collaboration_messages WHERE project_id=?",
    ).get(ADVANCE_PROJECT) as { content: string; id: string };
    expect(indexRows()).toEqual([
      {
        content: "Advance thread",
        kind: "thread_title",
        message_id: null,
        occurred_at: NOW,
        project_id: ADVANCE_PROJECT,
        source_seq: 0,
        thread_id: threadId,
      },
      {
        content: message.content,
        kind: "message",
        message_id: message.id,
        occurred_at: NOW,
        project_id: ADVANCE_PROJECT,
        source_seq: 1,
        thread_id: threadId,
      },
    ]);
    expect(message.content).toBe("Audit start committed 代理正文");
  });

  it("is idempotent: a second run applies nothing and the index is byte-identical", () => {
    seedCollaborationGraph();
    const threadId = seedThread("Idempotent thread");
    writeMessage(threadId, "First message");
    writeMessage(threadId, "Second message");

    expect(catchUpThreadSearchIndex(databasePath)).toEqual({
      applied: 3,
      batches: 1,
      lastOutboxSeq: 2,
    });
    const firstPass = indexRows();

    expect(catchUpThreadSearchIndex(databasePath)).toEqual({
      applied: 0,
      batches: 0,
      lastOutboxSeq: 2,
    });
    expect(indexRows()).toEqual(firstPass);
  });

  it("self-heals the checkpoint row on an empty outbox", () => {
    seedProjectOnly();

    expect(catchUpThreadSearchIndex(databasePath)).toEqual({
      applied: 0,
      batches: 0,
      lastOutboxSeq: 0,
    });
    expect(indexRows()).toEqual([]);
    expect(checkpointRow()).toEqual({ lastOutboxSeq: 0, status: "idle" });
  });

  it("skips non-message events and other sources but advances the cursor past them", () => {
    seedCollaborationGraph();
    const threadId = seedThread("Run thread");
    startThreadRun(databasePath, PROJECT_ID, threadId, {
      message: "Start the indexed run",
      operationId: operationId(),
    });
    // A foreign-source outbox row interleaves after the collaboration events.
    database.prepare(`
      INSERT INTO audit_event_outbox (
        id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
      ) VALUES ('search-exec-event',?,'safe_execution','execution_started','{}',?,3)
    `).run(PROJECT_ID, NOW);

    expect(catchUpThreadSearchIndex(databasePath)).toEqual({
      applied: 2,
      batches: 1,
      lastOutboxSeq: 3,
    });
    expect(indexRows().map((row) => row.kind)).toEqual(["thread_title", "message"]);
    expect(checkpointRow()).toEqual({ lastOutboxSeq: 3, status: "idle" });
  });

  it("keeps projects isolated under one global cursor", () => {
    seedCollaborationGraph();
    const threadA = seedThread("Alpha project thread");
    writeMessage(threadA, "Alpha unique term 甲");
    const threadB = seedAdvanceThread();
    driveAgentTurn("Beta unique term 乙");

    const result = catchUpThreadSearchIndex(databasePath);
    expect(result).toEqual({ applied: 4, batches: 1, lastOutboxSeq: 3 });

    const rows = indexRows();
    expect(rows.map((row) => [row.project_id, row.kind])).toEqual([
      [ADVANCE_PROJECT, "thread_title"],
      [ADVANCE_PROJECT, "message"],
      [PROJECT_ID, "thread_title"],
      [PROJECT_ID, "message"],
    ]);
    expect(rows.find((row) => row.project_id === PROJECT_ID && row.kind === "message"))
      .toMatchObject({ thread_id: threadA, content: "Alpha unique term 甲" });
    expect(rows.find((row) => row.project_id === ADVANCE_PROJECT && row.kind === "message"))
      .toMatchObject({ thread_id: threadB, content: "Beta unique term 乙" });

    const scoped = database.prepare(`
      SELECT project_id FROM thread_search_index
      WHERE project_id=? AND content LIKE '%unique%'
    `).all(PROJECT_ID) as Array<{ project_id: string }>;
    expect(scoped).toHaveLength(1);
    expect(
      database.prepare(
        "SELECT 1 FROM thread_search_index WHERE project_id=? AND content LIKE '%Beta%'",
      ).all(PROJECT_ID),
    ).toEqual([]);
  });

  it("indexes exactly the persisted public body even when the audit excerpt is withheld", () => {
    const threadId = seedAdvanceThread({ realProviderKey: "advance-provider-key" });
    driveAgentTurn("The provider key advance-provider-key must never leak");

    // The audit trail withheld the excerpt; the message body itself is the
    // already-persisted public text the owner sees in the thread UI.
    const outboxPayload = JSON.parse(
      (database.prepare(
        "SELECT payload_json AS p FROM audit_event_outbox WHERE event_type='agent_message'",
      ).get() as { p: string }).p,
    ) as Record<string, unknown>;
    expect(outboxPayload.messageExcerpt).toBe("[redacted]");

    catchUpThreadSearchIndex(databasePath);
    const stored = database.prepare(
      "SELECT content FROM collaboration_messages WHERE project_id=? AND thread_id=?",
    ).get(ADVANCE_PROJECT, threadId) as { content: string };
    const indexed = indexRows().find((row) => row.kind === "message");
    expect(indexed?.content).toBe(stored.content);
    expect(indexed?.content).toContain("advance-provider-key");
  });

  it("refuses to catch up while a rebuild is in progress", () => {
    seedCollaborationGraph();
    const threadId = seedThread("Rebuild gate");
    writeMessage(threadId, "Pending message");
    upsertAuditCheckpoint(database, {
      consumerId: THREAD_SEARCH_INDEX_CONSUMER_ID,
      lastOutboxSeq: 0,
      status: "rebuilding",
    });

    expect(() => catchUpThreadSearchIndex(databasePath)).toThrowError(
      expect.objectContaining({
        code: "PROJECTION_REBUILD_IN_PROGRESS",
        name: "OperationsProjectionError",
      }) as OperationsProjectionError,
    );
    expect(indexRows()).toEqual([]);
  });

  it("fails closed on a corrupt checkpoint (last_outbox_seq beyond the outbox)", () => {
    seedCollaborationGraph();
    const threadId = seedThread("Corrupt cursor");
    writeMessage(threadId, "Message behind the cursor");
    catchUpThreadSearchIndex(databasePath);
    const before = indexRows();
    // Outbox rows deleted behind the checkpoint: reopen invariants reject this
    // drift at open, so the consumer never silently rewinds or self-heals it.
    database.exec("DELETE FROM audit_event_outbox");

    expect(() => catchUpThreadSearchIndex(databasePath)).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_DATA_INVALID",
        name: "SchemaError",
      }) as SchemaError,
    );
    expect(indexRowsLocal()).toEqual(before);
  });
});

describe("rebuildThreadSearchIndex", () => {
  it("rebuilds titles for every thread and replays all message events from scratch", () => {
    seedCollaborationGraph();
    const idleThread = seedThread("Empty thread 空线程");
    const activeThread = seedThread("Active thread");
    const messageId = writeMessage(activeThread, "Replay me 重放");

    expect(rebuildThreadSearchIndex(databasePath)).toEqual({
      lastOutboxSeq: 1,
      replayed: 3,
    });

    // Thread ids are random UUIDs; the index row order follows the
    // deterministic INDEX_ROW_SELECT ordering (thread_id, kind, source_seq).
    const expected = [
      {
        content: "Empty thread 空线程",
        kind: "thread_title",
        message_id: null,
        occurred_at: NOW,
        project_id: PROJECT_ID,
        source_seq: 0,
        thread_id: idleThread,
      },
      {
        content: "Active thread",
        kind: "thread_title",
        message_id: null,
        occurred_at: NOW,
        project_id: PROJECT_ID,
        source_seq: 0,
        thread_id: activeThread,
      },
      {
        content: "Replay me 重放",
        kind: "message",
        message_id: messageId,
        occurred_at: NOW,
        project_id: PROJECT_ID,
        source_seq: 1,
        thread_id: activeThread,
      },
    ].sort((a, b) =>
      a.thread_id === b.thread_id
        ? (a.kind === b.kind ? a.source_seq - b.source_seq : a.kind === "thread_title" ? -1 : 1)
        : a.thread_id < b.thread_id ? -1 : 1
    );
    expect(indexRows()).toEqual(expected);
    expect(checkpointRow()).toEqual({ lastOutboxSeq: 1, status: "idle" });
  });

  it("repairs a diverged index deterministically and is a fixed point", () => {
    seedCollaborationGraph();
    const threadId = seedThread("Diverge me");
    writeMessage(threadId, "First message");
    writeMessage(threadId, "Second message");
    catchUpThreadSearchIndex(databasePath);
    const reference = indexRows();
    // Diverge the index: drop one message row and tamper the title content.
    database.exec("DELETE FROM thread_search_index WHERE kind='message' AND source_seq=1");
    database.exec("UPDATE thread_search_index SET content='tampered' WHERE kind='thread_title'");

    expect(rebuildThreadSearchIndex(databasePath)).toEqual({
      lastOutboxSeq: 2,
      replayed: 3,
    });
    expect(indexRows()).toEqual(reference);
    // Rebuilding again is a fixed point.
    expect(rebuildThreadSearchIndex(databasePath)).toEqual({
      lastOutboxSeq: 2,
      replayed: 3,
    });
    expect(indexRows()).toEqual(reference);
  });

  it("rebuilds an empty database to an empty index and an idle zero checkpoint", () => {
    expect(rebuildThreadSearchIndex(databasePath)).toEqual({
      lastOutboxSeq: 0,
      replayed: 0,
    });
    expect(indexRows()).toEqual([]);
    expect(checkpointRow()).toEqual({ lastOutboxSeq: 0, status: "idle" });
  });

  it("rejects a concurrent rebuild and leaves the index untouched", () => {
    seedCollaborationGraph();
    const threadId = seedThread("Concurrent rebuild");
    writeMessage(threadId, "Keep me");
    catchUpThreadSearchIndex(databasePath);
    const before = indexRows();
    upsertAuditCheckpoint(database, {
      consumerId: THREAD_SEARCH_INDEX_CONSUMER_ID,
      lastOutboxSeq: 1,
      status: "rebuilding",
    });

    expect(() => rebuildThreadSearchIndex(databasePath)).toThrowError(
      expect.objectContaining({
        code: "PROJECTION_REBUILD_IN_PROGRESS",
        name: "OperationsProjectionError",
      }) as OperationsProjectionError,
    );
    expect(indexRows()).toEqual(before);
    expect(checkpointRow()).toEqual({ lastOutboxSeq: 1, status: "rebuilding" });
  });
});

describe("thread search index reopen invariants", () => {
  it("keeps a healthy indexed database reopenable", () => {
    seedCollaborationGraph();
    const threadId = seedThread("Healthy thread");
    writeMessage(threadId, "Healthy body");
    catchUpThreadSearchIndex(databasePath);

    database.close();
    database = openDatabase(databasePath);

    expect(indexRowsLocal()).toHaveLength(2);
  });

  it("fails reopen when an index row references a missing thread", () => {
    seedProjectOnly();
    insertIndexRow({ content: "orphan title", kind: "thread_title", threadId: "ghost-thread" });

    expect(() => catchUpThreadSearchIndex(databasePath)).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_DATA_INVALID",
        name: "SchemaError",
      }) as SchemaError,
    );
  });

  it("fails reopen when a message index row references a missing message", () => {
    seedCollaborationGraph();
    const threadId = seedThread("Invariant thread");
    catchUpThreadSearchIndex(databasePath);
    insertIndexRow({
      content: "ghost body",
      kind: "message",
      messageId: "ghost-message",
      sourceSeq: 99,
      threadId,
    });

    expect(() => catchUpThreadSearchIndex(databasePath)).toThrowError(
      expect.objectContaining({
        code: "SCHEMA_DATA_INVALID",
        name: "SchemaError",
      }) as SchemaError,
    );
  });
});
