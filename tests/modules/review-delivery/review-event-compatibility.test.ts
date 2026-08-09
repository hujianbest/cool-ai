import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import * as readService from "@/src/adapters/outbound/sqlite/review-delivery/review-read-service";
import { reviewEventDtoSchema } from "@/src/shared/review-contracts";

const NOW = "2026-08-01T09:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const roots: string[] = [];
const databases: DatabaseSync[] = [];

type StoredEvent = {
  actorId?: string | null;
  actorType?: "owner" | "agent" | "system";
  payload: Record<string, unknown>;
  type: string;
};
type EventPage = {
  items: Array<{
    actorId: string | null;
    actorType: "owner" | "agent" | "system";
    createdAt: string;
    id: string;
    payload: Record<string, unknown>;
    sequence: number;
    type: string;
  }>;
  nextCursor: string | null;
};
type DatabaseEventReader = (
  database: DatabaseSync,
  databasePath: string,
  missionId: string,
  query: { after?: string; limit?: string },
) => EventPage;

function readEvents(
  database: DatabaseSync,
  path: string,
  query: { after?: string; limit?: string } = { limit: "100" },
): EventPage {
  const reader = (readService as unknown as {
    listReviewEventsFromDatabase?: DatabaseEventReader;
  }).listReviewEventsFromDatabase;
  expect(reader, "T-25 must expose the single DB compatibility read path").toBeTypeOf("function");
  return reader!(database, path, "mission", query);
}

function databasePath(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `review-event-compat-${label}-`));
  roots.push(root);
  return join(root, "cockpit.sqlite");
}

function open(path: string): DatabaseSync {
  const database = openDatabase(path);
  databases.push(database);
  return database;
}

function close(database: DatabaseSync): void {
  database.close();
  databases.splice(databases.indexOf(database), 1);
}

function seed(database: DatabaseSync, events: StoredEvent[]): void {
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    INSERT INTO projects(id,name,created_at,version) VALUES ('project','Events','${NOW}',1);
    INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','project','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items(
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES ('work','mission','Work','','in_progress','executor',1,'${NOW}','${NOW}');
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,1,1,'${NOW}');
    INSERT INTO agents(
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,
      created_at,updated_at,review_capable
    ) VALUES ('reviewer','Reviewer','Review','Review','provider','model','R','slate',
      1,0,0,1000,2,1,'${NOW}','${NOW}',1);
    INSERT INTO review_attempts(
      id,project_id,mission_id,work_item_id,result_id,reviewer_agent_id,
      operation_id,status,lease_token,lease_expires_at,frozen_material_json,
      frozen_material_hash,prompt_hash,provider_id,provider_version,
      credential_generation,verified_at,model,parsed_output_json,
      parsed_output_hash,output_checkpointed_at,finalize_error_code,error_category,
      started_at,finished_at
    ) VALUES ('attempt','project','mission','work','result','reviewer','review-operation',
      'discarded','lease','2026-08-01T09:02:00.000Z','{"sourceRefs":[]}',
      '${HASH_A}','${HASH_B}','provider',1,1,'${NOW}','model',
      NULL,NULL,NULL,NULL,'stale','${NOW}','${NOW}');
    INSERT INTO review_decisions(
      id,attempt_id,result_id,reviewer_agent_id,choice,public_summary,
      findings_json,evidence_refs_json,limitations_json,created_at
    ) VALUES ('decision','attempt','result','reviewer','escalate','Summary','[]','[]','[]','${NOW}');
    INSERT INTO review_escalations(
      id,decision_id,work_item_id,result_id,question,options_json,evidence_refs_json,created_at
    ) VALUES ('escalation','decision','work','result','Question','["A","B"]','[]','${NOW}');
    INSERT INTO review_escalation_answers(
      id,escalation_id,operation_id,answer,action,created_at
    ) VALUES ('answer','escalation','answer-operation','Answer','terminate_mission','${NOW}');
    INSERT INTO review_operations(
      id,project_id,kind,parent_id,request_hash,status,http_status,response_json,created_at,updated_at
    ) VALUES
      ('delivery-operation','project','generate_delivery','mission','${HASH_A}',
       'completed',200,'{"ok":true}','${NOW}','${NOW}'),
      ('delivery-operation-2','project','generate_delivery','mission','${HASH_B}',
       'completed',409,'{"ok":false}','${NOW}','${NOW}');
    INSERT INTO mission_deliveries(
      id,project_id,mission_id,version,input_fingerprint,summary_json,
      evidence_manifest_json,supersedes_delivery_id,created_at
    ) VALUES ('delivery','project','mission',1,'${HASH_A}','{}','{}',NULL,'${NOW}');
  `);
  const insert = database.prepare(`
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES (?, 'project', 'mission', ?, ?, ?, ?, ?, ?)
  `);
  events.forEach((event, index) => insert.run(
    `event-${index + 1}`,
    index + 1,
    event.type,
    event.actorType ?? "system",
    event.actorId ?? null,
    JSON.stringify(event.payload),
    NOW,
  ));
  database.prepare(`
    UPDATE mission_delivery_heads SET next_event_sequence=? WHERE mission_id='mission'
  `).run(events.length + 1);
  database.exec("PRAGMA foreign_keys=ON");
}

const historicalEvents: StoredEvent[] = [
  {
    payload: { headVersion: 3, workItemId: "work" },
    type: "work_item_review_passed",
  },
  {
    actorId: "reviewer",
    actorType: "agent",
    payload: { decisionId: "decision", resultId: "result", workItemId: "work" },
    type: "work_item_passed",
  },
  {
    payload: { reason: "OWNER_REOPENED", workItemId: "work" },
    type: "work_item_completion_invalidated",
  },
  {
    actorId: "reviewer",
    actorType: "agent",
    payload: {
      decisionId: "decision",
      escalationId: "escalation",
      resultId: "result",
      workItemId: "work",
    },
    type: "review_escalated",
  },
  {
    actorType: "owner",
    payload: {
      action: "terminate_mission",
      answerId: "answer",
      escalationId: "escalation",
      resultId: "result",
      workItemId: "work",
    },
    type: "escalation_answered",
  },
  {
    actorType: "owner",
    payload: { escalationId: "escalation", missionId: "mission" },
    type: "mission_owner_terminated",
  },
  {
    actorId: "reviewer",
    actorType: "agent",
    payload: {
      attemptId: "attempt",
      reason: "MISSION_CONTEXT_CHANGED",
      workItemId: "work",
    },
    type: "review_attempt_discarded",
  },
  {
    payload: { inputFingerprint: HASH_A, operationId: "delivery-operation" },
    type: "delivery_generation_started",
  },
  {
    payload: { errorCode: "DELIVERY_GENERATION_FAILED", operationId: "delivery-operation" },
    type: "delivery_generation_failed",
  },
  {
    payload: { deliveryId: "delivery", inputFingerprint: HASH_A, reused: false, version: 1 },
    type: "delivery_generation_completed",
  },
  {
    payload: { inputFingerprint: HASH_B, operationId: "delivery-operation-2" },
    type: "delivery_generation_started",
  },
  {
    payload: {
      errorCode: "DELIVERY_GENERATION_INTERRUPTED",
      operationId: "delivery-operation-2",
    },
    type: "delivery_generation_interrupted",
  },
  {
    payload: { deliveryId: "delivery", reason: "OWNER_REOPENED", workItemId: "work" },
    type: "mission_delivery_invalidated",
  },
  {
    payload: {
      deliveryId: null,
      operationId: "delivery-operation-2",
      reason: "MISSION_CONTEXT_CHANGED",
    },
    type: "mission_delivery_invalidated",
  },
  {
    payload: {
      executionId: "execution-2",
      resultId: "result-2",
      resultVersion: 2,
      supersedesResultId: "result",
      workItemId: "work",
    },
    type: "result_version_created",
  },
  {
    payload: { inputFingerprint: HASH_B, operationId: "delivery-operation-3" },
    type: "delivery_generation_started",
  },
  {
    payload: { deliveryId: "delivery-2", deliveryVersion: 2, inputFingerprint: HASH_B },
    type: "delivery_completed",
  },
];

afterEach(() => {
  for (const database of [...databases]) close(database);
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("review event historical compatibility", () => {
  it("projects every designed legacy variant and survives restart as strict public DTOs", () => {
    const path = databasePath("round-trip");
    const database = open(path);
    seed(database, historicalEvents);
    close(database);

    const firstDatabase = new DatabaseSync(path);
    databases.push(firstDatabase);
    const first = readEvents(firstDatabase, path);
    close(firstDatabase);
    expect(first.items.map(({ type }) => type)).toEqual([
      "legacy_work_item_review_passed",
      "work_item_passed",
      "legacy_work_item_completion_invalidated",
      "escalation_opened",
      "escalation_answered",
      "mission_terminated",
      "review_attempt_discarded",
      "delivery_generation_started",
      "delivery_generation_failed",
      "delivery_completed",
      "delivery_generation_started",
      "delivery_generation_failed",
      "delivery_invalidated",
      "delivery_invalidated",
      "result_version_created",
      "delivery_generation_started",
      "delivery_completed",
    ]);
    expect(first.items.map(({ sequence }) => sequence)).toEqual(
      historicalEvents.map((_, index) => index + 1),
    );
    expect(first.items[1]).toMatchObject({
      actorId: "reviewer",
      actorType: "agent",
      payload: { reasonCode: "review_passed" },
    });
    expect(first.items[4]?.payload).toEqual({
      action: "terminate_mission",
      answerId: "answer",
      escalationId: "escalation",
    });
    expect(first.items[5]?.payload).toEqual({ reason: "owner_terminated" });
    expect(first.items[6]?.payload).toEqual({
      attemptId: "attempt",
      category: "context_changed",
    });
    expect(first.items[8]?.payload).toEqual({
      category: "generation_failed",
      inputFingerprint: HASH_A,
      operationId: "delivery-operation",
    });
    expect(first.items[11]?.payload).toEqual({
      category: "interrupted",
      inputFingerprint: HASH_B,
      operationId: "delivery-operation-2",
    });
    expect(first.items[12]?.payload).toEqual({
      deliveryId: "delivery",
      reasonCode: "OWNER_REOPENED",
      workItemIds: ["work"],
    });
    expect(first.items[13]?.payload).toEqual({
      deliveryId: null,
      reasonCode: "MISSION_CONTEXT_CHANGED",
      workItemIds: [],
    });
    expect(first.items.every((event) => reviewEventDtoSchema.safeParse(event).success)).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(
      /Bearer|Authorization|rawProviderBody|leaseToken|C:\\|\/workspace\//iu,
    );

    const secondDatabase = new DatabaseSync(path);
    databases.push(secondDatabase);
    const second = readEvents(secondDatabase, path);
    expect(second).toEqual(first);
  });

  it.each([
    ["unknown type", [{ payload: {}, type: "future_event" }]],
    ["unknown field", [{
      payload: { headVersion: 1, rawProviderBody: "secret", workItemId: "work" },
      type: "work_item_review_passed",
    }]],
    ["unknown reason", [{
      payload: { reason: "UNLISTED", workItemId: "work" },
      type: "work_item_completion_invalidated",
    }]],
    ["unknown error code", [
      {
        payload: { inputFingerprint: HASH_A, operationId: "delivery-operation" },
        type: "delivery_generation_started",
      },
      {
        payload: { errorCode: "UNLISTED", operationId: "delivery-operation" },
        type: "delivery_generation_failed",
      },
    ]],
    ["missing predecessor", [{
      payload: { errorCode: "DELIVERY_GENERATION_FAILED", operationId: "delivery-operation" },
      type: "delivery_generation_failed",
    }]],
    ["duplicate predecessor", [
      {
        payload: { inputFingerprint: HASH_A, operationId: "delivery-operation" },
        type: "delivery_generation_started",
      },
      {
        payload: { inputFingerprint: HASH_A, operationId: "delivery-operation" },
        type: "delivery_generation_started",
      },
      {
        payload: { errorCode: "DELIVERY_GENERATION_FAILED", operationId: "delivery-operation" },
        type: "delivery_generation_failed",
      },
    ]],
    ["association drift", [{
      payload: {
        action: "terminate_mission",
        answerId: "answer",
        escalationId: "escalation",
        resultId: "other-result",
        workItemId: "work",
      },
      type: "escalation_answered",
    }]],
  ])("fails closed on %s", (_label, events) => {
    const path = databasePath(String(_label));
    const database = open(path);
    seed(database, events as StoredEvent[]);
    expect(() => readEvents(database, path))
      .toThrowError(expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }));
  });
});
