import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendStructuredMessage,
  commitStructuredMessageTx,
  ingestStructuredBlocks,
} from "@/src/adapters/outbound/sqlite/public-collaboration/structured-message-store";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { validateCurrentSchema } from "@/src/adapters/outbound/sqlite/validate-current-schema";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";

type DecisionModule = {
  INLINE_DECISION_STEPS: readonly string[];
  decideInline: (
    databasePath: string,
    tuple: {
      blockId: string;
      messageId: string;
      projectId: string;
      runId: string;
      threadId: string;
    },
    raw: string | Uint8Array,
    dependencies?: {
      clock: () => Date;
      randomUUID: () => string;
      afterStep?: (step: string) => void;
    },
  ) => { body: unknown; status: number };
};

const modules = import.meta.glob<DecisionModule>(
  "../../../src/adapters/outbound/sqlite/public-collaboration/inline-decision-service.ts",
);

const NOW = "2026-08-09T01:00:00.000Z";
const OPERATION = "00000000-0000-4000-8000-000000000901";
let directory: string;
let databasePath: string;
let generatedId: number;
let tuple: {
  blockId: string;
  messageId: string;
  projectId: string;
  runId: string;
  threadId: string;
};

async function service(): Promise<DecisionModule> {
  const load = modules["../../../src/adapters/outbound/sqlite/public-collaboration/inline-decision-service.ts"];
  expect(load, "Inline Decision domain seam must exist").toBeTypeOf("function");
  return load();
}

function dependencies(afterStep?: (step: string) => void) {
  return {
    afterStep,
    clock: () => new Date(NOW),
    randomUUID: () => {
      generatedId += 1;
      return `90000000-0000-4000-8000-${generatedId.toString().padStart(12, "0")}`;
    },
  };
}

function businessCounts() {
  const database = openDatabase(databasePath);
  try {
    return {
      decisions: (database.prepare("SELECT count(*) AS count FROM inline_decisions").get() as { count: number }).count,
      facts: (database.prepare(
        "SELECT count(*) AS count FROM collaboration_thread_facts WHERE type='inline_decision'",
      ).get() as { count: number }).count,
      operations: (database.prepare(
        "SELECT count(*) AS count FROM collaboration_operations WHERE kind='inline_decision'",
      ).get() as { count: number }).count,
      receipts: (database.prepare("SELECT count(*) AS count FROM business_action_receipts").get() as { count: number }).count,
      revisions: (database.prepare(
        "SELECT count(*) AS count FROM structured_message_state_revisions WHERE block_id=?",
      ).get(tuple.blockId) as { count: number }).count,
    };
  } finally {
    database.close();
  }
}

function createChecklist() {
  const database = openDatabase(databasePath);
  database.exec("BEGIN");
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
            { id: "item-a", text: "First" },
            { id: "item-b", text: "Second" },
          ],
          logicalBlockId: "checklist-inline",
          title: "Steps",
        }],
      })),
      content: "Track the work.",
      factId: "fact-checklist-inline",
      messageId: "message-checklist-inline",
      projectId: tuple.projectId,
      runId: tuple.runId,
      threadId: tuple.threadId,
      timestamp: NOW,
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  const block = database.prepare(
    "SELECT id,payload_json AS payloadJson FROM structured_message_blocks WHERE message_id=?",
  ).get("message-checklist-inline") as { id: string; payloadJson: string };
  database.close();
  return {
    payloadJson: block.payloadJson,
    tuple: { ...tuple, blockId: block.id, messageId: "message-checklist-inline" },
  };
}

beforeEach(() => {
  generatedId = 0;
  directory = mkdtempSync(join(tmpdir(), "inline-decision-"));
  databasePath = join(directory, "cockpit.sqlite");
  const projectId = "project-inline";
  const runId = "run-inline";
  const threadId = seedV7AdvanceFixture(databasePath, {
    agentId: "agent-inline-a",
    agentPrompt: "Plan",
    missionId: "mission-inline",
    now: NOW,
    ownerMessage: null,
    projectId,
    projectName: "Inline",
    providerId: "provider-inline",
    runId,
    secondAgentId: "agent-inline-b",
    secondAgentPrompt: "Review",
    threadCreateOperationId: "00000000-0000-4000-8000-000000000900",
  });
  const messageId = "message-proposal-inline";
  appendStructuredMessage(databasePath, {
    actor: { displayName: "Owner", id: null, type: "owner" },
    blocksRaw: JSON.stringify({
      blocks: [{
        actions: ["accept", "reject"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        body: "Adopt this plan.",
        logicalBlockId: "proposal-inline",
        title: "Plan",
      }],
    }),
    content: "Choose.",
    factId: "fact-proposal-inline",
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
});

afterEach(() => rmSync(directory, { force: true, recursive: true }));

describe("Proposal Inline Decision public domain seam", () => {
  it("atomically accepts an exact pending Proposal and returns its unique business receipt", async () => {
    const { decideInline } = await service();
    const result = decideInline(databasePath, tuple, JSON.stringify({
      action: "accept",
      expectedStateVersion: 1,
      operationId: OPERATION,
    }), dependencies());

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      kind: "completed",
      receipt: {
        action: "accept",
        blockId: tuple.blockId,
        blockRevision: 1,
        fromStateVersion: 1,
        operationId: OPERATION,
        receiptSchemaVersion: 1,
        toStateVersion: 2,
      },
    });
    expect(businessCounts()).toEqual({
      decisions: 1,
      facts: 1,
      operations: 1,
      receipts: 1,
      revisions: 2,
    });

    const database = openDatabase(databasePath);
    expect(database.prepare(
      `SELECT h.current_state_version AS stateVersion,s.state_json AS stateJson
       FROM structured_message_state_heads h
       JOIN structured_message_state_revisions s
         ON (s.project_id,s.thread_id,s.block_id,s.state_version)=
            (h.project_id,h.thread_id,h.block_id,h.current_state_version)
       WHERE h.block_id=?`,
    ).get(tuple.blockId)).toEqual({
      stateJson: '{"status":"accepted"}',
      stateVersion: 2,
    });
    database.close();
  });

  it("rejects unsupported actions and every injected transaction fault with zero partial business rows", async () => {
    const decision = await service();
    expect(() => decision.decideInline(databasePath, tuple, JSON.stringify({
      action: "execute",
      expectedStateVersion: 1,
      operationId: OPERATION,
    }), dependencies())).toThrow();
    expect(businessCounts()).toEqual({
      decisions: 0,
      facts: 0,
      operations: 0,
      receipts: 0,
      revisions: 1,
    });

    for (const step of decision.INLINE_DECISION_STEPS) {
      expect(() => decision.decideInline(databasePath, tuple, JSON.stringify({
        action: "reject",
        expectedStateVersion: 1,
        operationId: OPERATION,
      }), dependencies((current) => {
        if (current === step) throw new Error(`fault:${step}`);
      }))).toThrow(`fault:${step}`);
      expect(businessCounts()).toEqual({
        decisions: 0,
        facts: 0,
        operations: 0,
        receipts: 0,
        revisions: 1,
      });
    }
  });
});

describe("Checklist Inline Decision", () => {
  it("checks and unchecks exactly one existing item across contiguous immutable revisions", async () => {
    const { decideInline } = await service();
    const checklist = createChecklist();
    const checked = decideInline(databasePath, checklist.tuple, JSON.stringify({
      action: "check_item",
      expectedStateVersion: 1,
      itemId: "item-a",
      operationId: "00000000-0000-4000-8000-000000001001",
    }), dependencies());
    expect(checked).toMatchObject({
      status: 200,
      body: { receipt: { itemId: "item-a", fromStateVersion: 1, toStateVersion: 2 } },
    });
    const unchecked = decideInline(databasePath, checklist.tuple, JSON.stringify({
      action: "uncheck_item",
      expectedStateVersion: 2,
      itemId: "item-a",
      operationId: "00000000-0000-4000-8000-000000001002",
    }), dependencies());
    expect(unchecked).toMatchObject({
      status: 200,
      body: { receipt: { itemId: "item-a", fromStateVersion: 2, toStateVersion: 3 } },
    });

    const database = openDatabase(databasePath);
    const revisions = database.prepare(
      `SELECT state_version AS stateVersion,state_json AS stateJson
       FROM structured_message_state_revisions WHERE block_id=? ORDER BY state_version`,
    ).all(checklist.tuple.blockId);
    const block = database.prepare(
      "SELECT block_revision AS blockRevision,payload_json AS payloadJson FROM structured_message_blocks WHERE id=?",
    ).get(checklist.tuple.blockId);
    const decisions = database.prepare(
      "SELECT count(*) AS count FROM inline_decisions WHERE block_id=?",
    ).get(checklist.tuple.blockId);
    expect(() => validateCurrentSchema(database)).not.toThrow();
    database.close();
    expect(revisions).toEqual([
      {
        stateJson: '{"items":[{"checked":false,"id":"item-a"},{"checked":false,"id":"item-b"}]}',
        stateVersion: 1,
      },
      {
        stateJson: '{"items":[{"checked":true,"id":"item-a"},{"checked":false,"id":"item-b"}]}',
        stateVersion: 2,
      },
      {
        stateJson: '{"items":[{"checked":false,"id":"item-a"},{"checked":false,"id":"item-b"}]}',
        stateVersion: 3,
      },
    ]);
    expect(block).toEqual({
      blockRevision: 1,
      payloadJson: checklist.payloadJson,
    });
    expect(decisions).toEqual({ count: 2 });
  });

  it("rejects missing, repeated-target, batch, and extra-field item changes with zero writes", async () => {
    const { decideInline } = await service();
    expect(() => ingestStructuredBlocks(JSON.stringify({
      blocks: [{
        actions: ["check_item", "uncheck_item"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "checklist",
        items: [
          { id: "duplicate", text: "First" },
          { id: "duplicate", text: "Second" },
        ],
        logicalBlockId: "ambiguous-checklist",
        title: "Ambiguous",
      }],
    }))).toThrow();
    const checklist = createChecklist();
    const invalidRequests = [
      {
        action: "check_item",
        expectedStateVersion: 1,
        itemId: "missing",
        operationId: "00000000-0000-4000-8000-000000001011",
      },
      {
        action: "check_item",
        expectedStateVersion: 1,
        itemId: "item-a",
        itemIds: ["item-a", "item-b"],
        operationId: "00000000-0000-4000-8000-000000001012",
      },
      {
        action: "accept",
        expectedStateVersion: 1,
        itemId: "item-a",
        operationId: "00000000-0000-4000-8000-000000001013",
      },
    ];
    for (const request of invalidRequests) {
      expect(() => decideInline(
        databasePath,
        checklist.tuple,
        JSON.stringify(request),
        dependencies(),
      )).toThrow();
    }
    decideInline(databasePath, checklist.tuple, JSON.stringify({
      action: "check_item",
      expectedStateVersion: 1,
      itemId: "item-a",
      operationId: "00000000-0000-4000-8000-000000001014",
    }), dependencies());
    expect(() => decideInline(databasePath, checklist.tuple, JSON.stringify({
      action: "check_item",
      expectedStateVersion: 2,
      itemId: "item-a",
      operationId: "00000000-0000-4000-8000-000000001015",
    }), dependencies())).toThrow();

    const database = openDatabase(databasePath);
    expect(database.prepare(
      "SELECT count(*) AS count FROM inline_decisions WHERE block_id=?",
    ).get(checklist.tuple.blockId)).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM collaboration_operations WHERE id LIKE '%1011' OR id LIKE '%1012' OR id LIKE '%1013' OR id LIKE '%1015'",
    ).get()).toEqual({ count: 0 });
    database.close();
  });
});

describe("Inline Decision operation outcome matrix", () => {
  it("replays completed same-hash success and rejects a changed hash without changing the original", async () => {
    const { decideInline } = await service();
    const firstRaw = '{"operationId":"00000000-0000-4000-8000-000000001101","expectedStateVersion":1,"action":"accept"}';
    const first = decideInline(databasePath, tuple, firstRaw, dependencies());
    const replay = decideInline(
      databasePath,
      tuple,
      '{ "action":"accept", "expectedStateVersion":1, "operationId":"00000000-0000-4000-8000-000000001101" }',
      dependencies(),
    );
    expect(replay).toEqual(first);
    expect(() => decideInline(databasePath, tuple, JSON.stringify({
      action: "reject",
      expectedStateVersion: 1,
      operationId: "00000000-0000-4000-8000-000000001101",
    }), dependencies())).toThrowError(/different input/i);
    expect(businessCounts()).toEqual({
      decisions: 1,
      facts: 1,
      operations: 1,
      receipts: 1,
      revisions: 2,
    });
    const database = openDatabase(databasePath);
    expect(() => validateCurrentSchema(database)).not.toThrow();
    database.close();
  });

  it("persists and deterministically replays terminal version-conflict with zero business rows", async () => {
    const { decideInline } = await service();
    const staleRaw = JSON.stringify({
      action: "reject",
      expectedStateVersion: 7,
      operationId: "00000000-0000-4000-8000-000000001111",
    });
    const conflict = decideInline(databasePath, tuple, staleRaw, dependencies());
    expect(conflict).toEqual({
      body: {
        currentStateVersion: 1,
        error: {
          code: "VERSION_CONFLICT",
          message: "Structured message state changed.",
        },
        kind: "version_conflict",
      },
      status: 409,
    });
    decideInline(databasePath, tuple, JSON.stringify({
      action: "accept",
      expectedStateVersion: 1,
      operationId: "00000000-0000-4000-8000-000000001112",
    }), dependencies());
    expect(decideInline(
      databasePath,
      tuple,
      '{ "expectedStateVersion":7,"action":"reject","operationId":"00000000-0000-4000-8000-000000001111" }',
      dependencies(),
    )).toEqual(conflict);

    const database = openDatabase(databasePath);
    expect(database.prepare(
      `SELECT status,http_status AS httpStatus,lease_applicability AS leaseApplicability,
              lease_id AS leaseId FROM collaboration_operations WHERE id=?`,
    ).get("00000000-0000-4000-8000-000000001111")).toEqual({
      httpStatus: 409,
      leaseApplicability: "not_applicable",
      leaseId: null,
      status: "version_conflict",
    });
    expect(database.prepare(
      "SELECT count(*) AS count FROM inline_decisions WHERE operation_id=?",
    ).get("00000000-0000-4000-8000-000000001111")).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM business_action_receipts WHERE operation_id=?",
    ).get("00000000-0000-4000-8000-000000001111")).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM collaboration_operations WHERE kind='inline_decision' AND status='pending'",
    ).get()).toEqual({ count: 0 });
    database.close();
  });
});
