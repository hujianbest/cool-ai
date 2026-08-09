import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { readThreadFacts } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { reduceTranscript } from "@/src/shared/transcript-model";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type StoreModule = {
  appendStructuredMessage: (databasePath: string, input: {
    actor: { displayName: string; id: string | null; type: "owner" | "agent" };
    blocksRaw: string;
    content: string;
    factId: string;
    messageId: string;
    projectId: string;
    runId: string | null;
    threadId: string;
    timestamp: string;
  }) => unknown;
  readStructuredMessage: (
    databasePath: string,
    tuple: { messageId: string; projectId: string; threadId: string },
  ) => unknown;
  encodeStructuredMessageDomain: (domain: unknown) => {
    canonicalBytes: Uint8Array;
    hash: string;
  };
};

const modules = import.meta.glob<StoreModule>(
  "../../../src/adapters/outbound/sqlite/public-collaboration/structured-message-store.ts",
);

async function loadStore(): Promise<StoreModule> {
  const load = modules["../../../src/adapters/outbound/sqlite/public-collaboration/structured-message-store.ts"];
  expect(load, "the Structured Message Store public seam must exist").toBeTypeOf("function");
  return load();
}

function fixture(): { path: string; projectId: string; runId: string; threadId: string } {
  const path = memoryDatabasePath();
  const projectId = "project-structured";
  const runId = "run-structured";
  const threadId = seedV7AdvanceFixture(path, {
    agentId: "agent-alpha",
    agentPrompt: "Plan",
    missionId: "mission-structured",
    now: "2026-08-09T00:00:00.000Z",
    ownerMessage: "Existing plain text",
    projectId,
    projectName: "Structured",
    providerId: "provider-structured",
    runId,
    secondAgentId: "agent-beta",
    secondAgentPrompt: "Review",
    threadCreateOperationId: "00000000-0000-4000-8000-000000000801",
  });
  return { path, projectId, runId, threadId };
}

afterEach(() => {
});

describe("Structured Message Store public seam", () => {
  it("atomically persists and reads one immutable Proposal through its existing message fact", async () => {
    const store = await loadStore();
    const setup = fixture();
    const input = {
      actor: { displayName: "Owner", id: null, type: "owner" as const },
      blocksRaw: JSON.stringify({
        blocks: [{
          actions: ["accept", "reject"],
          blockRevision: 1,
          blockSchemaVersion: 1,
          blockType: "proposal",
          body: "Adopt the normalized model.",
          logicalBlockId: "proposal-normalized",
          title: "Storage model",
        }],
      }),
      content: "Please decide.",
      factId: "fact-proposal",
      messageId: "message-proposal",
      projectId: setup.projectId,
      runId: setup.runId,
      threadId: setup.threadId,
      timestamp: "2026-08-09T00:01:00.000Z",
    };

    store.appendStructuredMessage(setup.path, input);
    expect(store.readStructuredMessage(setup.path, {
      messageId: input.messageId,
      projectId: setup.projectId,
      threadId: setup.threadId,
    })).toEqual({
      actor: input.actor,
      blocks: [{
        actor: input.actor,
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        id: expect.any(String),
        logicalBlockId: "proposal-normalized",
        payload: {
          actions: ["accept", "reject"],
          blockRevision: 1,
          blockSchemaVersion: 1,
          blockType: "proposal",
          body: "Adopt the normalized model.",
          logicalBlockId: "proposal-normalized",
          title: "Storage model",
        },
        position: 0,
        source: {
          entityVersion: null,
          id: input.messageId,
          kind: "message",
          messageId: input.messageId,
          projectId: setup.projectId,
          runId: setup.runId,
          threadId: setup.threadId,
        },
        state: { stateVersion: 1, status: "pending" },
      }],
      content: input.content,
      factId: input.factId,
      messageId: input.messageId,
      projectId: setup.projectId,
      runId: setup.runId,
      threadId: setup.threadId,
    });

    const factPage = readThreadFacts(
      setup.path,
      setup.projectId,
      setup.threadId,
      { after: 0, limit: 200 },
    ).body;
    const transcript = reduceTranscript({
      currentTargetKey: `${setup.projectId}|${setup.threadId}|${setup.runId}`,
      pages: [factPage],
      targetKey: `${setup.projectId}|${setup.threadId}|${setup.runId}`,
    });
    expect(transcript).toMatchObject({
      kind: "ready",
      entries: expect.arrayContaining([expect.objectContaining({
        factId: input.factId,
        text: input.content,
        blocks: [expect.objectContaining({
          id: expect.any(String),
          kind: "proposal",
          title: "Storage model",
        })],
      })]),
    });

    const database = openDatabase(setup.path);
    expect(database.prepare(
      "SELECT count(*) AS count FROM collaboration_thread_facts WHERE message_id=?",
    ).get(input.messageId)).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT content FROM collaboration_messages ORDER BY sequence",
    ).all()).toEqual(expect.arrayContaining([
      { content: "Existing plain text" },
      { content: "Please decide." },
    ]));
    database.close();
  });

  it("rejects block-only input without any partial message, block, state, or fact", async () => {
    const store = await loadStore();
    const setup = fixture();

    expect(() => store.appendStructuredMessage(setup.path, {
      actor: { displayName: "Owner", id: null, type: "owner" },
      blocksRaw: JSON.stringify({
        blocks: [{
          actions: ["accept", "reject"],
          blockRevision: 1,
          blockSchemaVersion: 1,
          blockType: "proposal",
          body: "No message body.",
          logicalBlockId: "proposal-invalid",
          title: "Invalid",
        }],
      }),
      content: "",
      factId: "fact-invalid",
      messageId: "message-invalid",
      projectId: setup.projectId,
      runId: setup.runId,
      threadId: setup.threadId,
      timestamp: "2026-08-09T00:01:00.000Z",
    })).toThrow();

    const database = openDatabase(setup.path);
    expect(database.prepare(
      "SELECT count(*) AS count FROM collaboration_messages WHERE id='message-invalid'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM structured_message_blocks WHERE logical_block_id='proposal-invalid'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM collaboration_thread_facts WHERE id='fact-invalid'",
    ).get()).toEqual({ count: 0 });
    database.close();
  });

  it("measures and hashes the complete canonical domain envelope at 256 KiB ±1", async () => {
    const store = await loadStore();
    const domain = {
      actor: { displayName: "Agent", id: "agent", type: "agent" },
      blocks: [{
        blockId: "block",
        metadata: {
          blockRevision: 1,
          blockSchemaVersion: 1,
          blockType: "proposal",
          logicalBlockId: "logical",
          position: 0,
        },
        payload: { body: "" },
        source: {
          entityVersion: null,
          id: "message",
          kind: "message",
          messageId: "message",
          projectId: "project",
          runId: "run",
          threadId: "thread",
        },
        state: { stateVersion: 1, value: { status: "pending" } },
      }],
      message: {
        id: "message",
        projectId: "project",
        runId: "run",
        threadId: "thread",
      },
      schemaVersion: 1,
    };
    const baseline = Buffer.byteLength(JSON.stringify(domain));
    domain.blocks[0].payload.body = "x".repeat(256 * 1024 - baseline);
    const exact = store.encodeStructuredMessageDomain(domain);
    expect(exact.canonicalBytes.byteLength).toBe(256 * 1024);
    expect(exact.hash).toBe(
      createHash("sha256").update(exact.canonicalBytes).digest("hex"),
    );
    domain.blocks[0].payload.body += "x";
    expect(() => store.encodeStructuredMessageDomain(domain)).toThrow();
  });
});
