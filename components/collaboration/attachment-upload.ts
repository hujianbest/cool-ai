import type { ThreadMessageAttachmentRefDto } from "@/src/shared/collaboration-contracts";

export const COMPOSER_ATTACHMENT_MAX_COUNT = 4;
export const COMPOSER_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const COMPOSER_ATTACHMENT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export class AttachmentUploadError extends Error {
  constructor() {
    super("Attachment upload failed.");
    this.name = "AttachmentUploadError";
  }
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      Object.keys(value).every((key) => keys.includes(key)),
  );
}

function parseUploadResponse(
  payload: unknown,
  projectId: string,
  threadId: string,
): ThreadMessageAttachmentRefDto {
  if (!exactKeys(payload, ["attachment", "reused"]) || typeof payload.reused !== "boolean") {
    throw new AttachmentUploadError();
  }
  const attachment = payload.attachment;
  if (
    !exactKeys(attachment, [
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
    ])
    || attachment.projectId !== projectId
    || attachment.threadId !== threadId
    || attachment.status !== "uploaded"
    || attachment.messageId !== null
    || attachment.linkedAt !== null
    || typeof attachment.id !== "string"
    || typeof attachment.fileName !== "string"
    || !Number.isSafeInteger(attachment.size)
    || !COMPOSER_ATTACHMENT_MIME_TYPES.has(String(attachment.mimeType))
  ) {
    throw new AttachmentUploadError();
  }
  return {
    fileName: attachment.fileName,
    id: attachment.id,
    mimeType: attachment.mimeType as ThreadMessageAttachmentRefDto["mimeType"],
    size: Number(attachment.size),
  };
}

export type AttachmentUploadHandle = {
  abort: () => void;
  promise: Promise<ThreadMessageAttachmentRefDto>;
};

export function uploadThreadAttachment(input: {
  file: File;
  onProgress?: (ratio: number) => void;
  projectId: string;
  threadId: string;
}): AttachmentUploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<ThreadMessageAttachmentRefDto>((resolve, reject) => {
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        input.onProgress?.(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new AttachmentUploadError());
        return;
      }
      try {
        resolve(parseUploadResponse(
          JSON.parse(xhr.responseText) as unknown,
          input.projectId,
          input.threadId,
        ));
      } catch {
        reject(new AttachmentUploadError());
      }
    };
    xhr.onerror = () => reject(new AttachmentUploadError());
    xhr.onabort = () => reject(new AttachmentUploadError());
  });
  xhr.open(
    "POST",
    `/api/projects/${encodeURIComponent(input.projectId)}/threads/${encodeURIComponent(input.threadId)}/attachments?name=${encodeURIComponent(input.file.name)}`,
  );
  xhr.setRequestHeader("content-type", input.file.type || "application/octet-stream");
  xhr.send(input.file);
  return { abort: () => xhr.abort(), promise };
}
