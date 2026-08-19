import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";
import {
  insertAuditProjectionRows,
  upsertAuditCheckpoint,
} from "@/src/adapters/outbound/sqlite/operations-projection/audit-projection-store";
import { extractExecutionAuditPayload } from "@/src/adapters/outbound/sqlite/safe-execution/audit-event-outbox";
import { recordUsageEvent } from "@/src/adapters/outbound/sqlite/safe-execution/execution-usage-budget";
import { execV7Fixture } from "@/tests/fixtures/execution/current-graph";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-10T03:00:00.000Z";
const PROJECT_ID = "audit-project";
const EXECUTION_ID = "audit-execution";
const ATTEMPT_ID = "audit-attempt";
const ACTION_ID = "audit-action";
const POLICY_HASH =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const HASH = "a".repeat(64);

let databasePath: string;
let database: DatabaseSync;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  database = openDatabase(databasePath);
});

afterEach(() => {
  try {
    database.close();
  } catch {
    // Rejection tests close the suite connection before corrupting the graph.
  }
  vi.useRealTimers();
});

function seedProjectOnly(): void {
  database.prepare(
    "INSERT INTO projects(id,name,created_at,version) VALUES (?,?,?,1)",
  ).run(PROJECT_ID, "Audit", NOW);
}

function seedExecutionGraph(): void {
  execV7Fixture(databasePath, database, `
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Audit','${NOW}',NULL,NULL,1);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES ('provider','Provider','http://127.0.0.1','model','cipher','iv','tag',
      1,1,'key','***','${NOW}',1,'${NOW}','${NOW}');
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES ('agent','Agent','Builder','private','provider','model','A','sage',
      1,1,1,1000,5,1,'${NOW}','${NOW}');
    INSERT INTO project_memberships (project_id,agent_id,joined_at)
    VALUES ('${PROJECT_ID}','agent','${NOW}');
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','${PROJECT_ID}','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES ('work','mission','Work','','in_progress','agent',1,'${NOW}','${NOW}');
    INSERT INTO collaboration_runs (
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES ('run','${PROJECT_ID}','planned','agent',1,1,1,1,NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES ('policy','${PROJECT_ID}',NULL,'system',1,'${POLICY_HASH}',1,0,2,0,'${NOW}');
    INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
    VALUES ('${PROJECT_ID}','policy',1,'${NOW}');
    INSERT INTO executions (
      id,project_id,source_collaboration_run_id,source_collaboration_thread_id,
      mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES ('${EXECUTION_ID}','${PROJECT_ID}','run',(
        SELECT thread_id FROM collaboration_runs WHERE project_id='${PROJECT_ID}' AND id='run'
      ),'mission','work','agent','policy',
      'running',NULL,NULL,0,NULL,1,1,0,1,1,'${NOW}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),'${NOW}',NULL);
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,sandbox_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES ('${ATTEMPT_ID}','${PROJECT_ID}','${EXECUTION_ID}',1,'acting',
      'verified://sandbox',NULL,NULL,
      '${HASH}','${HASH}','{}','{}','${HASH}','policy',1,'${POLICY_HASH}','${NOW}',NULL);
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,
      action_count,final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES ('audit-operation','${PROJECT_ID}','${EXECUTION_ID}','advance',
      '${HASH}',1,1,NULL,'pending',NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO execution_actions (
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,overall_deadline_at,created_at
    ) VALUES ('${ACTION_ID}','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',
      'audit-operation',0,'model','pending','${HASH}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes'),'${NOW}');
    INSERT INTO execution_model_calls (
      id,project_id,execution_id,attempt_id,action_id,business_round,kind,call_index,
      status,prompt_hash,prompt_tokens,completion_tokens,total_tokens,error_category,
      call_started_at,call_deadline_at,finished_at,created_at
    ) VALUES
      ('call-1','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}','${ACTION_ID}',1,'primary',1,
       'calling','${HASH}',NULL,NULL,NULL,NULL,'${NOW}',
       strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes'),NULL,'${NOW}'),
      ('call-2','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}','${ACTION_ID}',1,'primary',2,
       'calling','${HASH}',NULL,NULL,NULL,NULL,'${NOW}',
       strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes'),NULL,'${NOW}');
  `);
}

type OutboxRow = {
  eventType: string;
  id: string;
  occurredAt: string;
  payloadJson: string;
  projectId: string;
  seq: number;
  source: string;
};

function outboxRows(): OutboxRow[] {
  return database.prepare(`
    SELECT id,project_id AS projectId,source,event_type AS eventType,
           payload_json AS payloadJson,occurred_at AS occurredAt,outbox_seq AS seq
    FROM audit_event_outbox ORDER BY outbox_seq
  `).all() as OutboxRow[];
}

function insertOutboxRow(input: {
  id: string;
  occurredAt?: string;
  payloadJson?: string;
  projectId?: string;
  seq: number;
  source?: string;
}): void {
  database.prepare(`
    INSERT INTO audit_event_outbox (
      id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
    ) VALUES (?,?,?,?,?,?,?)
  `).run(
    input.id,
    input.projectId ?? PROJECT_ID,
    input.source ?? "safe_execution",
    "usage_recorded",
    input.payloadJson ?? "{}",
    input.occurredAt ?? NOW,
    input.seq,
  );
}

describe("audit outbox schema", () => {
  it("bootstraps the three audit tables at identity 17", () => {
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
    const names = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name LIKE 'audit_%' ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(names.map(({ name }) => name)).toEqual([
      "audit_event_outbox",
      "audit_event_projection",
      "audit_projection_checkpoints",
    ]);
  });

  it("enforces outbox source/payload/occurred_at/seq guards", () => {
    seedProjectOnly();
    expect(() => insertOutboxRow({ id: "bad-source", seq: 1, source: "collaboration" }))
      .toThrow();
    expect(() => insertOutboxRow({ id: "bad-json", seq: 1, payloadJson: "not json" }))
      .toThrow();
    expect(() => insertOutboxRow({
      id: "oversize",
      seq: 1,
      payloadJson: `{"k":"${"x".repeat(70_000)}"}`,
    })).toThrow();
    expect(() => insertOutboxRow({ id: "bad-time", seq: 1, occurredAt: "not-a-date" }))
      .toThrow();
    expect(() => insertOutboxRow({ id: "bad-seq", seq: 0 })).toThrow();

    insertOutboxRow({ id: "ok-1", seq: 1 });
    insertOutboxRow({ id: "ok-2", seq: 2 });
    expect(() => insertOutboxRow({ id: "dup-seq", seq: 2 })).toThrow();
    expect(outboxRows().map(({ id }) => id)).toEqual(["ok-1", "ok-2"]);
  });

  it("enforces checkpoint status vocabulary and defaults", () => {
    expect(() => database.prepare(`
      INSERT INTO audit_projection_checkpoints (consumer_id,last_outbox_seq,status,updated_at)
      VALUES ('consumer',0,'bogus','${NOW}')
    `).run()).toThrow();
    expect(() => database.prepare(`
      INSERT INTO audit_projection_checkpoints (consumer_id,last_outbox_seq,status,updated_at)
      VALUES ('consumer',-1,'idle','${NOW}')
    `).run()).toThrow();

    database.prepare(`
      INSERT INTO audit_projection_checkpoints (consumer_id,status,updated_at)
      VALUES ('consumer','idle','${NOW}')
    `).run();
    expect(database.prepare(`
      SELECT last_outbox_seq AS lastOutboxSeq,status
      FROM audit_projection_checkpoints WHERE consumer_id='consumer'
    `).get()).toEqual({ lastOutboxSeq: 0, status: "idle" });
  });

  it("enforces projection outbox_seq uniqueness and payload guard", () => {
    const insert = (id: string, seq: number, payloadJson = "{}") => database.prepare(`
      INSERT INTO audit_event_projection (
        outbox_seq,id,project_id,source,event_type,actor_type,occurred_at,
        execution_id,payload_json
      ) VALUES (?,?,?,'safe_execution','usage_recorded',NULL,?,NULL,?)
    `).run(seq, id, PROJECT_ID, NOW, payloadJson);
    insert("row-1", 1);
    expect(() => insert("row-2", 1)).toThrow();
    expect(() => insert("row-3", 3, "not json")).toThrow();
  });
});

describe("Safe Execution audit outbox write", () => {
  it("appends a whitelisted outbox row in the same transaction as each usage event", () => {
    seedExecutionGraph();
    recordUsageEvent(database, "call-1", {
      completionTokens: 3,
      promptTokens: 2,
      totalTokens: 5,
    });
    recordUsageEvent(database, "call-2", null);

    const events = database.prepare(`
      SELECT id,type,actor_type AS actorType,actor_id AS actorId
      FROM execution_events ORDER BY sequence
    `).all() as Array<{ actorId: string | null; actorType: string; id: string; type: string }>;
    expect(events).toHaveLength(2);

    const rows = outboxRows();
    expect(rows.map((row) => row.id)).toEqual(events.map(({ id }) => id));
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({
      eventType: "usage_recorded",
      occurredAt: NOW,
      projectId: PROJECT_ID,
      source: "safe_execution",
    });
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: "agent",
      actorType: "agent",
      agentId: "agent",
      attemptNo: 1,
      completionTokens: 3,
      executionId: EXECUTION_ID,
      modelCallId: "call-1",
      occurredAt: NOW,
      promptTokens: 2,
      reported: true,
      totalTokens: 5,
      type: "usage_recorded",
    });
    expect(JSON.parse(rows[1]!.payloadJson)).toEqual({
      actorId: "agent",
      actorType: "agent",
      agentId: "agent",
      attemptNo: 1,
      completionTokens: 0,
      executionId: EXECUTION_ID,
      modelCallId: "call-2",
      occurredAt: NOW,
      promptTokens: 0,
      reported: false,
      totalTokens: 0,
      type: "usage_recorded",
    });
  });
});

describe("extractExecutionAuditPayload whitelist", () => {
  const core = {
    actorId: null,
    actorType: "system",
    attemptNo: 2,
    eventType: "stale_detected",
    executionId: EXECUTION_ID,
    occurredAt: NOW,
  };

  it("keeps only flat public contract fields and renames the source tool type", () => {
    const payload = extractExecutionAuditPayload({
      ...core,
      eventType: "tool_succeeded",
      sourcePayload: {
        afterHash: null,
        apiKey: "sk-secret",
        beforeHash: HASH,
        code: "SANDBOX_UNVERIFIABLE",
        durationMs: 12,
        hiddenReasoning: "chain-of-thought",
        hostPath: "D:\\cool-ai\\.env",
        prompt: "system prompt text",
        requestSummary: { authorization: "one_shot", requestHash: HASH },
        resultSummary: { entryCount: 1, path: "." },
        status: "completed",
        stderr: "raw command output with secrets",
        stdout: { bytes: 3, sha256: HASH, truncated: false },
        systemPrompt: "private",
        toolCallId: "tool-call-1",
        type: "command",
        workspacePath: "D:\\cool-ai",
      },
    });
    expect(payload).toEqual({
      actorId: null,
      actorType: "system",
      afterHash: null,
      attemptNo: 2,
      beforeHash: HASH,
      code: "SANDBOX_UNVERIFIABLE",
      durationMs: 12,
      executionId: EXECUTION_ID,
      occurredAt: NOW,
      status: "completed",
      toolCallId: "tool-call-1",
      toolType: "command",
      type: "tool_succeeded",
    });
  });

  it("drops non-scalar and non-whitelisted values without failing", () => {
    const payload = extractExecutionAuditPayload({
      ...core,
      sourcePayload: {
        categories: ["external_workspace"],
        from: "running",
        mixed: ["ok", 1],
        nested: { pathCount: 1 },
        notAContractKey: "dropped",
        otherExecutionIds: ["execution-b"],
        pathCount: 2,
        reasonCode: null,
        to: "stale",
        unbounded: Number.POSITIVE_INFINITY,
      },
    });
    expect(payload).toEqual({
      actorId: null,
      actorType: "system",
      attemptNo: 2,
      categories: ["external_workspace"],
      executionId: EXECUTION_ID,
      from: "running",
      occurredAt: NOW,
      otherExecutionIds: ["execution-b"],
      pathCount: 2,
      reasonCode: null,
      to: "stale",
      type: "stale_detected",
    });
  });

  it("falls back to core fields for non-object source payloads", () => {
    for (const sourcePayload of [null, "text", ["a"], 42] as const) {
      expect(extractExecutionAuditPayload({ ...core, sourcePayload })).toEqual({
        actorId: null,
        actorType: "system",
        attemptNo: 2,
        executionId: EXECUTION_ID,
        occurredAt: NOW,
        type: "stale_detected",
      });
    }
  });
});

describe("operations-projection writer anchor", () => {
  const row = (seq: number) => ({
    actorType: "agent" as const,
    eventType: "usage_recorded",
    executionId: EXECUTION_ID,
    id: `event-${seq}`,
    occurredAt: NOW,
    outboxSeq: seq,
    payloadJson: "{}",
    projectId: PROJECT_ID,
    source: "safe_execution",
  });

  it("inserts projection rows idempotently by outbox_seq", () => {
    expect(insertAuditProjectionRows(database, [row(1), row(2)])).toBe(2);
    expect(insertAuditProjectionRows(database, [row(1), row(2)])).toBe(0);
    expect(database.prepare(
      "SELECT count(*) AS count FROM audit_event_projection",
    ).get()).toEqual({ count: 2 });
  });

  it("creates then advances the consumer checkpoint", () => {
    upsertAuditCheckpoint(database, {
      consumerId: "audit-projection",
      lastOutboxSeq: 0,
      status: "idle",
    });
    upsertAuditCheckpoint(database, {
      consumerId: "audit-projection",
      lastOutboxSeq: 2,
      status: "idle",
    });
    expect(database.prepare(`
      SELECT last_outbox_seq AS lastOutboxSeq,status,updated_at AS updatedAt
      FROM audit_projection_checkpoints WHERE consumer_id='audit-projection'
    `).get()).toEqual({ lastOutboxSeq: 2, status: "idle", updatedAt: NOW });
  });
});

describe("audit projection reopen invariants", () => {
  function seedProjectionGraph(): void {
    seedProjectOnly();
    insertOutboxRow({ id: "event-1", seq: 1 });
    insertOutboxRow({ id: "event-2", seq: 2 });
    insertAuditProjectionRows(database, [
      {
        actorType: "agent",
        eventType: "usage_recorded",
        executionId: EXECUTION_ID,
        id: "event-1",
        occurredAt: NOW,
        outboxSeq: 1,
        payloadJson: "{}",
        projectId: PROJECT_ID,
        source: "safe_execution",
      },
      {
        actorType: "agent",
        eventType: "usage_recorded",
        executionId: EXECUTION_ID,
        id: "event-2",
        occurredAt: NOW,
        outboxSeq: 2,
        payloadJson: "{}",
        projectId: PROJECT_ID,
        source: "safe_execution",
      },
    ]);
    upsertAuditCheckpoint(database, {
      consumerId: "audit-projection",
      lastOutboxSeq: 2,
      status: "idle",
    });
  }

  it("reopens a consistent outbox/projection/checkpoint graph idempotently", () => {
    seedProjectionGraph();
    database.close();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = openDatabase(databasePath);
      reopened.close();
    }
    database = openDatabase(databasePath);
    expect(database.prepare(
      "SELECT count(*) AS count FROM audit_event_outbox",
    ).get()).toEqual({ count: 2 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM audit_event_projection",
    ).get()).toEqual({ count: 2 });
  });

  it("rejects a projection row without a matching outbox sequence", () => {
    seedProjectionGraph();
    database.close();
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec("PRAGMA foreign_keys=OFF");
      raw.prepare(`
        INSERT INTO audit_event_projection (
          outbox_seq,id,project_id,source,event_type,actor_type,occurred_at,
          execution_id,payload_json
        ) VALUES (99,'ghost','${PROJECT_ID}','safe_execution','usage_recorded',NULL,
          '${NOW}',NULL,'{}')
      `).run();
    } finally {
      raw.close();
    }
    expect(() => openDatabase(databasePath).close()).toThrowError(
      expect.objectContaining<Partial<SchemaError>>({ code: "SCHEMA_DATA_INVALID" }),
    );
  });

  it("rejects a checkpoint ahead of the outbox head", () => {
    seedProjectionGraph();
    database.close();
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec("PRAGMA foreign_keys=OFF");
      raw.prepare(`
        UPDATE audit_projection_checkpoints SET last_outbox_seq=99
        WHERE consumer_id='audit-projection'
      `).run();
    } finally {
      raw.close();
    }
    expect(() => openDatabase(databasePath).close()).toThrowError(
      expect.objectContaining<Partial<SchemaError>>({ code: "SCHEMA_DATA_INVALID" }),
    );
  });
});
