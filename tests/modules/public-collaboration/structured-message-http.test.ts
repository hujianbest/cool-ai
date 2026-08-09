import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendStructuredMessage } from "@/src/adapters/outbound/sqlite/public-collaboration/structured-message-store";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import { currentSchemaObjectSql } from "@/tests/fixtures/current-schema-object";

type AdapterModule = {
  structuredMessageBlockGet: (request: Request, context: {
    params: Promise<Record<string, string>>;
  }) => Promise<Response>;
  structuredMessageSourcePost: (request: Request, context: {
    params: Promise<Record<string, string>>;
  }) => Promise<Response>;
};

const modules = import.meta.glob<AdapterModule>(
  "../../../app/api/_shared/structured-messages/structured-message-http.ts",
);
const directories: string[] = [];

async function adapter(): Promise<AdapterModule> {
  const load = modules["../../../app/api/_shared/structured-messages/structured-message-http.ts"];
  expect(load, "strict tuple Structured Message HTTP adapter must exist").toBeTypeOf("function");
  return load();
}

function fixture(): {
  blockId: string;
  messageId: string;
  path: string;
  projectId: string;
  runId: string;
  threadId: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "structured-message-http-"));
  directories.push(directory);
  const path = join(directory, "cockpit.sqlite");
  const projectId = "project-http";
  const runId = "run-http";
  const threadId = seedV7AdvanceFixture(path, {
    agentId: "agent-http-a",
    agentPrompt: "Plan",
    missionId: "mission-http",
    now: "2026-08-09T00:00:00.000Z",
    ownerMessage: null,
    projectId,
    projectName: "HTTP",
    providerId: "provider-http",
    runId,
    secondAgentId: "agent-http-b",
    secondAgentPrompt: "Review",
    threadCreateOperationId: "00000000-0000-4000-8000-000000000808",
  });
  const messageId = "message-http";
  appendStructuredMessage(path, {
    actor: { displayName: "Owner", id: null, type: "owner" },
    blocksRaw: JSON.stringify({
      blocks: [{
        actions: ["accept", "reject"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        body: "Choose safely.",
        logicalBlockId: "proposal-http",
        title: "Choice",
      }],
    }),
    content: "Choose.",
    factId: "fact-http",
    messageId,
    projectId,
    runId,
    threadId,
    timestamp: "2026-08-09T00:01:00.000Z",
  });
  const database = openDatabase(path);
  const block = database.prepare(
    "SELECT id FROM structured_message_blocks WHERE message_id=?",
  ).get(messageId) as { id: string };
  database.close();
  return { blockId: block.id, messageId, path, projectId, runId, threadId };
}

function context(setup: ReturnType<typeof fixture>, overrides: Record<string, string> = {}) {
  return {
    params: Promise.resolve({
      blockId: setup.blockId,
      messageId: setup.messageId,
      projectId: setup.projectId,
      runId: setup.runId,
      threadId: setup.threadId,
      ...overrides,
    }),
  };
}

function restoreBlockImmutability(database: ReturnType<typeof openDatabase>): void {
  database.exec(currentSchemaObjectSql("structured_message_blocks_no_update"));
}

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("strict tuple Structured Message HTTP adapter", () => {
  it("reads a Known block and makes every tuple substitution indistinguishable from unknown", async () => {
    const api = await adapter();
    const setup = fixture();
    process.env.COCKPIT_DB_PATH = setup.path;
    const response = await api.structuredMessageBlockGet(
      new Request("http://local/structured-message"),
      context(setup),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      block: {
        blockRevision: 1,
        blockSchemaVersion: 1,
        kind: "known",
        source: { id: setup.messageId, kind: "message" },
      },
    });

    for (const [field, value] of [
      ["projectId", "other-project"],
      ["threadId", "other-thread"],
      ["runId", "other-run"],
      ["messageId", "other-message"],
      ["blockId", "other-block"],
    ]) {
      const missing = await api.structuredMessageBlockGet(
        new Request("http://local/structured-message"),
        context(setup, { [field]: value }),
      );
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toMatchObject({ error: { code: "RESOURCE_NOT_FOUND" } });
    }
  });

  it("strictly rejects query/body/content-type and never invents navigation for message sources", async () => {
    const api = await adapter();
    const setup = fixture();
    process.env.COCKPIT_DB_PATH = setup.path;

    expect((await api.structuredMessageBlockGet(
      new Request("http://local/structured-message?latest=true"),
      context(setup),
    )).status).toBe(400);
    expect((await api.structuredMessageSourcePost(
      new Request("http://local/source", {
        body: JSON.stringify({ source: { id: setup.messageId, kind: "message", version: null } }),
        headers: { "content-type": "text/plain" },
        method: "POST",
      }),
      context(setup),
    )).status).toBe(415);
    const response = await api.structuredMessageSourcePost(
      new Request("http://local/source", {
        body: JSON.stringify({ source: { id: setup.messageId, kind: "message", version: null } }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      context(setup),
    );
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toMatch(/D:\\|raw|payload/i);
  });

  it("distinguishes UnknownSchema from Invalid persisted content without exposing raw payload", async () => {
    const api = await adapter();
    const unknown = fixture();
    process.env.COCKPIT_DB_PATH = unknown.path;
    let database = openDatabase(unknown.path);
    const unknownPayload =
      '{"blockRevision":1,"blockSchemaVersion":2,"blockType":"proposal","future":"opaque","logicalBlockId":"proposal-http"}';
    const unknownHash = createHash("sha256").update(unknownPayload).digest("hex");
    database.exec("DROP TRIGGER structured_message_blocks_no_update");
    database.prepare(
      `UPDATE structured_message_blocks
       SET block_schema_version=2,payload_json=?,payload_hash=?
       WHERE id=?`,
    ).run(unknownPayload, unknownHash, unknown.blockId);
    restoreBlockImmutability(database);
    database.close();

    const unknownResponse = await api.structuredMessageBlockGet(
      new Request("http://local/structured-message"),
      context(unknown),
    );
    expect(unknownResponse.status).toBe(200);
    await expect(unknownResponse.json()).resolves.toMatchObject({
      block: { blockSchemaVersion: 2, kind: "unknown-schema" },
    });

    const invalid = fixture();
    process.env.COCKPIT_DB_PATH = invalid.path;
    database = openDatabase(invalid.path);
    database.exec("DROP TRIGGER structured_message_blocks_no_update");
    database.prepare(
      `UPDATE structured_message_blocks
       SET payload_json='{"blockSchemaVersion":1,"blockType":"proposal"}'
       WHERE id=?`,
    ).run(invalid.blockId);
    restoreBlockImmutability(database);
    database.close();

    const invalidResponse = await api.structuredMessageBlockGet(
      new Request("http://local/structured-message"),
      context(invalid),
    );
    expect(invalidResponse.status).toBe(503);
    expect(JSON.stringify(await invalidResponse.json())).not.toContain("blockType");
  });
});
