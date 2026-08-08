import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { validateV7 } from "@/src/server/migrations-v7";
import { migrateDatabase } from "@/src/server/migrations";

type StoredOperation = {
  createdAt: string;
  httpStatus: number;
  id: string;
  kind: "start" | "message" | "control" | "answer_decision" | "advance" | "recover";
  projectId: string;
  requestHash: string;
  responseJson: string;
  runId: string | null;
  schemaVersion: number;
  status: string;
  threadId: string;
  updatedAt: string;
};

const PROJECT = "project-receipts";
const RUN = "run-receipts";
const NOW = "2026-08-08T08:00:00.000Z";
const directories: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function legacyThreadId(projectId = PROJECT): string {
  return `legacy-thread-${sha256(projectId)}`;
}

function operationId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN,
    projectId: PROJECT,
    status: "stopped",
    currentAgentId: "agent-a",
    roundCount: 2,
    pauseCategory: null,
    version: 3,
    createdAt: NOW,
    updatedAt: "2026-08-08T08:06:00.000Z",
    ...overrides,
  };
}

function message(
  id: string,
  sequence: number,
  runId: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    sequence,
    runId,
    authorType: "owner",
    authorAgentId: null,
    authorDisplayName: "Owner",
    content: `message ${sequence}`,
    mentionAgentId: null,
    mentionDisplayName: null,
    mentionMemberStatus: null,
    createdAt: `2026-08-08T08:0${sequence}:00.000Z`,
    ...overrides,
  };
}

function event(
  id: string,
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    runId: RUN,
    sequence,
    type,
    actorType: "system",
    actorId: null,
    payload,
    createdAt: `2026-08-08T08:0${sequence}:00.000Z`,
    ...overrides,
  };
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

function seedBase(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
      VALUES ('${PROJECT}','Receipt fixture','${NOW}',NULL,NULL,1);
    INSERT INTO providers(
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'provider-receipts','Fixture','http://localhost/v1','fixture-model',
      'cipher','iv','tag',1,1,'key','***','${NOW}',1,'${NOW}','${NOW}'
    );
    INSERT INTO agents(
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
      updated_at,review_capable
    ) VALUES
      ('agent-a','Alpha','Role','Prompt','provider-receipts','fixture-model','A','sage',1,1,0,1000,3,1,'${NOW}','${NOW}',0),
      ('agent-b','Beta','Role','Prompt','provider-receipts','fixture-model','B','gold',1,1,0,1000,3,1,'${NOW}','${NOW}',0);
    INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES
      ('${PROJECT}','agent-a','${NOW}'),('${PROJECT}','agent-b','${NOW}');
    INSERT INTO collaboration_runs(
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES (
      '${RUN}','${PROJECT}','stopped','agent-a',2,6,3,1,NULL,NULL,
      '${NOW}','2026-08-08T08:06:00.000Z'
    );
    INSERT INTO collaboration_project_sequences(project_id,next_message_sequence)
      VALUES ('${PROJECT}',4);
    INSERT INTO collaboration_messages(
      id,project_id,run_id,author_type,author_agent_id,author_display_name,
      content,mention_agent_id,mention_display_name,sequence,consumed_at,created_at
    ) VALUES
      ('message-project','${PROJECT}',NULL,'owner',NULL,'Owner','message 1',NULL,NULL,1,NULL,'2026-08-08T08:01:00.000Z'),
      ('message-answer','${PROJECT}','${RUN}','owner',NULL,'Owner','message 2',NULL,NULL,2,NULL,'2026-08-08T08:02:00.000Z'),
      ('message-agent','${PROJECT}','${RUN}','agent','agent-a','Alpha','message 3',NULL,NULL,3,NULL,'2026-08-08T08:03:00.000Z');
  `);
}

function insertOperation(
  database: DatabaseSync,
  input: {
    body: unknown;
    httpStatus?: number;
    id: string;
    kind: StoredOperation["kind"] | string;
    requestHash?: string;
    runId?: string | null;
    updatedAt?: string;
  },
): void {
  database.prepare(`
    INSERT INTO collaboration_operations(
      id,project_id,run_id,kind,request_hash,status,http_status,response_json,
      created_at,updated_at
    ) VALUES (?,?,?,? ,?,'completed',?,?,?,?)
  `).run(
    input.id,
    PROJECT,
    input.runId === undefined ? RUN : input.runId,
    input.kind,
    input.requestHash ?? `hash-${input.id}`,
    input.httpStatus ?? 200,
    JSON.stringify(input.body),
    NOW,
    input.updatedAt ?? NOW,
  );
}

function createLegalFixture(path: string): void {
  const database = bootstrapV6(path);
  try {
    seedBase(database);
    const startMessage = message("message-answer", 2, RUN);
    insertOperation(database, {
      id: operationId(1),
      kind: "start",
      httpStatus: 201,
      body: { created: true, run: run(), message: startMessage },
    });
    insertOperation(database, {
      id: operationId(2),
      kind: "start",
      body: { created: false, run: run(), message: startMessage },
    });
    insertOperation(database, {
      id: operationId(3),
      kind: "message",
      httpStatus: 201,
      runId: null,
      body: { message: message("message-project", 1, null), run: null },
    });
    insertOperation(database, {
      id: operationId(4),
      kind: "control",
      updatedAt: "2026-08-08T08:05:00.000Z",
      body: { run: run() },
    });
    insertOperation(database, {
      id: operationId(5),
      kind: "answer_decision",
      updatedAt: "2026-08-08T08:04:00.000Z",
      body: {
        decision: {
          id: "decision-receipts",
          runId: RUN,
          turnId: "turn-receipts",
          requestingAgentId: "agent-a",
          question: "Proceed?",
          options: ["Yes", "No"],
          status: "answered",
          answer: "message 2",
          answerMessageId: "message-answer",
          version: 2,
          createdAt: "2026-08-08T08:00:00.000Z",
          answeredAt: "2026-08-08T08:04:00.000Z",
        },
        run: run(),
      },
    });
    insertOperation(database, {
      id: operationId(6),
      kind: "advance",
      body: {
        attemptStatus: "committed",
        attempt: { id: "attempt-receipts", status: "committed" },
        events: [
          event("event-advance", 7, "run_planned", { turnId: "turn-receipts" }),
        ],
        run: run({ status: "planned" }),
      },
    });
    for (const [index, status] of [
      "calling",
      "committed",
      "failed",
      "interrupted",
      "discarded",
    ].entries()) {
      insertOperation(database, {
        id: operationId(10 + index),
        kind: "recover",
        body: {
          attempt: {
            id: `recover-attempt-${status}`,
            status,
            leaseExpiresAt: "2026-08-08T08:10:00.000Z",
          },
          run: run(),
        },
      });
    }

    const errorKinds: StoredOperation["kind"][] = [
      "start",
      "message",
      "control",
      "answer_decision",
      "advance",
      "recover",
    ];
    errorKinds.forEach((kind, index) => insertOperation(database, {
      id: operationId(20 + index),
      kind,
      httpStatus: 409,
      body: {
        error: {
          message: `${kind} conflict`,
          code: "RUN_STATE_CONFLICT",
          currentVersion: 3,
          fields: { operation: kind },
          category: "action_conflict",
          correlationId: `correlation-${kind}`,
        },
      },
    }));

    database.exec(`
      INSERT INTO collaboration_attempts(
        id,project_id,run_id,agent_id,operation_id,status,lease_token,lease_expires_at,
        prompt_hash,acquire_execution_epoch,acquire_context_hash,included_message_sequence,
        error_category,failure_provider_id,failure_provider_version,
        failure_credential_version,failure_credential_generation,failure_verified_at,
        started_at,finished_at
      ) VALUES (
        'attempt-receipts','${PROJECT}','${RUN}','agent-a','${operationId(6)}','committed',
        'lease','2026-08-08T08:10:00.000Z','prompt',1,'context',2,NULL,NULL,NULL,NULL,NULL,NULL,
        '${NOW}','2026-08-08T08:03:00.000Z'
      );
      INSERT INTO collaboration_turns(
        id,attempt_id,run_id,agent_id,round_number,message_id,disposition,created_at
      ) VALUES (
        'turn-receipts','attempt-receipts','${RUN}','agent-a',1,'message-agent','decision_request',
        '2026-08-08T08:03:00.000Z'
      );
      INSERT INTO decision_requests(
        id,run_id,turn_id,requesting_agent_id,question,options_json,status,answer,
        answer_message_id,version,created_at,answered_at
      ) VALUES (
        'decision-receipts','${RUN}','turn-receipts','agent-a','Proceed?',
        json_array('Yes','No'),'answered','message 2','message-answer',2,
        '${NOW}','2026-08-08T08:04:00.000Z'
      );
      INSERT INTO collaboration_events(
        id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
      ) VALUES
        ('event-start','${RUN}',1,'run_started','owner',NULL,
         json_object('messageId','message-answer','messageSequence',2,'currentAgentId','agent-a'),
         '2026-08-08T08:01:30.000Z'),
        ('event-answer-message','${RUN}',2,'owner_message','owner',NULL,
         json_object('messageId','message-answer','messageSequence',2,'mentionAgentId',NULL,'mentionDisplayName',NULL),
         '2026-08-08T08:02:00.000Z'),
        ('event-agent','${RUN}',3,'agent_message','agent','agent-a',
         json_object('messageId','message-agent','messageSequence',3,'agentId','agent-a','agentDisplayName','Alpha','turnId','turn-receipts'),
         '2026-08-08T08:03:00.000Z'),
        ('event-decision','${RUN}',4,'decision_answered','owner',NULL,
         json_object('decisionId','decision-receipts','messageId','message-answer','messageSequence',2,'answer','message 2','nextAgentId','agent-a'),
         '2026-08-08T08:04:00.000Z'),
        ('event-control','${RUN}',5,'run_stopped','owner',NULL,json_object(),
         '2026-08-08T08:05:00.000Z');
    `);
  } finally {
    database.close();
  }
}

function readOperations(database: DatabaseSync): StoredOperation[] {
  return database.prepare(`
    SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,kind,
           request_hash AS requestHash,status,http_status AS httpStatus,
           response_json AS responseJson,response_schema_version AS schemaVersion,
           created_at AS createdAt,updated_at AS updatedAt
    FROM collaboration_operations
    WHERE kind<>'thread_create' ORDER BY id
  `).all() as StoredOperation[];
}

function createInvalidFixture(path: string, kind: string, body: unknown): void {
  const database = bootstrapV6(path);
  try {
    seedBase(database);
    database.exec(`
      DELETE FROM collaboration_messages;
      UPDATE collaboration_project_sequences SET next_message_sequence=1;
    `);
    insertOperation(database, { body, id: operationId(99), kind });
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("v6 completed receipt conversion", () => {
  it("strictly converts and replays every legal completed kind without changing receipt identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "cockpit-v7-receipts-"));
    directories.push(directory);
    const path = join(directory, "cockpit.sqlite");
    createLegalFixture(path);

    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=ON");
    migrateDatabase(database);
    expect(validateV7(database)).toBeNull();
    const operations = readOperations(database);
    const beforeReopen = operations;
    database.close();
    const threadId = legacyThreadId();

    expect(operations).toHaveLength(17);
    expect(operations.every((operation) =>
      operation.threadId === threadId
      && operation.status === "completed"
      && operation.schemaVersion === 7
      && operation.requestHash === `hash-${operation.id}`
      && operation.createdAt === NOW)).toBe(true);
    expect(operations.map(({ httpStatus, id, kind, runId, updatedAt }) => ({
      httpStatus, id, kind, runId, updatedAt,
    }))).toEqual(expect.arrayContaining([
      {
        httpStatus: 201,
        id: operationId(1),
        kind: "start",
        runId: RUN,
        updatedAt: NOW,
      },
      {
        httpStatus: 200,
        id: operationId(2),
        kind: "start",
        runId: RUN,
        updatedAt: NOW,
      },
      {
        httpStatus: 409,
        id: operationId(20),
        kind: "start",
        runId: RUN,
        updatedAt: NOW,
      },
    ]));

    const bodies = new Map(operations.map((operation) => [
      operation.id,
      JSON.parse(operation.responseJson) as Record<string, unknown>,
    ]));
    expect(bodies.get(operationId(1))).toMatchObject({
      created: true,
      message: { id: "message-answer", projectId: PROJECT, threadId },
      run: { id: RUN, projectId: PROJECT, threadId },
    });
    expect(bodies.get(operationId(2))).toMatchObject({
      created: false,
      message: { id: "message-answer", projectId: PROJECT, threadId },
      run: { id: RUN, projectId: PROJECT, threadId },
    });
    expect(bodies.get(operationId(3))).toMatchObject({
      message: { id: "message-project", projectId: PROJECT, threadId },
      fact: {
        type: "owner_message",
        messageId: "message-project",
        projectId: PROJECT,
        threadId,
      },
      run: null,
    });
    expect(bodies.get(operationId(4))).toMatchObject({
      run: { id: RUN, projectId: PROJECT, threadId },
      fact: {
        type: "run_event",
        runEventId: "event-control",
        projectId: PROJECT,
        threadId,
      },
    });
    expect(bodies.get(operationId(5))).toMatchObject({
      decision: { id: "decision-receipts", projectId: PROJECT, threadId },
      message: { id: "message-answer", projectId: PROJECT, threadId },
      run: { id: RUN, projectId: PROJECT, threadId },
      facts: [
        expect.objectContaining({ messageId: "message-answer", type: "owner_message" }),
        expect.objectContaining({ runEventId: "event-decision", type: "run_event" }),
      ],
    });
    expect(bodies.get(operationId(6))).toMatchObject({
      attemptStatus: "committed",
      events: [
        expect.objectContaining({
          id: "event-advance",
          projectId: PROJECT,
          threadId,
        }),
      ],
      run: { id: RUN, projectId: PROJECT, threadId },
    });
    for (const [index, status] of [
      "calling",
      "committed",
      "failed",
      "interrupted",
      "discarded",
    ].entries()) {
      expect(bodies.get(operationId(10 + index))).toMatchObject({
        attempt: { id: `recover-attempt-${status}`, status },
        fact: null,
        run: { id: RUN, projectId: PROJECT, threadId },
      });
    }
    for (const [index, kind] of [
      "start",
      "message",
      "control",
      "answer_decision",
      "advance",
      "recover",
    ].entries()) {
      expect(bodies.get(operationId(20 + index))).toEqual({
        error: {
          category: "action_conflict",
          code: "RUN_STATE_CONFLICT",
          correlationId: `correlation-${kind}`,
          currentVersion: 3,
          fields: { operation: kind },
          message: `${kind} conflict`,
        },
      });
    }

    const reopened = new DatabaseSync(path);
    reopened.exec("PRAGMA foreign_keys=ON");
    migrateDatabase(reopened);
    expect(validateV7(reopened)).toBeNull();
    expect(readOperations(reopened)).toEqual(beforeReopen);
    reopened.close();
  });

  it.each([
    ["start", { created: true, run: run(), message: { ...message("message-answer", 2, RUN), extra: true } }],
    ["message", { message: message("message-project", 1, null), run: null, extra: true }],
    ["control", { run: { ...run(), status: "unknown" } }],
    ["answer_decision", { decision: { id: "only-an-id" }, run: run() }],
    ["advance", { attemptStatus: "unknown", run: run() }],
    ["recover", { attempt: { id: "attempt", status: "unknown", leaseExpiresAt: NOW }, run: run() }],
    ["start", { created: true, run: run({ projectId: "other-project" }), message: message("message-answer", 2, RUN) }],
    ["mystery", { run: run() }],
  ])("rejects malformed, extra, or unknown %s completed receipts", (kind, body) => {
    const directory = mkdtempSync(join(tmpdir(), "cockpit-v7-invalid-receipt-"));
    directories.push(directory);
    const path = join(directory, "cockpit.sqlite");
    createInvalidFixture(path, kind, body);
    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=ON");
    expect(() => migrateDatabase(database)).toThrow(
      expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }),
    );
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    database.close();
  });
});
