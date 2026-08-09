import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/server/collaboration/collaboration-errors";
import { appendBatchTx } from "@/src/server/collaboration/thread-fact-store";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  canonicalizeStructuredJson,
  decodePersistedStructuredJson,
  hashCanonicalBytes,
  ingestStructuredJson,
  type ValidatedValue,
} from "@/src/server/structured-messages/structured-message-codec";
import {
  agentStructuredBlockSchema,
  blockCodecSchema,
  blocksEnvelopeSchema,
  checklistBlockSchema,
  diffPreviewBlockSchema,
  envelopeCodecSchema,
  fileReferenceBlockSchema,
  handoffCardBlockSchema,
  graphemeLength,
  persistedStructuredBlockSchema,
  persistedEnvelopeCodecSchema,
  proposalBlockSchema,
  type AgentStructuredBlock,
  type StructuredBlock,
} from "@/src/server/structured-messages/structured-message-schema";
import {
  assertPublicProjectionText,
  resolveVerifiedSource,
} from "@/src/server/structured-messages/verified-source-projection";
import type { PublicStructuredBlockEnvelope } from "@/src/shared/collaboration-contracts";
export {
  agentStructuredBlockSchema,
  checklistBlockSchema,
  diffPreviewBlockSchema,
  fileReferenceBlockSchema,
  handoffCardBlockSchema,
  proposalBlockSchema,
};
export type ProposalBlock = Extract<StructuredBlock, { blockType: "proposal" }>;
export type { AgentStructuredBlock, StructuredBlock };

export function decodeStructuredBlockPayload(raw: string | Uint8Array) {
  return decodePersistedStructuredJson(raw, {
    maxCanonicalBytes: 64 * 1024,
    maxWireBytes: 64 * 1024,
    schema: blockCodecSchema,
  });
}

export type ValidatedStructuredBlocks = ValidatedValue<{ blocks: AgentStructuredBlock[] }>;
export type ValidatedPersistedStructuredBlocks = ValidatedValue<{ blocks: StructuredBlock[] }>;

export function encodeStructuredMessageDomain(domain: unknown): {
  canonicalBytes: Uint8Array;
  hash: string;
} {
  const canonicalBytes = canonicalizeStructuredJson(JSON.stringify(domain), {
    maxCanonicalBytes: 256 * 1024,
    maxWireBytes: 1024 * 1024,
  });
  return { canonicalBytes, hash: hashCanonicalBytes(canonicalBytes) };
}

export function ingestStructuredBlocks(
  raw: string | Uint8Array,
  configuredCredentialValues: readonly string[] = [],
): ValidatedStructuredBlocks {
  return ingestStructuredJson(raw, {
    configuredCredentialValues,
    maxCanonicalBytes: 256 * 1024,
    maxWireBytes: 256 * 1024,
    schema: envelopeCodecSchema,
  }).value;
}

export function materializeStructuredBlocks(
  database: DatabaseSync,
  tuple: { projectId: string; runId: string; threadId: string },
  actor: { displayName: string; id: string | null; type: "owner" | "agent" },
  input: ValidatedStructuredBlocks,
): ValidatedPersistedStructuredBlocks {
  const blocks = input.blocks.map((block): StructuredBlock => {
    if (block.blockType === "diff_preview") {
      for (const reference of block.fileReferences) {
        assertPublicProjectionText(database, reference);
      }
      const source = resolveVerifiedSource(database, tuple, {
        kind: "diff",
        observationHash: block.observationHash,
        observationId: block.observationId,
        stagedResultId: block.stagedResultId,
      });
      if (!source.snapshotHash || !source.stagedHash || !source.navigation.executionId) invalid();
      return {
        ...block,
        executionId: source.navigation.executionId,
        preview: source.display.preview,
        previewHash: source.snapshotHash,
        stagedHash: source.stagedHash,
      };
    }
    if (block.blockType === "file_reference") {
      resolveVerifiedSource(database, tuple, {
        artifactHash: block.artifactHash,
        artifactId: block.artifactId,
        executionId: block.executionId,
        kind: "file",
      });
      return block;
    }
    if (block.blockType === "handoff_card") {
      const source = resolveVerifiedSource(database, tuple, {
        factId: block.factId,
        kind: "handoff",
        turnId: block.turnId,
      });
      if (
        !source.actor
        || source.actor.type !== actor.type
        || source.actor.id !== actor.id
        || source.actor.displayName !== actor.displayName
      ) invalid();
      return block;
    }
    return block;
  });
  return ingestStructuredJson(JSON.stringify({ blocks }), {
    maxCanonicalBytes: 256 * 1024,
    maxWireBytes: 256 * 1024,
    schema: persistedEnvelopeCodecSchema,
  }).value;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function invalid(): never {
  throw new CollaborationError("INVALID_INPUT", 400, "Structured message input is invalid.");
}

function notFound(): never {
  throw new CollaborationError("RESOURCE_NOT_FOUND", 404, "Resource was not found.");
}

function nextMessageSequenceTx(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
): number {
  database.prepare(
    `INSERT OR IGNORE INTO collaboration_project_sequences(
       project_id,thread_id,next_message_sequence
     ) VALUES (?,?,1)`,
  ).run(projectId, threadId);
  const row = database.prepare(
    `SELECT next_message_sequence AS sequence
     FROM collaboration_project_sequences WHERE project_id=? AND thread_id=?`,
  ).get(projectId, threadId) as { sequence: number } | undefined;
  if (!row) invalid();
  const updated = database.prepare(
    `UPDATE collaboration_project_sequences
     SET next_message_sequence=next_message_sequence+1
     WHERE project_id=? AND thread_id=? AND next_message_sequence=?`,
  ).run(projectId, threadId, row.sequence);
  if (updated.changes !== 1) invalid();
  return row.sequence;
}

export type AppendStructuredMessageInput = {
  actor: { displayName: string; id: string | null; type: "owner" | "agent" };
  blocksRaw: string | Uint8Array;
  content: string;
  factId: string;
  messageId: string;
  projectId: string;
  runId: string | null;
  threadId: string;
  timestamp: string;
};

export function commitStructuredMessageTx(
  database: DatabaseSync,
  input: Omit<AppendStructuredMessageInput, "blocksRaw"> & {
    blocks: ValidatedPersistedStructuredBlocks | ValidatedStructuredBlocks;
  },
): number {
  if (
    !input.content.trim()
    || graphemeLength(input.content.trim()) > 20_000
    || !input.actor.displayName.trim()
    || graphemeLength(input.actor.displayName.trim()) > 160
  ) invalid();
  const persistedBlocks = ingestStructuredJson(JSON.stringify(input.blocks), {
    maxCanonicalBytes: 256 * 1024,
    maxWireBytes: 256 * 1024,
    schema: persistedEnvelopeCodecSchema,
  }).value;
  if (
    (input.actor.type === "owner" && input.actor.id !== null)
    || (input.actor.type === "agent" && input.actor.id === null)
  ) invalid();
  const owner = database.prepare(
    `SELECT 1 FROM collaboration_threads
     WHERE project_id=? AND id=?
       AND (? IS NULL OR EXISTS(
         SELECT 1 FROM collaboration_runs
         WHERE project_id=? AND thread_id=? AND id=?
       ))`,
  ).get(
    input.projectId,
    input.threadId,
    input.runId,
    input.projectId,
    input.threadId,
    input.runId,
  );
  if (!owner) notFound();

  const messageSequence = nextMessageSequenceTx(database, input.projectId, input.threadId);
  database.prepare(
    `INSERT INTO collaboration_messages(
       id,project_id,thread_id,run_id,author_type,author_agent_id,
       author_display_name,content,mention_agent_id,mention_display_name,
       sequence,consumed_at,created_at
     ) VALUES (?,?,?,?,?,?,?, ?,NULL,NULL,?,NULL,?)`,
  ).run(
    input.messageId,
    input.projectId,
    input.threadId,
    input.runId,
    input.actor.type,
    input.actor.id,
    input.actor.displayName,
    input.content,
    messageSequence,
    input.timestamp,
  );

  const domainBlocks: Array<Record<string, unknown>> = [];
  for (const [position, block] of persistedBlocks.blocks.entries()) {
    const encoded = ingestStructuredJson(JSON.stringify(block), {
      maxCanonicalBytes: 64 * 1024,
      maxWireBytes: 64 * 1024,
      schema: blockCodecSchema,
    });
    const blockId = randomUUID();
    const source = block.blockType === "diff_preview"
      ? { id: block.observationId, kind: "execution", version: block.observationHash }
      : block.blockType === "file_reference"
        ? { id: block.artifactId, kind: "artifact", version: block.artifactHash }
        : block.blockType === "handoff_card"
          ? (() => {
              const handoff = database.prepare(
                `SELECT run_event_id AS eventId
                 FROM collaboration_thread_facts
                 WHERE project_id=? AND thread_id=? AND run_id=? AND id=?
                   AND type='run_event'`,
              ).get(
                input.projectId,
                input.threadId,
                input.runId,
                block.factId,
              ) as { eventId: string | null } | undefined;
              if (!handoff?.eventId) invalid();
              return { id: block.factId, kind: "handoff", version: handoff.eventId };
            })()
          : { id: input.messageId, kind: "message", version: null };
    database.prepare(
      `INSERT INTO structured_message_blocks(
         id,project_id,thread_id,run_id,message_id,logical_block_id,block_type,
         block_schema_version,block_revision,position,payload_json,payload_hash,
         actor_type,actor_id,actor_display_name,source_kind,source_id,
         source_entity_version,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      blockId,
      input.projectId,
      input.threadId,
      input.runId,
      input.messageId,
      block.logicalBlockId,
      block.blockType,
      block.blockSchemaVersion,
      block.blockRevision,
      position,
      Buffer.from(encoded.canonicalBytes).toString("utf8"),
      hashCanonicalBytes(encoded.canonicalBytes),
      input.actor.type,
      input.actor.id,
      input.actor.displayName,
      source.kind,
      source.id,
      source.version,
      input.timestamp,
    );
    const stateKind = block.blockType === "proposal" || block.blockType === "checklist"
      ? block.blockType
      : "read_only";
    const stateJson = block.blockType === "proposal"
      ? '{"status":"pending"}'
      : block.blockType === "checklist"
        ? JSON.stringify({ items: block.items.map(({ id }) => ({ checked: false, id })) })
        : '{"status":"read_only"}';
    domainBlocks.push({
      blockId,
      metadata: {
        blockRevision: block.blockRevision,
        blockSchemaVersion: block.blockSchemaVersion,
        blockType: block.blockType,
        logicalBlockId: block.logicalBlockId,
        position,
      },
      payload: block,
      source: {
        entityVersion: source.version,
        id: source.id,
        kind: source.kind,
        messageId: input.messageId,
        projectId: input.projectId,
        runId: input.runId,
        threadId: input.threadId,
      },
      state: { stateVersion: 1, value: JSON.parse(stateJson) },
    });
    database.prepare(
      `INSERT INTO structured_message_state_revisions(
         project_id,thread_id,block_id,state_version,prior_state_version,
         state_kind,state_json,created_at
       ) VALUES (?,?,?,1,NULL,?,?,?)`,
    ).run(input.projectId, input.threadId, blockId, stateKind, stateJson, input.timestamp);
    database.prepare(
      `INSERT INTO structured_message_state_heads(
         project_id,thread_id,block_id,current_state_version
       ) VALUES (?,?,?,1)`,
    ).run(input.projectId, input.threadId, blockId);
  }

  encodeStructuredMessageDomain({
    actor: input.actor,
    blocks: domainBlocks,
    message: {
      id: input.messageId,
      projectId: input.projectId,
      runId: input.runId,
      threadId: input.threadId,
    },
    schemaVersion: 1,
  });

  appendBatchTx(database, [{
    actorId: input.actor.id,
    actorType: input.actor.type,
    factId: input.factId,
    messageId: input.messageId,
    payload: {
      authorDisplayName: input.actor.displayName,
      authorType: input.actor.type,
      messageId: input.messageId,
    },
    projectId: input.projectId,
    runId: input.runId,
    threadId: input.threadId,
    timestamp: input.timestamp,
    type: input.actor.type === "owner" ? "owner_message" : "agent_message",
  }]);
  return messageSequence;
}

export function appendStructuredMessage(
  databasePath: string,
  input: AppendStructuredMessageInput,
): void {
  if (!input.content.trim()) invalid();
  const blocks = ingestStructuredBlocks(input.blocksRaw);
  if (blocks.blocks.length !== 1 || blocks.blocks[0]?.blockType !== "proposal") invalid();
  const persistedBlocks = ingestStructuredJson(JSON.stringify(blocks), {
    maxCanonicalBytes: 256 * 1024,
    maxWireBytes: 256 * 1024,
    schema: persistedEnvelopeCodecSchema,
  }).value;
  const database = openDatabase(databasePath);
  try {
    transaction(
      database,
      () => commitStructuredMessageTx(database, { ...input, blocks: persistedBlocks }),
    );
  } finally {
    database.close();
  }
}

type BlockRow = {
  actorDisplayName: string;
  actorId: string | null;
  actorType: "owner" | "agent";
  blockRevision: number;
  blockSchemaVersion: number;
  blockType: string;
  currentStateVersion: number;
  id: string;
  logicalBlockId: string;
  payloadJson: string;
  position: number;
  runId: string | null;
  sourceEntityVersion: string | null;
  sourceId: string;
  sourceKind: string;
  stateJson: string;
};

export function readPublicStructuredBlocksTx(
  database: DatabaseSync,
  message: {
    messageId: string;
    projectId: string;
    runId: string | null;
    threadId: string;
  },
): PublicStructuredBlockEnvelope[] {
  const rows = database.prepare(
    `SELECT b.id,b.logical_block_id AS logicalBlockId,b.block_type AS blockType,
            b.block_schema_version AS blockSchemaVersion,
            b.block_revision AS blockRevision,b.position,b.payload_json AS payloadJson,
            b.actor_type AS actorType,b.actor_id AS actorId,
            b.actor_display_name AS actorDisplayName,b.source_kind AS sourceKind,
            b.source_id AS sourceId,b.source_entity_version AS sourceEntityVersion,
            b.run_id AS runId,h.current_state_version AS currentStateVersion,
            s.state_json AS stateJson
     FROM structured_message_blocks b
     JOIN structured_message_state_heads h
       ON (h.project_id,h.thread_id,h.block_id)=(b.project_id,b.thread_id,b.id)
     JOIN structured_message_state_revisions s
       ON (s.project_id,s.thread_id,s.block_id,s.state_version)=
          (h.project_id,h.thread_id,h.block_id,h.current_state_version)
     WHERE b.project_id=? AND b.thread_id=? AND b.message_id=?
     ORDER BY b.position ASC`,
  ).all(message.projectId, message.threadId, message.messageId) as BlockRow[];
  return rows.map((row) => {
    if (row.runId !== message.runId) {
      throw new CollaborationError(
        "STORAGE_UNAVAILABLE",
        503,
        "Structured message storage is invalid.",
      );
    }
    const decoded = decodeStructuredBlockPayload(row.payloadJson);
    const common = {
      actor: {
        displayName: row.actorDisplayName,
        id: row.actorId,
        type: row.actorType,
      },
      blockRevision: row.blockRevision,
      blockSchemaVersion: row.blockSchemaVersion,
      blockType: row.blockType,
      id: row.id,
      logicalBlockId: row.logicalBlockId,
      position: row.position,
      source: {
        entityVersion: row.sourceEntityVersion,
        id: row.sourceId,
        kind: row.sourceKind,
        messageId: message.messageId,
        projectId: message.projectId,
        runId: row.runId,
        threadId: message.threadId,
      },
    };
    if (decoded.kind === "unknown-schema") {
      return {
        ...common,
        kind: "unknown-schema" as const,
        stateVersion: row.currentStateVersion,
      };
    }
    if (decoded.kind === "invalid") {
      throw new CollaborationError(
        "STORAGE_UNAVAILABLE",
        503,
        "Structured message storage is invalid.",
      );
    }
    let state: unknown;
    try {
      state = JSON.parse(row.stateJson);
    } catch {
      throw new CollaborationError(
        "STORAGE_UNAVAILABLE",
        503,
        "Structured message storage is invalid.",
      );
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new CollaborationError(
        "STORAGE_UNAVAILABLE",
        503,
        "Structured message storage is invalid.",
      );
    }
    return {
      ...common,
      kind: "known" as const,
      payload: decoded.value,
      state: {
        ...(state as Record<string, unknown>),
        stateVersion: row.currentStateVersion,
      },
    };
  });
}

export function readStructuredMessage(
  databasePath: string,
  tuple: { messageId: string; projectId: string; threadId: string },
): unknown {
  const database = openDatabase(databasePath);
  try {
    const message = database.prepare(
      `SELECT m.id AS messageId,m.project_id AS projectId,m.thread_id AS threadId,
              m.run_id AS runId,m.author_type AS actorType,m.author_agent_id AS actorId,
              m.author_display_name AS actorDisplayName,m.content,f.id AS factId
       FROM collaboration_thread_facts f
       JOIN collaboration_messages m
         ON (m.project_id,m.thread_id,m.id)=(f.project_id,f.thread_id,f.message_id)
       WHERE f.project_id=? AND f.thread_id=? AND f.message_id=?
         AND f.type IN('owner_message','agent_message')`,
    ).get(tuple.projectId, tuple.threadId, tuple.messageId) as {
      actorDisplayName: string;
      actorId: string | null;
      actorType: "owner" | "agent";
      content: string;
      factId: string;
      messageId: string;
      projectId: string;
      runId: string | null;
      threadId: string;
    } | undefined;
    if (!message) notFound();
    const blocks = readPublicStructuredBlocksTx(database, message).map((block) => {
      if (block.kind !== "known") {
        throw new CollaborationError(
          "STORAGE_UNAVAILABLE",
          503,
          "Structured message storage is invalid.",
        );
      }
      const { kind: _kind, ...known } = block;
      return known;
    });
    return {
      actor: {
        displayName: message.actorDisplayName,
        id: message.actorId,
        type: message.actorType,
      },
      blocks,
      content: message.content,
      factId: message.factId,
      messageId: message.messageId,
      projectId: message.projectId,
      runId: message.runId,
      threadId: message.threadId,
    };
  } finally {
    database.close();
  }
}
