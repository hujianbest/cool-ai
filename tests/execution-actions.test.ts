import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createV6FixtureDatabaseOpener } from "@/tests/v6-fixture-db";

const openDatabase = createV6FixtureDatabaseOpener({
  missingDeliveryHeadMissionIds: ["mission"],
  missingReviewHeadResultIds: [],
});

const PROJECT_ID = "action-project";
const EXECUTION_ID = "action-execution";
const ATTEMPT_ID = "action-attempt";
const NOW = "2026-07-30T03:30:00.000Z";
const HASH = "a".repeat(64);

type CasResult = { affectedRows: 0 | 1 };
type ActionModule = {
  acquireExecutionAction: (database: DatabaseSync, input: {
    actionIndex: number;
    operationId: string;
    projectId: string;
  }) => { affectedRows: 0 | 1; leaseToken: string | null };
  discardExecutionAction: (database: DatabaseSync, input: {
    actionId: string;
    body: unknown;
    httpStatus: number;
    projectId: string;
  }) => CasResult;
  finalizeExecutionAction: (database: DatabaseSync, input: {
    actionId: string;
    body: unknown;
    httpStatus: number;
    leaseToken: string;
    projectId: string;
    result: unknown;
    status: "succeeded" | "failed";
  }) => CasResult;
  heartbeatExecutionAction: (database: DatabaseSync, input: {
    actionId: string;
    leaseToken: string;
    projectId: string;
  }) => CasResult;
  reconcileExecutionAction: (database: DatabaseSync, input: {
    actionId: string;
    body: unknown;
    errorCode: string;
    httpStatus: number;
    projectId: string;
  }) => CasResult;
};

let directory: string;
let databasePath: string;
let actions: ActionModule;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-execution-actions-"));
  databasePath = join(directory, "cockpit.sqlite");
  seedExecution();
  const moduleId = "@/src/server/execution/execution-actions";
  try {
    actions = await import(/* @vite-ignore */ moduleId) as ActionModule;
  } catch {
    expect.fail("The generic execution action CAS primitive is unavailable.");
  }
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

function seedExecution(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
      VALUES ('${PROJECT_ID}','Actions','${NOW}','D:\\workspace','d:/workspace',1);
      INSERT INTO providers (
        id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
        credential_version,credential_generation,key_id,api_key_mask,verified_at,
        version,created_at,updated_at
      ) VALUES (
        'provider','Provider','http://127.0.0.1:4000/v1','model','c','i','t',
        1,1,'k','***','${NOW}',1,'${NOW}','${NOW}'
      );
      INSERT INTO agents (
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
      ) VALUES (
        'agent','Agent','Builder','private','provider','model','A','sage',
        1,1,1,1000,5,1,'${NOW}','${NOW}'
      );
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
      ) VALUES (
        'policy','${PROJECT_ID}',NULL,'system',1,
        '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        1,0,2,0,'${NOW}'
      );
      INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
      VALUES ('${PROJECT_ID}','policy',1,'${NOW}');
      INSERT INTO executions (
        id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
        current_policy_revision_id,status,resume_target,reason_code,
        manual_recovery_required,recovery_resolution,current_attempt_no,
        business_round_count,tool_call_count,next_event_sequence,version,created_at,
        business_deadline_at,first_running_at,updated_at,merged_at
      ) VALUES (
        '${EXECUTION_ID}','${PROJECT_ID}','run','mission','work','agent','policy',
        'queued',NULL,NULL,0,NULL,1,0,0,1,1,'${NOW}',NULL,NULL,'${NOW}',NULL
      );
      INSERT INTO execution_attempts (
        id,project_id,execution_id,attempt_no,status,sandbox_root,
        baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
        frozen_public_json,frozen_private_json,frozen_context_hash,
        frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
        started_at,finished_at
      ) VALUES (
        '${ATTEMPT_ID}','${PROJECT_ID}','${EXECUTION_ID}',1,'ready','D:\\sandbox',
        NULL,NULL,NULL,'{}','{}','${"c".repeat(64)}','policy',1,
        '${"d".repeat(64)}','${NOW}',NULL
      );
    `);
  } finally {
    database.close();
  }
}

function operationId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function createPendingAction(
  database: DatabaseSync,
  index: number,
  deadlineModifier = "+1 hour",
): { actionId: string; operationId: string } {
  const actionId = `action-${index}`;
  const operationIdValue = operationId(index);
  database.prepare(`
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,
      action_count,final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES (?,? ,?,'advance',?,1,1,NULL,'pending',NULL,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(operationIdValue, PROJECT_ID, EXECUTION_ID, HASH);
  database.prepare(`
    INSERT INTO execution_actions (
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,overall_deadline_at,created_at
    ) VALUES (?,?,?,?,?,0,'model','pending',?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now',?),
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    actionId,
    PROJECT_ID,
    EXECUTION_ID,
    ATTEMPT_ID,
    operationIdValue,
    HASH,
    deadlineModifier,
  );
  return { actionId, operationId: operationIdValue };
}

function acquire(database: DatabaseSync, operationIdValue: string) {
  return actions.acquireExecutionAction(database, {
    actionIndex: 0,
    operationId: operationIdValue,
    projectId: PROJECT_ID,
  });
}

function readAction(database: DatabaseSync, actionId: string) {
  return database.prepare(`
    SELECT status,lease_token AS leaseToken,lease_expires_at AS leaseExpiresAt,
           overall_deadline_at AS overallDeadlineAt,last_heartbeat_at AS lastHeartbeatAt,
           started_at AS startedAt,finished_at AS finishedAt,result_json AS resultJson,
           error_code AS errorCode
    FROM execution_actions WHERE id=?
  `).get(actionId);
}

describe("generic execution child action CAS", () => {
  it("starts the business clock from SQLite once and never resets or extends it", () => {
    const database = openDatabase(databasePath);
    try {
      const created = createPendingAction(database, 1);
      expect(database.prepare(`
        SELECT status,first_running_at AS firstRunningAt,
               business_deadline_at AS businessDeadlineAt
        FROM executions WHERE id=?
      `).get(EXECUTION_ID)).toEqual({
        businessDeadlineAt: null,
        firstRunningAt: null,
        status: "queued",
      });

      const before = database.prepare(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now",
      ).get() as { now: string };
      const lease = acquire(database, created.operationId);
      const after = database.prepare(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now",
      ).get() as { now: string };
      expect(lease.affectedRows).toBe(1);
      expect(lease.leaseToken).toMatch(/^[0-9a-f-]{36}$/);

      const first = database.prepare(`
        SELECT status,first_running_at AS firstRunningAt,
               business_deadline_at AS businessDeadlineAt
        FROM executions WHERE id=?
      `).get(EXECUTION_ID) as {
        businessDeadlineAt: string;
        firstRunningAt: string;
        status: string;
      };
      expect(first.status).toBe("running");
      expect(first.firstRunningAt >= before.now).toBe(true);
      expect(first.firstRunningAt <= after.now).toBe(true);
      expect(
        Date.parse(first.businessDeadlineAt) - Date.parse(first.firstRunningAt),
      ).toBe(900_000);

      actions.finalizeExecutionAction(database, {
        actionId: created.actionId,
        body: { outcome: "done" },
        httpStatus: 200,
        leaseToken: lease.leaseToken!,
        projectId: PROJECT_ID,
        result: { code: "DONE" },
        status: "succeeded",
      });
      database.prepare(`
        UPDATE executions SET status='queued',version=version+1
        WHERE id=?
      `).run(EXECUTION_ID);
      const retry = createPendingAction(database, 2);
      const secondLease = acquire(database, retry.operationId);
      expect(secondLease.affectedRows).toBe(1);
      expect(database.prepare(`
        SELECT first_running_at AS firstRunningAt,
               business_deadline_at AS businessDeadlineAt
        FROM executions WHERE id=?
      `).get(EXECUTION_ID)).toEqual({
        businessDeadlineAt: first.businessDeadlineAt,
        firstRunningAt: first.firstRunningAt,
      });
    } finally {
      database.close();
    }
  });

  it("uses a random 120 second lease and heartbeat renews from DB time without extending overall deadline", () => {
    const database = openDatabase(databasePath);
    try {
      const first = createPendingAction(database, 3, "+121 seconds");
      const firstLease = acquire(database, first.operationId);
      const acquired = readAction(database, first.actionId) as {
        lastHeartbeatAt: string;
        leaseExpiresAt: string;
        overallDeadlineAt: string;
      };
      expect(
        Date.parse(acquired.leaseExpiresAt) - Date.parse(acquired.lastHeartbeatAt),
      ).toBe(120_000);

      database.prepare(`
        UPDATE execution_actions
        SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second'),
            overall_deadline_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+119 seconds')
        WHERE id=?
      `).run(first.actionId);
      expect(actions.heartbeatExecutionAction(database, {
        actionId: first.actionId,
        leaseToken: firstLease.leaseToken!,
        projectId: PROJECT_ID,
      })).toEqual({ affectedRows: 1 });
      const heartbeat = readAction(database, first.actionId) as {
        lastHeartbeatAt: string;
        leaseExpiresAt: string;
        overallDeadlineAt: string;
      };
      expect(heartbeat.leaseExpiresAt).toBe(heartbeat.overallDeadlineAt);
      expect(
        Date.parse(heartbeat.leaseExpiresAt) - Date.parse(heartbeat.lastHeartbeatAt),
      ).toBeLessThanOrEqual(120_000);

      expect(actions.heartbeatExecutionAction(database, {
        actionId: first.actionId,
        leaseToken: "00000000-0000-4000-8000-000000000000",
        projectId: PROJECT_ID,
      })).toEqual({ affectedRows: 0 });
    } finally {
      database.close();
    }
  });

  it.each([
    ["deadline-1", "+1 second", 1],
    ["deadline", "+0 seconds", 0],
    ["deadline+1", "-1 second", 0],
  ] as const)("enforces the DB-time boundary at now=%s", (_label, modifier, expected) => {
    const database = openDatabase(databasePath);
    try {
      const created = createPendingAction(database, expected + modifier.length, modifier);
      expect(acquire(database, created.operationId).affectedRows).toBe(expected);
      expect(readAction(database, created.actionId)).toEqual(expect.objectContaining({
        status: expected === 1 ? "running" : "pending",
      }));
    } finally {
      database.close();
    }
  });

  it("lets heartbeat, finalize, reconcile, or control win one terminal CAS with durable receipt and late no-op", () => {
    const database = openDatabase(databasePath);
    try {
      const finalizeCase = createPendingAction(database, 10);
      const finalizeLease = acquire(database, finalizeCase.operationId);
      const finalBody = { outcome: "finalized" };
      expect(actions.finalizeExecutionAction(database, {
        actionId: finalizeCase.actionId,
        body: finalBody,
        httpStatus: 200,
        leaseToken: finalizeLease.leaseToken!,
        projectId: PROJECT_ID,
        result: { code: "OK" },
        status: "succeeded",
      })).toEqual({ affectedRows: 1 });
      expect(actions.reconcileExecutionAction(database, {
        actionId: finalizeCase.actionId,
        body: { outcome: "late-reconcile" },
        errorCode: "ACTION_DEADLINE_EXCEEDED",
        httpStatus: 504,
        projectId: PROJECT_ID,
      })).toEqual({ affectedRows: 0 });
      expect(actions.heartbeatExecutionAction(database, {
        actionId: finalizeCase.actionId,
        leaseToken: finalizeLease.leaseToken!,
        projectId: PROJECT_ID,
      })).toEqual({ affectedRows: 0 });
      expect(database.prepare(`
        SELECT status,http_status AS httpStatus,response_json AS responseJson
        FROM execution_operations WHERE id=?
      `).get(finalizeCase.operationId)).toEqual({
        httpStatus: 200,
        responseJson: JSON.stringify(finalBody),
        status: "completed",
      });

      database.prepare("UPDATE executions SET status='queued' WHERE id=?").run(EXECUTION_ID);
      const reconcileCase = createPendingAction(database, 11);
      const reconcileLease = acquire(database, reconcileCase.operationId);
      database.prepare(`
        UPDATE execution_actions
        SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second')
        WHERE id=?
      `).run(reconcileCase.actionId);
      const interruptedBody = { outcome: "interrupted" };
      expect(actions.reconcileExecutionAction(database, {
        actionId: reconcileCase.actionId,
        body: interruptedBody,
        errorCode: "ACTION_LEASE_EXPIRED",
        httpStatus: 409,
        projectId: PROJECT_ID,
      })).toEqual({ affectedRows: 1 });
      expect(actions.finalizeExecutionAction(database, {
        actionId: reconcileCase.actionId,
        body: { outcome: "late-finalize" },
        httpStatus: 200,
        leaseToken: reconcileLease.leaseToken!,
        projectId: PROJECT_ID,
        result: { code: "LATE" },
        status: "succeeded",
      })).toEqual({ affectedRows: 0 });
      expect(database.prepare(`
        SELECT status,http_status AS httpStatus,response_json AS responseJson
        FROM execution_operations WHERE id=?
      `).get(reconcileCase.operationId)).toEqual({
        httpStatus: 409,
        responseJson: JSON.stringify(interruptedBody),
        status: "completed",
      });

      database.prepare("UPDATE executions SET status='queued' WHERE id=?").run(EXECUTION_ID);
      const controlCase = createPendingAction(database, 12);
      const controlLease = acquire(database, controlCase.operationId);
      const discardedBody = { outcome: "discarded" };
      expect(actions.discardExecutionAction(database, {
        actionId: controlCase.actionId,
        body: discardedBody,
        httpStatus: 200,
        projectId: PROJECT_ID,
      })).toEqual({ affectedRows: 1 });
      expect(actions.finalizeExecutionAction(database, {
        actionId: controlCase.actionId,
        body: { outcome: "late-control-finalize" },
        httpStatus: 200,
        leaseToken: controlLease.leaseToken!,
        projectId: PROJECT_ID,
        result: { code: "LATE" },
        status: "succeeded",
      })).toEqual({ affectedRows: 0 });
      expect(readAction(database, controlCase.actionId)).toEqual(expect.objectContaining({
        leaseExpiresAt: null,
        leaseToken: null,
        status: "discarded",
      }));
    } finally {
      database.close();
    }
  });

  it("ignores caller-skew fields and uses only SQLite time", () => {
    const database = openDatabase(databasePath);
    try {
      const created = createPendingAction(database, 20, "+121 seconds");
      const before = database.prepare(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now",
      ).get() as { now: string };
      const lease = acquire(database, created.operationId);
      const after = database.prepare(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now",
      ).get() as { now: string };
      expect(lease.affectedRows).toBe(1);
      const row = readAction(database, created.actionId) as {
        lastHeartbeatAt: string;
        leaseExpiresAt: string;
      };
      expect(row.lastHeartbeatAt >= before.now).toBe(true);
      expect(row.lastHeartbeatAt <= after.now).toBe(true);
      expect(row.lastHeartbeatAt).not.toBe(NOW);
      expect(Date.parse(row.leaseExpiresAt) - Date.parse(row.lastHeartbeatAt)).toBe(120_000);
    } finally {
      database.close();
    }
  });
});
