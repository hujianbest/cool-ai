import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  clearThreadDraft,
  readThreadDraft,
  saveThreadDraft,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-draft-service";
import {
  createThread,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { CollaborationError } from "@/src/modules/public-collaboration";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type DraftRoute = {
  DELETE(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
  PUT(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

const draftRoutes = import.meta.glob<DraftRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/draft/route.ts",
);

const NOW = "2026-08-08T08:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 23).toString("base64url");
const SECRET_CONTENT = "token=sk-live-secret-123";

let databasePath: string;
let threadA: string;
let threadB: string;
let foreignThread: string;
let targetMessageId: string;
let otherThreadMessageId: string;
let foreignMessageId: string;

function seedProject(
  projectId: string,
  agentIds: [string, string],
  operationId: string,
): string {
  const database = openDatabase(databasePath);
  try {
    database.prepare(
      `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
       VALUES (?,?,?,NULL,NULL,1)`,
    ).run(projectId, projectId, NOW);
    const providerId = `provider-${projectId}`;
    const encrypted = createCredentialVault().encrypt(providerId, `key-${projectId}`);
    database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES (?,'Provider','http://localhost/v1','model',?,?,?,?,1,?,?,?,1,?,?)`,
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
  return createThread(databasePath, projectId, {
    memberAgentIds: agentIds,
    operationId,
    title: `Thread ${projectId}`,
  }).body.thread.id;
}

function draftRows(): unknown[] {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw.prepare("SELECT * FROM thread_drafts ORDER BY project_id,thread_id").all();
  } finally {
    raw.close();
  }
}

function storedDraft(projectId: string, threadId: string) {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw.prepare(
      `SELECT project_id AS projectId,thread_id AS threadId,content,
              attachments_json AS attachmentsJson,reply_to_message_id AS replyToMessageId,
              version,updated_at AS updatedAt
       FROM thread_drafts WHERE project_id=? AND thread_id=?`,
    ).get(projectId, threadId) as
      | {
          attachmentsJson: string;
          content: string;
          projectId: string;
          replyToMessageId: string | null;
          threadId: string;
          updatedAt: string;
          version: number;
        }
      | undefined;
  } finally {
    raw.close();
  }
}

function factCounts(projectId: string, threadId: string) {
  const database = openDatabase(databasePath);
  try {
    return database.prepare(
      `SELECT
         (SELECT count(*) FROM collaboration_messages
           WHERE project_id=? AND thread_id=?) AS messages,
         (SELECT count(*) FROM collaboration_thread_facts
           WHERE project_id=? AND thread_id=?) AS facts`,
    ).get(projectId, threadId, projectId, threadId);
  } finally {
    database.close();
  }
}

function catchDraftError(operation: () => unknown): CollaborationError {
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

async function draftRoute(): Promise<DraftRoute> {
  const load = draftRoutes[
    "../../../app/api/projects/[projectId]/threads/[threadId]/draft/route.ts"
  ];
  expect(load, "thread draft route must exist").toBeTypeOf("function");
  return load!();
}

async function putDraft(
  projectId: string,
  threadId: string,
  body: BodyInit,
  contentType = "application/json",
  urlSuffix = "",
): Promise<Response> {
  return (await draftRoute()).PUT(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/draft${urlSuffix}`,
      { body, headers: { "content-type": contentType }, method: "PUT" },
    ),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

async function getDraft(
  projectId: string,
  threadId: string,
  urlSuffix = "",
): Promise<Response> {
  return (await draftRoute()).GET(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/draft${urlSuffix}`,
    ),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

async function deleteDraft(
  projectId: string,
  threadId: string,
  urlSuffix = "",
): Promise<Response> {
  return (await draftRoute()).DELETE(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/draft${urlSuffix}`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  process.env.COCKPIT_DB_PATH = databasePath;
  threadA = seedProject("project-a", ["agent-a", "agent-b"], "00000000-0000-4000-8000-000000004101");
  threadB = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000004102",
    title: "Thread B",
  }).body.thread.id;
  foreignThread = seedProject("project-b", ["agent-c", "agent-d"], "00000000-0000-4000-8000-000000004103");
  targetMessageId = writeOwnerThreadMessage(databasePath, "project-a", threadA, {
    content: "Target message",
    operationId: "00000000-0000-4000-8000-000000004104",
  }).body.message.id;
  otherThreadMessageId = writeOwnerThreadMessage(databasePath, "project-a", threadB, {
    content: "Other thread message",
    operationId: "00000000-0000-4000-8000-000000004105",
  }).body.message.id;
  foreignMessageId = writeOwnerThreadMessage(databasePath, "project-b", foreignThread, {
    content: "Foreign message",
    operationId: "00000000-0000-4000-8000-000000004106",
  }).body.message.id;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("thread draft command/query seam", () => {
  it("returns null for a thread without a draft", () => {
    expect(readThreadDraft(databasePath, "project-a", threadA)).toEqual({
      body: { draft: null },
      status: 200,
    });
  });

  it("round-trips content, attachment placeholders, and the reply link verbatim", () => {
    const saved = saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [{ name: "notes.txt", size: 128 }],
      content: "  Draft text with  padding  ",
      replyToMessageId: targetMessageId,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      contentSaved: true,
      draft: {
        attachments: [{ name: "notes.txt", size: 128 }],
        content: "  Draft text with  padding  ",
        projectId: "project-a",
        replyToMessageId: targetMessageId,
        threadId: threadA,
        updatedAt: NOW,
        version: 1,
      },
    });
    expect(readThreadDraft(databasePath, "project-a", threadA).body).toEqual({
      draft: saved.body.draft,
    });
    const stored = storedDraft("project-a", threadA);
    expect(stored?.attachmentsJson).toBe('[{"name":"notes.txt","size":128}]');
    expect(stored?.content).toBe("  Draft text with  padding  ");
  });

  it("round-trips uploaded attachment references carrying attachmentId", () => {
    const saved = saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [
        { attachmentId: "att-1", name: "photo.png", size: 2048 },
        { name: "legacy.txt", size: 12 },
      ],
      content: "Mixed draft",
      replyToMessageId: null,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.draft.attachments).toEqual([
      { attachmentId: "att-1", name: "photo.png", size: 2048 },
      { name: "legacy.txt", size: 12 },
    ]);
    expect(readThreadDraft(databasePath, "project-a", threadA).body).toEqual({
      draft: saved.body.draft,
    });
    const stored = storedDraft("project-a", threadA);
    expect(stored?.attachmentsJson).toBe(
      '[{"attachmentId":"att-1","name":"photo.png","size":2048},{"name":"legacy.txt","size":12}]',
    );
  });

  it("overwrites the draft, increments the version, and honors an explicit null reply link", () => {
    saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [{ name: "first.png", size: 10 }],
      content: "First",
      replyToMessageId: targetMessageId,
    });
    const overwritten = saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [],
      content: "Second",
      replyToMessageId: null,
    });
    expect(overwritten.body.contentSaved).toBe(true);
    expect(overwritten.body.draft).toMatchObject({
      attachments: [],
      content: "Second",
      replyToMessageId: null,
      updatedAt: NOW,
      version: 2,
    });
    expect(readThreadDraft(databasePath, "project-a", threadA).body.draft)
      .toEqual(overwritten.body.draft);
  });

  it("clears the draft idempotently within the tuple", () => {
    saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [],
      content: "To clear",
      replyToMessageId: null,
    });
    expect(clearThreadDraft(databasePath, "project-a", threadA)).toEqual({
      body: { cleared: true },
      status: 200,
    });
    expect(readThreadDraft(databasePath, "project-a", threadA).body).toEqual({ draft: null });
    expect(clearThreadDraft(databasePath, "project-a", threadA)).toEqual({
      body: { cleared: true },
      status: 200,
    });
    expect(draftRows()).toEqual([]);
  });

  it("keeps drafts isolated per thread within the same project", () => {
    saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [],
      content: "Thread A draft",
      replyToMessageId: null,
    });
    expect(readThreadDraft(databasePath, "project-a", threadB).body).toEqual({ draft: null });
    saveThreadDraft(databasePath, "project-a", threadB, {
      attachments: [],
      content: "Thread B draft",
      replyToMessageId: null,
    });
    expect(readThreadDraft(databasePath, "project-a", threadA).body.draft)
      .toMatchObject({ content: "Thread A draft", version: 1 });
    expect(readThreadDraft(databasePath, "project-a", threadB).body.draft)
      .toMatchObject({ content: "Thread B draft", version: 1 });
  });

  it("never persists credential-like content but keeps placeholders and the reply link", () => {
    const saved = saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [{ name: "leak.txt", size: 64 }],
      content: SECRET_CONTENT,
      replyToMessageId: targetMessageId,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      contentSaved: false,
      draft: {
        attachments: [{ name: "leak.txt", size: 64 }],
        content: "",
        projectId: "project-a",
        replyToMessageId: targetMessageId,
        threadId: threadA,
        updatedAt: NOW,
        version: 1,
      },
    });
    expect(readThreadDraft(databasePath, "project-a", threadA).body.draft)
      .toEqual(saved.body.draft);
    const stored = storedDraft("project-a", threadA);
    expect(stored?.content).toBe("");
    expect(stored?.attachmentsJson).not.toContain("sk-live-secret-123");
  });

  it("skips content matching a configured provider key", () => {
    const saved = saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [],
      content: "the provider key is key-project-a exactly",
      replyToMessageId: null,
    });
    expect(saved.body.contentSaved).toBe(false);
    expect(saved.body.draft.content).toBe("");
    expect(storedDraft("project-a", threadA)?.content).toBe("");
  });

  it("replaces previously stored content with an empty placeholder on a sensitive overwrite", () => {
    saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [],
      content: "Clean draft",
      replyToMessageId: null,
    });
    const overwritten = saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [],
      content: SECRET_CONTENT,
      replyToMessageId: null,
    });
    expect(overwritten.body).toMatchObject({ contentSaved: false });
    expect(overwritten.body.draft).toMatchObject({ content: "", version: 2 });
    expect(storedDraft("project-a", threadA)?.content).toBe("");
  });

  it("rejects missing, cross-thread, and cross-project reply targets with one stable envelope", () => {
    for (const replyToMessageId of ["missing-message", otherThreadMessageId, foreignMessageId]) {
      const error = catchDraftError(() => saveThreadDraft(databasePath, "project-a", threadA, {
        attachments: [],
        content: "Reply draft",
        replyToMessageId,
      }));
      expect(error).toMatchObject({
        code: "INVALID_INPUT",
        details: { fields: { replyToMessageId: "not_found" } },
        httpStatus: 400,
        message: "Thread draft input is invalid.",
      });
    }
    expect(draftRows()).toEqual([]);
  });

  it("uses identical safe 404s for unknown and cross-project tuples with zero writes", () => {
    saveThreadDraft(databasePath, "project-b", foreignThread, {
      attachments: [],
      content: "Foreign draft",
      replyToMessageId: null,
    });
    const unknownSave = catchDraftError(() => saveThreadDraft(
      databasePath,
      "project-a",
      "unknown-thread",
      { attachments: [], content: "No", replyToMessageId: null },
    ));
    const crossSave = catchDraftError(() => saveThreadDraft(
      databasePath,
      "project-a",
      foreignThread,
      { attachments: [], content: "No", replyToMessageId: null },
    ));
    const unknownRead = catchDraftError(() => readThreadDraft(
      databasePath,
      "project-a",
      "unknown-thread",
    ));
    const crossRead = catchDraftError(() => readThreadDraft(
      databasePath,
      "project-a",
      foreignThread,
    ));
    const unknownClear = catchDraftError(() => clearThreadDraft(
      databasePath,
      "project-a",
      "unknown-thread",
    ));
    const crossClear = catchDraftError(() => clearThreadDraft(
      databasePath,
      "project-a",
      foreignThread,
    ));
    for (const error of [unknownSave, crossSave, unknownRead, crossRead, unknownClear, crossClear]) {
      expect(error).toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        httpStatus: 404,
        message: "Resource was not found.",
      });
    }
    expect(readThreadDraft(databasePath, "project-b", foreignThread).body.draft)
      .toMatchObject({ content: "Foreign draft", version: 1 });
    expect(draftRows()).toHaveLength(1);
  });

  it.each([
    [null, { input: "invalid_format" }, "null input"],
    [[], { input: "invalid_format" }, "array input"],
    [{ attachments: [], replyToMessageId: null }, { content: "required" }, "missing content"],
    [{ content: "x", replyToMessageId: null }, { attachments: "required" }, "missing attachments"],
    [{ content: "x", attachments: [] }, { replyToMessageId: "required" }, "missing replyToMessageId"],
    [
      { attachments: [], content: "x", extra: true, replyToMessageId: null },
      { extra: "unknown" },
      "unknown key",
    ],
    [
      { attachments: [], content: 42, replyToMessageId: null },
      { content: "invalid_format" },
      "non-string content",
    ],
    [
      { attachments: [], content: "a".repeat(10_001), replyToMessageId: null },
      { content: "too_long" },
      "content over 10000 graphemes",
    ],
    [
      { attachments: {}, content: "x", replyToMessageId: null },
      { attachments: "invalid_format" },
      "non-array attachments",
    ],
    [
      { attachments: [{ name: "a.txt", size: 1, type: "text/plain" }], content: "x", replyToMessageId: null },
      { attachments: "invalid_format" },
      "attachment with extra key",
    ],
    [
      { attachments: [{ name: "a.txt" }], content: "x", replyToMessageId: null },
      { attachments: "invalid_format" },
      "attachment missing size",
    ],
    [
      { attachments: [{ attachmentId: 7, name: "a.txt", size: 1 }], content: "x", replyToMessageId: null },
      { attachments: "invalid_format" },
      "non-string attachmentId",
    ],
    [
      { attachments: [{ attachmentId: "bad id", name: "a.txt", size: 1 }], content: "x", replyToMessageId: null },
      { attachments: "invalid_format" },
      "malformed attachmentId",
    ],
    [
      { attachments: [{ attachmentId: "att-1", name: "a.txt", size: 1, extra: true }], content: "x", replyToMessageId: null },
      { attachments: "invalid_format" },
      "attachment reference with extra key",
    ],
    [
      { attachments: [{ name: "", size: 1 }], content: "x", replyToMessageId: null },
      { attachments: "invalid_format" },
      "empty attachment name",
    ],
    [
      { attachments: [{ name: "a".repeat(256), size: 1 }], content: "x", replyToMessageId: null },
      { attachments: "invalid_format" },
      "attachment name over 255 graphemes",
    ],
    [
      { attachments: [{ name: "a.txt", size: -1 }], content: "x", replyToMessageId: null },
      { attachments: "invalid_format" },
      "negative attachment size",
    ],
    [
      { attachments: [{ name: "a.txt", size: 1.5 }], content: "x", replyToMessageId: null },
      { attachments: "invalid_format" },
      "non-integer attachment size",
    ],
    [
      {
        attachments: Array.from({ length: 9 }, (_, index) => ({ name: `f${index}.txt`, size: 1 })),
        content: "x",
        replyToMessageId: null,
      },
      { attachments: "invalid_range" },
      "more than 8 attachments",
    ],
    [
      { attachments: [], content: "x", replyToMessageId: "bad id" },
      { replyToMessageId: "invalid_format" },
      "malformed replyToMessageId",
    ],
    [
      { attachments: [], content: "x", replyToMessageId: 7 },
      { replyToMessageId: "invalid_format" },
      "non-string replyToMessageId",
    ],
  ])("rejects invalid draft input: %s", (input, fields, _label) => {
    const error = catchDraftError(() => saveThreadDraft(
      databasePath,
      "project-a",
      threadA,
      input,
    ));
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      details: { fields },
      httpStatus: 400,
      message: "Thread draft input is invalid.",
    });
    expect(draftRows()).toEqual([]);
  });

  it("accepts the exact content, attachment count, and name boundaries", () => {
    const saved = saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [
        { name: "a".repeat(255), size: 0 },
        ...Array.from({ length: 7 }, (_, index) => ({ name: `f${index}.txt`, size: 1 })),
      ],
      content: "a".repeat(10_000),
      replyToMessageId: null,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.draft.attachments).toHaveLength(8);
    expect(saved.body.draft.content).toHaveLength(10_000);
  });

  it("does not append messages or facts when saving or clearing a draft", () => {
    const before = factCounts("project-a", threadA);
    saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [],
      content: "Silent draft",
      replyToMessageId: null,
    });
    clearThreadDraft(databasePath, "project-a", threadA);
    expect(factCounts("project-a", threadA)).toEqual(before);
  });
});

describe("thread draft reply edge reopen validation", () => {
  function expectReopenFailClosed(): void {
    const before = draftRows();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => openDatabase(databasePath).close()).toThrowError(
        expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }),
      );
    }
    expect(draftRows()).toEqual(before);
  }

  it("keeps a legal draft graph stable and idempotent across repeated reopen", () => {
    saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [{ name: "notes.txt", size: 128 }],
      content: "Stable draft",
      replyToMessageId: targetMessageId,
    });
    const first = readThreadDraft(databasePath, "project-a", threadA).body;
    for (let reopen = 0; reopen < 2; reopen += 1) {
      openDatabase(databasePath).close();
      expect(readThreadDraft(databasePath, "project-a", threadA).body).toEqual(first);
    }
  });

  it("fails closed when the draft reply target is missing from the tuple", () => {
    saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [],
      content: "Reply draft",
      replyToMessageId: targetMessageId,
    });
    corrupt(
      "UPDATE thread_drafts SET reply_to_message_id=? WHERE project_id=? AND thread_id=?",
      "00000000-0000-4000-8000-000000004999",
      "project-a",
      threadA,
    );
    expectReopenFailClosed();
  });

  it("fails closed when the draft reply target lives in another thread", () => {
    saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [],
      content: "Reply draft",
      replyToMessageId: targetMessageId,
    });
    corrupt(
      "UPDATE thread_drafts SET reply_to_message_id=? WHERE project_id=? AND thread_id=?",
      otherThreadMessageId,
      "project-a",
      threadA,
    );
    expectReopenFailClosed();
  });

  it("keeps reopening cleanly when the reply link is null", () => {
    saveThreadDraft(databasePath, "project-a", threadA, {
      attachments: [],
      content: "No reply",
      replyToMessageId: null,
    });
    openDatabase(databasePath).close();
    expect(readThreadDraft(databasePath, "project-a", threadA).body.draft)
      .toMatchObject({ content: "No reply", replyToMessageId: null });
  });
});

describe("thread draft route", () => {
  const VALID_INPUT = {
    attachments: [{ name: "notes.txt", size: 128 }],
    content: "Route draft",
    replyToMessageId: null,
  };

  it("round-trips a draft through PUT, GET, and DELETE", async () => {
    const put = await putDraft("project-a", threadA, JSON.stringify(VALID_INPUT));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      contentSaved: true,
      draft: {
        attachments: [{ name: "notes.txt", size: 128 }],
        content: "Route draft",
        projectId: "project-a",
        replyToMessageId: null,
        threadId: threadA,
        updatedAt: NOW,
        version: 1,
      },
    });

    const get = await getDraft("project-a", threadA);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({
      draft: {
        attachments: [{ name: "notes.txt", size: 128 }],
        content: "Route draft",
        projectId: "project-a",
        replyToMessageId: null,
        threadId: threadA,
        updatedAt: NOW,
        version: 1,
      },
    });

    const cleared = await deleteDraft("project-a", threadA);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ cleared: true });
    expect(await (await getDraft("project-a", threadA)).json()).toEqual({ draft: null });
  });

  it("returns the neutral contentSaved signal for sensitive content over the route", async () => {
    const put = await putDraft("project-a", threadA, JSON.stringify({
      ...VALID_INPUT,
      content: SECRET_CONTENT,
    }));
    expect(put.status).toBe(200);
    expect((await put.json()).contentSaved).toBe(false);
    const get = await getDraft("project-a", threadA);
    expect((await get.json()).draft.content).toBe("");
    expect(storedDraft("project-a", threadA)?.content).toBe("");
  });

  it("enforces content type, valid JSON, and the 65536-byte body limit on PUT", async () => {
    const unsupported = await putDraft("project-a", threadA, "{}", "text/plain");
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });
    const malformed = await putDraft("project-a", threadA, "{");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "INVALID_JSON" } });
    const oversized = await putDraft("project-a", threadA, JSON.stringify({
      attachments: [],
      content: "a".repeat(65_536),
      replyToMessageId: null,
    }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });
    expect(draftRows()).toEqual([]);
  });

  it("rejects an invalid draft body with a stable 400 envelope", async () => {
    const response = await putDraft("project-a", threadA, JSON.stringify({
      attachments: [],
      content: "x",
      replyToMessageId: null,
      unexpected: true,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: { unexpected: "unknown" },
        message: "Thread draft input is invalid.",
      },
    });
    expect(draftRows()).toEqual([]);
  });

  it.each([
    ["bad%2Fproject", "thread"],
    ["project-a", "bad%5Cthread"],
    ["project-a", ".."],
  ])("rejects malformed project/thread path IDs", async (projectId, threadId) => {
    const response = await putDraft(projectId, threadId, JSON.stringify(VALID_INPUT));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("rejects query keys and fragments on all three methods", async () => {
    for (const suffix of ["?unknown=1", "#fragment"]) {
      const put = await putDraft("project-a", threadA, JSON.stringify(VALID_INPUT), "application/json", suffix);
      expect(put.status).toBe(400);
      const get = await getDraft("project-a", threadA, suffix);
      expect(get.status).toBe(400);
      const cleared = await deleteDraft("project-a", threadA, suffix);
      expect(cleared.status).toBe(400);
    }
    expect(draftRows()).toEqual([]);
  });

  it("uses identical safe 404s for unknown and cross-project tuples", async () => {
    const unknownGet = await getDraft("project-a", "unknown-thread");
    const crossGet = await getDraft("project-a", foreignThread);
    expect([unknownGet.status, crossGet.status]).toEqual([404, 404]);
    const bodies = await Promise.all([unknownGet.json(), crossGet.json()]);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toEqual({
      error: { code: "RESOURCE_NOT_FOUND", message: "Resource was not found." },
    });

    const unknownPut = await putDraft("project-a", "unknown-thread", JSON.stringify(VALID_INPUT));
    const crossPut = await putDraft("project-a", foreignThread, JSON.stringify(VALID_INPUT));
    expect([unknownPut.status, crossPut.status]).toEqual([404, 404]);
    const unknownDelete = await deleteDraft("project-a", "unknown-thread");
    const crossDelete = await deleteDraft("project-a", foreignThread);
    expect([unknownDelete.status, crossDelete.status]).toEqual([404, 404]);
    expect(draftRows()).toEqual([]);
  });
});
