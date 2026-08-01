import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createV6FixtureDatabaseOpener } from "@/tests/v6-fixture-db";

const openDatabase = createV6FixtureDatabaseOpener({
  missingDeliveryHeadMissionIds: ["mission", "other-mission"],
  missingReviewHeadResultIds: [],
});
import {
  controlExecution,
  type ExecutionControlDependencies,
} from "@/src/server/execution/execution-control-service";

const PROJECT_ID = "control-project";
const OTHER_PROJECT_ID = "control-project-other";
const EXECUTION_ID = "control-execution";
const OTHER_EXECUTION_ID = "control-execution-other";
const ATTEMPT_ID = "control-attempt";
const HASH = "a".repeat(64);
const POLICY_HASH =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const NOW = "2026-07-30T07:00:00.000Z";

const operationId = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

let directory: string;
let databasePath: string;
let database: DatabaseSync;
let terminate: ReturnType<typeof vi.fn<(actionId: string) => boolean>>;
let sandboxInputs: Array<Record<string, string>>;
let dependencies: ExecutionControlDependencies;

function seed(): void {
  database.exec(`
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES
      ('${PROJECT_ID}','Controls','${NOW}','D:\\canonical','d:/canonical',1),
      ('${OTHER_PROJECT_ID}','Other','${NOW}','D:\\other','d:/other',1);
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
    ) VALUES
      ('agent','Agent','Builder','private','provider','model','A','sage',
       1,1,1,1000,5,1,'${NOW}','${NOW}'),
      ('other-agent','Other','Builder','private','provider','model','O','blue',
       1,1,1,1000,5,1,'${NOW}','${NOW}');
    INSERT INTO project_memberships (project_id,agent_id,joined_at)
    VALUES
      ('${PROJECT_ID}','agent','${NOW}'),
      ('${OTHER_PROJECT_ID}','other-agent','${NOW}');
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES
      ('mission','${PROJECT_ID}','Mission','Goal',1,'${NOW}','${NOW}'),
      ('other-mission','${OTHER_PROJECT_ID}','Other','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES
      ('work','mission','Work','','in_progress','agent',1,'${NOW}','${NOW}'),
      ('other-work','other-mission','Other work','','in_progress','other-agent',1,'${NOW}','${NOW}');
    INSERT INTO collaboration_runs (
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES
      ('run','${PROJECT_ID}','planned','agent',1,1,1,1,NULL,NULL,'${NOW}','${NOW}'),
      ('other-run','${OTHER_PROJECT_ID}','planned','other-agent',1,1,1,1,NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES
      ('policy','${PROJECT_ID}',NULL,'system',1,'${POLICY_HASH}',1,0,2,0,'${NOW}'),
      ('other-policy','${OTHER_PROJECT_ID}',NULL,'system',1,'${POLICY_HASH}',1,0,2,0,'${NOW}');
    INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
    VALUES
      ('${PROJECT_ID}','policy',1,'${NOW}'),
      ('${OTHER_PROJECT_ID}','other-policy',1,'${NOW}');
    INSERT INTO executions (
      id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES
      ('${EXECUTION_ID}','${PROJECT_ID}','run','mission','work','agent','policy',
       'running',NULL,NULL,0,NULL,1,3,4,1,1,'${NOW}',
       '2099-07-30T07:15:00.000Z','2099-07-30T07:00:00.000Z','${NOW}',NULL),
      ('${OTHER_EXECUTION_ID}','${OTHER_PROJECT_ID}','other-run','other-mission',
       'other-work','other-agent','other-policy','running',NULL,NULL,0,NULL,1,0,0,1,1,
       '${NOW}','2099-07-30T07:15:00.000Z','2099-07-30T07:00:00.000Z','${NOW}',NULL);
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES
      ('${ATTEMPT_ID}','${PROJECT_ID}','${EXECUTION_ID}',1,'ready','D:\\sandbox',
       NULL,'${HASH}','${HASH}','{}','{}','${HASH}','policy',1,'${POLICY_HASH}','${NOW}',NULL),
      ('other-attempt','${OTHER_PROJECT_ID}','${OTHER_EXECUTION_ID}',1,'ready','D:\\other-sandbox',
       NULL,'${HASH}','${HASH}','{}','{}','${HASH}','other-policy',1,'${POLICY_HASH}','${NOW}',NULL);
  `);
}

function setExecution(
  status: string,
  resumeTarget: string | null = null,
  reasonCode: string | null = null,
): number {
  database.prepare(`
    UPDATE executions SET status=?,resume_target=?,reason_code=?,
      merged_at=CASE WHEN ?='merged' THEN '${NOW}' ELSE NULL END,
      version=version+1
    WHERE id=?
  `).run(status, resumeTarget, reasonCode, status, EXECUTION_ID);
  return (database.prepare("SELECT version FROM executions WHERE id=?")
    .get(EXECUTION_ID) as { version: number }).version;
}

function row(
  table: string,
  where: string,
  ...args: Array<string | number | null | Uint8Array>
): Record<string, unknown> {
  return database.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...args) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cool-ai-execution-controls-"));
  databasePath = join(directory, "cockpit.sqlite");
  database = openDatabase(databasePath);
  seed();
  terminate = vi.fn<(actionId: string) => boolean>(() => true);
  sandboxInputs = [];
  dependencies = {
    executionRoot: join(directory, "executions"),
    requestProcessTermination: terminate,
    sandboxExecutor: (input) => {
      sandboxInputs.push(input);
      return new Promise<never>(() => undefined);
    },
  };
});

afterEach(() => {
  database.close();
  rmSync(directory, { force: true, recursive: true });
});

describe("execution lifecycle controls", () => {
  it.each([
    ["queued", "queued"],
    ["running", "running"],
    ["waiting_approval", "waiting_approval"],
  ])("pauses %s with its exact resume target", async (status, target) => {
    const version = setExecution(status);
    const result = controlExecution(databasePath, EXECUTION_ID, {
      action: "pause",
      expectedVersion: version,
      operationId: operationId(version),
    }, dependencies);

    await expect(result).resolves.toMatchObject({
      body: { execution: { status: "paused", resumeTarget: target } },
      status: 200,
    });
  });

  it("discards an in-flight action, requests command termination, and fences late results", async () => {
    database.exec(`
      INSERT INTO execution_operations (
        id,project_id,execution_id,kind,request_hash,has_external_actions,
        action_count,final_action_index,status,http_status,response_json,created_at,updated_at
      ) VALUES (
        '${operationId(50)}','${PROJECT_ID}','${EXECUTION_ID}','advance','${HASH}',1,
        1,NULL,'pending',NULL,NULL,'${NOW}','${NOW}'
      );
      INSERT INTO execution_actions (
        id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
        request_hash,lease_token,lease_expires_at,overall_deadline_at,last_heartbeat_at,
        result_json,error_code,created_at,started_at,finished_at
      ) VALUES (
        'command-action','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',
        '${operationId(50)}',0,'command','running','${HASH}','lease',
        '2099-07-30T07:02:00.000Z','2099-07-30T07:02:00.000Z','${NOW}',
        NULL,NULL,'${NOW}','${NOW}',NULL
      );
    `);
    const result = await controlExecution(databasePath, EXECUTION_ID, {
      action: "pause",
      expectedVersion: 1,
      operationId: operationId(1),
    }, dependencies);

    expect(terminate).toHaveBeenCalledWith("command-action");
    expect(row("execution_actions", "id=?", "command-action").status).toBe("discarded");
    expect(row("execution_operations", "id=?", operationId(50))).toMatchObject({
      status: "completed",
      http_status: 409,
    });
    expect(result.body.execution.status).toBe("paused");
  });

  it("continues only to the recorded target with target-specific preconditions", async () => {
    const runningVersion = setExecution("paused", "running", "OWNER_PAUSED");
    await expect(controlExecution(databasePath, EXECUTION_ID, {
      action: "continue",
      expectedVersion: runningVersion,
      operationId: operationId(10),
    }, dependencies)).resolves.toMatchObject({
      body: { execution: { status: "running", resumeTarget: null } },
    });

    const waitingVersion = setExecution("paused", "waiting_approval", "OWNER_PAUSED");
    await expect(controlExecution(databasePath, EXECUTION_ID, {
      action: "continue",
      expectedVersion: waitingVersion,
      operationId: operationId(11),
    }, dependencies)).rejects.toMatchObject({ code: "EXECUTION_STATE_CONFLICT" });
  });

  it("retries stale execution as a new attempt and sandbox without resetting history or deadline", async () => {
    const oldDeadline = row("executions", "id=?", EXECUTION_ID).business_deadline_at;
    const version = setExecution("stale", null, "STALE_EXECUTION");
    const pending = controlExecution(databasePath, EXECUTION_ID, {
      action: "retry",
      expectedVersion: version,
      operationId: operationId(20),
    }, dependencies);
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(sandboxInputs).toHaveLength(1));

    expect(row("executions", "id=?", EXECUTION_ID)).toMatchObject({
      status: "queued",
      current_attempt_no: 2,
      business_round_count: 3,
      tool_call_count: 4,
      business_deadline_at: oldDeadline,
    });
    expect(row("execution_attempts", "execution_id=? AND attempt_no=1", EXECUTION_ID).status)
      .toBe("superseded");
    expect(row("execution_attempts", "execution_id=? AND attempt_no=2", EXECUTION_ID))
      .toMatchObject({ status: "preparing" });
    expect(sandboxInputs[0]?.sandboxRoot).toContain(join(EXECUTION_ID, "2", "sandbox"));
    expect(row("execution_operations", "id=?", operationId(20))).toMatchObject({
      kind: "retry",
      status: "pending",
    });
    void pending;
  });

  it("rejects retry when current eligibility, workspace, context, or budget preconditions fail", async () => {
    const version = setExecution("failed", null, "PROCESS_TERMINATION_UNCONFIRMED");
    database.prepare("UPDATE work_items SET assignee_agent_id=NULL WHERE id='work'").run();
    await expect(controlExecution(databasePath, EXECUTION_ID, {
      action: "retry",
      expectedVersion: version,
      operationId: operationId(21),
    }, dependencies)).rejects.toMatchObject({ code: "TASK_NOT_ELIGIBLE" });
    expect(row("executions", "id=?", EXECUTION_ID).current_attempt_no).toBe(1);
  });

  it("stops a single execution, expires approvals, and never mutates the other execution", async () => {
    database.exec(`
      INSERT INTO execution_tool_calls (
        id,project_id,execution_id,attempt_id,action_id,business_round,type,request_hash,
        status,public_request_json,public_result_json,before_sandbox_hash,after_sandbox_hash,
        started_at,finished_at
      ) VALUES (
        'tool','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',NULL,1,'command','${HASH}',
        'waiting_approval','{}',NULL,NULL,NULL,'${NOW}',NULL
      );
      INSERT INTO execution_approvals (
        id,project_id,execution_id,attempt_id,tool_call_id,kind,status,request_hash,
        input_hash,staged_hash,public_request_json,decided_at,consumed_at,created_at
      ) VALUES (
        'approval','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}','tool','command',
        'pending','${HASH}','${HASH}',NULL,'{}',NULL,NULL,'${NOW}'
      );
    `);
    await controlExecution(databasePath, EXECUTION_ID, {
      action: "stop",
      expectedVersion: 1,
      operationId: operationId(30),
    }, dependencies);

    expect(row("executions", "id=?", EXECUTION_ID).status).toBe("stopped");
    expect(row("execution_approvals", "id='approval'").status).toBe("expired");
    expect(row("executions", "id=?", OTHER_EXECUTION_ID)).toMatchObject({
      status: "running",
      version: 1,
    });
  });

  it.each(["stopped", "merged"])("keeps %s terminal", async (status) => {
    const version = setExecution(status);
    await expect(controlExecution(databasePath, EXECUTION_ID, {
      action: "continue",
      expectedVersion: version,
      operationId: operationId(31),
    }, dependencies)).rejects.toMatchObject({ code: "EXECUTION_STATE_CONFLICT" });
  });

  it("blocks every ordinary control while manual recovery is required", async () => {
    database.prepare(`
      UPDATE executions SET status='conflicted',manual_recovery_required=1,
        recovery_resolution=NULL,version=version+1 WHERE id=?
    `).run(EXECUTION_ID);
    const version = Number(row("executions", "id=?", EXECUTION_ID).version);
    for (const [index, action] of ["pause", "continue", "retry", "stop"].entries()) {
      await expect(controlExecution(databasePath, EXECUTION_ID, {
        action,
        expectedVersion: version,
        operationId: operationId(40 + index),
      }, dependencies)).rejects.toMatchObject({ code: "MANUAL_RECOVERY_REQUIRED" });
    }
  });

  it("durably replays the exact receipt and conflicts on reused operation content", async () => {
    const input = {
      action: "pause" as const,
      expectedVersion: 1,
      operationId: operationId(60),
    };
    const first = await controlExecution(databasePath, EXECUTION_ID, input, dependencies);
    const replay = await controlExecution(databasePath, EXECUTION_ID, input, dependencies);
    expect(replay).toEqual(first);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM execution_events
      WHERE execution_id=? AND type='control_applied'
    `).get(EXECUTION_ID)).toEqual({ count: 1 });
    await expect(controlExecution(databasePath, EXECUTION_ID, {
      ...input,
      action: "stop",
    }, dependencies)).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  });

  it("persists stale-version conflicts without overwriting newer owner actions", async () => {
    await expect(controlExecution(databasePath, EXECUTION_ID, {
      action: "pause",
      expectedVersion: 99,
      operationId: operationId(70),
    }, dependencies)).rejects.toMatchObject({ code: "EXECUTION_STATE_CONFLICT" });
    expect(row("execution_operations", "id=?", operationId(70))).toMatchObject({
      status: "completed",
      http_status: 409,
    });
    expect(row("executions", "id=?", EXECUTION_ID).status).toBe("running");
  });
});
