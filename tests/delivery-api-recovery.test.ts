import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/adapters/outbound/sqlite/connection", () => ({
  openDatabase(path: string) {
    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=ON");
    return database;
  },
}));

type ReadModule = typeof import("../src/server/review/delivery-read-service");
const readModules = import.meta.glob<ReadModule>(
  "../src/server/review/delivery-read-service.ts",
);
const roots: string[] = [];
const NOW = "2026-08-01T10:00:00.000Z";
const HASH = "a".repeat(64);

async function reads(): Promise<ReadModule> {
  const load = readModules["../src/server/review/delivery-read-service.ts"];
  expect(load, "delivery read service must exist").toBeTypeOf("function");
  return load!();
}

function database(): { database: DatabaseSync; path: string } {
  const root = mkdtempSync(join(tmpdir(), "delivery-api-recovery-"));
  roots.push(root);
  const path = join(root, "delivery.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE missions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL);
    CREATE TABLE work_items(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE work_item_review_heads(
      work_item_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,current_result_id TEXT,
      state TEXT NOT NULL,version INTEGER NOT NULL
    );
    CREATE TABLE mission_delivery_heads(
      mission_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,context_version INTEGER NOT NULL,
      state TEXT NOT NULL,current_delivery_id TEXT,current_operation_id TEXT,
      generation_lease_token TEXT,generation_lease_expires_at TEXT,last_error_code TEXT,
      next_event_sequence INTEGER NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE mission_deliveries(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,mission_id TEXT NOT NULL,version INTEGER NOT NULL,
      input_fingerprint TEXT NOT NULL,summary_json TEXT NOT NULL,evidence_manifest_json TEXT NOT NULL,
      supersedes_delivery_id TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE review_events(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,mission_id TEXT NOT NULL,sequence INTEGER NOT NULL,
      type TEXT NOT NULL,actor_type TEXT NOT NULL,actor_id TEXT,payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO missions VALUES('mission','project');
    INSERT INTO mission_delivery_heads VALUES(
      'mission','project',2,'ongoing',NULL,NULL,NULL,NULL,'DELIVERY_GENERATION_INTERRUPTED',
      4,7,'${NOW}'
    );
    INSERT INTO mission_deliveries VALUES(
      'delivery-1','project','mission',1,'${HASH}',
      '{"mission":{"completedAt":"${NOW}","conclusion":"completed","goal":"Goal","id":"mission","title":"Mission"},"tasks":[]}',
      '{"entries":[],"inputFingerprint":"${HASH}","schemaVersion":1}',NULL,'${NOW}'
    );
    INSERT INTO review_events VALUES(
      'event-1','project','mission',1,'delivery_completed','system',NULL,
      '{"deliveryId":"delivery-1","deliveryVersion":1,"inputFingerprint":"${HASH}"}','${NOW}'
    );
    INSERT INTO review_events VALUES(
      'event-2','project','mission',2,'delivery_invalidated','system',NULL,
      '{"deliveryId":"delivery-1","reasonCode":"OWNER_REOPENED","workItemIds":["work"]}','${NOW}'
    );
    INSERT INTO review_events VALUES(
      'event-3','project','mission',3,'delivery_generation_failed','system',NULL,
      '{"category":"interrupted","inputFingerprint":"${HASH}","operationId":"operation"}','${NOW}'
    );
  `);
  return { database, path };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("delivery API recovery reads", () => {
  it("restores explicit retry progress and immutable invalidated history after restart", async () => {
    const fixture = database();
    fixture.database.close();
    const service = await reads();

    expect(service.readMissionDelivery(fixture.path, "mission")).toEqual(
      expect.objectContaining({
        blockers: [],
        currentDelivery: null,
        currentDeliveryId: null,
        lastErrorCode: "DELIVERY_GENERATION_INTERRUPTED",
        missionId: "mission",
        retry: { kind: "explicit-owner-retry" },
        state: "ongoing",
        version: 7,
      }),
    );
    const history = service.listMissionDeliveries(fixture.path, "mission", { limit: "1" });
    expect(history.items).toEqual([
      expect.objectContaining({
        id: "delivery-1",
        invalidatedReason: "OWNER_REOPENED",
        invalidatedWorkItemIds: ["work"],
        state: "invalidated",
        version: 1,
      }),
    ]);
  });

  it("uses a scoped cursor that survives reopening and rejects cross-mission reuse", async () => {
    const fixture = database();
    fixture.database.exec(`
      INSERT INTO missions VALUES('other','project');
      INSERT INTO mission_delivery_heads VALUES(
        'other','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,1,1,'${NOW}'
      );
      INSERT INTO mission_deliveries VALUES(
        'delivery-2','project','mission',2,'${"b".repeat(64)}',
        '{"mission":{"completedAt":"${NOW}","conclusion":"completed","goal":"Goal","id":"mission","title":"Mission"},"tasks":[]}',
        '{"entries":[],"inputFingerprint":"${"b".repeat(64)}","schemaVersion":1}',
        'delivery-1','${NOW}'
      );
    `);
    fixture.database.close();
    const service = await reads();
    const first = service.listMissionDeliveries(fixture.path, "mission", { limit: "1" });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(service.listMissionDeliveries(fixture.path, "mission", {
      after: first.nextCursor!,
      limit: "1",
    }).items[0]).toMatchObject({ id: "delivery-1", version: 1 });
    expect(() => service.listMissionDeliveries(fixture.path, "other", {
      after: first.nextCursor!,
      limit: "1",
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});
