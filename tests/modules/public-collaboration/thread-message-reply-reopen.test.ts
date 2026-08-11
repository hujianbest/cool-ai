import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";
import {
  createThread,
  readThreadMessages,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-08T08:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 29).toString("base64url");
const MISSING_MESSAGE = "00000000-0000-4000-8000-000000003999";

let databasePath: string;
let threadId: string;
let otherThreadId: string;
let targetMessageId: string;
let replyMessageId: string;
let otherThreadMessageId: string;

function replyEdges() {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw.prepare(
      `SELECT project_id AS projectId, thread_id AS threadId, id,
              reply_to_message_id AS replyToMessageId,
              reply_to_sequence AS replyToSequence,
              reply_to_author_display_name AS replyToAuthorDisplayName,
              reply_to_excerpt AS replyToExcerpt
       FROM collaboration_messages ORDER BY project_id, thread_id, sequence`,
    ).all();
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
  const before = replyEdges();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    expect(() => openDatabase(databasePath).close()).toThrowError(
      expect.objectContaining<Partial<SchemaError>>({ code: "SCHEMA_DATA_INVALID" }),
    );
  }
  const raw = new DatabaseSync(databasePath);
  try {
    expect(raw.isTransaction).toBe(false);
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 18 });
  } finally {
    raw.close();
  }
  expect(replyEdges()).toEqual(before);
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  const database = openDatabase(databasePath);
  try {
    database.prepare(
      `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
       VALUES ('project-a','Project A',?,NULL,NULL,1)`,
    ).run(NOW);
    const encrypted = createCredentialVault().encrypt("provider-a", "key-a");
    database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES ('provider-a','Provider','http://localhost/v1','model',?,?,?,?,1,?,?,?,1,?,?)`,
    ).run(
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
       ) VALUES (?,?,'Peer','Prompt','provider-a','model','A','sage',
         1,1,0,1000,3,1,?,?,0)`,
    );
    const insertMember = database.prepare(
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES ('project-a',?,?)",
    );
    for (const agentId of ["agent-a", "agent-b"]) {
      insertAgent.run(agentId, `Agent ${agentId}`, NOW, NOW);
      insertMember.run(agentId, NOW);
    }
  } finally {
    database.close();
  }
  threadId = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000003111",
    title: "Thread A",
  }).body.thread.id;
  otherThreadId = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000003112",
    title: "Thread B",
  }).body.thread.id;
  targetMessageId = writeOwnerThreadMessage(databasePath, "project-a", threadId, {
    content: "Target message",
    operationId: "00000000-0000-4000-8000-000000003101",
  }).body.message.id;
  writeOwnerThreadMessage(databasePath, "project-a", threadId, {
    content: "Middle message",
    operationId: "00000000-0000-4000-8000-000000003102",
  });
  replyMessageId = writeOwnerThreadMessage(databasePath, "project-a", threadId, {
    content: "Reply message",
    operationId: "00000000-0000-4000-8000-000000003103",
    replyToMessageId: targetMessageId,
  }).body.message.id;
  otherThreadMessageId = writeOwnerThreadMessage(databasePath, "project-a", otherThreadId, {
    content: "Other thread message",
    operationId: "00000000-0000-4000-8000-000000003104",
  }).body.message.id;
});

afterEach(() => {
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("reply edge reopen validation on a legal owner graph", () => {
  it("keeps legal reply graphs stable and idempotent across repeated reopen", () => {
    const first = readThreadMessages(databasePath, "project-a", threadId, {
      after: 0,
      limit: 50,
    }).body;
    expect(first.items.map((message) => message.replyTo)).toEqual([
      null,
      null,
      {
        authorDisplayName: "Owner",
        excerpt: "Target message",
        messageId: targetMessageId,
        sequence: 1,
      },
    ]);

    for (let reopen = 0; reopen < 2; reopen += 1) {
      const database = openDatabase(databasePath);
      try {
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 18 });
      } finally {
        database.close();
      }
      expect(
        readThreadMessages(databasePath, "project-a", threadId, { after: 0, limit: 50 }).body,
      ).toEqual(first);
    }
  });

  it("fails closed when the reply target is missing from the tuple", () => {
    corrupt(
      "UPDATE collaboration_messages SET reply_to_message_id=? WHERE id=?",
      MISSING_MESSAGE,
      replyMessageId,
    );
    expectReopenFailClosed();
  });

  it("fails closed when the reply target lives in another thread of the same project", () => {
    corrupt(
      "UPDATE collaboration_messages SET reply_to_message_id=? WHERE id=?",
      otherThreadMessageId,
      replyMessageId,
    );
    expectReopenFailClosed();
  });

  it("fails closed when a message replies to itself", () => {
    corrupt(
      `UPDATE collaboration_messages
       SET reply_to_message_id=id, reply_to_sequence=sequence,
           reply_to_author_display_name=author_display_name, reply_to_excerpt=content
       WHERE id=?`,
      replyMessageId,
    );
    expectReopenFailClosed();
  });

  it("fails closed when the frozen excerpt diverges from the target content", () => {
    corrupt(
      "UPDATE collaboration_messages SET reply_to_excerpt='tampered excerpt' WHERE id=?",
      replyMessageId,
    );
    expectReopenFailClosed();
  });

  it("fails closed when the frozen author display name diverges from the target", () => {
    corrupt(
      "UPDATE collaboration_messages SET reply_to_author_display_name='Forged Author' WHERE id=?",
      replyMessageId,
    );
    expectReopenFailClosed();
  });

  it("fails closed when the frozen sequence diverges from the target sequence", () => {
    corrupt(
      "UPDATE collaboration_messages SET reply_to_sequence=2 WHERE id=?",
      replyMessageId,
    );
    expectReopenFailClosed();
  });

  it("fails closed when the target sequence is not strictly before the message sequence", () => {
    corrupt(
      `UPDATE collaboration_messages
       SET reply_to_message_id=?, reply_to_sequence=3,
           reply_to_author_display_name='Owner', reply_to_excerpt='Reply message'
       WHERE id=?`,
      replyMessageId,
      targetMessageId,
    );
    expectReopenFailClosed();
  });

  it("fails closed when only some reply columns are cleared", () => {
    corrupt(
      "UPDATE collaboration_messages SET reply_to_excerpt=NULL WHERE id=?",
      replyMessageId,
    );
    expectReopenFailClosed();
  });

  it("fails closed when the reply target id is cleared but the snapshot remains", () => {
    corrupt(
      "UPDATE collaboration_messages SET reply_to_message_id=NULL WHERE id=?",
      replyMessageId,
    );
    expectReopenFailClosed();
  });
});
