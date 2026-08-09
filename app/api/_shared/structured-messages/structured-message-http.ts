import { join } from "node:path";
import { createHash } from "node:crypto";

import { z } from "zod";

import { collaborationErrorResponse } from "@/app/api/_shared/collaboration/collaboration-api";
import {
  inlineDecisionService,
  sqliteConnection,
  structuredMessageStore,
  verifiedSourceProjection,
} from "@/src/composition";
import {
  CollaborationError,
  type StructuredBlock,
} from "@/src/modules/public-collaboration";
import {
  ingestStructuredJson,
  type StructuredMessageSchema,
} from "@/src/modules/public-collaboration/internal/structured-message-codec";

type RouteContext = {
  params: Promise<Record<string, string>>;
};

type Tuple = {
  blockId: string;
  messageId: string;
  projectId: string;
  runId: string;
  threadId: string;
};

type BlockRow = {
  actorDisplayName: string;
  actorId: string | null;
  actorType: "owner" | "agent";
  blockRevision: number;
  blockSchemaVersion: number;
  blockType: string;
  currentStateVersion: number;
  payloadJson: string;
  sourceEntityVersion: string | null;
  sourceId: string;
  sourceKind: "artifact" | "execution" | "handoff" | "message";
  stateJson: string;
};

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const sourceRequestSchema = z.object({
  source: z.object({
    id: z.string().min(1).max(200),
    kind: z.enum(["artifact", "execution", "handoff", "message"]),
    version: z.string().nullable(),
  }).strict(),
}).strict();

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalid(fields?: Record<string, string>): never {
  throw new CollaborationError(
    "INVALID_INPUT",
    400,
    "Structured message input is invalid.",
    fields ? { fields } : {},
  );
}

function parseTuple(params: Record<string, string>): Tuple {
  const fields: Record<string, string> = {};
  const result = {} as Record<keyof Tuple, string>;
  for (const field of [
    "projectId",
    "threadId",
    "runId",
    "messageId",
    "blockId",
  ] as const) {
    const raw = params[field];
    let value = "";
    try {
      value = decodeURIComponent(raw ?? "");
    } catch {
      fields[field] = "invalid_format";
    }
    if (!RESOURCE_ID.test(value) || value.includes("/") || value.includes("\\")) {
      fields[field] = "invalid_format";
    }
    result[field] = value;
  }
  if (Object.keys(fields).length > 0) invalid(fields);
  return result;
}

function rejectQuery(request: Request): void {
  const url = new URL(request.url);
  if (url.search || url.hash) invalid({ query: "unknown" });
}

function blockRow(database: ReturnType<typeof sqliteConnection.openDatabase>, tuple: Tuple): BlockRow {
  const row = database.prepare(
    `SELECT b.block_type AS blockType,b.block_schema_version AS blockSchemaVersion,
            b.block_revision AS blockRevision,b.payload_json AS payloadJson,
            b.actor_type AS actorType,b.actor_id AS actorId,
            b.actor_display_name AS actorDisplayName,b.source_kind AS sourceKind,
            b.source_id AS sourceId,b.source_entity_version AS sourceEntityVersion,
            h.current_state_version AS currentStateVersion,s.state_json AS stateJson
     FROM structured_message_blocks b
     JOIN collaboration_messages m
       ON (m.project_id,m.thread_id,m.run_id,m.id)=
          (b.project_id,b.thread_id,b.run_id,b.message_id)
     JOIN collaboration_thread_facts f
       ON (f.project_id,f.thread_id,f.run_id,f.message_id)=
          (m.project_id,m.thread_id,m.run_id,m.id)
      AND f.type IN('owner_message','agent_message')
     JOIN structured_message_state_heads h
       ON (h.project_id,h.thread_id,h.block_id)=(b.project_id,b.thread_id,b.id)
     JOIN structured_message_state_revisions s
       ON (s.project_id,s.thread_id,s.block_id,s.state_version)=
          (h.project_id,h.thread_id,h.block_id,h.current_state_version)
     WHERE b.project_id=? AND b.thread_id=? AND b.run_id=?
       AND b.message_id=? AND b.id=?`,
  ).get(
    tuple.projectId,
    tuple.threadId,
    tuple.runId,
    tuple.messageId,
    tuple.blockId,
  ) as BlockRow | undefined;
  if (!row) {
    throw new CollaborationError("RESOURCE_NOT_FOUND", 404, "Resource was not found.");
  }
  return row;
}

function publicBlock(row: BlockRow): { block: Record<string, unknown>; payload?: StructuredBlock } {
  const decoded = structuredMessageStore.decodeStructuredBlockPayload(row.payloadJson);
  const common = {
    actor: {
      displayName: row.actorDisplayName,
      id: row.actorId,
      type: row.actorType,
    },
    blockRevision: row.blockRevision,
    blockSchemaVersion: row.blockSchemaVersion,
    blockType: row.blockType,
    source: {
      id: row.sourceId,
      kind: row.sourceKind,
      version: row.sourceEntityVersion,
    },
    stateVersion: row.currentStateVersion,
  };
  if (decoded.kind === "unknown-schema") {
    return { block: { ...common, kind: "unknown-schema" } };
  }
  if (decoded.kind === "invalid") {
    throw new CollaborationError(
      "STORAGE_UNAVAILABLE",
      503,
      "Structured message storage is invalid.",
    );
  }
  return {
    block: {
      ...common,
      kind: "known",
      payload: decoded.value,
      state: JSON.parse(row.stateJson),
    },
    payload: decoded.value,
  };
}

export async function structuredMessageBlockGet(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    rejectQuery(request);
    if (request.headers.has("content-type") || request.headers.has("content-length")) invalid();
    const tuple = parseTuple(await context.params);
    const database = sqliteConnection.openDatabase(databasePath());
    try {
      return Response.json({ block: publicBlock(blockRow(database, tuple)).block });
    } finally {
      database.close();
    }
  } catch (error) {
    return collaborationErrorResponse(error, "GET structured message block");
  }
}

async function parseSourceRequest(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new CollaborationError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "Content-Type must be application/json.",
    );
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  const schema: StructuredMessageSchema<z.infer<typeof sourceRequestSchema>> = {
    classify: () => "known",
    parse: (value) => sourceRequestSchema.parse(value),
    visibleText: () => [],
  };
  return ingestStructuredJson(bytes, {
    maxCanonicalBytes: 8 * 1024,
    maxWireBytes: 8 * 1024,
    schema,
  }).value;
}

export async function structuredMessageSourcePost(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    rejectQuery(request);
    const tuple = parseTuple(await context.params);
    const input = await parseSourceRequest(request);
    const database = sqliteConnection.openDatabase(databasePath());
    try {
      const row = blockRow(database, tuple);
      if (
        row.sourceId !== input.source.id
        || row.sourceKind !== input.source.kind
        || row.sourceEntityVersion !== input.source.version
      ) {
        throw new CollaborationError("RESOURCE_NOT_FOUND", 404, "Resource was not found.");
      }
      if (row.sourceKind === "message") {
        throw new CollaborationError(
          "ACTION_CONFLICT",
          409,
          "This source has no controlled navigation target.",
        );
      }
      const decoded = publicBlock(row);
      if (!decoded.payload) {
        throw new CollaborationError("RESOURCE_NOT_FOUND", 404, "Resource was not found.");
      }
      const block = decoded.payload;
      if (block.blockType === "diff_preview") {
        if (
          createHash("sha256").update(block.preview).digest("hex") !== block.previewHash
          || row.sourceId !== block.observationId
          || row.sourceEntityVersion !== block.observationHash
        ) {
          throw new CollaborationError(
            "STORAGE_UNAVAILABLE",
            503,
            "Structured message storage is invalid.",
          );
        }
        return Response.json({
          display: { preview: block.preview },
          navigation: {
            executionId: block.executionId,
            sourceId: block.observationId,
          },
          source: {
            id: block.observationId,
            kind: "execution",
            version: block.observationHash,
          },
        });
      }
      const sourceRef = block.blockType === "file_reference"
          ? {
              artifactHash: block.artifactHash,
              artifactId: block.artifactId,
              executionId: block.executionId,
              kind: "file" as const,
            }
          : block.blockType === "handoff_card"
            ? {
                factId: block.factId,
                kind: "handoff" as const,
                turnId: block.turnId,
              }
            : null;
      if (!sourceRef) {
        throw new CollaborationError("ACTION_CONFLICT", 409, "Source navigation is unavailable.");
      }
      const projection = verifiedSourceProjection.resolveVerifiedSource(database, tuple, sourceRef);
      return Response.json({
        display: projection.display,
        navigation: projection.navigation,
        source: projection.identity,
      });
    } finally {
      database.close();
    }
  } catch (error) {
    return collaborationErrorResponse(error, "POST structured message source");
  }
}

export async function inlineDecisionPost(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    rejectQuery(request);
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new CollaborationError(
        "UNSUPPORTED_MEDIA_TYPE",
        415,
        "Content-Type must be application/json.",
      );
    }
    const tuple = parseTuple(await context.params);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 32 * 1024) {
      throw new CollaborationError("BODY_TOO_LARGE", 413, "Request body is too large.");
    }
    const result = inlineDecisionService.decideInline(databasePath(), tuple, bytes);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(error, "POST inline decision");
  }
}

export async function inlineOperationGet(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    rejectQuery(request);
    if (request.headers.has("content-type") || request.headers.has("content-length")) invalid();
    const params = await context.params;
    const fields = parseTuple({
      ...params,
      blockId: params.operationId,
      messageId: params.operationId,
    });
    const result = inlineDecisionService.readInlineOperation(databasePath(), fields, params.operationId);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return collaborationErrorResponse(error, "GET inline decision operation");
  }
}
