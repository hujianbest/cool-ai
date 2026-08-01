import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

type FinalizerModule = typeof import("../src/server/review/review-finalizer");

const modules = import.meta.glob<FinalizerModule>(
  "../src/server/review/review-finalizer.ts",
);
const databases: DatabaseSync[] = [];

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE review_attempts(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,mission_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,result_id TEXT NOT NULL,reviewer_agent_id TEXT NOT NULL,
      status TEXT NOT NULL,parsed_output_hash TEXT
    );
    CREATE TABLE review_decisions(
      id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,result_id TEXT NOT NULL,
      reviewer_agent_id TEXT NOT NULL
    );
    CREATE TABLE review_events(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,mission_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,type TEXT NOT NULL,actor_type TEXT NOT NULL,
      actor_id TEXT,payload_json TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE memory_entries(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,proposer_actor_type TEXT NOT NULL,
      proposer_actor_id TEXT,confirming_review_attempt_id TEXT
    );
  `);
  db.prepare(`
    INSERT INTO review_attempts(
      id,project_id,mission_id,work_item_id,result_id,reviewer_agent_id,status,
      parsed_output_hash
    ) VALUES ('attempt-1','project-1','mission-1','work-1','result-1',
      'reviewer-1','finalizing',?)
  `).run("a".repeat(64));
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("durable review actor anti-forgery", () => {
  it.each(["owner", "platform", "client", "other-agent"])(
    "rejects %s from creating an Agent decision",
    async (claimedActor) => {
      const db = database();
      const load = modules["../src/server/review/review-finalizer.ts"];
      expect(load).toBeTypeOf("function");
      const module = await load();
      const authorize = (module as unknown as Record<string, unknown>)
        .assertDurableReviewAgentAuthority;

      expect(authorize, "T-17 durable authority guard must exist").toBeTypeOf("function");
      expect(() => (authorize as (database: DatabaseSync, input: unknown) => unknown)(db, {
        attemptId: "attempt-1",
        checkpointHash: "a".repeat(64),
        claimedActorId: claimedActor,
        claimedActorType: claimedActor === "other-agent" ? "agent" : claimedActor,
      })).toThrow();
      expect(db.prepare("SELECT COUNT(*) AS count FROM review_decisions").get())
        .toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_entries").get())
        .toEqual({ count: 0 });
    },
  );

  it("derives decision, memory proposer, and public event actors from durable review facts", async () => {
    const db = database();
    db.prepare(`
      INSERT INTO review_decisions(id,attempt_id,result_id,reviewer_agent_id)
      VALUES ('decision-1','attempt-1','result-1','reviewer-1')
    `).run();
    db.prepare(`
      INSERT INTO memory_entries(
        id,project_id,proposer_actor_type,proposer_actor_id,confirming_review_attempt_id
      ) VALUES ('memory-1','project-1','agent','reviewer-1','attempt-1')
    `).run();
    db.prepare(`
      INSERT INTO review_events(
        id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
      ) VALUES ('event-1','project-1','mission-1',1,'review_decided','agent',
        'reviewer-1','{"attemptId":"attempt-1","decisionId":"decision-1"}',
        '2026-08-01T06:00:00.000Z')
    `).run();
    const load = modules["../src/server/review/review-finalizer.ts"];
    expect(load).toBeTypeOf("function");
    const module = await load();
    const derive = (module as unknown as Record<string, unknown>)
      .deriveDurableReviewPublicActors;

    expect(derive, "T-17 durable actor projection must exist").toBeTypeOf("function");
    expect((derive as (database: DatabaseSync, attemptId: string) => unknown)(
      db,
      "attempt-1",
    )).toEqual({
      decision: { actorId: "reviewer-1", actorType: "agent" },
      events: [{ actorId: "reviewer-1", actorType: "agent", id: "event-1" }],
      memories: [{ actorId: "reviewer-1", actorType: "agent", id: "memory-1" }],
    });
  });

  it("exposes no public route that accepts a decision or Agent memory proposer payload", async () => {
    const reviewRoute = await import(
      "../app/api/work-items/[workItemId]/reviews/route"
    );
    const attemptRoute = await import("../app/api/reviews/[attemptId]/route");
    const memoryRoute = await import("../app/api/projects/[projectId]/memories/route");

    expect(Object.keys(reviewRoute).sort()).toEqual(["GET", "POST"]);
    expect(Object.keys(attemptRoute).sort()).toEqual(["GET"]);
    expect(Object.keys(memoryRoute).sort()).toEqual(["GET", "POST"]);
    expect(String(reviewRoute.POST)).not.toMatch(/decision|memoryCandidates|proposerActor/iu);
    expect(String(memoryRoute.POST)).not.toMatch(/proposerActorType|proposerAgentId/iu);
  });
});
