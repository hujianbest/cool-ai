import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getProjectTimeline } from "@/app/api/projects/[projectId]/timeline/route";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-15T03:00:00.000Z";
const EARLIER = "2026-08-15T01:00:00.000Z";
const PROJECT_ID = "timeline-api-project";

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
  ).run(PROJECT_ID, "Timeline API", NOW);
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
  occurredAt?: string;
  payload?: Record<string, unknown>;
}): void {
  const occurredAt = input.occurredAt ?? NOW;
  const eventType = input.eventType ?? "execution_started";
  database.prepare(`
    INSERT INTO audit_event_outbox (
      id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
    ) VALUES (?,?,'safe_execution',?,?,?,?)
  `).run(
    input.id,
    PROJECT_ID,
    eventType,
    JSON.stringify(input.payload ?? {
      actorId: null,
      actorType: "agent",
      attemptNo: 1,
      executionId: "execution-1",
      occurredAt,
      type: eventType,
    }),
    occurredAt,
    input.seq,
  );
}

describe("GET /api/projects/:projectId/timeline", () => {
  it("serves the chronological first page with sourceMissing and no-store", async () => {
    insertOutboxRow({
      eventType: "project_created",
      id: "event-missing",
      occurredAt: EARLIER,
      payload: { actorType: "owner", projectName: "Timeline API", type: "project_created" },
      seq: 2,
    });
    insertOutboxRow({
      eventType: "execution_started",
      id: "event-located",
      payload: {
        actorType: "agent",
        executionId: "execution-9",
        occurredAt: NOW,
        type: "execution_started",
      },
      seq: 1,
    });

    const response = await getProjectTimeline(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/timeline`),
      projectContext(PROJECT_ID),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      freshness: { lag: 0, status: "caught_up" },
      items: [
        {
          actorType: "owner",
          eventType: "project_created",
          executionId: null,
          id: "event-missing",
          occurredAt: EARLIER,
          outboxSeq: 2,
          payload: {
            actorType: "owner",
            projectName: "Timeline API",
            type: "project_created",
          },
          sourceMissing: true,
        },
        {
          actorType: "agent",
          eventType: "execution_started",
          executionId: "execution-9",
          id: "event-located",
          occurredAt: NOW,
          outboxSeq: 1,
          payload: {
            actorType: "agent",
            executionId: "execution-9",
            occurredAt: NOW,
            type: "execution_started",
          },
          sourceMissing: false,
        },
      ],
    });
  });

  it("filters by missionId and honors limit", async () => {
    insertOutboxRow({
      eventType: "work_item_created",
      id: "keep",
      occurredAt: EARLIER,
      payload: {
        actorType: "owner",
        missionId: "mission-1",
        type: "work_item_created",
        workItemId: "work-1",
      },
      seq: 1,
    });
    insertOutboxRow({
      eventType: "work_item_created",
      id: "other-mission",
      payload: {
        actorType: "owner",
        missionId: "mission-2",
        type: "work_item_created",
        workItemId: "work-2",
      },
      seq: 2,
    });
    insertOutboxRow({
      eventType: "execution_started",
      id: "no-mission",
      seq: 3,
    });

    const filtered = await getProjectTimeline(
      new Request(
        `http://localhost/api/projects/${PROJECT_ID}/timeline?missionId=mission-1`,
      ),
      projectContext(PROJECT_ID),
    );
    expect(filtered.status).toBe(200);
    const filteredBody = await filtered.json();
    expect(filteredBody.items.map((item: { id: string }) => item.id)).toEqual(["keep"]);

    const limited = await getProjectTimeline(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/timeline?limit=1`),
      projectContext(PROJECT_ID),
    );
    expect(limited.status).toBe(200);
    const limitedBody = await limited.json();
    expect(limitedBody.items.map((item: { id: string }) => item.id)).toEqual(["keep"]);
  });

  it.each([
    ["limit=0", "limit", "invalid_range"],
    ["limit=101", "limit", "invalid_range"],
    ["limit=abc", "limit", "invalid_format"],
    ["limit=", "limit", "required"],
    ["limit=1&limit=2", "limit", "duplicate"],
    ["missionId=", "missionId", "required"],
    ["missionId=..", "missionId", "invalid_format"],
    ["missionId=mission/1", "missionId", "invalid_format"],
    ["bogus=1", "bogus", "unknown"],
    ["before=1", "before", "unknown"],
  ])("rejects invalid query %s with a stable 400 envelope", async (query, field, code) => {
    const response = await getProjectTimeline(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/timeline?${query}`),
      projectContext(PROJECT_ID),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toBe("Timeline query is invalid.");
    expect(body.error.fields).toContainEqual({ code, field });
    expect(JSON.stringify(body)).not.toContain("COCKPIT");
    expect(JSON.stringify(body)).not.toContain("api");
  });

  it("returns 404 PROJECT_NOT_FOUND for a missing project", async () => {
    const response = await getProjectTimeline(
      new Request("http://localhost/api/projects/missing/timeline"),
      projectContext("missing"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project was not found." },
    });
  });

  it("rejects a malformed projectId with 400 before touching storage", async () => {
    const response = await getProjectTimeline(
      new Request("http://localhost/api/projects/../timeline"),
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
