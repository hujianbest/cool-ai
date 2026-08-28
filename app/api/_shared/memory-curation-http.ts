import { TextDecoder } from "node:util";

import { MemoryError } from "@/src/modules/knowledge-provenance";

const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const MAX_BODY_BYTES = 65_536;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;

function invalidResourceId(field: string): never {
  throw new MemoryError(
    "INVALID_INPUT",
    400,
    "Curation request is invalid.",
    [{ field, code: "invalid_format" }],
  );
}

export function parseCurationResourceId(value: string, field: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return invalidResourceId(field);
  }
  if (
    decoded === "."
    || decoded === ".."
    || decoded.includes("..")
    || decoded.includes("/")
    || decoded.includes("\\")
    || decoded.includes("\0")
    || !RESOURCE_ID.test(decoded)
  ) {
    return invalidResourceId(field);
  }
  return decoded;
}

export function requireNoCurationUrlSuffix(request: Request): void {
  const url = new URL(request.url);
  const fields: Array<{ field: string; code: string }> = [];
  if (url.hash) fields.push({ field: "fragment", code: "unknown" });
  for (const key of new Set(url.searchParams.keys())) {
    fields.push({ field: key, code: "unknown" });
  }
  if (fields.length > 0) {
    throw new MemoryError(
      "INVALID_INPUT",
      400,
      "Curation request is invalid.",
      fields,
    );
  }
}

export async function readStrictCurationJson(request: Request): Promise<unknown> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new MemoryError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "Content-Type must be application/json.",
    );
  }

  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null
    && (
      !DECIMAL_INTEGER.test(declaredLength)
      || Number(declaredLength) > MAX_BODY_BYTES
    )
  ) {
    throw new MemoryError(
      "BODY_TOO_LARGE",
      413,
      "Request body is too large.",
    );
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new MemoryError(
          "BODY_TOO_LARGE",
          413,
          "Request body is too large.",
        );
      }
      chunks.push(value);
    }
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new MemoryError(
      "INVALID_JSON",
      400,
      "Request body must be valid JSON.",
    );
  }
}
