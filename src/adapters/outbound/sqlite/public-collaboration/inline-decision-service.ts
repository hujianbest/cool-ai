import { randomUUID } from "node:crypto";

import { z } from "zod";

import { CollaborationError } from "@/src/modules/public-collaboration";
import { appendBatchTx } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-fact-store";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  hashCanonicalBytes,
  ingestStructuredJson,
  type StructuredMessageSchema,
} from "@/src/modules/public-collaboration/internal/structured-message-codec";

const operationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
const decisionRequestSchema = z.object({
  action: z.enum(["accept", "reject", "check_item", "uncheck_item"]),
  expectedStateVersion: z.number().int().min(1),
  itemId: z.string().min(1).max(200).optional(),
  operationId: operationIdSchema,
}).strict().superRefine((request, context) => {
  const itemAction = request.action === "check_item" || request.action === "uncheck_item";
  if (itemAction !== (request.itemId !== undefined)) {
    context.addIssue({ code: "custom", message: "itemId does not match action", path: ["itemId"] });
  }
});

type DecisionRequest = z.infer<typeof decisionRequestSchema>;
type DecisionTuple = {
  blockId: string;
  messageId: string;
  projectId: string;
  runId: string;
  threadId: string;
};

type BlockStateRow = {
  blockRevision: number;
  blockType: "proposal" | "checklist";
  currentStateVersion: number;
  payloadJson: string;
  stateJson: string;
};

type OperationRow = {
  httpStatus: number | null;
  kind: string;
  requestHash: string;
  responseJson: string | null;
  runId: string | null;
  status: "completed" | "pending" | "version_conflict";
  threadId: string;
};

type Dependencies = {
  afterStep?: (step: string) => void;
  clock: () => Date;
  randomUUID: () => string;
};

export const INLINE_DECISION_STEPS = [
  "state",
  "head",
  "operation",
  "decision",
  "receipt",
  "fact",
] as const;

const defaultDependencies: Dependencies = {
  clock: () => new Date(),
  randomUUID,
};

function invalid(): never {
  throw new CollaborationError("INVALID_INPUT", 400, "Inline Decision input is invalid.");
}

function notFound(): never {
  throw new CollaborationError("RESOURCE_NOT_FOUND", 404, "Resource was not found.");
}

function parseRequest(raw: string | Uint8Array): DecisionRequest {
  const schema: StructuredMessageSchema<DecisionRequest> = {
    classify: () => "known",
    parse: (value) => decisionRequestSchema.parse(value),
    visibleText: () => [],
  };
  try {
    return ingestStructuredJson(raw, {
      maxCanonicalBytes: 32 * 1024,
      maxWireBytes: 32 * 1024,
      schema,
    }).value;
  } catch {
    invalid();
  }
}

function blockState(
  database: ReturnType<typeof openDatabase>,
  tuple: DecisionTuple,
): BlockStateRow {
  const row = database.prepare(
    `SELECT b.block_type AS blockType,b.block_revision AS blockRevision,
            b.payload_json AS payloadJson,h.current_state_version AS currentStateVersion,
            s.state_json AS stateJson
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
       AND b.message_id=? AND b.id=? AND b.block_type IN('proposal','checklist')`,
  ).get(
    tuple.projectId,
    tuple.threadId,
    tuple.runId,
    tuple.messageId,
    tuple.blockId,
  ) as BlockStateRow | undefined;
  if (!row) notFound();
  return row;
}

function requestHash(
  tuple: DecisionTuple,
  blockRevision: number,
  request: DecisionRequest,
): string {
  const intent = {
    action: request.action,
    blockId: tuple.blockId,
    blockRevision,
    expectedStateVersion: request.expectedStateVersion,
    ...(request.itemId === undefined ? {} : { itemId: request.itemId }),
    messageId: tuple.messageId,
    projectId: tuple.projectId,
    runId: tuple.runId,
    threadId: tuple.threadId,
  };
  const intentSchema = z.object({
    action: z.string(),
    blockId: z.string(),
    blockRevision: z.number().int(),
    expectedStateVersion: z.number().int(),
    itemId: z.string().optional(),
    messageId: z.string(),
    projectId: z.string(),
    runId: z.string(),
    threadId: z.string(),
  }).strict();
  const schema: StructuredMessageSchema<z.infer<typeof intentSchema>> = {
    classify: () => "known",
    parse(value) {
      return intentSchema.parse(value);
    },
    visibleText: () => [],
  };
  const canonical = ingestStructuredJson(JSON.stringify(intent), {
    maxCanonicalBytes: 16 * 1024,
    maxWireBytes: 16 * 1024,
    schema,
  });
  return hashCanonicalBytes(canonical.canonicalBytes);
}

function existingOperation(
  database: ReturnType<typeof openDatabase>,
  tuple: DecisionTuple,
  operationId: string,
): OperationRow | undefined {
  return database.prepare(
    `SELECT kind,request_hash AS requestHash,status,http_status AS httpStatus,
            response_json AS responseJson,thread_id AS threadId,run_id AS runId
     FROM collaboration_operations WHERE project_id=? AND id=?`,
  ).get(tuple.projectId, operationId) as OperationRow | undefined;
}

function replay(
  row: OperationRow,
  tuple: DecisionTuple,
  hash: string,
): { body: unknown; status: number } {
  if (
    row.threadId !== tuple.threadId
    || row.runId !== tuple.runId
    || row.kind !== "inline_decision"
  ) notFound();
  if (row.requestHash !== hash) {
    throw new CollaborationError(
      "OPERATION_CONFLICT",
      409,
      "Operation id was already used for different input.",
    );
  }
  if (
    (row.status !== "completed" && row.status !== "version_conflict")
    || row.httpStatus === null
    || row.responseJson === null
  ) {
    throw new CollaborationError("OPERATION_IN_PROGRESS", 409, "Operation is still in progress.");
  }
  return { body: JSON.parse(row.responseJson), status: row.httpStatus };
}

function nextState(
  row: BlockStateRow,
  request: DecisionRequest,
): { itemId: string | null; json: string } {
  if (row.blockType === "proposal") {
    if (
      request.itemId !== undefined
      || (request.action !== "accept" && request.action !== "reject")
    ) invalid();
    const state = JSON.parse(row.stateJson) as { status?: unknown };
    if (state.status !== "pending") {
      throw new CollaborationError("ACTION_CONFLICT", 409, "Proposal is already terminal.");
    }
    return {
      itemId: null,
      json: JSON.stringify({ status: request.action === "accept" ? "accepted" : "rejected" }),
    };
  }
  if (
    request.itemId === undefined
    || (request.action !== "check_item" && request.action !== "uncheck_item")
  ) invalid();
  const state = JSON.parse(row.stateJson) as {
    items?: Array<{ checked: boolean; id: string }>;
  };
  if (!Array.isArray(state.items)) invalid();
  const index = state.items.findIndex(({ id }) => id === request.itemId);
  if (index < 0) invalid();
  const target = request.action === "check_item";
  if (state.items[index]?.checked === target) {
    throw new CollaborationError("ACTION_CONFLICT", 409, "Checklist item already has target state.");
  }
  return {
    itemId: request.itemId,
    json: JSON.stringify({
      items: state.items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, checked: target } : item),
    }),
  };
}

function versionConflictBody(currentStateVersion: number) {
  return {
    currentStateVersion,
    error: {
      code: "VERSION_CONFLICT",
      message: "Structured message state changed.",
    },
    kind: "version_conflict",
  };
}

export function decideInline(
  databasePath: string,
  tuple: DecisionTuple,
  raw: string | Uint8Array,
  dependencies: Dependencies = defaultDependencies,
): { body: unknown; status: number } {
  const request = parseRequest(raw);
  const database = openDatabase(databasePath);
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = blockState(database, tuple);
    const hash = requestHash(tuple, row.blockRevision, request);
    const prior = existingOperation(database, tuple, request.operationId);
    if (prior) {
      const result = replay(prior, tuple, hash);
      database.exec("COMMIT");
      return result;
    }
    const timestamp = dependencies.clock().toISOString();
    if (request.expectedStateVersion !== row.currentStateVersion) {
      const body = versionConflictBody(row.currentStateVersion);
      database.prepare(
        `INSERT INTO collaboration_operations(
           id,project_id,thread_id,run_id,kind,request_hash,status,http_status,
           response_json,response_schema_version,lease_applicability,lease_id,
           created_at,updated_at
         ) VALUES (?,?,?,?,'inline_decision',?,'version_conflict',409,?,8,
                   'not_applicable',NULL,?,?)`,
      ).run(
        request.operationId,
        tuple.projectId,
        tuple.threadId,
        tuple.runId,
        hash,
        JSON.stringify(body),
        timestamp,
        timestamp,
      );
      database.exec("COMMIT");
      return { body, status: 409 };
    }

    const state = nextState(row, request);
    const toStateVersion = row.currentStateVersion + 1;
    const decisionId = dependencies.randomUUID();
    const receiptId = dependencies.randomUUID();
    const factId = dependencies.randomUUID();
    database.prepare(
      `INSERT INTO structured_message_state_revisions(
         project_id,thread_id,block_id,state_version,prior_state_version,
         state_kind,state_json,created_at
       ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      tuple.projectId,
      tuple.threadId,
      tuple.blockId,
      toStateVersion,
      row.currentStateVersion,
      row.blockType,
      state.json,
      timestamp,
    );
    dependencies.afterStep?.("state");
    const head = database.prepare(
      `UPDATE structured_message_state_heads SET current_state_version=?
       WHERE project_id=? AND thread_id=? AND block_id=? AND current_state_version=?`,
    ).run(
      toStateVersion,
      tuple.projectId,
      tuple.threadId,
      tuple.blockId,
      row.currentStateVersion,
    );
    if (head.changes !== 1) {
      throw new CollaborationError("VERSION_CONFLICT", 409, "Structured message state changed.");
    }
    dependencies.afterStep?.("head");
    const receipt = {
      action: request.action,
      blockId: tuple.blockId,
      blockRevision: row.blockRevision,
      decisionId,
      fromStateVersion: row.currentStateVersion,
      ...(state.itemId === null ? {} : { itemId: state.itemId }),
      operationId: request.operationId,
      receiptId,
      receiptSchemaVersion: 1,
      requestHash: hash,
      toStateVersion,
    };
    const body = { kind: "completed", receipt };
    database.prepare(
      `INSERT INTO collaboration_operations(
         id,project_id,thread_id,run_id,kind,request_hash,status,http_status,
         response_json,response_schema_version,lease_applicability,lease_id,
         created_at,updated_at
       ) VALUES (?,?,?,?,'inline_decision',?,'completed',200,?,8,
                 'not_applicable',NULL,?,?)`,
    ).run(
      request.operationId,
      tuple.projectId,
      tuple.threadId,
      tuple.runId,
      hash,
      JSON.stringify(body),
      timestamp,
      timestamp,
    );
    dependencies.afterStep?.("operation");
    database.prepare(
      `INSERT INTO inline_decisions(
         id,project_id,thread_id,run_id,operation_id,block_id,block_revision,
         decision_schema_version,from_state_version,to_state_version,action,item_id,
         actor_type,actor_id,created_at
       ) VALUES (?,?,?,?,?,?,?,1,?,?,?,?, 'owner',NULL,?)`,
    ).run(
      decisionId,
      tuple.projectId,
      tuple.threadId,
      tuple.runId,
      request.operationId,
      tuple.blockId,
      row.blockRevision,
      row.currentStateVersion,
      toStateVersion,
      request.action,
      state.itemId,
      timestamp,
    );
    dependencies.afterStep?.("decision");
    database.prepare(
      `INSERT INTO business_action_receipts(
         id,project_id,thread_id,run_id,decision_id,operation_id,request_hash,
         receipt_schema_version,block_id,block_revision,from_state_version,
         to_state_version,result_json,created_at
       ) VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
    ).run(
      receiptId,
      tuple.projectId,
      tuple.threadId,
      tuple.runId,
      decisionId,
      request.operationId,
      hash,
      tuple.blockId,
      row.blockRevision,
      row.currentStateVersion,
      toStateVersion,
      JSON.stringify(receipt),
      timestamp,
    );
    dependencies.afterStep?.("receipt");
    appendBatchTx(database, [{
      actorId: null,
      actorType: "owner",
      businessReceiptId: receiptId,
      factId,
      inlineDecisionId: decisionId,
      payload: {
        action: request.action,
        blockId: tuple.blockId,
        blockRevision: row.blockRevision,
        decisionId,
        fromStateVersion: row.currentStateVersion,
        itemId: state.itemId,
        operationId: request.operationId,
        receiptId,
        toStateVersion,
      },
      projectId: tuple.projectId,
      runId: tuple.runId,
      threadId: tuple.threadId,
      timestamp,
      type: "inline_decision",
    }]);
    dependencies.afterStep?.("fact");
    database.exec("COMMIT");
    return { body, status: 200 };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export function readInlineOperation(
  databasePath: string,
  tuple: Pick<DecisionTuple, "projectId" | "runId" | "threadId">,
  operationId: string,
): { body: unknown; status: number } {
  const database = openDatabase(databasePath);
  try {
    const row = existingOperation(database, {
      ...tuple,
      blockId: "",
      messageId: "",
    }, operationId);
    if (!row || row.kind !== "inline_decision") {
      throw new CollaborationError("OPERATION_NOT_FOUND", 404, "Operation was not found.");
    }
    if (row.threadId !== tuple.threadId || row.runId !== tuple.runId) {
      throw new CollaborationError("OPERATION_NOT_FOUND", 404, "Operation was not found.");
    }
    if (
      row.httpStatus === null
      || row.responseJson === null
      || (row.status !== "completed" && row.status !== "version_conflict")
    ) {
      throw new CollaborationError("OPERATION_IN_PROGRESS", 409, "Operation is still in progress.");
    }
    return { body: JSON.parse(row.responseJson), status: row.httpStatus };
  } finally {
    database.close();
  }
}
