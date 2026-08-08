import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateV7 } from "@/src/server/migrations-v7";
import { migrateDatabase } from "@/src/server/migrations";

const PROJECT = "project-pending";
const OTHER_PROJECT = "project-pending-other";
const RUN = "run-pending";
const OTHER_RUN = "run-pending-other";
const OPERATION = "00000000-0000-4000-8000-000000000705";
const ATTEMPT = "attempt-pending";
const NOW = "2026-08-08T09:00:00.000Z";
const EXPIRES = "2026-08-08T09:02:00.000Z";
const directories: string[] = [];

vi.mock("@/src/server/provider-api", () => ({
  callProvider: vi.fn(() => {
    throw new Error("Provider must not be called while opening a database");
  }),
}));

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function threadId(projectId = PROJECT): string {
  return `legacy-thread-${sha256(projectId)}`;
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
    INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version) VALUES
      ('${PROJECT}','Pending fixture','${NOW}',NULL,NULL,1),
      ('${OTHER_PROJECT}','Other fixture','${NOW}',NULL,NULL,1);
    INSERT INTO providers(
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'provider-pending','Fixture','http://localhost/v1','fixture-model',
      'cipher','iv','tag',1,1,'key','***','${NOW}',1,'${NOW}','${NOW}'
    );
    INSERT INTO agents(
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
      updated_at,review_capable
    ) VALUES
      ('agent-a','Alpha','Role','Prompt','provider-pending','fixture-model','A','sage',1,1,0,1000,3,1,'${NOW}','${NOW}',0),
      ('agent-b','Beta','Role','Prompt','provider-pending','fixture-model','B','gold',1,1,0,1000,3,1,'${NOW}','${NOW}',0);
    INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES
      ('${PROJECT}','agent-a','${NOW}'),('${PROJECT}','agent-b','${NOW}'),
      ('${OTHER_PROJECT}','agent-a','${NOW}'),('${OTHER_PROJECT}','agent-b','${NOW}');
    INSERT INTO collaboration_runs(
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES
      ('${RUN}','${PROJECT}','running','agent-a',0,2,1,1,NULL,NULL,'${NOW}','${NOW}'),
      ('${OTHER_RUN}','${OTHER_PROJECT}','planned','agent-a',0,1,1,1,NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO collaboration_project_sequences(project_id,next_message_sequence) VALUES
      ('${PROJECT}',1),('${OTHER_PROJECT}',1);
  `);
}

function seedPendingOperation(
  database: DatabaseSync,
  input: {
    httpStatus?: number | null;
    kind?: string;
    projectId?: string;
    responseJson?: string | null;
    runId?: string | null;
  } = {},
): void {
  database.prepare(`
    INSERT INTO collaboration_operations(
      id,project_id,run_id,kind,request_hash,status,http_status,response_json,
      created_at,updated_at
    ) VALUES (?,?,?,?,?,'pending',?,?,?,?)
  `).run(
    OPERATION,
    input.projectId ?? PROJECT,
    input.runId === undefined ? RUN : input.runId,
    input.kind ?? "advance",
    "pending-request-hash",
    input.httpStatus ?? null,
    input.responseJson ?? null,
    NOW,
    NOW,
  );
}

function seedAttempt(
  database: DatabaseSync,
  input: {
    id?: string;
    operationId?: string;
    projectId?: string;
    runId?: string;
    status?: "calling" | "committed" | "failed" | "interrupted" | "discarded";
  } = {},
): void {
  const status = input.status ?? "calling";
  database.prepare(`
    INSERT INTO collaboration_attempts(
      id,project_id,run_id,agent_id,operation_id,status,lease_token,lease_expires_at,
      prompt_hash,acquire_execution_epoch,acquire_context_hash,included_message_sequence,
      error_category,failure_provider_id,failure_provider_version,
      failure_credential_version,failure_credential_generation,failure_verified_at,
      started_at,finished_at
    ) VALUES (?,?,?,?,?,?,?,?,'prompt-hash',1,'context-hash',0,NULL,NULL,NULL,NULL,NULL,NULL,?,?)
  `).run(
    input.id ?? ATTEMPT,
    input.projectId ?? PROJECT,
    input.runId ?? RUN,
    "agent-a",
    input.operationId ?? OPERATION,
    status,
    `lease-${input.id ?? ATTEMPT}`,
    EXPIRES,
    NOW,
    status === "calling" ? null : NOW,
  );
}

function seedStartedEvent(database: DatabaseSync): void {
  database.prepare(`
    INSERT INTO collaboration_events(
      id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES (
      'event-pending-started',?,1,'model_call_started','agent','agent-a',
      json_object('attemptId',?,'agentId','agent-a','kind','primary'),?
    )
  `).run(RUN, ATTEMPT, NOW);
}

function createFixture(
  path: string,
  mutate: (database: DatabaseSync) => void = () => undefined,
): void {
  const database = bootstrapV6(path);
  try {
    seedBase(database);
    seedPendingOperation(database);
    seedAttempt(database);
    seedStartedEvent(database);
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
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("v6 pending advance migration", () => {
  it("preserves the sole legal pending tuple and does not mutate it on reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cockpit-v7-pending-"));
    directories.push(directory);
    const path = join(directory, "cockpit.sqlite");
    createFixture(path);

    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=ON");
    migrateDatabase(database);
    expect(validateV7(database)).toBeNull();

    const operation = database.prepare(`
      SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
             kind,request_hash AS requestHash,status,http_status AS httpStatus,
             response_json AS responseJson,response_schema_version AS responseSchemaVersion
      FROM collaboration_operations WHERE project_id=? AND id=?
    `).get(PROJECT, OPERATION);
    expect(operation).toEqual({
      httpStatus: null,
      id: OPERATION,
      kind: "advance",
      projectId: PROJECT,
      requestHash: "pending-request-hash",
      responseJson: null,
      responseSchemaVersion: null,
      runId: RUN,
      status: "pending",
      threadId: threadId(),
    });
    expect(database.prepare(`
      SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
             operation_id AS operationId,status
      FROM collaboration_attempts WHERE id=?
    `).get(ATTEMPT)).toEqual({
      id: ATTEMPT,
      operationId: OPERATION,
      projectId: PROJECT,
      runId: RUN,
      status: "calling",
      threadId: threadId(),
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_model_calls WHERE attempt_id=?",
    ).get(ATTEMPT)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_turns WHERE attempt_id=?",
    ).get(ATTEMPT)).toEqual({ count: 0 });

    const beforeReopen = {
      attempt: database.prepare(
        "SELECT * FROM collaboration_attempts WHERE id=?",
      ).get(ATTEMPT),
      operation: database.prepare(
        "SELECT * FROM collaboration_operations WHERE project_id=? AND id=?",
      ).get(PROJECT, OPERATION),
    };
    database.close();

    const reopened = new DatabaseSync(path);
    reopened.exec("PRAGMA foreign_keys=ON");
    migrateDatabase(reopened);
    expect(validateV7(reopened)).toBeNull();
    expect({
      attempt: reopened.prepare(
        "SELECT * FROM collaboration_attempts WHERE id=?",
      ).get(ATTEMPT),
      operation: reopened.prepare(
        "SELECT * FROM collaboration_operations WHERE project_id=? AND id=?",
      ).get(PROJECT, OPERATION),
    }).toEqual(beforeReopen);
    expect((await import("@/src/server/provider-api")).callProvider).not.toHaveBeenCalled();
    reopened.close();
  });

  it("allows later tuple-scoped reconciliation to complete the operation at most once", () => {
    const directory = mkdtempSync(join(tmpdir(), "cockpit-v7-pending-cas-"));
    directories.push(directory);
    const path = join(directory, "cockpit.sqlite");
    createFixture(path);
    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=ON");
    migrateDatabase(database);

    const complete = database.prepare(`
      UPDATE collaboration_operations
      SET status='completed',http_status=200,response_json=?,
          response_schema_version=7,updated_at=?
      WHERE project_id=? AND thread_id=? AND run_id=? AND id=?
        AND kind='advance' AND status='pending'
    `);
    const body = JSON.stringify({
      attemptStatus: "interrupted",
      run: {
        id: RUN,
        projectId: PROJECT,
        threadId: threadId(),
        status: "paused",
      },
    });
    expect(complete.run(
      body, "2026-08-08T09:03:00.000Z", PROJECT, threadId(), RUN, OPERATION,
    ).changes).toBe(1);
    expect(complete.run(
      body, "2026-08-08T09:04:00.000Z", PROJECT, threadId(), RUN, OPERATION,
    ).changes).toBe(0);
    expect(database.prepare(`
      SELECT status,http_status AS httpStatus,response_schema_version AS schemaVersion
      FROM collaboration_operations
      WHERE project_id=? AND thread_id=? AND run_id=? AND id=?
    `).get(PROJECT, threadId(), RUN, OPERATION)).toEqual({
      httpStatus: 200,
      schemaVersion: 7,
      status: "completed",
    });
    database.close();
  });

  it.each([
    ["missing calling attempt", (database: DatabaseSync) => {
      database.prepare("DELETE FROM collaboration_events WHERE run_id=?").run(RUN);
      database.prepare("DELETE FROM collaboration_attempts WHERE id=?").run(ATTEMPT);
    }],
    ["non-calling attempt", (database: DatabaseSync) => {
      database.prepare(`
        UPDATE collaboration_attempts
        SET status='interrupted',error_category='interrupted',finished_at=?
        WHERE id=?
      `).run(NOW, ATTEMPT);
    }],
    ["persisted model call", (database: DatabaseSync) => {
      database.prepare(`
        INSERT INTO collaboration_model_calls(
          id,attempt_id,kind,call_index,status,prompt_tokens,completion_tokens,
          total_tokens,error_category,created_at
        ) VALUES ('call-pending',?,'primary',1,'succeeded',1,1,2,NULL,?)
      `).run(ATTEMPT, NOW);
    }],
    ["persisted business turn", (database: DatabaseSync) => {
      database.exec(`
        INSERT INTO collaboration_messages(
          id,project_id,run_id,author_type,author_agent_id,author_display_name,
          content,mention_agent_id,mention_display_name,sequence,consumed_at,created_at
        ) VALUES (
          'message-pending','${PROJECT}','${RUN}','agent','agent-a','Alpha',
          'must not survive',NULL,NULL,1,NULL,'${NOW}'
        );
        UPDATE collaboration_project_sequences SET next_message_sequence=2
          WHERE project_id='${PROJECT}';
        INSERT INTO collaboration_turns(
          id,attempt_id,run_id,agent_id,round_number,message_id,disposition,created_at
        ) VALUES (
          'turn-pending','${ATTEMPT}','${RUN}','agent-a',1,'message-pending','plan_ready','${NOW}'
        );
        INSERT INTO collaboration_events(
          id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
        ) VALUES (
          'event-pending-message','${RUN}',2,'agent_message','agent','agent-a',
          json_object(
            'messageId','message-pending','messageSequence',1,'agentId','agent-a',
            'agentDisplayName','Alpha','turnId','turn-pending'
          ),
          '${NOW}'
        );
      `);
    }],
    ["pending start", (database: DatabaseSync) => {
      database.prepare(
        "UPDATE collaboration_operations SET kind='start' WHERE project_id=? AND id=?",
      ).run(PROJECT, OPERATION);
    }],
    ["pending http status", (database: DatabaseSync) => {
      database.prepare(
        "UPDATE collaboration_operations SET http_status=202 WHERE project_id=? AND id=?",
      ).run(PROJECT, OPERATION);
    }],
    ["pending response", (database: DatabaseSync) => {
      database.prepare(
        "UPDATE collaboration_operations SET response_json='{}' WHERE project_id=? AND id=?",
      ).run(PROJECT, OPERATION);
    }],
    ["malformed operation tuple", (database: DatabaseSync) => {
      database.prepare(
        "UPDATE collaboration_operations SET run_id=? WHERE project_id=? AND id=?",
      ).run(OTHER_RUN, PROJECT, OPERATION);
    }],
    ["duplicate calling operation attempt", (database: DatabaseSync) => {
      seedAttempt(database, {
        id: "attempt-pending-duplicate",
        operationId: OPERATION,
        projectId: PROJECT,
        runId: OTHER_RUN,
      });
    }],
  ])("fails closed and restores v6 for %s", (_name, mutate) => {
    const directory = mkdtempSync(join(tmpdir(), "cockpit-v7-pending-invalid-"));
    directories.push(directory);
    const path = join(directory, "cockpit.sqlite");
    createFixture(path, mutate);
    expectMigrationRollback(path);
  });
});
