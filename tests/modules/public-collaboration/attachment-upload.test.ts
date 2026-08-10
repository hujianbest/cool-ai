import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  createThread,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { CollaborationError } from "@/src/modules/public-collaboration";
import type {
  AttachmentRemoveResponse,
  AttachmentUploadResponse,
} from "@/src/shared/collaboration-contracts";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type AttachmentService = {
  removeAttachment(
    databasePath: string,
    attachmentsRoot: string,
    projectId: string,
    threadId: string,
    attachmentId: string,
  ): { body: AttachmentRemoveResponse; status: 200 };
  uploadAttachment(
    databasePath: string,
    attachmentsRoot: string,
    projectId: string,
    threadId: string,
    input: { bytes: Uint8Array; fileName: unknown },
  ): { body: AttachmentUploadResponse; status: 200 | 201 };
};

type AttachmentsRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

type AttachmentItemRoute = {
  DELETE(
    request: Request,
    context: {
      params: Promise<{ attachmentId: string; projectId: string; threadId: string }>;
    },
  ): Promise<Response>;
};

const serviceModules = import.meta.glob<AttachmentService>(
  "../../../src/adapters/outbound/sqlite/public-collaboration/attachment-service.ts",
);
const attachmentsRoutes = import.meta.glob<AttachmentsRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/attachments/route.ts",
);
const attachmentItemRoutes = import.meta.glob<AttachmentItemRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/attachments/[attachmentId]/route.ts",
);

const NOW = "2026-08-10T00:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 23).toString("base64url");
const MAX_BYTES = 5 * 1024 * 1024;

// Deterministic minimal magic-byte fixtures; the service must treat these
// bytes as the only type fact (no full decode, no extension trust).
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG_BYTES = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const GIF_BYTES = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00,
]);
const WEBP_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x20,
]);
const TEXT_BYTES = new TextEncoder().encode("this is not an image at all");

let databasePath: string;
let attachmentsRoot: string;
let threadA: string;
let threadB: string;
let foreignThread: string;

const temporaryDirectories: string[] = [];

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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

async function attachmentService(): Promise<AttachmentService> {
  const load = serviceModules[
    "../../../src/adapters/outbound/sqlite/public-collaboration/attachment-service.ts"
  ];
  expect(load, "attachment service must exist").toBeTypeOf("function");
  return load!();
}

async function attachmentsRoute(): Promise<AttachmentsRoute> {
  const load = attachmentsRoutes[
    "../../../app/api/projects/[projectId]/threads/[threadId]/attachments/route.ts"
  ];
  expect(load, "attachments upload route must exist").toBeTypeOf("function");
  return load!();
}

async function attachmentItemRoute(): Promise<AttachmentItemRoute> {
  const load = attachmentItemRoutes[
    "../../../app/api/projects/[projectId]/threads/[threadId]/attachments/[attachmentId]/route.ts"
  ];
  expect(load, "attachment item route must exist").toBeTypeOf("function");
  return load!();
}

function attachmentRows(): unknown[] {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw.prepare(
      "SELECT * FROM message_attachments ORDER BY project_id,thread_id,id",
    ).all();
  } finally {
    raw.close();
  }
}

function eventRows(): Array<{
  attachmentId: string;
  projectId: string;
  threadId: string;
  type: string;
}> {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw.prepare(
      `SELECT project_id AS projectId,thread_id AS threadId,
              attachment_id AS attachmentId,type
       FROM attachment_events ORDER BY rowid`,
    ).all() as Array<{
      attachmentId: string;
      projectId: string;
      threadId: string;
      type: string;
    }>;
  } finally {
    raw.close();
  }
}

function storedFilePath(projectId: string, attachmentId: string): string {
  return join(attachmentsRoot, projectId, attachmentId);
}

function catchAttachmentError(operation: () => unknown): CollaborationError {
  try {
    operation();
  } catch (error) {
    if (error instanceof CollaborationError) return error;
    throw error;
  }
  throw new Error("EXPECTED_COLLABORATION_ERROR");
}

async function postAttachment(
  projectId: string,
  threadId: string,
  bytes: Uint8Array<ArrayBuffer>,
  options: {
    contentType?: string;
    name?: string;
    rawQuery?: string;
  } = {},
): Promise<Response> {
  const query = options.rawQuery ?? `?name=${encodeURIComponent(options.name ?? "image.png")}`;
  return (await attachmentsRoute()).POST(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/attachments${query}`,
      {
        body: bytes,
        headers: { "content-type": options.contentType ?? "image/png" },
        method: "POST",
      },
    ),
    { params: Promise.resolve({ projectId, threadId }) },
  );
}

async function deleteAttachment(
  projectId: string,
  threadId: string,
  attachmentId: string,
  urlSuffix = "",
): Promise<Response> {
  return (await attachmentItemRoute()).DELETE(
    new Request(
      `http://localhost/api/projects/${projectId}/threads/${threadId}/attachments/${attachmentId}${urlSuffix}`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ attachmentId, projectId, threadId }) },
  );
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
  threadA = seedProject("project-a", ["agent-a", "agent-b"], "00000000-0000-4000-8000-000000005101");
  threadB = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000005102",
    title: "Thread B",
  }).body.thread.id;
  foreignThread = seedProject("project-b", ["agent-c", "agent-d"], "00000000-0000-4000-8000-000000005103");
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

describe("attachment upload command seam", () => {
  it.each([
    ["photo.png", "image/png", PNG_BYTES],
    ["photo.jpg", "image/jpeg", JPEG_BYTES],
    ["photo.gif", "image/gif", GIF_BYTES],
    ["photo.webp", "image/webp", WEBP_BYTES],
  ] as const)(
    "uploads a valid %s with magic-derived type, row, audit event, and project-scoped bytes",
    async (fileName, mimeType, bytes) => {
      const service = await attachmentService();
      const result = service.uploadAttachment(
        databasePath,
        attachmentsRoot,
        "project-a",
        threadA,
        { bytes, fileName },
      );
      expect(result.status).toBe(201);
      const attachment = result.body.attachment;
      expect(result.body.reused).toBe(false);
      expect(attachment).toMatchObject({
        fileName,
        linkedAt: null,
        messageId: null,
        mimeType,
        projectId: "project-a",
        sha256: sha256Hex(bytes),
        size: bytes.byteLength,
        status: "uploaded",
        threadId: threadA,
      });
      expect(attachment.createdAt).toBe(NOW);
      expect(Object.keys(attachment).sort()).toEqual([
        "createdAt",
        "fileName",
        "id",
        "linkedAt",
        "messageId",
        "mimeType",
        "projectId",
        "sha256",
        "size",
        "status",
        "threadId",
      ]);

      const raw = new DatabaseSync(databasePath);
      try {
        const row = raw.prepare(
          `SELECT project_id AS projectId,thread_id AS threadId,message_id AS messageId,
                  file_name AS fileName,size,mime_type AS mimeType,sha256,
                  storage_relpath AS storageRelpath,status,created_at AS createdAt,
                  linked_at AS linkedAt
           FROM message_attachments WHERE id=?`,
        ).get(attachment.id) as Record<string, unknown>;
        expect(row).toMatchObject({
          createdAt: NOW,
          fileName,
          linkedAt: null,
          messageId: null,
          mimeType,
          projectId: "project-a",
          sha256: sha256Hex(bytes),
          size: bytes.byteLength,
          status: "uploaded",
          storageRelpath: `project-a/${attachment.id}`,
          threadId: threadA,
        });
      } finally {
        raw.close();
      }
      expect(readFileSync(storedFilePath("project-a", attachment.id))).toEqual(
        Buffer.from(bytes),
      );
      expect(eventRows()).toEqual([{
        attachmentId: attachment.id,
        projectId: "project-a",
        threadId: threadA,
        type: "uploaded",
      }]);
    },
  );

  it("derives the mime type from magic bytes even when the file name disagrees", async () => {
    const service = await attachmentService();
    const result = service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      { bytes: PNG_BYTES, fileName: "misleading.txt" },
    );
    expect(result.status).toBe(201);
    expect(result.body.attachment.mimeType).toBe("image/png");
    expect(result.body.attachment.fileName).toBe("misleading.txt");
  });

  it("reuses the existing attachment for the same thread and content hash", async () => {
    const service = await attachmentService();
    const first = service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      { bytes: PNG_BYTES, fileName: "first.png" },
    );
    const second = service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      { bytes: Uint8Array.from(PNG_BYTES), fileName: "second-name.png" },
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.attachment).toEqual(first.body.attachment);
    expect(attachmentRows()).toHaveLength(1);
    expect(eventRows()).toHaveLength(1);
  });

  it("stores the same content as distinct attachments in other threads and projects", async () => {
    const service = await attachmentService();
    const inThreadA = service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      { bytes: PNG_BYTES, fileName: "same.png" },
    ).body.attachment;
    const inThreadB = service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadB,
      { bytes: PNG_BYTES, fileName: "same.png" },
    ).body.attachment;
    const inForeign = service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-b",
      foreignThread,
      { bytes: PNG_BYTES, fileName: "same.png" },
    ).body.attachment;
    expect(new Set([inThreadA.id, inThreadB.id, inForeign.id]).size).toBe(3);
    expect(attachmentRows()).toHaveLength(3);
    expect(existsSync(storedFilePath("project-a", inThreadA.id))).toBe(true);
    expect(existsSync(storedFilePath("project-b", inForeign.id))).toBe(true);
  });

  it("rejects non-image bytes with a stable 400 and zero writes", async () => {
    const service = await attachmentService();
    const error = catchAttachmentError(() => service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      { bytes: TEXT_BYTES, fileName: "fake.png" },
    ));
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      details: { fields: { file: "unsupported_type" } },
      httpStatus: 400,
    });
    expect(error.message).not.toContain(attachmentsRoot);
    expect(attachmentRows()).toEqual([]);
    expect(eventRows()).toEqual([]);
    expect(existsSync(join(attachmentsRoot, "project-a"))).toBe(false);
  });

  it("rejects an empty body and bytes over 5 MiB with zero writes", async () => {
    const service = await attachmentService();
    const empty = catchAttachmentError(() => service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      { bytes: new Uint8Array(0), fileName: "empty.png" },
    ));
    expect(empty).toMatchObject({
      code: "INVALID_INPUT",
      details: { fields: { file: "required" } },
      httpStatus: 400,
    });
    const oversized = new Uint8Array(MAX_BYTES + 1);
    oversized.set(PNG_BYTES, 0);
    const tooLarge = catchAttachmentError(() => service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      { bytes: oversized, fileName: "huge.png" },
    ));
    expect(tooLarge).toMatchObject({ code: "BODY_TOO_LARGE", httpStatus: 413 });
    expect(attachmentRows()).toEqual([]);
  });

  it.each([
    ["", "empty name"],
    ["a".repeat(256), "name over 255 graphemes"],
    ["../escape.png", "name with traversal"],
    ["a/b.png", "name with slash"],
    ["a\\b.png", "name with backslash"],
    ["a\0b.png", "name with NUL"],
    [42, "non-string name"],
  ])("rejects an invalid file name: %s", async (fileName, _label) => {
    const service = await attachmentService();
    const error = catchAttachmentError(() => service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      { bytes: PNG_BYTES, fileName },
    ));
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      details: { fields: { name: "invalid_format" } },
      httpStatus: 400,
    });
    expect(attachmentRows()).toEqual([]);
  });

  it("uses identical safe 404s for unknown and cross-project threads with zero writes", async () => {
    const service = await attachmentService();
    const unknown = catchAttachmentError(() => service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      "unknown-thread",
      { bytes: PNG_BYTES, fileName: "x.png" },
    ));
    const cross = catchAttachmentError(() => service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      foreignThread,
      { bytes: PNG_BYTES, fileName: "x.png" },
    ));
    for (const error of [unknown, cross]) {
      expect(error).toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        httpStatus: 404,
        message: "Resource was not found.",
      });
    }
    expect(attachmentRows()).toEqual([]);
    expect(eventRows()).toEqual([]);
  });

  it("keeps uploaded attachments valid across database reopen", async () => {
    const service = await attachmentService();
    service.uploadAttachment(databasePath, attachmentsRoot, "project-a", threadA, {
      bytes: PNG_BYTES,
      fileName: "stable.png",
    });
    for (let reopen = 0; reopen < 2; reopen += 1) {
      openDatabase(databasePath).close();
    }
    expect(attachmentRows()).toHaveLength(1);
  });
});

describe("attachment remove command seam", () => {
  async function uploadPng(fileName = "orphan.png") {
    const service = await attachmentService();
    return service.uploadAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      { bytes: PNG_BYTES, fileName },
    ).body.attachment;
  }

  it("removes an uploaded orphan, deleting row and bytes while keeping the audit event", async () => {
    const service = await attachmentService();
    const attachment = await uploadPng();
    const removed = service.removeAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      attachment.id,
    );
    expect(removed).toEqual({ body: { removed: true }, status: 200 });
    expect(attachmentRows()).toEqual([]);
    expect(existsSync(storedFilePath("project-a", attachment.id))).toBe(false);
    expect(eventRows().map(({ type }) => type)).toEqual(["uploaded", "removed"]);
    expect(eventRows()[1]).toMatchObject({
      attachmentId: attachment.id,
      projectId: "project-a",
      threadId: threadA,
    });

    const again = catchAttachmentError(() => service.removeAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      attachment.id,
    ));
    expect(again).toMatchObject({ code: "RESOURCE_NOT_FOUND", httpStatus: 404 });
  });

  it("rejects removing an attachment once it is linked to a message", async () => {
    const service = await attachmentService();
    const attachment = await uploadPng();
    const messageId = writeOwnerThreadMessage(databasePath, "project-a", threadA, {
      content: "Message holding the attachment",
      operationId: "00000000-0000-4000-8000-000000005104",
    }).body.message.id;
    const raw = new DatabaseSync(databasePath);
    try {
      raw.prepare(
        `UPDATE message_attachments
         SET status='linked',message_id=?,linked_at=? WHERE id=?`,
      ).run(messageId, NOW, attachment.id);
    } finally {
      raw.close();
    }
    const error = catchAttachmentError(() => service.removeAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      attachment.id,
    ));
    expect(error).toMatchObject({ code: "ACTION_CONFLICT", httpStatus: 409 });
    expect(attachmentRows()).toHaveLength(1);
    expect(existsSync(storedFilePath("project-a", attachment.id))).toBe(true);
    expect(eventRows().map(({ type }) => type)).toEqual(["uploaded"]);
  });

  it("keeps the row and reports an error when the byte file cannot be deleted", async () => {
    const service = await attachmentService();
    const attachment = await uploadPng();
    const filePath = storedFilePath("project-a", attachment.id);
    rmSync(filePath);
    mkdirSync(filePath);
    const error = catchAttachmentError(() => service.removeAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      attachment.id,
    ));
    expect(error).toMatchObject({ code: "STORAGE_UNAVAILABLE", httpStatus: 503 });
    expect(error.message).not.toContain(attachmentsRoot);
    const raw = new DatabaseSync(databasePath);
    try {
      expect(raw.prepare(
        "SELECT status FROM message_attachments WHERE id=?",
      ).get(attachment.id)).toEqual({ status: "uploaded" });
    } finally {
      raw.close();
    }
    expect(eventRows().map(({ type }) => type)).toEqual(["uploaded"]);
    rmSync(filePath, { recursive: true });
  });

  it("uses identical safe 404s for unknown, cross-thread, and cross-project removal", async () => {
    const service = await attachmentService();
    const attachment = await uploadPng();
    const unknown = catchAttachmentError(() => service.removeAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadA,
      "00000000-0000-4000-8000-000000005998",
    ));
    const crossThread = catchAttachmentError(() => service.removeAttachment(
      databasePath,
      attachmentsRoot,
      "project-a",
      threadB,
      attachment.id,
    ));
    const crossProject = catchAttachmentError(() => service.removeAttachment(
      databasePath,
      attachmentsRoot,
      "project-b",
      foreignThread,
      attachment.id,
    ));
    for (const error of [unknown, crossThread, crossProject]) {
      expect(error).toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        httpStatus: 404,
        message: "Resource was not found.",
      });
    }
    expect(attachmentRows()).toHaveLength(1);
    expect(existsSync(storedFilePath("project-a", attachment.id))).toBe(true);
  });
});

describe("attachment routes", () => {
  it("round-trips an upload through POST and removes it through DELETE", async () => {
    const posted = await postAttachment("project-a", threadA, PNG_BYTES, {
      name: "roundtrip.png",
    });
    expect(posted.status).toBe(201);
    const body = await posted.json();
    expect(body.reused).toBe(false);
    expect(body.attachment).toMatchObject({
      fileName: "roundtrip.png",
      mimeType: "image/png",
      sha256: sha256Hex(PNG_BYTES),
      size: PNG_BYTES.byteLength,
      status: "uploaded",
    });
    expect(JSON.stringify(body)).not.toContain(attachmentsRoot);
    expect(body.attachment).not.toHaveProperty("storageRelpath");

    const reposted = await postAttachment("project-a", threadA, PNG_BYTES, {
      name: "again.png",
    });
    expect(reposted.status).toBe(200);
    expect((await reposted.json()).attachment.id).toBe(body.attachment.id);

    const removed = await deleteAttachment("project-a", threadA, body.attachment.id);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    expect(attachmentRows()).toEqual([]);
    expect(eventRows().map(({ type }) => type)).toEqual(["uploaded", "removed"]);
  });

  it("treats magic bytes as the only type fact over the wire", async () => {
    const posted = await postAttachment("project-a", threadA, JPEG_BYTES, {
      contentType: "image/png",
      name: "actually-jpeg.png",
    });
    expect(posted.status).toBe(201);
    expect((await posted.json()).attachment.mimeType).toBe("image/jpeg");
  });

  it("rejects a non-image Content-Type before reading the body", async () => {
    const response = await postAttachment("project-a", threadA, PNG_BYTES, {
      contentType: "application/octet-stream",
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });
    expect(attachmentRows()).toEqual([]);
  });

  it("rejects a missing, empty, or duplicated file name query", async () => {
    const missing = await postAttachment("project-a", threadA, PNG_BYTES, { rawQuery: "" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: { code: "INVALID_INPUT", fields: { name: "required" } },
    });
    const duplicated = await postAttachment("project-a", threadA, PNG_BYTES, {
      rawQuery: "?name=a.png&name=b.png",
    });
    expect(duplicated.status).toBe(400);
    const unknownKey = await postAttachment("project-a", threadA, PNG_BYTES, {
      rawQuery: "?name=a.png&path=/etc/passwd",
    });
    expect(unknownKey.status).toBe(400);
    expect(await unknownKey.json()).toMatchObject({
      error: { code: "INVALID_INPUT", fields: { path: "unknown" } },
    });
    expect(attachmentRows()).toEqual([]);
  });

  it("enforces the 5 MiB body limit with hard truncation protection", async () => {
    const oversized = new Uint8Array(MAX_BYTES + 1);
    oversized.set(PNG_BYTES, 0);
    const response = await postAttachment("project-a", threadA, oversized);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "BODY_TOO_LARGE" },
    });
    expect(attachmentRows()).toEqual([]);
    expect(existsSync(join(attachmentsRoot, "project-a"))).toBe(false);
  });

  it.each([
    ["bad%2Fproject", "thread", "slash in project id"],
    ["project-a", "..", "dot-dot thread id"],
  ])("rejects malformed path ids: %s / %s", async (projectId, threadId, _label) => {
    const response = await postAttachment(projectId, threadId, PNG_BYTES);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("uses identical safe 404s for unknown and cross-project tuples on POST and DELETE", async () => {
    const unknownPost = await postAttachment("project-a", "unknown-thread", PNG_BYTES);
    const crossPost = await postAttachment("project-a", foreignThread, PNG_BYTES);
    expect([unknownPost.status, crossPost.status]).toEqual([404, 404]);
    const bodies = await Promise.all([unknownPost.json(), crossPost.json()]);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toEqual({
      error: { code: "RESOURCE_NOT_FOUND", message: "Resource was not found." },
    });

    const unknownDelete = await deleteAttachment(
      "project-a",
      threadA,
      "00000000-0000-4000-8000-000000005997",
    );
    expect(unknownDelete.status).toBe(404);
    const queryDelete = await deleteAttachment(
      "project-a",
      threadA,
      "00000000-0000-4000-8000-000000005997",
      "?force=true",
    );
    expect(queryDelete.status).toBe(400);
    expect(attachmentRows()).toEqual([]);
  });

  it("never echoes the host storage path in error responses", async () => {
    const posted = await postAttachment("project-a", threadA, PNG_BYTES, {
      name: "kept.png",
    });
    const attachment = (await posted.json()).attachment;
    const filePath = storedFilePath("project-a", attachment.id);
    rmSync(filePath);
    mkdirSync(filePath);
    const failedDelete = await deleteAttachment("project-a", threadA, attachment.id);
    expect(failedDelete.status).toBe(503);
    const body = await failedDelete.json();
    expect(body).toMatchObject({ error: { code: "STORAGE_UNAVAILABLE" } });
    expect(JSON.stringify(body)).not.toContain(attachmentsRoot);
    rmSync(filePath, { recursive: true });
  });
});
