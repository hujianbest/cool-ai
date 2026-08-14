import { createHash } from "node:crypto";

import { DatabaseSync } from "node:sqlite";
import canonicalize from "canonicalize";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createThread,
  readThreadFacts,
  readThreadMessages,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";
import {
  decideInline,
  readInlineOperation,
} from "@/src/adapters/outbound/sqlite/public-collaboration/inline-decision-service";
import {
  appendStructuredMessage,
  commitStructuredMessageTx,
  ingestStructuredBlocks,
} from "@/src/adapters/outbound/sqlite/public-collaboration/structured-message-store";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import { currentSchemaObjectSql } from "@/tests/fixtures/current-schema-object";
import {
  commitFileReferenceMessage,
  seedFileReferenceGraph,
} from "@/tests/fixtures/structured-messages/file-reference";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-09T05:15:00.000Z";
const COMPLETED_OPERATION = "00000000-0000-4000-8000-000000001501";
const CONFLICT_OPERATION = "00000000-0000-4000-8000-000000001502";

let databasePath: string;
let tuple: {
  blockId: string;
  messageId: string;
  projectId: string;
  runId: string;
  threadId: string;
};

function readAllFacts() {
  const items: unknown[] = [];
  let after = 0;
  for (;;) {
    const page = readThreadFacts(
      databasePath,
      tuple.projectId,
      tuple.threadId,
      { after, limit: 2 },
    ).body;
    items.push(...page.items);
    if (page.nextAfter === null) return items;
    after = page.nextAfter;
  }
}

function readAllMessages() {
  const items: unknown[] = [];
  let after = 0;
  for (;;) {
    const page = readThreadMessages(
      databasePath,
      tuple.projectId,
      tuple.threadId,
      { after, limit: 1 },
    ).body;
    items.push(...page.items);
    if (page.nextAfter === null) return items;
    after = page.nextAfter;
  }
}

type CorruptionKind =
  | "actor"
  | "fact-action"
  | "fact-version"
  | "item"
  | "jcs"
  | "missing-fact"
  | "missing-receipt"
  | "outcome"
  | "shape"
  | "source"
  | "source-id"
  | "state"
  | "version";

function canonical(value: unknown): string {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error("Expected canonical JSON.");
  return encoded;
}

function corrupt(kind: CorruptionKind): void {
  const database = new DatabaseSync(databasePath);
  const immutableBlockTrigger = currentSchemaObjectSql("structured_message_blocks_no_update");
  const immutableStateTrigger = currentSchemaObjectSql("structured_message_state_revisions_no_update");
  const immutableReceiptTrigger = currentSchemaObjectSql("business_action_receipts_no_update");
  const immutableFactTrigger = currentSchemaObjectSql("thread_fact_no_update");
  const immutableFactDeleteTrigger = currentSchemaObjectSql("thread_fact_no_delete");
  database.exec("PRAGMA foreign_keys=OFF");
  const deleteDecisionFactWithoutBreakingSequences = (): void => {
    database.exec("DROP TRIGGER thread_fact_no_delete");
    database.prepare(
      "DELETE FROM collaboration_thread_facts WHERE inline_decision_id IS NOT NULL",
    ).run();
    database.exec(immutableFactDeleteTrigger);
    database.prepare(`
      UPDATE collaboration_threads
      SET next_fact_sequence=1+(
            SELECT count(*) FROM collaboration_thread_facts f
            WHERE f.project_id=collaboration_threads.project_id
              AND f.thread_id=collaboration_threads.id
          ),
          last_activity_sequence=(
            SELECT max(f.activity_sequence) FROM collaboration_thread_facts f
            WHERE f.project_id=collaboration_threads.project_id
              AND f.thread_id=collaboration_threads.id
          )
      WHERE project_id=? AND id=?
    `).run(tuple.projectId, tuple.threadId);
    database.prepare(`
      UPDATE collaboration_project_thread_sequences
      SET next_activity_sequence=1+coalesce((
        SELECT max(f.activity_sequence) FROM collaboration_thread_facts f
        WHERE f.project_id=collaboration_project_thread_sequences.project_id
      ),0)
      WHERE project_id=?
    `).run(tuple.projectId);
  };
  if (kind === "actor" || kind === "source-id") {
    database.exec("DROP TRIGGER structured_message_blocks_no_update");
    database.prepare(
      kind === "actor"
        ? "UPDATE structured_message_blocks SET actor_display_name='Wrong actor' WHERE id=?"
        : "UPDATE structured_message_blocks SET source_id='wrong-message' WHERE id=?",
    ).run(tuple.blockId);
    database.exec(immutableBlockTrigger);
  } else if (kind === "fact-action" || kind === "fact-version") {
    const row = database.prepare(
      "SELECT payload_json AS payloadJson FROM collaboration_thread_facts WHERE inline_decision_id IS NOT NULL",
    ).get() as { payloadJson: string };
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    if (kind === "fact-action") payload.action = "reject";
    else payload.blockRevision = 2;
    database.exec("DROP TRIGGER thread_fact_no_update");
    database.prepare(
      "UPDATE collaboration_thread_facts SET payload_json=? WHERE inline_decision_id IS NOT NULL",
    ).run(canonical(payload));
    database.exec(immutableFactTrigger);
  } else if (kind === "missing-receipt") {
    deleteDecisionFactWithoutBreakingSequences();
    database.prepare("DELETE FROM business_action_receipts").run();
  } else if (kind === "missing-fact") {
    deleteDecisionFactWithoutBreakingSequences();
  } else if (kind === "item") {
    const receiptRow = database.prepare(
      "SELECT result_json AS resultJson FROM business_action_receipts",
    ).get() as { resultJson: string };
    const receipt = JSON.parse(receiptRow.resultJson) as Record<string, unknown>;
    receipt.itemId = "wrong-item";
    database.exec("DROP TRIGGER business_action_receipts_no_update");
    database.prepare("UPDATE business_action_receipts SET result_json=?").run(canonical(receipt));
    database.exec(immutableReceiptTrigger);
    const operationRow = database.prepare(
      "SELECT response_json AS responseJson FROM collaboration_operations WHERE id=?",
    ).get(COMPLETED_OPERATION) as { responseJson: string };
    const response = JSON.parse(operationRow.responseJson) as {
      kind: string;
      receipt: Record<string, unknown>;
    };
    response.receipt.itemId = "wrong-item";
    database.prepare(
      "UPDATE collaboration_operations SET response_json=? WHERE id=?",
    ).run(canonical(response), COMPLETED_OPERATION);
  } else if (kind === "jcs") {
    const row = database.prepare(
      "SELECT payload_json AS payloadJson FROM structured_message_blocks WHERE id=?",
    ).get(tuple.blockId) as { payloadJson: string };
    const noncanonical = JSON.stringify(JSON.parse(row.payloadJson), null, 2);
    const hash = createHash("sha256").update(noncanonical).digest("hex");
    database.exec("DROP TRIGGER structured_message_blocks_no_update");
    database.prepare(
      "UPDATE structured_message_blocks SET payload_json=?,payload_hash=? WHERE id=?",
    ).run(noncanonical, hash, tuple.blockId);
    database.exec(immutableBlockTrigger);
  } else if (kind === "shape") {
    const malformed =
      '{"actions":["accept","reject"],"blockRevision":1,"blockSchemaVersion":1,"blockType":"proposal","logicalBlockId":"proposal-reopen"}';
    database.exec("DROP TRIGGER structured_message_blocks_no_update");
    database.prepare(
      "UPDATE structured_message_blocks SET payload_json=?,payload_hash=? WHERE id=?",
    ).run(malformed, createHash("sha256").update(malformed).digest("hex"), tuple.blockId);
    database.exec(immutableBlockTrigger);
  } else if (kind === "outcome") {
    database.exec("PRAGMA ignore_check_constraints=ON");
    database.prepare(
      `UPDATE collaboration_operations
       SET status='pending',http_status=NULL,response_json=NULL,response_schema_version=NULL
       WHERE id=?`,
    ).run(CONFLICT_OPERATION);
    database.exec("PRAGMA ignore_check_constraints=OFF");
  } else if (kind === "source") {
    database.exec("DROP TRIGGER structured_message_blocks_no_update");
    database.prepare(
      "UPDATE structured_message_blocks SET run_id='cross-run' WHERE id=?",
    ).run(tuple.blockId);
    database.exec(immutableBlockTrigger);
  } else if (kind === "state") {
    database.exec("DROP TRIGGER structured_message_state_revisions_no_update");
    database.prepare(
      `UPDATE structured_message_state_revisions SET state_json='{"status":"pending"}'
       WHERE block_id=? AND state_version=2`,
    ).run(tuple.blockId);
    database.exec(immutableStateTrigger);
  } else {
    database.prepare(
      "UPDATE structured_message_state_heads SET current_state_version=99 WHERE block_id=?",
    ).run(tuple.blockId);
  }
  database.close();
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  const projectId = "project-reopen";
  const runId = "run-reopen";
  const threadId = seedV7AdvanceFixture(databasePath, {
    agentId: "agent-reopen-a",
    agentPrompt: "Plan",
    missionId: "mission-reopen",
    now: NOW,
    ownerMessage: "Legacy plain text",
    projectId,
    projectName: "Reopen",
    providerId: "provider-reopen",
    runId,
    secondAgentId: "agent-reopen-b",
    secondAgentPrompt: "Review",
    threadCreateOperationId: "00000000-0000-4000-8000-000000001500",
  });
  const messageId = "message-reopen-proposal";
  appendStructuredMessage(databasePath, {
    actor: { displayName: "Owner", id: null, type: "owner" },
    blocksRaw: JSON.stringify({
      blocks: [{
        actions: ["accept", "reject"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        body: "Persist this decision.",
        logicalBlockId: "proposal-reopen",
        title: "Reopen proposal",
      }],
    }),
    content: "Choose after reopen.",
    factId: "fact-reopen-proposal",
    messageId,
    projectId,
    runId,
    threadId,
    timestamp: NOW,
  });
  const database = openDatabase(databasePath);
  const block = database.prepare(
    "SELECT id FROM structured_message_blocks WHERE message_id=?",
  ).get(messageId) as { id: string };
  database.close();
  tuple = { blockId: block.id, messageId, projectId, runId, threadId };
  decideInline(databasePath, tuple, JSON.stringify({
    action: "accept",
    expectedStateVersion: 1,
    operationId: COMPLETED_OPERATION,
  }));
  decideInline(databasePath, tuple, JSON.stringify({
    action: "reject",
    expectedStateVersion: 1,
    operationId: CONFLICT_OPERATION,
  }));
});

describe("Structured Message migration/reopen persistence seam", () => {
  it("preserves paginated facts, messages, and durable operation outcomes across repeated process reopen", () => {
    const facts = readAllFacts();
    const messages = readAllMessages();
    const completed = readInlineOperation(databasePath, tuple, COMPLETED_OPERATION);
    const conflict = readInlineOperation(databasePath, tuple, CONFLICT_OPERATION);
    const before = openDatabase(databasePath);
    const operationBytes = before.prepare(
      `SELECT id,status,http_status AS httpStatus,response_json AS responseJson
       FROM collaboration_operations WHERE id IN (?,?) ORDER BY id`,
    ).all(COMPLETED_OPERATION, CONFLICT_OPERATION);
    before.close();

    for (let reopen = 0; reopen < 2; reopen += 1) {
      const database = openDatabase(databasePath);
      try {
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 25 });
      } finally {
        database.close();
      }
      expect(readAllFacts()).toEqual(facts);
      expect(readAllMessages()).toEqual(messages);
      expect(readInlineOperation(databasePath, tuple, COMPLETED_OPERATION)).toEqual(completed);
      expect(readInlineOperation(databasePath, tuple, CONFLICT_OPERATION)).toEqual(conflict);
      expect(decideInline(databasePath, tuple, JSON.stringify({
        action: "accept",
        expectedStateVersion: 1,
        operationId: COMPLETED_OPERATION,
      }))).toEqual(completed);
      expect(decideInline(databasePath, tuple, JSON.stringify({
        action: "reject",
        expectedStateVersion: 1,
        operationId: CONFLICT_OPERATION,
      }))).toEqual(conflict);
    }
    expect(() => readInlineOperation(
      databasePath,
      tuple,
      "00000000-0000-4000-8000-000000001599",
    )).toThrowError(expect.objectContaining({ code: "OPERATION_NOT_FOUND" }));

    const database = openDatabase(databasePath);
    expect(database.prepare(
      "SELECT count(*) AS count FROM collaboration_operations WHERE kind='inline_decision' AND status='pending'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM structured_message_blocks").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM inline_decisions").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM business_action_receipts").get())
      .toEqual({ count: 1 });
    expect(database.prepare(
      `SELECT id,status,http_status AS httpStatus,response_json AS responseJson
       FROM collaboration_operations WHERE id IN (?,?) ORDER BY id`,
    ).all(COMPLETED_OPERATION, CONFLICT_OPERATION)).toEqual(operationBytes);
    database.close();
  });

  it.each([
    "actor",
    "fact-action",
    "fact-version",
    "item",
    "jcs",
    "missing-fact",
    "missing-receipt",
    "outcome",
    "shape",
    "source",
    "source-id",
    "state",
    "version",
  ] as const)(
    "fails every reopen closed for invalid persisted %s data without changing schema version",
    (kind) => {
      corrupt(kind);
      for (let reopen = 0; reopen < 2; reopen += 1) {
        expect(() => {
          const database = openDatabase(databasePath);
          database.close();
        }).toThrowError(
          expect.objectContaining<Partial<SchemaError>>({ code: "SCHEMA_DATA_INVALID" }),
        );
        const raw = new DatabaseSync(databasePath);
        try {
          expect(raw.isTransaction).toBe(false);
          expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 25 });
        } finally {
          raw.close();
        }
      }
    },
  );
});

describe("Structured Message reopen exhaustive source and state DAG validation", () => {
  let fileReferenceBlockId: string;
  let secondThreadId: string;

  beforeEach(() => {
    process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 10).toString("base64url");
    const encrypted = createCredentialVault().encrypt("provider-reopen", "sk-reopen-dag-key");
    const credentials = openDatabase(databasePath);
    try {
      credentials.prepare(
        `UPDATE providers
         SET api_key_cipher=?,api_key_iv=?,api_key_tag=?,credential_version=?,
             key_id=?,api_key_mask=?
         WHERE id=?`,
      ).run(
        encrypted.apiKeyCipher,
        encrypted.apiKeyIv,
        encrypted.apiKeyTag,
        encrypted.credentialVersion,
        encrypted.keyId,
        encrypted.apiKeyMask,
        "provider-reopen",
      );
    } finally {
      credentials.close();
    }
    const graph = seedFileReferenceGraph(databasePath, {
      agentId: "agent-reopen-a",
      missionId: "mission-reopen",
      now: NOW,
      projectId: tuple.projectId,
      runId: tuple.runId,
      threadId: tuple.threadId,
    });
    fileReferenceBlockId = commitFileReferenceMessage(databasePath, {
      actor: { displayName: "Alpha", id: "agent-reopen-a", type: "agent" },
      graph,
      now: NOW,
      projectId: tuple.projectId,
      runId: tuple.runId,
      threadId: tuple.threadId,
    }).blockId;
    secondThreadId = createThread(databasePath, tuple.projectId, {
      memberAgentIds: ["agent-reopen-a", "agent-reopen-b"],
      operationId: "00000000-0000-4000-8000-000000001511",
      title: "Reopen second thread",
    }).body.thread.id;
  });

  afterEach(() => {
    delete process.env.COCKPIT_MASTER_KEY;
  });

  type DagCorruptionKind =
    | "branch"
    | "cross-tuple"
    | "cycle"
    | "duplicate"
    | "head"
    | "orphan"
    | "source-version"
    | "state-kind";

  function userVersion(): number {
    const raw = new DatabaseSync(databasePath);
    try {
      return (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    } finally {
      raw.close();
    }
  }

  function corruptDag(kind: DagCorruptionKind): void {
    const database = new DatabaseSync(databasePath);
    const immutableBlockTrigger = currentSchemaObjectSql("structured_message_blocks_no_update");
    const immutableStateTrigger = currentSchemaObjectSql(
      "structured_message_state_revisions_no_update",
    );
    database.exec("PRAGMA foreign_keys=OFF");
    if (kind === "orphan") {
      database.prepare(
        `INSERT INTO structured_message_state_revisions(
           project_id,thread_id,block_id,state_version,prior_state_version,
           state_kind,state_json,created_at
         ) VALUES (?,?,'orphan-ghost-block',1,NULL,'read_only','{"status":"read_only"}',?)`,
      ).run(tuple.projectId, tuple.threadId, NOW);
    } else if (kind === "cross-tuple") {
      database.prepare(
        `INSERT INTO structured_message_state_revisions(
           project_id,thread_id,block_id,state_version,prior_state_version,
           state_kind,state_json,created_at
         ) VALUES (?,?,?,1,NULL,'proposal','{"status":"pending"}',?)`,
      ).run(tuple.projectId, secondThreadId, tuple.blockId, NOW);
    } else if (kind === "duplicate") {
      const duplicatePayload = canonical({
        actions: ["accept", "reject"],
        blockRevision: 2,
        blockSchemaVersion: 2,
        blockType: "proposal",
        body: "Duplicated logical identity.",
        logicalBlockId: "proposal-reopen",
        title: "Duplicate proposal",
      });
      database.prepare(
        `INSERT INTO structured_message_blocks(
           id,project_id,thread_id,run_id,message_id,logical_block_id,block_type,
           block_schema_version,block_revision,position,payload_json,payload_hash,
           actor_type,actor_id,actor_display_name,source_kind,source_id,
           source_entity_version,created_at
         ) VALUES ('duplicate-block-id',?,?,?,?,?,'proposal',2,2,1,?,?,
                   'owner',NULL,'Owner','message',?,NULL,?)`,
      ).run(
        tuple.projectId,
        tuple.threadId,
        tuple.runId,
        tuple.messageId,
        "proposal-reopen",
        duplicatePayload,
        createHash("sha256").update(duplicatePayload).digest("hex"),
        tuple.messageId,
        NOW,
      );
      database.prepare(
        `INSERT INTO structured_message_state_revisions(
           project_id,thread_id,block_id,state_version,prior_state_version,
           state_kind,state_json,created_at
         ) VALUES (?,?,'duplicate-block-id',1,NULL,'proposal','{"status":"pending"}',?)`,
      ).run(tuple.projectId, tuple.threadId, NOW);
      database.prepare(
        `INSERT INTO structured_message_state_heads(
           project_id,thread_id,block_id,current_state_version
         ) VALUES (?,?,'duplicate-block-id',1)`,
      ).run(tuple.projectId, tuple.threadId);
    } else if (kind === "source-version") {
      database.exec("DROP TRIGGER structured_message_blocks_no_update");
      database.prepare(
        "UPDATE structured_message_blocks SET source_entity_version=? WHERE id=?",
      ).run("f".repeat(64), fileReferenceBlockId);
      database.exec(immutableBlockTrigger);
    } else if (kind === "head") {
      database.prepare(
        "UPDATE structured_message_state_heads SET current_state_version=1 WHERE block_id=?",
      ).run(tuple.blockId);
    } else if (kind === "branch") {
      database.exec("PRAGMA ignore_check_constraints=ON");
      database.prepare(
        `INSERT INTO structured_message_state_revisions(
           project_id,thread_id,block_id,state_version,prior_state_version,
           state_kind,state_json,created_at
         ) VALUES (?,?,?,3,1,'proposal','{"status":"accepted"}',?)`,
      ).run(tuple.projectId, tuple.threadId, tuple.blockId, NOW);
      database.prepare(
        "UPDATE structured_message_state_heads SET current_state_version=3 WHERE block_id=?",
      ).run(tuple.blockId);
      database.exec("PRAGMA ignore_check_constraints=OFF");
    } else if (kind === "cycle") {
      database.exec("PRAGMA ignore_check_constraints=ON");
      database.exec("DROP TRIGGER structured_message_state_revisions_no_update");
      database.prepare(
        `UPDATE structured_message_state_revisions
         SET prior_state_version=2
         WHERE block_id=? AND state_version=2`,
      ).run(tuple.blockId);
      database.exec(immutableStateTrigger);
      database.exec("PRAGMA ignore_check_constraints=OFF");
    } else {
      database.exec("DROP TRIGGER structured_message_state_revisions_no_update");
      database.prepare(
        `UPDATE structured_message_state_revisions
         SET state_kind='checklist'
         WHERE block_id=? AND state_version=1`,
      ).run(tuple.blockId);
      database.exec(immutableStateTrigger);
    }
    database.close();
  }

  it("keeps the exact legal enriched graph readable and unchanged across repeated reopen", () => {
    const identity = userVersion();
    for (let reopen = 0; reopen < 3; reopen += 1) {
      const database = openDatabase(databasePath);
      try {
        expect({
          blocks: database.prepare(
            "SELECT count(*) AS count FROM structured_message_blocks",
          ).get(),
          heads: database.prepare(
            "SELECT count(*) AS count FROM structured_message_state_heads",
          ).get(),
          revisions: database.prepare(
            "SELECT count(*) AS count FROM structured_message_state_revisions",
          ).get(),
        }).toEqual({
          blocks: { count: 2 },
          heads: { count: 2 },
          revisions: { count: 3 },
        });
      } finally {
        database.close();
      }
    }
    expect(userVersion()).toBe(identity);
  });

  it.each([
    "branch",
    "cross-tuple",
    "cycle",
    "duplicate",
    "head",
    "orphan",
    "source-version",
    "state-kind",
  ] as const)(
    "fails reopen closed with a stable redacted error for a single %s corruption and never writes",
    (kind) => {
      const identity = userVersion();
      corruptDag(kind);
      for (let reopen = 0; reopen < 2; reopen += 1) {
        expect(() => {
          const database = openDatabase(databasePath);
          database.close();
        }).toThrowError(
          expect.objectContaining<Partial<SchemaError>>({
            code: "SCHEMA_DATA_INVALID",
            message: "Database data is invalid.",
          }),
        );
      }
      const raw = new DatabaseSync(databasePath);
      try {
        expect(raw.isTransaction).toBe(false);
        expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: identity });
      } finally {
        raw.close();
      }
    },
  );
});

describe("Structured Message reopen completed outcome and Checklist transition validation", () => {
  const CHECK_OPERATION = "00000000-0000-4000-8000-000000001512";
  const UNCHECK_OPERATION = "00000000-0000-4000-8000-000000001513";
  let checklistBlockId: string;
  let checklistTuple: {
    blockId: string;
    messageId: string;
    projectId: string;
    runId: string;
    threadId: string;
  };
  let checkResult: { body: unknown; status: number };

  beforeEach(() => {
    const checklistMessageId = "message-reopen-checklist";
    const database = openDatabase(databasePath);
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        commitStructuredMessageTx(database, {
          actor: { displayName: "Owner", id: null, type: "owner" },
          blocks: ingestStructuredBlocks(JSON.stringify({
            blocks: [{
              actions: ["check_item", "uncheck_item"],
              blockRevision: 1,
              blockSchemaVersion: 1,
              blockType: "checklist",
              items: [
                { id: "item-a", text: "Alpha item" },
                { id: "item-b", text: "Beta item" },
              ],
              logicalBlockId: "checklist-reopen",
              title: "Reopen checklist",
            }],
          })),
          content: "Track after reopen.",
          factId: "fact-reopen-checklist",
          messageId: checklistMessageId,
          projectId: tuple.projectId,
          runId: tuple.runId,
          threadId: tuple.threadId,
          timestamp: NOW,
        });
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
      const block = database.prepare(
        "SELECT id FROM structured_message_blocks WHERE message_id=?",
      ).get(checklistMessageId) as { id: string };
      checklistBlockId = block.id;
    } finally {
      database.close();
    }
    checklistTuple = {
      blockId: checklistBlockId,
      messageId: checklistMessageId,
      projectId: tuple.projectId,
      runId: tuple.runId,
      threadId: tuple.threadId,
    };
    checkResult = decideInline(databasePath, checklistTuple, JSON.stringify({
      action: "check_item",
      expectedStateVersion: 1,
      itemId: "item-a",
      operationId: CHECK_OPERATION,
    }));
    decideInline(databasePath, checklistTuple, JSON.stringify({
      action: "uncheck_item",
      expectedStateVersion: 2,
      itemId: "item-a",
      operationId: UNCHECK_OPERATION,
    }));
  });

  type OutcomeCorruptionKind =
    | "check-content-drift"
    | "check-missing-target"
    | "check-multiple"
    | "check-wrong-direction"
    | "conflict-result"
    | "missing-decision"
    | "orphan-state"
    | "outcome-field";

  function outcomeUserVersion(): number {
    const raw = new DatabaseSync(databasePath);
    try {
      return (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    } finally {
      raw.close();
    }
  }

  function corruptOutcome(kind: OutcomeCorruptionKind): void {
    const database = new DatabaseSync(databasePath);
    const receiptTrigger = currentSchemaObjectSql("business_action_receipts_no_update");
    const factDeleteTrigger = currentSchemaObjectSql("thread_fact_no_delete");
    database.exec("PRAGMA foreign_keys=OFF");
    const fixSequences = (): void => {
      database.prepare(`
        UPDATE collaboration_threads
        SET next_fact_sequence=1+(
              SELECT count(*) FROM collaboration_thread_facts f
              WHERE f.project_id=collaboration_threads.project_id
                AND f.thread_id=collaboration_threads.id
            ),
            last_activity_sequence=(
              SELECT max(f.activity_sequence) FROM collaboration_thread_facts f
              WHERE f.project_id=collaboration_threads.project_id
                AND f.thread_id=collaboration_threads.id
            )
        WHERE project_id=? AND id=?
      `).run(tuple.projectId, tuple.threadId);
      database.prepare(`
        UPDATE collaboration_project_thread_sequences
        SET next_activity_sequence=1+coalesce((
          SELECT max(f.activity_sequence) FROM collaboration_thread_facts f
          WHERE f.project_id=collaboration_project_thread_sequences.project_id
        ),0)
        WHERE project_id=?
      `).run(tuple.projectId);
    };
    const fabricateChecklistTransition = (input: {
      action: "check_item" | "uncheck_item";
      itemId: string;
      nextState: unknown;
      operationId: string;
    }): void => {
      const decisionId = `decision-${kind}`;
      const receiptId = `receipt-${kind}`;
      const factId = `fact-${kind}`;
      const hash = createHash("sha256").update(`fabricated-${kind}`).digest("hex");
      const receipt = {
        action: input.action,
        blockId: checklistBlockId,
        blockRevision: 1,
        decisionId,
        fromStateVersion: 3,
        itemId: input.itemId,
        operationId: input.operationId,
        receiptId,
        receiptSchemaVersion: 1,
        requestHash: hash,
        toStateVersion: 4,
      };
      database.prepare(
        `INSERT INTO structured_message_state_revisions(
           project_id,thread_id,block_id,state_version,prior_state_version,
           state_kind,state_json,created_at
         ) VALUES (?,?,?,4,3,'checklist',?,?)`,
      ).run(tuple.projectId, tuple.threadId, checklistBlockId, JSON.stringify(input.nextState), NOW);
      database.prepare(
        `UPDATE structured_message_state_heads SET current_state_version=4
         WHERE project_id=? AND thread_id=? AND block_id=?`,
      ).run(tuple.projectId, tuple.threadId, checklistBlockId);
      database.prepare(
        `INSERT INTO collaboration_operations(
           id,project_id,thread_id,run_id,kind,request_hash,status,http_status,
           response_json,response_schema_version,lease_applicability,lease_id,
           created_at,updated_at
         ) VALUES (?,?,?,?,'inline_decision',?,'completed',200,?,8,
                   'not_applicable',NULL,?,?)`,
      ).run(
        input.operationId,
        tuple.projectId,
        tuple.threadId,
        tuple.runId,
        hash,
        canonical({ kind: "completed", receipt }),
        NOW,
        NOW,
      );
      database.prepare(
        `INSERT INTO inline_decisions(
           id,project_id,thread_id,run_id,operation_id,block_id,block_revision,
           decision_schema_version,from_state_version,to_state_version,action,item_id,
           actor_type,actor_id,created_at
         ) VALUES (?,?,?,?,?,?,1,1,3,4,?,?,'owner',NULL,?)`,
      ).run(
        decisionId,
        tuple.projectId,
        tuple.threadId,
        tuple.runId,
        input.operationId,
        checklistBlockId,
        input.action,
        input.itemId,
        NOW,
      );
      database.prepare(
        `INSERT INTO business_action_receipts(
           id,project_id,thread_id,run_id,decision_id,operation_id,request_hash,
           receipt_schema_version,block_id,block_revision,from_state_version,
           to_state_version,result_json,created_at
         ) VALUES (?,?,?,?,?,?,?,1,?,1,3,4,?,?)`,
      ).run(
        receiptId,
        tuple.projectId,
        tuple.threadId,
        tuple.runId,
        decisionId,
        input.operationId,
        hash,
        checklistBlockId,
        canonical(receipt),
        NOW,
      );
      const sequence = (database.prepare(
        `SELECT max(sequence) AS maxSequence FROM collaboration_thread_facts
         WHERE project_id=? AND thread_id=?`,
      ).get(tuple.projectId, tuple.threadId) as { maxSequence: number }).maxSequence + 1;
      const activitySequence = (database.prepare(
        `SELECT max(activity_sequence) AS maxActivity FROM collaboration_thread_facts
         WHERE project_id=?`,
      ).get(tuple.projectId) as { maxActivity: number }).maxActivity + 1;
      database.prepare(
        `INSERT INTO collaboration_thread_facts(
           id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
           run_id,message_id,run_event_id,policy_revision_id,inline_decision_id,
           business_receipt_id,payload_json,created_at
         ) VALUES (?,?,?,?,?,'inline_decision','owner',NULL,?,NULL,NULL,NULL,?,?,?,?)`,
      ).run(
        factId,
        tuple.projectId,
        tuple.threadId,
        sequence,
        activitySequence,
        tuple.runId,
        decisionId,
        receiptId,
        canonical({
          action: input.action,
          blockId: checklistBlockId,
          blockRevision: 1,
          decisionId,
          fromStateVersion: 3,
          itemId: input.itemId,
          operationId: input.operationId,
          receiptId,
          toStateVersion: 4,
        }),
        NOW,
      );
      fixSequences();
    };
    if (kind === "missing-decision") {
      const factRow = database.prepare(
        `SELECT sequence,activity_sequence AS activitySequence
         FROM collaboration_thread_facts
         WHERE inline_decision_id=(
           SELECT id FROM inline_decisions WHERE operation_id=?)`,
      ).get(COMPLETED_OPERATION) as { activitySequence: number; sequence: number };
      database.exec("DROP TRIGGER thread_fact_no_delete");
      database.exec("DROP TRIGGER thread_fact_no_update");
      database.prepare(
        `DELETE FROM collaboration_thread_facts
         WHERE inline_decision_id=(
           SELECT id FROM inline_decisions WHERE operation_id=?)`,
      ).run(COMPLETED_OPERATION);
      database.prepare(
        `UPDATE collaboration_thread_facts SET sequence=sequence-1
         WHERE project_id=? AND thread_id=? AND sequence>?`,
      ).run(tuple.projectId, tuple.threadId, factRow.sequence);
      database.prepare(
        `UPDATE collaboration_thread_facts SET activity_sequence=activity_sequence-1
         WHERE project_id=? AND activity_sequence>?`,
      ).run(tuple.projectId, factRow.activitySequence);
      database.exec(factDeleteTrigger);
      database.exec(currentSchemaObjectSql("thread_fact_no_update"));
      database.prepare(
        `DELETE FROM business_action_receipts
         WHERE decision_id=(SELECT id FROM inline_decisions WHERE operation_id=?)`,
      ).run(COMPLETED_OPERATION);
      database.prepare("DELETE FROM inline_decisions WHERE operation_id=?").run(COMPLETED_OPERATION);
      fixSequences();
    } else if (kind === "conflict-result") {
      const receiptRow = database.prepare(
        "SELECT result_json AS resultJson FROM business_action_receipts WHERE operation_id=?",
      ).get(CHECK_OPERATION) as { resultJson: string };
      database.prepare(
        "UPDATE collaboration_operations SET response_json=? WHERE id=?",
      ).run(
        canonical({ kind: "completed", receipt: JSON.parse(receiptRow.resultJson) }),
        CONFLICT_OPERATION,
      );
    } else if (kind === "outcome-field") {
      const row = database.prepare(
        "SELECT result_json AS resultJson FROM business_action_receipts WHERE operation_id=?",
      ).get(CHECK_OPERATION) as { resultJson: string };
      const receipt = JSON.parse(row.resultJson) as Record<string, unknown>;
      receipt.operationId = "00000000-0000-4000-8000-000000001599";
      database.exec("DROP TRIGGER business_action_receipts_no_update");
      database.prepare(
        "UPDATE business_action_receipts SET result_json=? WHERE operation_id=?",
      ).run(canonical(receipt), CHECK_OPERATION);
      database.exec(receiptTrigger);
    } else if (kind === "orphan-state") {
      database.prepare(
        `INSERT INTO structured_message_state_revisions(
           project_id,thread_id,block_id,state_version,prior_state_version,
           state_kind,state_json,created_at
         ) VALUES (?,?,?,4,3,'checklist',
                   '{"items":[{"checked":true,"id":"item-a"},{"checked":false,"id":"item-b"}]}',?)`,
      ).run(tuple.projectId, tuple.threadId, checklistBlockId, NOW);
      database.prepare(
        `UPDATE structured_message_state_heads SET current_state_version=4
         WHERE project_id=? AND thread_id=? AND block_id=?`,
      ).run(tuple.projectId, tuple.threadId, checklistBlockId);
    } else if (kind === "check-missing-target") {
      fabricateChecklistTransition({
        action: "check_item",
        itemId: "ghost-item",
        nextState: { items: [
          { checked: false, id: "item-a" },
          { checked: false, id: "item-b" },
        ] },
        operationId: "00000000-0000-4000-8000-000000001520",
      });
    } else if (kind === "check-wrong-direction") {
      fabricateChecklistTransition({
        action: "uncheck_item",
        itemId: "item-b",
        nextState: { items: [
          { checked: false, id: "item-a" },
          { checked: true, id: "item-b" },
        ] },
        operationId: "00000000-0000-4000-8000-000000001521",
      });
    } else if (kind === "check-multiple") {
      fabricateChecklistTransition({
        action: "check_item",
        itemId: "item-b",
        nextState: { items: [
          { checked: true, id: "item-a" },
          { checked: true, id: "item-b" },
        ] },
        operationId: "00000000-0000-4000-8000-000000001522",
      });
    } else {
      fabricateChecklistTransition({
        action: "check_item",
        itemId: "item-b",
        nextState: { items: [
          { checked: true, id: "item-b" },
          { checked: false, id: "item-a" },
        ] },
        operationId: "00000000-0000-4000-8000-000000001523",
      });
    }
    database.close();
  }

  it("keeps legal outcomes exactly-once, replay side-effect-free, and conflict result-free across reopen", () => {
    const replayed = decideInline(databasePath, checklistTuple, JSON.stringify({
      action: "check_item",
      expectedStateVersion: 1,
      itemId: "item-a",
      operationId: CHECK_OPERATION,
    }));
    expect(replayed).toEqual(checkResult);
    const raw = new DatabaseSync(databasePath);
    try {
      expect(raw.prepare("SELECT count(*) AS count FROM inline_decisions").get())
        .toEqual({ count: 3 });
      expect(raw.prepare("SELECT count(*) AS count FROM business_action_receipts").get())
        .toEqual({ count: 3 });
      expect(raw.prepare(
        "SELECT count(*) AS count FROM collaboration_thread_facts WHERE type='inline_decision'",
      ).get()).toEqual({ count: 3 });
      expect(raw.prepare(
        "SELECT count(*) AS count FROM inline_decisions WHERE operation_id=?",
      ).get(CONFLICT_OPERATION)).toEqual({ count: 0 });
      expect(raw.prepare(
        "SELECT count(*) AS count FROM business_action_receipts WHERE operation_id=?",
      ).get(CONFLICT_OPERATION)).toEqual({ count: 0 });
    } finally {
      raw.close();
    }
    for (let reopen = 0; reopen < 2; reopen += 1) {
      const database = openDatabase(databasePath);
      database.close();
    }
  });

  it.each([
    "check-content-drift",
    "check-missing-target",
    "check-multiple",
    "check-wrong-direction",
    "conflict-result",
    "missing-decision",
    "orphan-state",
    "outcome-field",
  ] as const)(
    "fails reopen closed with a stable redacted error for a single %s corruption and never writes",
    (kind) => {
      const identity = outcomeUserVersion();
      corruptOutcome(kind);
      for (let reopen = 0; reopen < 2; reopen += 1) {
        expect(() => {
          const database = openDatabase(databasePath);
          database.close();
        }).toThrowError(
          expect.objectContaining<Partial<SchemaError>>({
            code: "SCHEMA_DATA_INVALID",
            message: "Database data is invalid.",
          }),
        );
      }
      const raw = new DatabaseSync(databasePath);
      try {
        expect(raw.isTransaction).toBe(false);
        expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: identity });
      } finally {
        raw.close();
      }
    },
  );
});
