import { createHash } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";

import canonicalize from "canonicalize";
import {
  getNodeValue,
  parseTree,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";

import { StructuredMessageCodecError } from "@/src/modules/public-collaboration/public/errors";
import { classifyPublicText } from "@/src/modules/public-collaboration/internal/public-text-credential-classifier";

export { StructuredMessageCodecError } from "@/src/modules/public-collaboration/public/errors";

const canonicalBytesBrand: unique symbol = Symbol("CanonicalUtf8Bytes");
const validatedValueBrand: unique symbol = Symbol("ValidatedValue");

export type CanonicalUtf8Bytes = Uint8Array & {
  readonly [canonicalBytesBrand]: true;
};

export type ValidatedValue<T> = T & {
  readonly [validatedValueBrand]: true;
};

export type StructuredMessageSchema<T> = {
  classify(value: unknown): "known" | "unknown-schema";
  parse(value: unknown): T;
  visibleText(value: T): readonly string[];
};

export type IngressOptions<T> = {
  configuredCredentialValues?: readonly string[];
  maxCanonicalBytes: number;
  maxWireBytes: number;
  schema: StructuredMessageSchema<T>;
};

export type PersistedDecode<T> =
  | { canonicalBytes: CanonicalUtf8Bytes; kind: "known"; value: ValidatedValue<T> }
  | { kind: "unknown-schema" }
  | { kind: "invalid" };

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

function fail(code: StructuredMessageCodecError["code"]): never {
  throw new StructuredMessageCodecError(code);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function wireText(raw: Uint8Array | string, maxWireBytes: number): string {
  let bytes: Uint8Array;
  let text: string;
  if (typeof raw === "string") {
    if (hasLoneSurrogate(raw)) fail("INVALID_I_JSON");
    bytes = utf8Encoder.encode(raw);
    text = raw;
  } else {
    bytes = raw;
    try {
      text = utf8Decoder.decode(raw);
    } catch {
      return fail("INVALID_I_JSON");
    }
  }
  if (bytes.byteLength > maxWireBytes) fail("WIRE_TOO_LARGE");
  if (
    text.startsWith("\uFEFF")
    || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    fail("INVALID_I_JSON");
  }
  return text;
}

function rejectDuplicateKeys(node: JsonNode): void {
  if (node.type === "object") {
    const names = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      if (!keyNode || typeof keyNode.value !== "string" || !valueNode) fail("INVALID_JSON");
      if (names.has(keyNode.value)) fail("DUPLICATE_KEY");
      names.add(keyNode.value);
      rejectDuplicateKeys(valueNode);
    }
    return;
  }
  if (node.type === "array") {
    for (const child of node.children ?? []) rejectDuplicateKeys(child);
  }
}

function validateNode(node: JsonNode, source: string): void {
  if (node.type === "object" || node.type === "array") {
    for (const child of node.children ?? []) {
      if (node.type === "object") {
        const keyNode = child.children?.[0];
        const valueNode = child.children?.[1];
        if (!keyNode || !valueNode || hasLoneSurrogate(String(keyNode.value))) {
          fail("INVALID_I_JSON");
        }
        validateNode(valueNode, source);
      } else {
        validateNode(child, source);
      }
    }
    return;
  }
  if (node.type === "string") {
    const decoded: unknown = JSON.parse(source.slice(node.offset, node.offset + node.length));
    if (typeof decoded !== "string" || hasLoneSurrogate(decoded)) fail("INVALID_I_JSON");
  }
  if (
    node.type === "number"
    && (typeof node.value !== "number"
      || !Number.isFinite(node.value)
      || Object.is(Number(source.slice(node.offset, node.offset + node.length)), -0))
  ) {
    fail("INVALID_I_JSON");
  }
}

function parseRaw(raw: Uint8Array | string, maxWireBytes: number): unknown {
  const text = wireText(raw, maxWireBytes);
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (!root || errors.length > 0) fail("INVALID_JSON");
  rejectDuplicateKeys(root);
  validateNode(root, text);
  return getNodeValue(root);
}

function brandBytes(bytes: Uint8Array): CanonicalUtf8Bytes {
  Object.defineProperty(bytes, canonicalBytesBrand, { value: true });
  return bytes as CanonicalUtf8Bytes;
}

function canonicalBytes(value: unknown, maximum: number): CanonicalUtf8Bytes {
  const canonical = canonicalize(value);
  if (canonical === undefined) fail("INVALID_I_JSON");
  const bytes = brandBytes(utf8Encoder.encode(canonical));
  if (bytes.byteLength > maximum) fail("CANONICAL_TOO_LARGE");
  return bytes;
}

function brandValue<T>(value: T): ValidatedValue<T> {
  if (!value || typeof value !== "object") fail("INVALID_SCHEMA");
  Object.defineProperty(value, validatedValueBrand, { value: true });
  return value as ValidatedValue<T>;
}

function validateKnown<T>(
  rawValue: unknown,
  options: IngressOptions<T>,
): { canonicalBytes: CanonicalUtf8Bytes; value: ValidatedValue<T> } {
  if (options.schema.classify(rawValue) !== "known") fail("INVALID_SCHEMA");
  let parsed: T;
  try {
    parsed = options.schema.parse(rawValue);
  } catch {
    return fail("INVALID_SCHEMA");
  }
  for (const text of options.schema.visibleText(parsed)) {
    const category = classifyPublicText(text, options.configuredCredentialValues ?? []);
    if (category) {
      throw new StructuredMessageCodecError("CREDENTIAL_CONTENT_REJECTED", category);
    }
  }
  const bytes = canonicalBytes(parsed, options.maxCanonicalBytes);
  return { canonicalBytes: bytes, value: brandValue(parsed) };
}

export function ingestStructuredJson<T>(
  raw: Uint8Array | string,
  options: IngressOptions<T>,
): { canonicalBytes: CanonicalUtf8Bytes; value: ValidatedValue<T> } {
  return validateKnown(parseRaw(raw, options.maxWireBytes), options);
}

export function canonicalizeStructuredJson(
  raw: Uint8Array | string,
  limits: { maxCanonicalBytes: number; maxWireBytes: number },
): CanonicalUtf8Bytes {
  return canonicalBytes(parseRaw(raw, limits.maxWireBytes), limits.maxCanonicalBytes);
}

export function parseCanonicalStructuredJson(
  raw: Uint8Array | string,
  limits: { maxCanonicalBytes: number; maxWireBytes: number },
): { canonicalBytes: CanonicalUtf8Bytes; value: unknown } {
  const value = parseRaw(raw, limits.maxWireBytes);
  return { canonicalBytes: canonicalBytes(value, limits.maxCanonicalBytes), value };
}

export function decodePersistedStructuredJson<T>(
  raw: Uint8Array | string,
  options: IngressOptions<T>,
): PersistedDecode<T> {
  try {
    const rawValue = parseRaw(raw, options.maxWireBytes);
    if (options.schema.classify(rawValue) === "unknown-schema") {
      return { kind: "unknown-schema" };
    }
    const known = validateKnown(rawValue, options);
    return { ...known, kind: "known" };
  } catch {
    return { kind: "invalid" };
  }
}

export function canonicalByteLength(bytes: CanonicalUtf8Bytes): number {
  return bytes.byteLength;
}

export function hashCanonicalBytes(bytes: CanonicalUtf8Bytes): string {
  return createHash("sha256").update(bytes).digest("hex");
}
