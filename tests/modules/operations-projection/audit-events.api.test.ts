import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getProjectAuditEvents } from "@/app/api/projects/[projectId]/audit-events/route";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-10T03:00:00.000Z";
const PROJECT_ID = "audit-project";

let databasePath: string;
let database: DatabaseSync;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  database = openDatabase(databasePath);
  database.prepare(
    "INSERT INTO projects(id,name,created_at,version) VALUES (?,?,?,1)",
  ).run(PROJECT_ID, "Audit", NOW);
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  try {
    database.close();
  } catch {
    // Already closed by a failure-path test.
  }
  vi.useRealTimers();
});

function projectContext(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function insertOutboxRow(input: {
  id: string;
  seq: number;
  eventType?: string;
  payload?: Record<string, unknown>;
  projectId?: string;
}): void {
  database.prepare(`
    INSERT INTO audit_event_outbox (
      id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
    ) VALUES (?,?,'safe_execution',?,?,?,?)
  `).run(
    input.id,
    input.projectId ?? PROJECT_ID,
    input.eventType ?? "execution_started",
    JSON.stringify(input.payload ?? {
      actorId: null,
      actorType: "agent",
      attemptNo: 1,
      executionId: "execution-1",
      occurredAt: NOW,
      type: input.eventType ?? "execution_started",
    }),
    NOW,
    input.seq,
  );
}

describe("GET /api/projects/:projectId/audit-events", () => {
  it("serves the newest-first audit page with embedded freshness and no-store", async () => {
    insertOutboxRow({ id: "event-1", seq: 1 });
    insertOutboxRow({
      id: "event-2",
      seq: 2,
      eventType: "model_call_finished",
      payload: {
        actorId: "agent-1",
        actorType: "agent",
        attemptNo: 1,
        executionId: "execution-9",
        occurredAt: NOW,
        totalTokens: 42,
        type: "model_call_finished",
      },
    });

    const response = await getProjectAuditEvents(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/audit-events`),
      projectContext(PROJECT_ID),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      events: [
        {
          actorType: "agent",
          eventType: "model_call_finished",
          executionId: "execution-9",
          id: "event-2",
          occurredAt: NOW,
          outboxSeq: 2,
          payload: {
            actorId: "agent-1",
            actorType: "agent",
            attemptNo: 1,
            executionId: "execution-9",
            occurredAt: NOW,
            totalTokens: 42,
            type: "model_call_finished",
          },
        },
        {
          actorType: "agent",
          eventType: "execution_started",
          executionId: "execution-1",
          id: "event-1",
          occurredAt: NOW,
          outboxSeq: 1,
          payload: {
            actorId: null,
            actorType: "agent",
            attemptNo: 1,
            executionId: "execution-1",
            occurredAt: NOW,
            type: "execution_started",
          },
        },
      ],
      freshness: { lag: 0, status: "caught_up" },
      nextBeforeSeq: null,
    });
  });

  it("paginates through the limit and before query parameters", async () => {
    database.exec("BEGIN");
    for (let seq = 1; seq <= 5; seq += 1) {
      insertOutboxRow({ id: `event-${seq}`, seq });
    }
    database.exec("COMMIT");

    const page1 = await getProjectAuditEvents(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/audit-events?limit=2`),
      projectContext(PROJECT_ID),
    );
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.events.map((event: { outboxSeq: number }) => event.outboxSeq)).toEqual([5, 4]);
    expect(body1.nextBeforeSeq).toBe(4);

    const page2 = await getProjectAuditEvents(
      new Request(
        `http://localhost/api/projects/${PROJECT_ID}/audit-events?limit=2&before=${body1.nextBeforeSeq}`,
      ),
      projectContext(PROJECT_ID),
    );
    expect(page2.status).toBe(200);
    const body2 = await page2.json();
    expect(body2.events.map((event: { outboxSeq: number }) => event.outboxSeq)).toEqual([3, 2]);
    expect(body2.nextBeforeSeq).toBe(2);

    const page3 = await getProjectAuditEvents(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/audit-events?before=1`),
      projectContext(PROJECT_ID),
    );
    expect(page3.status).toBe(200);
    await expect(page3.json()).resolves.toMatchObject({
      events: [],
      nextBeforeSeq: null,
    });
  });

  it("serves an empty page for a project without events", async () => {
    const response = await getProjectAuditEvents(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/audit-events`),
      projectContext(PROJECT_ID),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [],
      freshness: { lag: 0, status: "caught_up" },
      nextBeforeSeq: null,
    });
  });

  it.each([
    ["limit=0", "limit", "invalid_range"],
    ["limit=101", "limit", "invalid_range"],
    ["limit=abc", "limit", "invalid_format"],
    ["limit=", "limit", "required"],
    ["limit=1&limit=2", "limit", "duplicate"],
    ["limit=99999999999999999999", "limit", "invalid_range"],
    ["before=0", "before", "invalid_range"],
    ["before=-1", "before", "invalid_format"],
    ["before=1.5", "before", "invalid_format"],
    ["before=", "before", "required"],
    ["before=1&before=2", "before", "duplicate"],
    ["bogus=1", "bogus", "unknown"],
  ])("rejects invalid query %s with a stable 400 envelope", async (query, field, code) => {
    const response = await getProjectAuditEvents(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/audit-events?${query}`),
      projectContext(PROJECT_ID),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toBe("Audit events query is invalid.");
    expect(body.error.fields).toContainEqual({ code, field });
  });

  it("returns 404 PROJECT_NOT_FOUND for a missing project", async () => {
    const response = await getProjectAuditEvents(
      new Request("http://localhost/api/projects/missing/audit-events"),
      projectContext("missing"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project was not found." },
    });
  });

  it("rejects a malformed projectId with 400 before touching storage", async () => {
    const response = await getProjectAuditEvents(
      new Request("http://localhost/api/projects/.. /audit-events"),
      projectContext(".."),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.fields).toContainEqual({
      code: "invalid_format",
      field: "projectId",
    });
  });
});
