import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  clearInputHistory,
  searchInputHistory,
} from "@/src/adapters/outbound/sqlite/public-collaboration/input-history-service";
import {
  readThreadDraft,
  saveThreadDraft,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-draft-service";
import {
  createThread,
  startThreadRun,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createMission } from "@/src/composition/mission-commands";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { CollaborationError } from "@/src/modules/public-collaboration";
import type {
  InputHistoryEntryDto,
  InputHistorySearchResponse,
} from "@/src/shared/collaboration-contracts";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type HistoryRoute = {
  DELETE(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const historyRoutes = import.meta.glob<HistoryRoute>(
  "../../../app/api/projects/[projectId]/input-history/route.ts",
);

const NOW = "2026-08-08T08:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 23).toString("base64url");
const SECRET_CONTENT = "token=sk-live-secret-123";

let databasePath: string;
let threadA: string;
let threadB: string;
let foreignThread: string;
let operationSequence: number;

function operationId(): string {
  operationSequence += 1;
  return `31000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function seedProject(projectId: string, agentIds: [string, string]): void {
  const database = openDatabase(databasePath);
  const vault = createCredentialVault();
  try {
    database.prepare(
      `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
       VALUES (?,?,?,'D:\\workspace',?,1)`,
    ).run(projectId, projectId, NOW, `workspace-${projectId}`);
    const providerId = `provider-${projectId}`;
    const encrypted = vault.encrypt(providerId, `key-${projectId}`);
    database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES (?,'Provider','http://127.0.0.1:1/v1','model',?,?,?,?,1,?,?,?,1,?,?)`,
    ).run(
      providerId,
      encrypted.apiKeyCipher,
      encrypted.apiKeyIv,
      encrypted.apiKeyTag,
      encrypted.credentialVersion,
      encrypted.keyId,
      encrypted.apiKeyMask,
      NOW,
      NOW,
      NOW,
    );
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
  createMission(databasePath, projectId, {
    expectedVersion: 0,
    goal: `Goal ${projectId}`,
    operationId: operationId(),
    title: `Mission ${projectId}`,
  });
}

function send(
  projectId: string,
  threadId: string,
  content: string,
  operation = operationId(),
): void {
  writeOwnerThreadMessage(databasePath, projectId, threadId, {
    content,
    operationId: operation,
  });
}

function search(
  projectId: string,
  query = "",
): InputHistorySearchResponse {
  return searchInputHistory(databasePath, projectId, query).body;
}

function readDraft(projectId: string, threadId: string) {
  return readThreadDraft(databasePath, projectId, threadId).body.draft;
}

function historyRows(): {
  content: string;
  created_at: string;
  id: string;
  project_id: string;
  thread_id: string;
}[] {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw.prepare(
      `SELECT id,project_id,thread_id,content,created_at
       FROM input_history_entries ORDER BY created_at,id`,
    ).all() as never;
  } finally {
    raw.close();
  }
}

function clearEventRows(): Record<string, unknown>[] {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw.prepare(
      "SELECT * FROM input_history_clear_events ORDER BY cleared_at,id",
    ).all() as never;
  } finally {
    raw.close();
  }
}

function storedMessageContent(projectId: string, threadId: string): string[] {
  const raw = new DatabaseSync(databasePath);
  try {
    return (
      raw.prepare(
        `SELECT content FROM collaboration_messages
         WHERE project_id=? AND thread_id=? AND author_type='owner' ORDER BY sequence`,
      ).all(projectId, threadId) as { content: string }[]
    ).map((row) => row.content);
  } finally {
    raw.close();
  }
}

function catchHistoryError(operation: () => unknown): CollaborationError {
  try {
    operation();
  } catch (error) {
    if (error instanceof CollaborationError) return error;
    throw error;
  }
  throw new Error("EXPECTED_COLLABORATION_ERROR");
}

function corrupt(statement: string, ...params: (number | string)[]): void {
  const raw = new DatabaseSync(databasePath);
  try {
    raw.exec("PRAGMA foreign_keys=OFF");
    raw.prepare(statement).run(...params);
  } finally {
    raw.close();
  }
}

async function historyRoute(): Promise<HistoryRoute> {
  const load = historyRoutes[
    "../../../app/api/projects/[projectId]/input-history/route.ts"
  ];
  expect(load, "input history route must exist").toBeTypeOf("function");
  return load!();
}

async function getHistory(
  projectId: string,
  urlSuffix = "",
): Promise<Response> {
  return (await historyRoute()).GET(
    new Request(`http://localhost/api/projects/${projectId}/input-history${urlSuffix}`),
    { params: Promise.resolve({ projectId }) },
  );
}

async function deleteHistory(
  projectId: string,
  urlSuffix = "",
): Promise<Response> {
  return (await historyRoute()).DELETE(
    new Request(`http://localhost/api/projects/${projectId}/input-history${urlSuffix}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ projectId }) },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  process.env.COCKPIT_DB_PATH = databasePath;
  operationSequence = 3100;
  seedProject("project-a", ["agent-a", "agent-b"]);
  threadA = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: operationId(),
    title: "Thread A",
  }).body.thread.id;
  threadB = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: operationId(),
    title: "Thread B",
  }).body.thread.id;
  seedProject("project-b", ["agent-c", "agent-d"]);
  foreignThread = createThread(databasePath, "project-b", {
    memberAgentIds: ["agent-c", "agent-d"],
    operationId: operationId(),
    title: "Foreign Thread",
  }).body.thread.id;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("owner message send records input history and clears the draft", () => {
  it("records a trimmed history entry and clears only that thread's draft on send", () => {
    saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [{ name: "notes.txt", size: 12 }],
      content: "Draft A",
      replyToMessageId: null,
    });
    saveThreadDraft(databasePath, "project-a", threadB, {
      attachments: [],
      content: "Draft B",
      replyToMessageId: null,
    });

    send("project-a", threadA, "  hello history  ");

    expect(search("project-a")).toEqual({
      entries: [{
        id: expect.any(String),
        threadId: threadA,
        content: "hello history",
        createdAt: NOW,
      }],
      lastClearedAt: null,
    });
    expect(storedMessageContent("project-a", threadA)).toEqual(["hello history"]);
    expect(historyRows().map((row) => row.content)).toEqual(["hello history"]);
    expect(
      readDraft("project-a", threadA),
      "send clears the draft of the same tuple",
    ).toBeNull();
    expect(readDraft("project-a", threadB)).toMatchObject({ content: "Draft B" });
  });

  it("does not record a second entry or re-clear a newer draft on same-operation replay", () => {
    const operation = operationId();
    send("project-a", threadA, "First send", operation);
    saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [],
      content: "Newer draft after send",
      replyToMessageId: null,
    });

    const replayed = writeOwnerThreadMessage(databasePath, "project-a", threadA, {
      content: "First send",
      operationId: operation,
    });
    expect(replayed.status).toBe(201);
    expect(search("project-a").entries).toHaveLength(1);
    expect(historyRows()).toHaveLength(1);
    expect(readDraft("project-a", threadA))
      .toMatchObject({ content: "Newer draft after send" });
  });

  it("skips history for credential-pattern content while the message itself commits", () => {
    send("project-a", threadA, SECRET_CONTENT);
    send("project-a", threadA, "the provider key is key-project-a exactly");

    expect(storedMessageContent("project-a", threadA)).toEqual([
      SECRET_CONTENT,
      "the provider key is key-project-a exactly",
    ]);
    expect(search("project-a")).toEqual({ entries: [], lastClearedAt: null });
    expect(historyRows()).toEqual([]);
  });

  it("records history and clears the draft when a run start sends the initial message", () => {
    saveThreadDraft(databasePath, "project-a", threadB, {
      attachments: [],
      content: "Run draft",
      replyToMessageId: null,
    });

    const started = startThreadRun(databasePath, "project-a", threadB, {
      message: "  kick off the run  ",
      operationId: operationId(),
    });
    expect(started.status).toBe(201);

    expect(search("project-a").entries).toEqual([{
      id: expect.any(String),
      threadId: threadB,
      content: "kick off the run",
      createdAt: NOW,
    }]);
    expect(readDraft("project-a", threadB)).toBeNull();
  });

  it("keeps history isolated per project", () => {
    send("project-a", threadA, "project a wording");
    send("project-b", foreignThread, "project b wording");

    expect(search("project-a").entries.map((entry) => entry.content))
      .toEqual(["project a wording"]);
    expect(search("project-b").entries.map((entry) => entry.content))
      .toEqual(["project b wording"]);
  });
});

describe("input history search", () => {
  it("matches case-insensitive substrings and orders newest first", () => {
    send("project-a", threadA, "Deploy the Staging build");
    vi.setSystemTime(new Date("2026-08-08T08:00:01.000Z"));
    send("project-a", threadA, "unrelated note");
    vi.setSystemTime(new Date("2026-08-08T08:00:02.000Z"));
    send("project-a", threadB, "refresh STAGING tokens");

    const hits = search("project-a", "staging").entries;
    expect(hits.map((entry) => entry.content)).toEqual([
      "refresh STAGING tokens",
      "Deploy the Staging build",
    ]);
    expect(search("project-a", "STAGING").entries.map((entry) => entry.id))
      .toEqual(hits.map((entry) => entry.id));
    expect(search("project-a", "nothing-matches").entries).toEqual([]);
  });

  it("treats LIKE wildcards in the query as literals", () => {
    send("project-a", threadA, "progress 100% done_now");
    send("project-a", threadA, "progress 1005 done now");

    expect(search("project-a", "100%").entries.map((entry) => entry.content))
      .toEqual(["progress 100% done_now"]);
    expect(search("project-a", "done_now").entries).toHaveLength(1);
    expect(search("project-a", "\\").entries).toEqual([]);
  });

  it("lists the newest 100 entries for an empty query", () => {
    const raw = new DatabaseSync(databasePath);
    try {
      const insert = raw.prepare(
        `INSERT INTO input_history_entries(id,project_id,thread_id,content,created_at)
         VALUES (?,?,?,?,?)`,
      );
      for (let index = 0; index < 105; index += 1) {
        insert.run(
          `entry-${index}`,
          "project-a",
          threadA,
          `bulk entry ${index}`,
          `2026-08-08T08:${String(Math.floor(index / 60)).padStart(2, "0")}:${
            String(index % 60).padStart(2, "0")
          }.000Z`,
        );
      }
    } finally {
      raw.close();
    }

    const entries = search("project-a").entries;
    expect(entries).toHaveLength(100);
    expect(entries[0]).toMatchObject({ content: "bulk entry 104" });
    expect(entries[99]).toMatchObject({ content: "bulk entry 5" });
  });

  it("rejects an over-long query with a stable 400 and writes nothing", () => {
    const error = catchHistoryError(() => searchInputHistory(
      databasePath,
      "project-a",
      "a".repeat(201),
    ));
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      details: { fields: { query: "too_long" } },
      httpStatus: 400,
    });
  });

  it("uses identical safe 404s for unknown projects on search and clear", () => {
    const unknownSearch = catchHistoryError(() => searchInputHistory(
      databasePath,
      "unknown-project",
      "",
    ));
    const unknownClear = catchHistoryError(() => clearInputHistory(
      databasePath,
      "unknown-project",
    ));
    for (const error of [unknownSearch, unknownClear]) {
      expect(error).toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        httpStatus: 404,
        message: "Resource was not found.",
      });
    }
  });
});

describe("input history clear", () => {
  it("clears only the project's history and records a content-free clear event", () => {
    send("project-a", threadA, "remember this exact wording");
    send("project-a", threadB, "second a entry");
    send("project-b", foreignThread, "project b keeps its history");

    const cleared = clearInputHistory(databasePath, "project-a");
    expect(cleared).toEqual({
      body: { cleared: true, clearedAt: NOW },
      status: 200,
    });

    expect(search("project-a")).toEqual({ entries: [], lastClearedAt: NOW });
    expect(search("project-b").entries).toHaveLength(1);
    expect(historyRows().map((row) => row.project_id)).toEqual(["project-b"]);

    const events = clearEventRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: expect.any(String),
      project_id: "project-a",
      cleared_at: NOW,
    });
    expect(JSON.stringify(events)).not.toContain("remember this exact wording");
  });

  it("records a distinct event per clear and exposes the latest via search", () => {
    clearInputHistory(databasePath, "project-a");
    vi.setSystemTime(new Date("2026-08-08T08:00:05.000Z"));
    send("project-a", threadA, "after first clear");
    clearInputHistory(databasePath, "project-a");

    expect(clearEventRows()).toHaveLength(2);
    expect(search("project-a")).toEqual({
      entries: [],
      lastClearedAt: "2026-08-08T08:00:05.000Z",
    });
  });
});

describe("input history tuple invariant on reopen", () => {
  function expectReopenFailClosed(): void {
    const before = historyRows();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => openDatabase(databasePath).close()).toThrowError(
        expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }),
      );
    }
    expect(historyRows()).toEqual(before);
  }

  it("keeps a legal history and clear-event graph stable across repeated reopen", () => {
    send("project-a", threadA, "stable entry");
    clearInputHistory(databasePath, "project-a");
    send("project-a", threadA, "after clear");
    const first = search("project-a");
    for (let reopen = 0; reopen < 2; reopen += 1) {
      openDatabase(databasePath).close();
      expect(search("project-a")).toEqual(first);
    }
  });

  it("fails closed when a history row points at a missing thread", () => {
    send("project-a", threadA, "orphaned entry");
    corrupt(
      "UPDATE input_history_entries SET thread_id=? WHERE project_id=?",
      "missing-thread",
      "project-a",
    );
    expectReopenFailClosed();
  });

  it("fails closed when a history row crosses into another project tuple", () => {
    send("project-a", threadA, "cross tuple entry");
    corrupt(
      "UPDATE input_history_entries SET project_id=? WHERE project_id=?",
      "project-b",
      "project-a",
    );
    expectReopenFailClosed();
  });
});

describe("input history route", () => {
  it("searches via GET and clears via DELETE", async () => {
    send("project-a", threadA, "route wording Alpha");
    send("project-a", threadB, "route wording beta");

    const found = await getHistory("project-a", "?query=ALPHA");
    expect(found.status).toBe(200);
    const foundBody = await found.json() as InputHistorySearchResponse;
    expect(foundBody.entries.map((entry: InputHistoryEntryDto) => entry.content))
      .toEqual(["route wording Alpha"]);
    expect(foundBody.lastClearedAt).toBeNull();

    const cleared = await deleteHistory("project-a");
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ cleared: true, clearedAt: NOW });

    const after = await getHistory("project-a");
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ entries: [], lastClearedAt: NOW });
  });

  it("rejects unknown query keys, fragments, and duplicate or over-long query params", async () => {
    for (const suffix of ["?unknown=1", "#fragment", "?query=a&query=b"]) {
      const response = await getHistory("project-a", suffix);
      expect(response.status, suffix).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    }
    const tooLong = await getHistory(
      "project-a",
      `?query=${encodeURIComponent("a".repeat(201))}`,
    );
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: { query: "too_long" },
        message: "Input history input is invalid.",
      },
    });
  });

  it("rejects query keys and fragments on DELETE", async () => {
    for (const suffix of ["?query=a", "#fragment"]) {
      const response = await deleteHistory("project-a", suffix);
      expect(response.status, suffix).toBe(400);
    }
  });

  it.each(["bad%2Fproject", "..", "bad project"])(
    "rejects malformed project path id %s",
    async (projectId) => {
      const response = await getHistory(projectId);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    },
  );

  it("uses identical safe 404s for unknown projects", async () => {
    const get = await getHistory("unknown-project");
    const cleared = await deleteHistory("unknown-project");
    expect([get.status, cleared.status]).toEqual([404, 404]);
    expect(await get.json()).toEqual(await cleared.json());
    expect(await getHistory("unknown-project").then((r) => r.json())).toEqual({
      error: { code: "RESOURCE_NOT_FOUND", message: "Resource was not found." },
    });
  });
});

describe("input history recording opt-out", () => {
  it("skips the history entry but still writes the message and clears the draft when recordInputHistory is false", () => {
    saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [],
      content: "Draft to clear",
      replyToMessageId: null,
    });

    const written = writeOwnerThreadMessage(databasePath, "project-a", threadA, {
      content: "private wording",
      operationId: operationId(),
      recordInputHistory: false,
    });
    expect(written.status).toBe(201);

    expect(storedMessageContent("project-a", threadA)).toEqual(["private wording"]);
    expect(search("project-a")).toEqual({ entries: [], lastClearedAt: null });
    expect(historyRows()).toEqual([]);
    expect(readDraft("project-a", threadA)).toBeNull();
  });

  it("skips the history entry on run start when recordInputHistory is false", () => {
    saveThreadDraft(databasePath, "project-a", threadB, {
      attachments: [],
      content: "Run draft to clear",
      replyToMessageId: null,
    });

    const started = startThreadRun(databasePath, "project-a", threadB, {
      message: "quiet run start",
      operationId: operationId(),
      recordInputHistory: false,
    });
    expect(started.status).toBe(201);

    expect(search("project-a")).toEqual({ entries: [], lastClearedAt: null });
    expect(historyRows()).toEqual([]);
    expect(readDraft("project-a", threadB)).toBeNull();
  });

  it("records by default and treats an explicit true like an absent flag", () => {
    send("project-a", threadA, "default recording");
    vi.setSystemTime(new Date("2026-08-08T08:00:01.000Z"));
    writeOwnerThreadMessage(databasePath, "project-a", threadA, {
      content: "explicit recording",
      operationId: operationId(),
      recordInputHistory: true,
    });

    expect(search("project-a").entries.map((entry) => entry.content))
      .toEqual(["explicit recording", "default recording"]);
  });

  it("rejects a same-operation replay that flips the recording flag", () => {
    const operation = operationId();
    writeOwnerThreadMessage(databasePath, "project-a", threadA, {
      content: "flagged wording",
      operationId: operation,
      recordInputHistory: false,
    });

    const conflict = catchHistoryError(() =>
      writeOwnerThreadMessage(databasePath, "project-a", threadA, {
        content: "flagged wording",
        operationId: operation,
      })
    );
    expect(conflict).toMatchObject({ code: "OPERATION_CONFLICT", httpStatus: 409 });
    expect(historyRows()).toEqual([]);
  });

  it.each([
    { label: "message", run: () => writeOwnerThreadMessage(
      databasePath,
      "project-a",
      threadA,
      { content: "shape check", operationId: operationId(), recordInputHistory: "no" },
    ) },
    { label: "run start", run: () => startThreadRun(
      databasePath,
      "project-a",
      threadB,
      { message: "shape check", operationId: operationId(), recordInputHistory: 0 },
    ) },
  ])("rejects a non-boolean recordInputHistory on $label with a stable 400", ({ run }) => {
    const error = catchHistoryError(run);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      details: { fields: { recordInputHistory: "invalid_format" } },
      httpStatus: 400,
    });
    expect(historyRows()).toEqual([]);
    expect(storedMessageContent("project-a", threadA)).toEqual([]);
    expect(storedMessageContent("project-a", threadB)).toEqual([]);
  });
});
