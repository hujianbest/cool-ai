import { z } from "zod";

const encoder = new TextEncoder();

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function boundedUtf8(minimum: number, maximum: number, allowBlank = false) {
  return z.string().refine((value) => {
    const length = utf8Length(value);
    return length >= minimum
      && length <= maximum
      && (allowBlank || value.trim().length > 0);
  });
}

const pathSchema = boundedUtf8(1, 4_096);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const summarySchema = z.string()
  .min(1)
  .max(2_000)
  .refine((value) => value.trim().length > 0);

const listActionSchema = z.object({
  type: z.literal("list"),
  path: pathSchema,
}).strict();

const readActionSchema = z.object({
  type: z.literal("read"),
  path: pathSchema,
}).strict();

const writeActionSchema = z.object({
  type: z.literal("write"),
  path: pathSchema,
  content: z.string()
    .refine((value) => !value.includes("\u0000"))
    .refine((value) => utf8Length(value) <= 1_048_576),
  expectedHash: hashSchema.nullable(),
}).strict();

const commandActionSchema = z.object({
  type: z.literal("command"),
  executable: boundedUtf8(1, 4_096),
  args: z.array(boundedUtf8(0, 4_096, true))
    .max(64)
    .refine((args) => args.reduce((total, argument) => total + utf8Length(argument), 0) <= 32_768),
  workdir: pathSchema,
  expectedEffect: z.string()
    .min(1)
    .max(2_000)
    .refine((value) => value.trim().length > 0),
}).strict();

const stagedActionSchema = z.object({
  type: z.literal("staged"),
}).strict();

export const executionActionSchema = z.object({
  summary: summarySchema,
  action: z.discriminatedUnion("type", [
    listActionSchema,
    readActionSchema,
    writeActionSchema,
    commandActionSchema,
    stagedActionSchema,
  ]),
}).strict();

export type ExecutionAction = z.infer<typeof executionActionSchema>;
export type ExecutionPermissions = {
  execute: boolean;
  read: boolean;
  write: boolean;
};
export type ExecutionActionParseResult =
  | { success: true; action: ExecutionAction }
  | {
      success: false;
      action: null;
      reason: "invalid_schema" | "permission_denied";
      permission: "execute" | "read" | "write" | null;
    };

export const EXECUTION_ACTION_SCHEMA_INSTRUCTIONS = [
  "Return one strict JSON object and no surrounding prose.",
  'Top level: {"summary":string(1..2000),"action":Action}.',
  'Action is exactly one of {"type":"list","path":string(1..4096 UTF-8 bytes)}, {"type":"read","path":string(1..4096 UTF-8 bytes)}, {"type":"write","path":string(1..4096 UTF-8 bytes),"content":UTF-8 text(0..1048576 bytes, no NUL),"expectedHash":null|lowercase SHA-256}, {"type":"command","executable":string(1..4096 UTF-8 bytes),"args":string[0..64] (each 0..4096 UTF-8 bytes, total <=32768 UTF-8 bytes),"workdir":string(1..4096 UTF-8 bytes),"expectedEffect":string(1..2000)}, or {"type":"staged"}.',
  "summary and expectedEffect must contain visible non-whitespace text.",
  "Unknown keys are forbidden at every object level.",
].join("\n");

function requiredPermission(
  action: ExecutionAction["action"],
): keyof ExecutionPermissions | null {
  switch (action.type) {
    case "list":
    case "read":
      return "read";
    case "write":
      return "write";
    case "command":
      return "execute";
    case "staged":
      return null;
  }
}

export function parseExecutionActionContent(
  content: string,
  permissions: ExecutionPermissions,
): ExecutionActionParseResult {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return {
      success: false,
      action: null,
      reason: "invalid_schema",
      permission: null,
    };
  }

  const parsed = executionActionSchema.safeParse(value);
  if (!parsed.success) {
    return {
      success: false,
      action: null,
      reason: "invalid_schema",
      permission: null,
    };
  }

  const permission = requiredPermission(parsed.data.action);
  if (permission !== null && !permissions[permission]) {
    return {
      success: false,
      action: null,
      reason: "permission_denied",
      permission,
    };
  }
  return { success: true, action: parsed.data };
}
