import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  uploadAttachment,
} from "@/src/adapters/outbound/sqlite/public-collaboration/attachment-service";
import {
  createThread,
  readThreadFacts,
  readThreadMessages,
  startThreadRun,
  writeOwnerThreadMessage,
  type ThreadMessageWriteHooks,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { CollaborationError } from "@/src/modules/public-collaboration";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type ContentRoute = {
  GET(
    request: Request,
    context: {
      params: Promise<{ attachmentId: string; projectId: string; threadId: string }>;
    },
  ): Promise<Response>;
};

type MessageRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

const contentRoutes = import.meta.glob<ContentRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/attachments/[attachmentId]/content/route.ts",
);
const messageRoutes = import.meta.glob<MessageRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/messages/route.ts",
);

const NOW = "2026-08-10T00:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 29).toString("base64url");
const OPERATION = "00000000-0000-4000-8000-000000006201";

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const GIF_BYTES = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00,
]);
const JPEG_BYTES = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

let databasePath: string;
let attachmentsRoot: string;
let threadA: string;
let threadB: string;
let foreignThread: string;

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

function upload(
  fileName: string,
  bytes: Uint8Array<ArrayBuffer>,
  threadId: string,
  projectId = "project-a",
) {
  const result = uploadAttachment(databasePath, attachmentsRoot, projectId, threadId, {
    bytes,
    fileName,
  });
  expect(result.status).toBe(201);
  return result.body.attachment;
}

function writeMessage(
  input: Record<string, unknown>,
  hooks: ThreadMessageWriteHooks = {},
  threadId: string = threadA,
) {
  return writeOwnerThreadMessage(databasePath, "project-a", threadId, input, hooks);
}

function attachmentRow(attachmentId: string) {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw.prepare(
      `SELECT status,message_id AS messageId,linked_at AS linkedAt
       FROM message_attachments WHERE id=?`,
    ).get(attachmentId) as
      | { linkedAt: string | null; messageId: string | null; status: string }
      | undefined;
  } finally {
    raw.close();
  }
}

function eventRows(): Array<{ attachmentId: string; type: string }> {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw.prepare(
      `SELECT attachment_id AS attachmentId,type
       FROM attachment_events ORDER BY rowid`,
    ).all() as Array<{ attachmentId: string; type: string }>;
  } finally {
    raw.close();
  }
}

function messageRows(): Array<{ content: string; id: string }> {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw.prepare(
      "SELECT id,content FROM collaboration_messages ORDER BY rowid",
    ).all() as Array<{ content: string; id: string }>;
  } finally {
    raw.close();
  }
}

function operationCount(): number {
  const raw = new DatabaseSync(databasePath);
  try {
    return (raw.prepare(
      "SELECT count(*) AS count FROM collaboration_operations WHERE kind='message'",
    ).get() as { count: number }).count;
  } finally {
    raw.close();
  }
}

function catchCollaborationError(operation: () => unknown): CollaborationError {
  try {
    operation();
  } catch (error) {
    if (error instanceof CollaborationError) return error;
    throw error;
  }
  throw new Error("EXPECTED_COLLABORATION_ERROR");
}

function attachmentsOf(message: unknown): unknown {
  return (message as { attachments?: unknown }).attachments;
}

async function contentRoute(): Promise<ContentRoute> {
  const load = contentRoutes[
    "../../../app/api/projects/[projectId]/threads/[threadId]/attachments/[attachmentId]/content/route.ts"
  ];
  expect(load, "attachment content route must exist").toBeTypeOf("function");
  return load!();
}

async function messageRoute(): Promise<MessageRoute> {
  const load = messageRoutes[
    "../../../app/api/projects/[projectId]/threads/[threadId]/messages/route.ts"
  ];
  expect(load, "thread messages route must exist").toBeTypeOf("function");
  return load!();
}

async function getContent(
  projectId: string,
  threadId: string,
  attachmentId: string,
  urlSuffix = "",
): Promise<Response> {
  return (await contentRoute()).GET(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/attachments/${attachmentId}/content${urlSuffix}`,
      { method: "GET" },
    ),
    { params: Promise.resolve({ attachmentId, projectId, threadId }) },
  );
}

async function postMessage(
  projectId: string,
  threadId: string,
  input: Record<string, unknown>,
): Promise<Response> {
  return (await messageRoute()).POST(
    new Request(`http://localhost/api/projects/${projectId}/threads/${threadId}/messages`, {
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

function expectSanitized(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(attachmentsRoot);
  expect(serialized).not.toContain(process.cwd());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  attachmentsRoot = mkdtempSync(join(tmpdir(), "cool-ai-attachments-"));
  temporaryDirectories.push(attachmentsRoot);
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_ATTACHMENTS_ROOT = attachmentsRoot;
  threadA = seedProject(
    "project-a",
    ["agent-a", "agent-b"],
    "00000000-0000-4000-8000-000000006101",
  );
  threadB = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000006102",
    title: "Thread B",
  }).body.thread.id;
  foreignThread = seedProject(
    "project-b",
    ["agent-c", "agent-d"],
    "00000000-0000-4000-8000-000000006103",
  );
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_ATTACHMENTS_ROOT;
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 3, recursive: true, retryDelay: 20 });
  }
});

describe("thread message command attachment linking", () => {
  it("links uploaded attachments atomically and returns them on the message DTO", () => {
    const png = upload("photo.png", PNG_BYTES, threadA);
    const gif = upload("anim.gif", GIF_BYTES, threadA);

    const result = writeMessage({
      attachmentIds: [png.id, gif.id],
      content: "see these",
      operationId: OPERATION,
    });

    expect(result.status).toBe(201);
    const refs = [
      {
        fileName: "photo.png",
        id: png.id,
        mimeType: "image/png",
        size: PNG_BYTES.byteLength,
      },
      {
        fileName: "anim.gif",
        id: gif.id,
        mimeType: "image/gif",
        size: GIF_BYTES.byteLength,
      },
    ];
    expect(attachmentsOf(result.body.message)).toEqual(refs);
    expect(attachmentsOf(result.body.fact.message)).toEqual(refs);
    expect(attachmentRow(png.id)).toEqual({
      linkedAt: NOW,
      messageId: result.body.message.id,
      status: "linked",
    });
    expect(attachmentRow(gif.id)).toEqual({
      linkedAt: NOW,
      messageId: result.body.message.id,
      status: "linked",
    });
    expect(eventRows()).toEqual([
      { attachmentId: png.id, type: "uploaded" },
      { attachmentId: gif.id, type: "uploaded" },
      { attachmentId: png.id, type: "linked" },
      { attachmentId: gif.id, type: "linked" },
    ]);
  });

  it("keeps the attachments array present and empty when a message has none", () => {
    const result = writeMessage({ content: "plain", operationId: OPERATION });
    expect(result.status).toBe(201);
    expect(attachmentsOf(result.body.message)).toEqual([]);

    const page = readThreadMessages(databasePath, "project-a", threadA);
    expect(page.body.items).toHaveLength(1);
    expect(attachmentsOf(page.body.items[0])).toEqual([]);

    const facts = readThreadFacts(databasePath, "project-a", threadA);
    const messageFact = facts.body.items.find((fact) => fact.type === "owner_message");
    expect(attachmentsOf(messageFact?.message)).toEqual([]);
  });

  it("surfaces linked attachments on read messages and fact read paths", () => {
    const jpeg = upload("photo.jpg", JPEG_BYTES, threadA);
    writeMessage({
      attachmentIds: [jpeg.id],
      content: "look",
      operationId: OPERATION,
    });

    const page = readThreadMessages(databasePath, "project-a", threadA);
    expect(page.body.items).toHaveLength(1);
    expect(attachmentsOf(page.body.items[0])).toEqual([
      {
        fileName: "photo.jpg",
        id: jpeg.id,
        mimeType: "image/jpeg",
        size: JPEG_BYTES.byteLength,
      },
    ]);

    const facts = readThreadFacts(databasePath, "project-a", threadA);
    const messageFact = facts.body.items.find((fact) => fact.type === "owner_message");
    expect(attachmentsOf(messageFact?.message)).toEqual([
      {
        fileName: "photo.jpg",
        id: jpeg.id,
        mimeType: "image/jpeg",
        size: JPEG_BYTES.byteLength,
      },
    ]);
  });

  it("rejects malformed attachmentIds shapes with a stable field error", () => {
    const png = upload("photo.png", PNG_BYTES, threadA);
    const cases: Array<{ attachmentIds: unknown; field: string; label: string }> = [
      { attachmentIds: "not-an-array", field: "invalid_format", label: "non-array" },
      { attachmentIds: [png.id, 42], field: "invalid_format", label: "non-string entry" },
      { attachmentIds: [png.id, "../escape"], field: "invalid_format", label: "illegal id shape" },
      { attachmentIds: [png.id, png.id], field: "invalid_format", label: "duplicate id" },
      {
        attachmentIds: [png.id, png.id, png.id, png.id, png.id],
        field: "too_many_items",
        label: "more than four",
      },
      {
        attachmentIds: ["00000000-0000-4000-8000-00000000ffff"],
        field: "not_found",
        label: "unknown id",
      },
    ];
    let operation = 0;
    for (const { attachmentIds, field, label } of cases) {
      operation += 1;
      const error = catchCollaborationError(() =>
        writeMessage({
          attachmentIds,
          content: `case ${label}`,
          operationId: `00000000-0000-4000-8000-0000000062${String(10 + operation)}`,
        }));
      expect(error.code, label).toBe("INVALID_INPUT");
      expect(error.httpStatus, label).toBe(400);
      expect(error.details, label).toEqual({ fields: { attachmentIds: field } });
    }
    expect(messageRows()).toEqual([]);
    expect(attachmentRow(png.id)).toEqual({
      linkedAt: null,
      messageId: null,
      status: "uploaded",
    });
    expect(eventRows()).toEqual([{ attachmentId: png.id, type: "uploaded" }]);
  });

  it("rejects cross-tuple attachment ids as not found", () => {
    const otherThread = upload("other.png", PNG_BYTES, threadB);
    const foreign = upload("foreign.png", GIF_BYTES, foreignThread, "project-b");
    for (const [index, id] of [otherThread.id, foreign.id].entries()) {
      const error = catchCollaborationError(() =>
        writeMessage({
          attachmentIds: [id],
          content: "cross tuple",
          operationId: `00000000-0000-4000-8000-0000000063${String(10 + index)}`,
        }));
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.details).toEqual({ fields: { attachmentIds: "not_found" } });
    }
    expect(messageRows()).toEqual([]);
  });

  it("rejects an attachment already linked to another message", () => {
    const png = upload("photo.png", PNG_BYTES, threadA);
    writeMessage({
      attachmentIds: [png.id],
      content: "first",
      operationId: OPERATION,
    });
    const error = catchCollaborationError(() =>
      writeMessage({
        attachmentIds: [png.id],
        content: "second",
        operationId: "00000000-0000-4000-8000-000000006202",
      }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.httpStatus).toBe(400);
    expect(error.details).toEqual({ fields: { attachmentIds: "already_linked" } });
    expect(messageRows()).toHaveLength(1);
  });

  it("rejects attachmentIds on run start with a neutral unknown field", () => {
    const error = catchCollaborationError(() =>
      startThreadRun(databasePath, "project-a", threadA, {
        attachmentIds: ["00000000-0000-4000-8000-00000000aaaa"],
        message: "go",
        operationId: OPERATION,
      }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.details).toEqual({ fields: { attachmentIds: "unknown" } });
  });

  it("replays the same operation without duplicating message, links, or events", () => {
    const png = upload("photo.png", PNG_BYTES, threadA);
    const input = {
      attachmentIds: [png.id],
      content: "see",
      operationId: OPERATION,
    };
    const first = writeMessage(input);
    const second = writeMessage(input);
    expect(second.status).toBe(201);
    expect(second.body.message.id).toBe(first.body.message.id);
    expect(attachmentsOf(second.body.message)).toEqual(attachmentsOf(first.body.message));
    expect(messageRows()).toHaveLength(1);
    expect(eventRows()).toEqual([
      { attachmentId: png.id, type: "uploaded" },
      { attachmentId: png.id, type: "linked" },
    ]);
    expect(operationCount()).toBe(1);
  });

  it("rejects the same operation id with a different attachment set", () => {
    const png = upload("photo.png", PNG_BYTES, threadA);
    const gif = upload("anim.gif", GIF_BYTES, threadA);
    writeMessage({
      attachmentIds: [png.id],
      content: "see",
      operationId: OPERATION,
    });
    const error = catchCollaborationError(() =>
      writeMessage({
        attachmentIds: [gif.id],
        content: "see",
        operationId: OPERATION,
      }));
    expect(error.code).toBe("OPERATION_CONFLICT");
    expect(error.httpStatus).toBe(409);
    expect(messageRows()).toHaveLength(1);
    expect(attachmentRow(gif.id)?.status).toBe("uploaded");
  });

  it.each(["after_message", "after_attachment_link", "after_fact"] as const)(
    "rolls the whole link transaction back when a fault hits %s",
    (point) => {
      const png = upload("photo.png", PNG_BYTES, threadA);
      expect(() =>
        writeMessage(
          {
            attachmentIds: [png.id],
            content: "will fail",
            operationId: OPERATION,
          },
          {
            fault: (at) => {
              if (at === point) throw new Error(`INJECTED_${point}`);
            },
          },
        )).toThrow(`INJECTED_${point}`);
      expect(messageRows()).toEqual([]);
      expect(attachmentRow(png.id)).toEqual({
        linkedAt: null,
        messageId: null,
        status: "uploaded",
      });
      expect(eventRows()).toEqual([{ attachmentId: png.id, type: "uploaded" }]);
      expect(operationCount()).toBe(0);
    },
  );

  it("carries attachmentIds through the POST messages route", async () => {
    const png = upload("photo.png", PNG_BYTES, threadA);
    const response = await postMessage("project-a", threadA, {
      attachmentIds: [png.id],
      content: "route message",
      operationId: OPERATION,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.message.attachments).toEqual([
      {
        fileName: "photo.png",
        id: png.id,
        mimeType: "image/png",
        size: PNG_BYTES.byteLength,
      },
    ]);
  });

  it("returns a stable field error from the route for an unknown attachment id", async () => {
    const response = await postMessage("project-a", threadA, {
      attachmentIds: ["00000000-0000-4000-8000-00000000ffff"],
      content: "route message",
      operationId: OPERATION,
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.fields).toEqual({ attachmentIds: "not_found" });
    expectSanitized(body);
  });
});

describe("attachment content delivery route", () => {
  it("delivers linked bytes with a whitelisted type, nosniff, and private caching", async () => {
    const png = upload("photo.png", PNG_BYTES, threadA);
    writeMessage({
      attachmentIds: [png.id],
      content: "see",
      operationId: OPERATION,
    });

    const response = await getContent("project-a", threadA, png.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, immutable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(PNG_BYTES);
  });

  it("answers a neutral 404 for unknown, orphan, and cross-tuple attachments", async () => {
    const orphan = upload("orphan.png", PNG_BYTES, threadA);
    const linked = upload("linked.png", GIF_BYTES, threadA);
    writeMessage({
      attachmentIds: [linked.id],
      content: "see",
      operationId: OPERATION,
    });

    const cases: Array<[string, string, string, string]> = [
      ["unknown id", "project-a", threadA, "00000000-0000-4000-8000-00000000ffff"],
      ["uploaded orphan", "project-a", threadA, orphan.id],
      ["other thread", "project-a", threadB, linked.id],
      ["other project", "project-b", foreignThread, linked.id],
    ];
    for (const [label, projectId, threadId, attachmentId] of cases) {
      const response = await getContent(projectId, threadId, attachmentId);
      expect(response.status, label).toBe(404);
      const body = await response.json();
      expect(body.error.code, label).toBe("RESOURCE_NOT_FOUND");
      expectSanitized(body);
    }
  });

  it("fails closed with a sanitized error when linked bytes are missing on disk", async () => {
    const png = upload("photo.png", PNG_BYTES, threadA);
    writeMessage({
      attachmentIds: [png.id],
      content: "see",
      operationId: OPERATION,
    });
    rmSync(join(attachmentsRoot, "project-a", png.id));

    const response = await getContent("project-a", threadA, png.id);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("STORAGE_UNAVAILABLE");
    expectSanitized(body);
  });

  it("rejects query suffixes on the content route", async () => {
    const png = upload("photo.png", PNG_BYTES, threadA);
    writeMessage({
      attachmentIds: [png.id],
      content: "see",
      operationId: OPERATION,
    });
    const response = await getContent("project-a", threadA, png.id, "?download=1");
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.fields).toEqual({ download: "unknown" });
  });

  it("keeps the linked file readable for every supported format", async () => {
    const fixtures = [
      ["photo.png", PNG_BYTES, "image/png"],
      ["photo.jpg", JPEG_BYTES, "image/jpeg"],
      ["anim.gif", GIF_BYTES, "image/gif"],
    ] as const;
    for (const [index, [fileName, bytes, mimeType]] of fixtures.entries()) {
      const attachment = upload(fileName, bytes, threadA);
      writeMessage(
        {
          attachmentIds: [attachment.id],
          content: `message ${index}`,
          operationId: `00000000-0000-4000-8000-0000000064${String(10 + index)}`,
        },
      );
      const response = await getContent("project-a", threadA, attachment.id);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(mimeType);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    }
  });

  it("keeps bytes on disk untouched by message linking", () => {
    const png = upload("photo.png", PNG_BYTES, threadA);
    writeMessage({
      attachmentIds: [png.id],
      content: "see",
      operationId: OPERATION,
    });
    expect(readFileSync(join(attachmentsRoot, "project-a", png.id))).toEqual(
      Buffer.from(PNG_BYTES),
    );
  });
});
