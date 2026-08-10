import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getPendingApprovals } from "@/app/api/projects/[projectId]/approvals/pending/route";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { appendStructuredMessage } from "@/src/adapters/outbound/sqlite/public-collaboration/structured-message-store";
import { seedCurrentAdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-10T04:00:00.000Z";
const PROJECT_ID = "project-approval-center-api";
const RUN_ID = "run-approval-center-api";

let databasePath: string;
let database: DatabaseSync;
let threadId: string;

beforeEach(() => {
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  database = openDatabase(databasePath);
  threadId = seedCurrentAdvanceFixture(databasePath, {
    agentId: "agent-ac-api-a",
    agentPrompt: "Plan",
    missionId: "mission-approval-center-api",
    now: NOW,
    ownerMessage: null,
    projectId: PROJECT_ID,
    projectName: "Approval Center API",
    providerId: "provider-ac-api",
    runId: RUN_ID,
    secondAgentId: "agent-ac-api-b",
    secondAgentPrompt: "Review",
    threadCreateOperationId: "00000000-0000-4000-8000-00000000ac51",
  });
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  database.close();
});

function projectContext(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function addProposal(input: {
  body: string;
  factId: string;
  logicalBlockId: string;
  messageId: string;
  timestamp: string;
  title: string;
}): string {
  appendStructuredMessage(databasePath, {
    actor: { displayName: "Agent Alpha", id: "agent-ac-api-a", type: "agent" },
    blocksRaw: JSON.stringify({
      blocks: [{
        actions: ["accept", "reject"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        body: input.body,
        logicalBlockId: input.logicalBlockId,
        title: input.title,
      }],
    }),
    content: "Decide.",
    factId: input.factId,
    messageId: input.messageId,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    threadId,
    timestamp: input.timestamp,
  });
  const block = database.prepare(
    "SELECT id FROM structured_message_blocks WHERE message_id=?",
  ).get(input.messageId) as { id: string };
  return block.id;
}

describe("GET /api/projects/:projectId/approvals/pending", () => {
  it("serves the aggregated pending list newest-first with no-store", async () => {
    const olderBlockId = addProposal({
      body: "Ship the older plan.",
      factId: "fact-api-proposal-older",
      logicalBlockId: "proposal-api-older",
      messageId: "message-api-proposal-older",
      timestamp: "2026-08-10T04:00:00.003Z",
      title: "Older plan",
    });
    const newerBlockId = addProposal({
      body: "Ship the newer plan.",
      factId: "fact-api-proposal-newer",
      logicalBlockId: "proposal-api-newer",
      messageId: "message-api-proposal-newer",
      timestamp: "2026-08-10T04:00:00.007Z",
      title: "Newer plan",
    });

    const response = await getPendingApprovals(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/approvals/pending`),
      projectContext(PROJECT_ID),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      approvals: [
        {
          approvalId: newerBlockId,
          createdAt: "2026-08-10T04:00:00.007Z",
          decisionHint: null,
          domain: "inline_decision",
          impactSummary: "Ship the newer plan.",
          kind: "proposal",
          sourceRef: {
            executionId: null,
            messageId: "message-api-proposal-newer",
            runId: RUN_ID,
            threadId,
          },
          status: "pending",
          title: "Newer plan",
        },
        {
          approvalId: olderBlockId,
          createdAt: "2026-08-10T04:00:00.003Z",
          decisionHint: null,
          domain: "inline_decision",
          impactSummary: "Ship the older plan.",
          kind: "proposal",
          sourceRef: {
            executionId: null,
            messageId: "message-api-proposal-older",
            runId: RUN_ID,
            threadId,
          },
          status: "pending",
          title: "Older plan",
        },
      ],
    });
  });

  it("serves an empty list for a project without pending requests", async () => {
    const response = await getPendingApprovals(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/approvals/pending`),
      projectContext(PROJECT_ID),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ approvals: [] });
  });

  it("returns 404 PROJECT_NOT_FOUND for a missing project", async () => {
    const response = await getPendingApprovals(
      new Request("http://localhost/api/projects/missing/approvals/pending"),
      projectContext("missing"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project was not found." },
    });
  });

  it("rejects a malformed projectId with 400 before touching storage", async () => {
    const response = await getPendingApprovals(
      new Request("http://localhost/api/projects/.. /approvals/pending"),
      projectContext(".."),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.fields).toContainEqual({
      code: "invalid_format",
      field: "projectId",
    });
  });

  it("rejects any query parameter with a stable 400 envelope", async () => {
    const response = await getPendingApprovals(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/approvals/pending?bogus=1`),
      projectContext(PROJECT_ID),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.fields).toContainEqual({ code: "unknown", field: "bogus" });
  });
});
