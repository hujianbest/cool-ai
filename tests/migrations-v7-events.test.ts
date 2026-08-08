import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { migrateDatabase } from "@/src/server/migrations";
import {
  timelinePayloadSchemas,
  type TimelineEventType,
} from "@/src/shared/collaboration-contracts";

const PROJECT = "project-events";
const RUN = "run-events";
const OTHER_RUN = "run-events-other";
const OWNER_MESSAGE = "message-owner";
const AGENT_MESSAGE = "message-agent";
const ANSWER_MESSAGE = "message-answer";
const PROJECT_OWNER_MESSAGE = "message-project-owner";
const PROJECT_AGENT_MESSAGE = "message-project-agent";
const ATTEMPT = "attempt-events";
const OTHER_ATTEMPT = "attempt-events-other";
const TURN = "turn-events";
const DECISION = "decision-events";
const NOW = "2026-08-08T10:00:00.000Z";
const directories: string[] = [];

const EVENT_TYPES = [
  "run_started",
  "owner_message",
  "agent_message",
  "model_call_started",
  "model_call_succeeded",
  "model_call_failed",
  "usage_recorded",
  "tasks_created",
  "task_claimed",
  "handoff",
  "decision_requested",
  "decision_answered",
  "boundary_paused",
  "run_paused",
  "run_resumed",
  "run_retried",
  "run_planned",
  "run_stopped",
  "attempt_interrupted",
  "action_rejected",
  "context_changed",
] as const satisfies readonly TimelineEventType[];

type EventSeed = {
  actorId: string | null;
  actorType: "owner" | "agent" | "system";
  createdAt: string;
  id: string;
  payload: Record<string, unknown>;
  sequence: number;
  type: TimelineEventType;
};

function timestamp(minute: number): string {
  return `2026-08-08T10:${minute.toString().padStart(2, "0")}:00.000Z`;
}

function legalEvents(): EventSeed[] {
  const entries: Array<Omit<EventSeed, "createdAt" | "id" | "sequence">> = [
    {
      actorId: null,
      actorType: "owner",
      payload: {
        currentAgentId: "agent-a",
        messageId: OWNER_MESSAGE,
        messageSequence: 1,
      },
      type: "run_started",
    },
    {
      actorId: null,
      actorType: "owner",
      payload: {
        mentionAgentId: "agent-b",
        mentionDisplayName: "Beta",
        messageId: OWNER_MESSAGE,
        messageSequence: 1,
      },
      type: "owner_message",
    },
    {
      actorId: "agent-a",
      actorType: "agent",
      payload: {
        agentDisplayName: "Alpha",
        agentId: "agent-a",
        messageId: AGENT_MESSAGE,
        messageSequence: 2,
        turnId: TURN,
      },
      type: "agent_message",
    },
    {
      actorId: "agent-a",
      actorType: "agent",
      payload: { agentId: "agent-a", attemptId: ATTEMPT, kind: "primary" },
      type: "model_call_started",
    },
    {
      actorId: "agent-a",
      actorType: "agent",
      payload: { attemptId: ATTEMPT, kind: "primary" },
      type: "model_call_succeeded",
    },
    {
      actorId: "agent-a",
      actorType: "agent",
      payload: {
        attemptId: ATTEMPT,
        category: "provider_timeout",
        kind: "repair",
      },
      type: "model_call_failed",
    },
    {
      actorId: "agent-a",
      actorType: "agent",
      payload: {
        attemptId: ATTEMPT,
        completionTokens: 5,
        kind: "primary",
        promptTokens: 8,
        reported: true,
        totalTokens: 13,
      },
      type: "usage_recorded",
    },
    {
      actorId: "agent-a",
      actorType: "agent",
      payload: {
        items: [{ dependsOnIds: [], id: "task-1", title: "Build it" }],
        turnId: TURN,
      },
      type: "tasks_created",
    },
    {
      actorId: "agent-a",
      actorType: "agent",
      payload: { agentId: "agent-a", turnId: TURN, workItemId: "task-1" },
      type: "task_claimed",
    },
    {
      actorId: "agent-a",
      actorType: "agent",
      payload: {
        fromAgentId: "agent-a",
        overriddenByMention: false,
        reason: "Implementation",
        summary: "Plan complete",
        toAgentId: "agent-b",
        turnId: TURN,
      },
      type: "handoff",
    },
    {
      actorId: "agent-a",
      actorType: "agent",
      payload: {
        agentId: "agent-a",
        decisionId: DECISION,
        options: ["Yes", "No"],
        question: "Proceed?",
        turnId: TURN,
      },
      type: "decision_requested",
    },
    {
      actorId: null,
      actorType: "owner",
      payload: {
        answer: "Yes",
        decisionId: DECISION,
        messageId: ANSWER_MESSAGE,
        messageSequence: 3,
        nextAgentId: "agent-b",
      },
      type: "decision_answered",
    },
    {
      actorId: null,
      actorType: "system",
      payload: { agentId: "agent-a", boundary: "tokens", limit: 100, value: 100 },
      type: "boundary_paused",
    },
    {
      actorId: null,
      actorType: "owner",
      payload: { category: "manual" },
      type: "run_paused",
    },
    {
      actorId: null,
      actorType: "owner",
      payload: { currentAgentId: "agent-a" },
      type: "run_resumed",
    },
    {
      actorId: null,
      actorType: "owner",
      payload: { currentAgentId: "agent-a" },
      type: "run_retried",
    },
    {
      actorId: "agent-a",
      actorType: "agent",
      payload: { turnId: TURN },
      type: "run_planned",
    },
    {
      actorId: null,
      actorType: "owner",
      payload: {},
      type: "run_stopped",
    },
    {
      actorId: null,
      actorType: "system",
      payload: { attemptId: ATTEMPT },
      type: "attempt_interrupted",
    },
    {
      actorId: null,
      actorType: "system",
      payload: {
        attemptId: ATTEMPT,
        category: "action_invalid",
        missing: ["tasks"],
      },
      type: "action_rejected",
    },
    {
      actorId: null,
      actorType: "system",
      payload: { attemptId: ATTEMPT },
      type: "context_changed",
    },
  ];
  const events = entries.map((entry, index) => ({
    ...entry,
    createdAt: timestamp(index + 1),
    id: `event-${entry.type}`,
    sequence: index + 1,
  }));
  events.splice(2, 0, {
    actorId: null,
    actorType: "owner",
    createdAt: timestamp(2),
    id: "event-owner-answer",
    payload: {
      mentionAgentId: null,
      mentionDisplayName: null,
      messageId: ANSWER_MESSAGE,
      messageSequence: 3,
    },
    sequence: 3,
    type: "owner_message",
  });
  return events.map((event, index) => ({
    ...event,
    createdAt: timestamp(index + 1),
    sequence: index + 1,
  }));
}

function bootstrapV6(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  expect(() => migrateDatabase(database, (step) => {
    if (step === "precheck") throw new Error("stop-at-v6");
  })).toThrow(expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }));
  expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  return database;
}

function seedFixture(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
      VALUES ('${PROJECT}','Event fixture','${NOW}',NULL,NULL,1);
    INSERT INTO providers(
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'provider-events','Fixture','http://localhost/v1','fixture-model',
      'cipher','iv','tag',1,1,'key','***','${NOW}',1,'${NOW}','${NOW}'
    );
    INSERT INTO agents(
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
      updated_at,review_capable
    ) VALUES
      ('agent-a','Alpha','Role','Prompt','provider-events','fixture-model','A','sage',1,1,0,1000,3,1,'${NOW}','${NOW}',0),
      ('agent-b','Beta','Role','Prompt','provider-events','fixture-model','B','gold',1,1,0,1000,3,1,'${NOW}','${NOW}',0);
    INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES
      ('${PROJECT}','agent-a','${NOW}'),('${PROJECT}','agent-b','${NOW}');
    INSERT INTO collaboration_runs(
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES
      ('${RUN}','${PROJECT}','stopped','agent-a',1,${legalEvents().length + 1},2,1,NULL,NULL,'${NOW}','${timestamp(23)}'),
      ('${OTHER_RUN}','${PROJECT}','planned','agent-b',0,1,1,1,NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO collaboration_project_sequences(project_id,next_message_sequence)
      VALUES ('${PROJECT}',6);
    INSERT INTO collaboration_messages(
      id,project_id,run_id,author_type,author_agent_id,author_display_name,
      content,mention_agent_id,mention_display_name,sequence,consumed_at,created_at
    ) VALUES
      ('${OWNER_MESSAGE}','${PROJECT}','${RUN}','owner',NULL,'Owner','Start', 'agent-b','Beta',1,'${NOW}','${timestamp(1)}'),
      ('${AGENT_MESSAGE}','${PROJECT}','${RUN}','agent','agent-a','Alpha','Agent reply',NULL,NULL,2,NULL,'${timestamp(4)}'),
      ('${ANSWER_MESSAGE}','${PROJECT}','${RUN}','owner',NULL,'Owner','Yes',NULL,NULL,3,NULL,'${timestamp(3)}'),
      ('${PROJECT_OWNER_MESSAGE}','${PROJECT}',NULL,'owner',NULL,'Owner','Project owner',NULL,NULL,4,NULL,'${timestamp(24)}'),
      ('${PROJECT_AGENT_MESSAGE}','${PROJECT}',NULL,'agent','agent-b','Beta','Project agent',NULL,NULL,5,NULL,'${timestamp(25)}');
    INSERT INTO collaboration_operations(
      id,project_id,run_id,kind,request_hash,status,http_status,response_json,
      created_at,updated_at
    ) VALUES
      ('00000000-0000-4000-8000-000000000706','${PROJECT}','${RUN}','advance',
       'hash-main','completed',500,
       json_object('error',json_object('code','INTERNAL_ERROR','message','failed')),
       '${NOW}','${timestamp(23)}'),
      ('00000000-0000-4000-8000-000000000707','${PROJECT}','${OTHER_RUN}','advance',
       'hash-other','completed',500,
       json_object('error',json_object('code','INTERNAL_ERROR','message','failed')),
       '${NOW}','${NOW}');
    INSERT INTO collaboration_attempts(
      id,project_id,run_id,agent_id,operation_id,status,lease_token,lease_expires_at,
      prompt_hash,acquire_execution_epoch,acquire_context_hash,included_message_sequence,
      error_category,failure_provider_id,failure_provider_version,
      failure_credential_version,failure_credential_generation,failure_verified_at,
      started_at,finished_at
    ) VALUES
      ('${ATTEMPT}','${PROJECT}','${RUN}','agent-a','00000000-0000-4000-8000-000000000706',
       'committed','lease-main','${timestamp(30)}','prompt',1,'context',1,NULL,NULL,NULL,NULL,NULL,NULL,'${timestamp(4)}','${timestamp(22)}'),
      ('${OTHER_ATTEMPT}','${PROJECT}','${OTHER_RUN}','agent-b','00000000-0000-4000-8000-000000000707',
       'committed','lease-other','${timestamp(30)}','prompt-other',1,'context-other',0,NULL,NULL,NULL,NULL,NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO collaboration_model_calls(
      id,attempt_id,kind,call_index,status,prompt_tokens,completion_tokens,total_tokens,
      error_category,created_at
    ) VALUES
      ('call-primary','${ATTEMPT}','primary',1,'succeeded',8,5,13,NULL,'${timestamp(5)}'),
      ('call-repair','${ATTEMPT}','repair',2,'provider_failed',NULL,NULL,NULL,'provider_timeout','${timestamp(6)}');
    INSERT INTO collaboration_turns(
      id,attempt_id,run_id,agent_id,round_number,message_id,disposition,created_at
    ) VALUES ('${TURN}','${ATTEMPT}','${RUN}','agent-a',1,'${AGENT_MESSAGE}','decision_request','${timestamp(4)}');
    INSERT INTO decision_requests(
      id,run_id,turn_id,requesting_agent_id,question,options_json,status,answer,
      answer_message_id,version,created_at,answered_at
    ) VALUES (
      '${DECISION}','${RUN}','${TURN}','agent-a','Proceed?',json_array('Yes','No'),
      'answered','Yes','${ANSWER_MESSAGE}',2,'${timestamp(11)}','${timestamp(13)}'
    );
  `);
  const insertEvent = database.prepare(`
    INSERT INTO collaboration_events(
      id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?)
  `);
  for (const event of legalEvents()) {
    insertEvent.run(
      event.id,
      RUN,
      event.sequence,
      event.type,
      event.actorType,
      event.actorId,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }
}

function createFixture(
  path: string,
  mutate: (database: DatabaseSync) => void = () => undefined,
): void {
  const database = bootstrapV6(path);
  try {
    seedFixture(database);
    mutate(database);
  } finally {
    database.close();
  }
}

function v6Snapshot(database: DatabaseSync): unknown {
  const tables = [
    "collaboration_runs",
    "collaboration_operations",
    "collaboration_project_sequences",
    "collaboration_messages",
    "collaboration_attempts",
    "collaboration_model_calls",
    "collaboration_turns",
    "decision_requests",
    "collaboration_events",
  ];
  return {
    schema: database.prepare(`
      SELECT type,name,sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND (
        name LIKE 'collaboration_%' OR name='decision_requests'
      ) ORDER BY type,name
    `).all(),
    tables: tables.map((table) => ({
      rows: database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
      table,
    })),
    version: database.prepare("PRAGMA user_version").get(),
  };
}

function expectMigrationRollback(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  const before = v6Snapshot(database);
  expect(() => migrateDatabase(database)).toThrow(
    expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }),
  );
  expect(v6Snapshot(database)).toEqual(before);
  expect(database.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'v7_%'",
  ).all()).toEqual([]);
  database.close();
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("v6 event to v7 thread fact migration", () => {
  it("maps every legacy TimelineEventType and every message exactly once", () => {
    expect(new Set(EVENT_TYPES)).toEqual(new Set(Object.keys(timelinePayloadSchemas)));
    const directory = mkdtempSync(join(tmpdir(), "cockpit-v7-events-"));
    directories.push(directory);
    const path = join(directory, "cockpit.sqlite");
    createFixture(path);

    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=ON");
    try {
      migrateDatabase(database);

      const thread = database.prepare(
      "SELECT id FROM collaboration_threads WHERE project_id=?",
      ).get(PROJECT) as { id: string };
      const migratedEvents = database.prepare(`
      SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
             sequence,type,actor_type AS actorType,actor_id AS actorId,
             payload_json AS payloadJson,created_at AS createdAt
      FROM collaboration_events WHERE run_id=? ORDER BY sequence
      `).all(RUN);
      expect(migratedEvents).toEqual(legalEvents().map((event) => ({
      actorId: event.actorId,
      actorType: event.actorType,
      createdAt: event.createdAt,
      id: event.id,
      payloadJson: JSON.stringify(event.payload),
      projectId: PROJECT,
      runId: RUN,
      sequence: event.sequence,
      threadId: thread.id,
      type: event.type,
      })));

      const messageFacts = database.prepare(`
      SELECT type,actor_type AS actorType,actor_id AS actorId,run_id AS runId,
             message_id AS messageId,run_event_id AS runEventId,payload_json AS payloadJson,
             created_at AS createdAt
      FROM collaboration_thread_facts
      WHERE type IN ('owner_message','agent_message')
      ORDER BY message_id
      `).all();
      expect(messageFacts).toEqual([
      {
        actorId: "agent-a", actorType: "agent", createdAt: timestamp(4),
        messageId: AGENT_MESSAGE, payloadJson: JSON.stringify({ messageId: AGENT_MESSAGE }),
        runEventId: null, runId: RUN, type: "agent_message",
      },
      {
        actorId: null, actorType: "owner", createdAt: timestamp(3),
        messageId: ANSWER_MESSAGE, payloadJson: JSON.stringify({ messageId: ANSWER_MESSAGE }),
        runEventId: null, runId: RUN, type: "owner_message",
      },
      {
        actorId: null, actorType: "owner", createdAt: timestamp(2),
        messageId: OWNER_MESSAGE, payloadJson: JSON.stringify({ messageId: OWNER_MESSAGE }),
        runEventId: null, runId: RUN, type: "owner_message",
      },
      {
        actorId: "agent-b", actorType: "agent", createdAt: timestamp(25),
        messageId: PROJECT_AGENT_MESSAGE, payloadJson: JSON.stringify({ messageId: PROJECT_AGENT_MESSAGE }),
        runEventId: null, runId: null, type: "agent_message",
      },
      {
        actorId: null, actorType: "owner", createdAt: timestamp(24),
        messageId: PROJECT_OWNER_MESSAGE, payloadJson: JSON.stringify({ messageId: PROJECT_OWNER_MESSAGE }),
        runEventId: null, runId: null, type: "owner_message",
      },
      ]);

      const runEventFacts = database.prepare(`
      SELECT fact.run_id AS runId,fact.run_event_id AS eventId,fact.message_id AS messageId,
             fact.actor_type AS actorType,fact.actor_id AS actorId,
             fact.payload_json AS payloadJson,fact.created_at AS createdAt
      FROM collaboration_thread_facts fact
      WHERE fact.type='run_event' ORDER BY fact.run_event_id
      `).all();
      const nonMessageEvents = legalEvents().filter(
      ({ type }) => type !== "owner_message" && type !== "agent_message",
      );
      expect(runEventFacts).toEqual(nonMessageEvents
      .map((event) => ({
        actorId: event.actorId,
        actorType: event.actorType,
        createdAt: event.createdAt,
        eventId: event.id,
        messageId: null,
        payloadJson: JSON.stringify({ eventType: event.type }),
        runId: RUN,
      }))
        .sort((left, right) => left.eventId.localeCompare(right.eventId)));

      const factOrder = database.prepare(`
      SELECT id,sequence,activity_sequence AS activitySequence,type,run_id AS runId,
             message_id AS messageId,run_event_id AS eventId,created_at AS createdAt
      FROM collaboration_thread_facts WHERE project_id=? ORDER BY sequence
      `).all(PROJECT) as Array<{
      activitySequence: number;
      createdAt: string;
      eventId: string | null;
      id: string;
      messageId: string | null;
      runId: string | null;
      sequence: number;
      type: string;
      }>;
      expect(factOrder.map(({ sequence }) => sequence)).toEqual(
        factOrder.map((_, index) => index + 1),
      );
      expect(factOrder.map(({ activitySequence }) => activitySequence)).toEqual(
        factOrder.map((_, index) => index + 1),
      );
      expect(factOrder.filter(({ type }) => type === "thread_created")).toHaveLength(1);
      expect(factOrder.filter(({ type }) => type === "policy_changed")).toHaveLength(1);
      expect(factOrder.filter(({ type }) => type === "run_linked")).toHaveLength(2);
      const eventSequences = new Map(legalEvents().map(({ id, sequence }) => [id, sequence]));
      const messageSequences = new Map([
        [OWNER_MESSAGE, 1],
        [AGENT_MESSAGE, 2],
        [ANSWER_MESSAGE, 3],
        [PROJECT_OWNER_MESSAGE, 4],
        [PROJECT_AGENT_MESSAGE, 5],
      ]);
      const rank = new Map([
        ["thread_created", 0],
        ["policy_changed", 1],
        ["run_linked", 2],
        ["owner_message", 3],
        ["agent_message", 3],
        ["run_event", 4],
      ]);
      const expectedOrder = [...factOrder].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || rank.get(left.type)! - rank.get(right.type)!
        || (left.messageId
          ? messageSequences.get(left.messageId)!
          : left.eventId
            ? eventSequences.get(left.eventId)!
            : 0)
          - (right.messageId
            ? messageSequences.get(right.messageId)!
            : right.eventId
              ? eventSequences.get(right.eventId)!
              : 0)
        || Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8"))
      );
      expect(factOrder.map(({ id }) => id)).toEqual(expectedOrder.map(({ id }) => id));
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("leaves v6 unchanged when its unique sequence constraint rejects a duplicate", () => {
    const directory = mkdtempSync(join(tmpdir(), "cockpit-v7-events-duplicate-sequence-"));
    directories.push(directory);
    const path = join(directory, "cockpit.sqlite");
    createFixture(path);
    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=ON");
    try {
      const before = v6Snapshot(database);
      expect(() => database.prepare(`
        INSERT INTO collaboration_events(
          id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
        ) VALUES ('event-duplicate-sequence',?,1,'run_stopped','owner',NULL,'{}',?)
      `).run(RUN, timestamp(29))).toThrow();
      expect(v6Snapshot(database)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it.each([
    ["unknown type", (database: DatabaseSync) => {
      database.prepare(
        "UPDATE collaboration_events SET type='mystery' WHERE id='event-run_started'",
      ).run();
    }],
    ["malformed payload", (database: DatabaseSync) => {
      database.prepare(
        "UPDATE collaboration_events SET payload_json='{}' WHERE id='event-run_started'",
      ).run();
    }],
    ["extra payload key", (database: DatabaseSync) => {
      database.prepare(`
        UPDATE collaboration_events
        SET payload_json=json_set(payload_json,'$.extra',1)
        WHERE id='event-run_started'
      `).run();
    }],
    ["wrong actor", (database: DatabaseSync) => {
      database.prepare(`
        UPDATE collaboration_events SET actor_type='system'
        WHERE id='event-owner_message'
      `).run();
    }],
    ["wrong message sequence reference", (database: DatabaseSync) => {
      database.prepare(`
        UPDATE collaboration_events
        SET payload_json=json_set(payload_json,'$.messageSequence',99)
        WHERE id='event-owner_message'
      `).run();
    }],
    ["duplicate message event", (database: DatabaseSync) => {
      const next = legalEvents().length + 1;
      database.prepare(`
        INSERT INTO collaboration_events(
          id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
        ) SELECT 'event-owner-duplicate',run_id,?,'owner_message',actor_type,actor_id,
                 payload_json,?
          FROM collaboration_events WHERE id='event-owner_message'
      `).run(next, timestamp(29));
      database.prepare(
        "UPDATE collaboration_runs SET next_event_sequence=? WHERE id=?",
      ).run(next + 1, RUN);
    }],
    ["missing event for run-linked message", (database: DatabaseSync) => {
      database.prepare(
        "DELETE FROM collaboration_events WHERE id='event-owner-answer'",
      ).run();
      database.prepare(`
        UPDATE collaboration_events SET sequence=sequence-1
        WHERE run_id=? AND sequence>3
      `).run(RUN);
      database.prepare(
        "UPDATE collaboration_runs SET next_event_sequence=next_event_sequence-1 WHERE id=?",
      ).run(RUN);
    }],
    ["sequence gap", (database: DatabaseSync) => {
      database.prepare(`
        UPDATE collaboration_events SET sequence=sequence+1
        WHERE id='event-context_changed'
      `).run();
      database.prepare(
        "UPDATE collaboration_runs SET next_event_sequence=next_event_sequence+1 WHERE id=?",
      ).run(RUN);
    }],
    ["attempt from another run", (database: DatabaseSync) => {
      database.prepare(`
        UPDATE collaboration_events
        SET payload_json=json_set(payload_json,'$.attemptId',?)
        WHERE id='event-model_call_started'
      `).run(OTHER_ATTEMPT);
    }],
    ["inconsistent decision and turn", (database: DatabaseSync) => {
      database.prepare(`
        UPDATE collaboration_events
        SET payload_json=json_set(payload_json,'$.turnId','missing-turn')
        WHERE id='event-decision_requested'
      `).run();
    }],
    ["agent message with wrong turn", (database: DatabaseSync) => {
      database.prepare(`
        UPDATE collaboration_events
        SET payload_json=json_set(payload_json,'$.turnId','missing-turn')
        WHERE id='event-agent_message'
      `).run();
    }],
  ])("fails closed with unchanged v6 for %s", (_name, mutate) => {
    const directory = mkdtempSync(join(tmpdir(), "cockpit-v7-events-invalid-"));
    directories.push(directory);
    const path = join(directory, "cockpit.sqlite");
    createFixture(path, mutate);
    expectMigrationRollback(path);
  });
});
