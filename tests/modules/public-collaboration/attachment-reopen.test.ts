import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";
import { uploadAttachment } from "@/src/adapters/outbound/sqlite/public-collaboration/attachment-service";
import {
  createThread,
  readThreadMessages,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-10T00:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 31).toString("base64url");
const MISSING_MESSAGE = "00000000-0000-4000-8000-000000007999";

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let databasePath: string;
let attachmentsRoot: string;
let threadId: string;
let otherThreadId: string;
let linkedAttachmentId: string;
let orphanAttachmentId: string;
let messageId: string;
let otherThreadMessageId: string;
let foreignThreadId: string;
let foreignMessageId: string;

const temporaryDirectories: string[] = [];

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

function attachmentEdges() {
  const raw = new DatabaseSync(databasePath);
  try {
    return {
      attachments: raw.prepare(
        `SELECT project_id AS projectId,thread_id AS threadId,id,
                message_id AS messageId,status,storage_relpath AS storageRelpath,
                created_at AS createdAt,linked_at AS linkedAt
         FROM message_attachments ORDER BY project_id,thread_id,id`,
      ).all(),
      events: raw.prepare(
        `SELECT project_id AS projectId,thread_id AS threadId,
                attachment_id AS attachmentId,type
         FROM attachment_events ORDER BY rowid`,
      ).all(),
    };
  } finally {
    raw.close();
  }
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

function expectReopenFailClosed(): void {
  const before = attachmentEdges();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    expect(() => openDatabase(databasePath).close()).toThrowError(
      expect.objectContaining<Partial<SchemaError>>({ code: "SCHEMA_DATA_INVALID" }),
    );
  }
  const raw = new DatabaseSync(databasePath);
  try {
    expect(raw.isTransaction).toBe(false);
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 20 });
  } finally {
    raw.close();
  }
  expect(attachmentEdges()).toEqual(before);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  attachmentsRoot = mkdtempSync(join(tmpdir(), "cool-ai-attachments-"));
  temporaryDirectories.push(attachmentsRoot);
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;

  threadId = seedProject(
    "project-a",
    ["agent-a", "agent-b"],
    "00000000-0000-4000-8000-000000007101",
  );
  otherThreadId = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000007102",
    title: "Thread B",
  }).body.thread.id;
  foreignThreadId = seedProject(
    "project-b",
    ["agent-c", "agent-d"],
    "00000000-0000-4000-8000-000000007103",
  );
  otherThreadMessageId = writeOwnerThreadMessage(
    databasePath,
    "project-a",
    otherThreadId,
    {
      content: "Other thread message",
      operationId: "00000000-0000-4000-8000-000000007104",
    },
  ).body.message.id;
  foreignMessageId = writeOwnerThreadMessage(
    databasePath,
    "project-b",
    foreignThreadId,
    {
      content: "Foreign message",
      operationId: "00000000-0000-4000-8000-000000007105",
    },
  ).body.message.id;

  const linked = uploadAttachment(databasePath, attachmentsRoot, "project-a", threadId, {
    bytes: PNG_BYTES,
    fileName: "linked.png",
  }).body.attachment;
  linkedAttachmentId = linked.id;
  messageId = writeOwnerThreadMessage(databasePath, "project-a", threadId, {
    attachmentIds: [linkedAttachmentId],
    content: "Message with image",
    operationId: "00000000-0000-4000-8000-000000007106",
  }).body.message.id;
  orphanAttachmentId = uploadAttachment(
    databasePath,
    attachmentsRoot,
    "project-a",
    threadId,
    { bytes: Uint8Array.from([...PNG_BYTES, 0x00]), fileName: "orphan.png" },
  ).body.attachment.id;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_MASTER_KEY;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 3, recursive: true, retryDelay: 20 });
  }
});

describe("attachment edge reopen validation on a legal owner graph", () => {
  it("keeps a legal linked/orphan graph stable and idempotent across repeated reopen", () => {
    const first = readThreadMessages(databasePath, "project-a", threadId, {
      after: 0,
      limit: 50,
    }).body;
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.attachments).toEqual([
      {
        fileName: "linked.png",
        id: linkedAttachmentId,
        mimeType: "image/png",
        size: PNG_BYTES.byteLength,
      },
    ]);

    for (let reopen = 0; reopen < 2; reopen += 1) {
      const database = openDatabase(databasePath);
      try {
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 20 });
      } finally {
        database.close();
      }
      expect(
        readThreadMessages(databasePath, "project-a", threadId, { after: 0, limit: 50 }).body,
      ).toEqual(first);
    }
  });

  it("fails closed when a linked attachment points at a message that does not exist", () => {
    corrupt(
      "UPDATE message_attachments SET message_id=? WHERE id=?",
      MISSING_MESSAGE,
      linkedAttachmentId,
    );
    expectReopenFailClosed();
  });

  it("fails closed when a linked attachment points at a message in another thread", () => {
    corrupt(
      "UPDATE message_attachments SET message_id=? WHERE id=?",
      otherThreadMessageId,
      linkedAttachmentId,
    );
    expectReopenFailClosed();
  });

  it("fails closed when a linked attachment points at a message in another project", () => {
    corrupt(
      "UPDATE message_attachments SET message_id=? WHERE id=?",
      foreignMessageId,
      linkedAttachmentId,
    );
    expectReopenFailClosed();
  });

  // The status machine is pinned by the table CHECK, so these combos are
  // unrepresentable at rest: the corruption write itself must fail closed and
  // the untouched graph must keep reopening.
  it.each([
    [
      "a linked attachment loses its message id",
      "UPDATE message_attachments SET message_id=NULL WHERE id=?",
      () => [linkedAttachmentId],
    ],
    [
      "a linked attachment loses its linked timestamp",
      "UPDATE message_attachments SET linked_at=NULL WHERE id=?",
      () => [linkedAttachmentId],
    ],
    [
      "an uploaded orphan gains a message id",
      "UPDATE message_attachments SET message_id=? WHERE id=?",
      () => [messageId, orphanAttachmentId],
    ],
    [
      "an uploaded orphan gains a linked timestamp",
      "UPDATE message_attachments SET linked_at=? WHERE id=?",
      () => [NOW, orphanAttachmentId],
    ],
  ] as const)("rejects the write when %s", (label, statement, params) => {
    void label;
    const before = attachmentEdges();
    expect(() => corrupt(statement, ...params())).toThrowError(/CHECK constraint/);
    expect(attachmentEdges()).toEqual(before);
    const database = openDatabase(databasePath);
    database.close();
  });

  it("fails closed when the linked timestamp predates the upload timestamp", () => {
    corrupt(
      "UPDATE message_attachments SET linked_at='2026-08-09T23:59:59.999Z' WHERE id=?",
      linkedAttachmentId,
    );
    expectReopenFailClosed();
  });

  it.each([
    ["a parent traversal", "../escape"],
    ["a nested traversal", "project-a/../../escape"],
    ["an absolute path", "/etc/passwd"],
    ["a backslash path", "project-a\\orphan.png"],
    ["a detached file name", "project-a/other-file"],
  ])("fails closed when storage_relpath is %s", (label, relpath) => {
    void label;
    corrupt(
      "UPDATE message_attachments SET storage_relpath=? WHERE id=?",
      relpath,
      orphanAttachmentId,
    );
    expectReopenFailClosed();
  });

  it("fails closed when an attachment row leaves its thread tuple", () => {
    corrupt(
      "UPDATE message_attachments SET thread_id=? WHERE id=?",
      otherThreadId,
      orphanAttachmentId,
    );
    expectReopenFailClosed();
  });
});
