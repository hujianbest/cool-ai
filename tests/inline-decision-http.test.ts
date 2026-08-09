import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readThreadFacts } from "@/src/server/collaboration/thread-service";
import { openDatabase } from "@/src/server/db";
import { appendStructuredMessage } from "@/src/server/structured-messages/structured-message-store";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";

type HttpModule = {
  inlineDecisionPost: (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;
  inlineOperationGet: (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;
};

const modules = import.meta.glob<HttpModule>(
  "../src/server/structured-messages/structured-message-http.ts",
);
const NOW = "2026-08-09T02:00:00.000Z";
let directory: string;
let tuple: Record<string, string>;

async function http(): Promise<HttpModule> {
  const load = modules["../src/server/structured-messages/structured-message-http.ts"];
  if (!load) throw new Error("Structured Message HTTP module is missing.");
  return load();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "inline-decision-http-"));
  process.env.COCKPIT_DB_PATH = join(directory, "cockpit.sqlite");
  const projectId = "project-inline-http";
  const runId = "run-inline-http";
  const threadId = seedV7AdvanceFixture(process.env.COCKPIT_DB_PATH, {
    agentId: "agent-inline-http-a",
    agentPrompt: "Plan",
    missionId: "mission-inline-http",
    now: NOW,
    ownerMessage: null,
    projectId,
    projectName: "Inline HTTP",
    providerId: "provider-inline-http",
    runId,
    secondAgentId: "agent-inline-http-b",
    secondAgentPrompt: "Review",
    threadCreateOperationId: "00000000-0000-4000-8000-000000000910",
  });
  const messageId = "message-inline-http";
  appendStructuredMessage(process.env.COCKPIT_DB_PATH, {
    actor: { displayName: "Owner", id: null, type: "owner" },
    blocksRaw: JSON.stringify({
      blocks: [{
        actions: ["accept", "reject"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        body: "Choose.",
        logicalBlockId: "proposal-inline-http",
        title: "Choice",
      }],
    }),
    content: "Choose.",
    factId: "fact-inline-http",
    messageId,
    projectId,
    runId,
    threadId,
    timestamp: NOW,
  });
  const database = openDatabase(process.env.COCKPIT_DB_PATH);
  const block = database.prepare(
    "SELECT id FROM structured_message_blocks WHERE message_id=?",
  ).get(messageId) as { id: string };
  database.close();
  tuple = { blockId: block.id, messageId, projectId, runId, threadId };
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("Inline Decision strict tuple HTTP", () => {
  it("accepts an exact Proposal action and rejects cross-tuple requests indistinguishably", async () => {
    const adapter = await http();
    expect(adapter.inlineDecisionPost, "Inline Decision POST adapter must exist").toBeTypeOf("function");
    const raw = JSON.stringify({
      action: "accept",
      expectedStateVersion: 1,
      operationId: "00000000-0000-4000-8000-000000000911",
    });
    const request = new Request(
      `http://localhost/api/projects/${tuple.projectId}/threads/${tuple.threadId}/runs/${tuple.runId}/messages/${tuple.messageId}/blocks/${tuple.blockId}/decision`,
      { body: raw, headers: { "content-type": "application/json" }, method: "POST" },
    );
    const response = await adapter.inlineDecisionPost(request, { params: Promise.resolve(tuple) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "completed",
      receipt: { action: "accept", blockId: tuple.blockId },
    });
    expect(readThreadFacts(
      process.env.COCKPIT_DB_PATH!,
      tuple.projectId,
      tuple.threadId,
      { after: 0, limit: 200 },
    ).body.items).toEqual(expect.arrayContaining([expect.objectContaining({
      message: null,
      payload: expect.objectContaining({
        action: "accept",
        blockId: tuple.blockId,
        fromStateVersion: 1,
        toStateVersion: 2,
      }),
      type: "inline_decision",
    })]));

    const cross = await adapter.inlineDecisionPost(
      new Request(request.url, {
        body: JSON.stringify({
          action: "accept",
          expectedStateVersion: 1,
          operationId: "00000000-0000-4000-8000-000000000912",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ ...tuple, threadId: "thread-other" }) },
    );
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual({
      error: { code: "RESOURCE_NOT_FOUND", message: "Resource was not found." },
    });
  });

  it("rejects query parameters, media types, extra fields, and oversized bodies without writes", async () => {
    const adapter = await http();
    expect(adapter.inlineDecisionPost).toBeTypeOf("function");
    const base = `http://localhost/api/projects/${tuple.projectId}/threads/${tuple.threadId}/runs/${tuple.runId}/messages/${tuple.messageId}/blocks/${tuple.blockId}/decision`;
    const cases = [
      new Request(`${base}?unexpected=1`, {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      new Request(base, {
        body: "{}",
        headers: { "content-type": "text/plain" },
        method: "POST",
      }),
      new Request(base, {
        body: JSON.stringify({
          action: "reject",
          expectedStateVersion: 1,
          extra: true,
          operationId: "00000000-0000-4000-8000-000000000913",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      new Request(base, {
        body: `{"padding":"${"x".repeat(33 * 1024)}"}`,
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    ];
    for (const request of cases) {
      const response = await adapter.inlineDecisionPost(request, { params: Promise.resolve(tuple) });
      expect([400, 413, 415]).toContain(response.status);
    }
    const database = openDatabase(process.env.COCKPIT_DB_PATH!);
    expect(database.prepare(
      "SELECT count(*) AS count FROM collaboration_operations WHERE kind='inline_decision'",
    ).get()).toEqual({ count: 0 });
    database.close();
  });

  it("reconciles completed operations and returns OPERATION_NOT_FOUND for safe unknown-write retry", async () => {
    const adapter = await http();
    expect(adapter.inlineOperationGet, "Inline operation GET adapter must exist").toBeTypeOf("function");
    const operationId = "00000000-0000-4000-8000-000000001121";
    const write = await adapter.inlineDecisionPost(
      new Request("http://localhost/decision", {
        body: JSON.stringify({ action: "reject", expectedStateVersion: 1, operationId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve(tuple) },
    );
    const writeBody = await write.json();
    const operationTuple = {
      operationId,
      projectId: tuple.projectId,
      runId: tuple.runId,
      threadId: tuple.threadId,
    };
    const known = await adapter.inlineOperationGet(
      new Request("http://localhost/operation"),
      { params: Promise.resolve(operationTuple) },
    );
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual(writeBody);

    const unknown = await adapter.inlineOperationGet(
      new Request("http://localhost/operation"),
      { params: Promise.resolve({ ...operationTuple, operationId: "operation-unknown" }) },
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: {
        code: "OPERATION_NOT_FOUND",
        message: "Operation was not found.",
      },
    });
    const cross = await adapter.inlineOperationGet(
      new Request("http://localhost/operation"),
      { params: Promise.resolve({ ...operationTuple, runId: "run-other" }) },
    );
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual({
      error: { code: "OPERATION_NOT_FOUND", message: "Operation was not found." },
    });
  });
});
