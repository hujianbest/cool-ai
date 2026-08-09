import { createHash } from "node:crypto";

import { DatabaseSync } from "node:sqlite";
import canonicalize from "canonicalize";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readThreadFacts,
  readThreadMessages,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";
import {
  decideInline,
  readInlineOperation,
} from "@/src/adapters/outbound/sqlite/public-collaboration/inline-decision-service";
import { appendStructuredMessage } from "@/src/adapters/outbound/sqlite/public-collaboration/structured-message-store";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import { currentSchemaObjectSql } from "@/tests/fixtures/current-schema-object";
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
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
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
          expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
        } finally {
          raw.close();
        }
      }
    },
  );
});
