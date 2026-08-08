import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import { execV7Fixture } from "@/tests/v7-fixture-graph";
import { refreshExecutionFrozenFixture } from "./execution-frozen-fixture";

type AdvanceModule = {
  advanceExecution(
    databasePath: string,
    executionId: string,
    input: unknown,
    dependencies: { fileAdapter: object },
  ): Promise<{ body: Record<string, unknown>; status: number }>;
};

const PROJECT_ID = "budget-project";
const EXECUTION_ID = "budget-execution";
const SECOND_EXECUTION_ID = "budget-execution-b";
const HASH = "a".repeat(64);
const MASTER_KEY = Buffer.alloc(32, 37).toString("base64url");
const operationId = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

let directory: string;
let databasePath: string;
let database: DatabaseSync;
let advance: AdvanceModule;

function insertExecution(
  executionId: string,
  agentId: string,
  workItemId: string,
  attemptId: string,
): void {
  database.prepare(`
    INSERT INTO executions (
      id,project_id,source_collaboration_run_id,source_collaboration_thread_id,
      mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES (?,?,'run',(
      SELECT thread_id FROM collaboration_runs WHERE project_id=? AND id='run'
    ),'mission',?,?, 'policy','queued',NULL,NULL,0,NULL,1,0,0,1,1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL)
  `).run(executionId, PROJECT_ID, PROJECT_ID, workItemId, agentId);
  database.prepare(`
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES (?, ?, ?, 1, 'ready', 'verified://sandbox', NULL, ?, ?, '{}', ?, ?,
      'policy',1,'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL)
  `).run(attemptId, PROJECT_ID, executionId, HASH, HASH, "{}", HASH);
  refreshExecutionFrozenFixture(database, executionId);
}

function seed(): void {
  const credential = createCredentialVault().encrypt("provider", "provider-secret");
  execV7Fixture(databasePath, database, `
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Budget',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      'D:\\canonical','d:/canonical',1);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES ('provider','Provider','https://provider.example/v1','model',
      '${credential.apiKeyCipher}','${credential.apiKeyIv}','${credential.apiKeyTag}',
      1,1,'${credential.keyId}','${credential.apiKeyMask}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES
      ('agent-a','Agent A','Builder','private','provider','model','A','sage',
       1,1,1,25,5,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ('agent-b','Agent B','Builder','private','provider','model','B','amber',
       1,1,1,25,5,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO project_memberships (project_id,agent_id,joined_at) VALUES
      ('${PROJECT_ID}','agent-a',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ('${PROJECT_ID}','agent-b',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','${PROJECT_ID}','Mission','Ship',1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES
      ('work-a','mission','Work A','','in_progress','agent-a',1,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ('work-b','mission','Work B','','in_progress','agent-b',1,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO collaboration_runs (
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES ('run','${PROJECT_ID}','planned','agent-a',1,1,1,1,NULL,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO collaboration_operations (
      id,project_id,run_id,kind,request_hash,status,http_status,response_json,created_at,updated_at
    ) VALUES ('s4-op','${PROJECT_ID}','run','advance','${HASH}','completed',200,'{}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO collaboration_attempts (
      id,project_id,run_id,agent_id,operation_id,status,lease_token,lease_expires_at,
      prompt_hash,acquire_execution_epoch,acquire_context_hash,included_message_sequence,
      error_category,started_at,finished_at
    ) VALUES ('s4-attempt','${PROJECT_ID}','run','agent-a','s4-op','committed','lease',
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds'),'${HASH}',1,'${HASH}',0,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO collaboration_model_calls (
      id,attempt_id,kind,call_index,status,prompt_tokens,completion_tokens,total_tokens,
      error_category,created_at
    ) VALUES ('s4-call','s4-attempt','primary',1,'succeeded',6,4,10,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES ('policy','${PROJECT_ID}',NULL,'system',1,
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      1,0,2,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
    VALUES ('${PROJECT_ID}','policy',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  `);
  insertExecution(EXECUTION_ID, "agent-a", "work-a", "attempt-a");
  insertExecution(SECOND_EXECUTION_ID, "agent-b", "work-b", "attempt-b");
}

function response(content: string, usage: unknown, status = 200): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage,
  }), { headers: { "content-type": "application/json" }, status });
}

function action(type: "list" | "staged" = "list"): string {
  return JSON.stringify({
    action: type === "list" ? { path: ".", type: "list" } : { type: "staged" },
    summary: "Visible summary",
  });
}

async function run(executionId: string, version: number, operation: number) {
  return advance.advanceExecution(
    databasePath,
    executionId,
    { expectedVersion: version, operationId: operationId(operation) },
    { fileAdapter: {} },
  );
}

beforeEach(async () => {
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  directory = mkdtempSync(join(tmpdir(), "cool-ai-usage-budget-"));
  databasePath = join(directory, "cockpit.sqlite");
  database = openDatabase(databasePath);
  seed();
  const modules = import.meta.glob<AdvanceModule>(
    "../src/server/execution/action-orchestrator.ts",
  );
  advance = await modules["../src/server/execution/action-orchestrator.ts"]();
});

afterEach(() => {
  vi.unstubAllGlobals();
  database.close();
  rmSync(directory, { force: true, recursive: true });
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("shared execution usage and business budgets", () => {
  it("aggregates S-4 primary plus S-5 primary/repair and pauses after crossing without a tool", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response('{"summary":"invalid"}', {
        completion_tokens: 2,
        prompt_tokens: 5,
        total_tokens: 7,
      }))
      .mockResolvedValueOnce(response(action(), {
        completion_tokens: 4,
        prompt_tokens: 11,
        total_tokens: 15,
      })));

    const result = await run(EXECUTION_ID, 1, 1);
    expect(result.status).toBe(409);
    expect(database.prepare(`
      SELECT status,reason_code AS reasonCode,business_round_count AS rounds
      FROM executions WHERE id=?
    `).get(EXECUTION_ID)).toEqual({
      reasonCode: "TOKEN_BUDGET_EXCEEDED",
      rounds: 1,
      status: "paused",
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count,SUM(total_tokens) AS tokens
      FROM execution_model_calls WHERE execution_id=?
    `).get(EXECUTION_ID)).toEqual({ count: 2, tokens: 22 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM execution_tool_calls").get())
      .toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM execution_events
      WHERE execution_id=? AND type='boundary_paused'
    `).get(EXECUTION_ID)).toEqual({ count: 1 });
  });

  it("does no HTTP or action when trusted same-Agent usage is already at max", async () => {
    database.prepare("UPDATE agents SET max_tokens=10 WHERE id='agent-a'").run();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await run(EXECUTION_ID, 1, 2);
    expect(result.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM execution_actions").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT status,reason_code AS reasonCode FROM executions WHERE id=?")
      .get(EXECUTION_ID)).toEqual({
      reasonCode: "TOKEN_BUDGET_EXCEEDED",
      status: "paused",
    });
  });

  it("counts valid provider-failure usage and keeps it across retry", async () => {
    database.prepare("UPDATE agents SET max_tokens=15 WHERE id='agent-a'").run();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("", {
      completion_tokens: 2,
      prompt_tokens: 3,
      total_tokens: 5,
    }, 429)));

    const failed = await run(EXECUTION_ID, 1, 3);
    expect(failed.status).toBe(502);
    expect(database.prepare(`
      SELECT status,total_tokens AS totalTokens FROM execution_model_calls
      WHERE execution_id=?
    `).get(EXECUTION_ID)).toEqual({ status: "provider_failed", totalTokens: 5 });

    database.prepare(`
      UPDATE executions SET status='queued',resume_target=NULL,reason_code=NULL,version=20
      WHERE id=?
    `).run(EXECUTION_ID);
    const retryFetch = vi.fn();
    vi.stubGlobal("fetch", retryFetch);
    await run(EXECUTION_ID, 20, 4);
    expect(retryFetch).not.toHaveBeenCalled();
    expect(database.prepare("SELECT status,reason_code AS reasonCode FROM executions WHERE id=?")
      .get(EXECUTION_ID)).toEqual({
      reasonCode: "TOKEN_BUDGET_EXCEEDED",
      status: "paused",
    });
  });

  it("pauses with no requested action for missing, negative, noninteger, and inconsistent usage", async () => {
    for (const [index, usage] of [
      [10, undefined],
      [11, { completion_tokens: 1, prompt_tokens: -1, total_tokens: 0 }],
      [12, { completion_tokens: 1, prompt_tokens: 1.5, total_tokens: 2.5 }],
      [13, { completion_tokens: 1, prompt_tokens: 1, total_tokens: 3 }],
    ] as const) {
      database.prepare(`
        UPDATE executions SET status='queued',resume_target=NULL,reason_code=NULL,version=?
        WHERE id=?
      `).run(index, EXECUTION_ID);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(action(), usage)));
      const result = await run(EXECUTION_ID, index, index);
      expect(result.status).toBe(502);
      expect(database.prepare("SELECT status,reason_code AS reasonCode FROM executions WHERE id=?")
        .get(EXECUTION_ID)).toEqual({
        reasonCode: "USAGE_INVALID",
        status: "paused",
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM execution_tool_calls").get())
        .toEqual({ count: 0 });
      database.prepare("DELETE FROM execution_model_calls WHERE execution_id=?")
        .run(EXECUTION_ID);
      database.prepare("DELETE FROM execution_actions WHERE execution_id=?")
        .run(EXECUTION_ID);
      database.prepare("DELETE FROM execution_operations WHERE execution_id=?")
        .run(EXECUTION_ID);
      database.prepare(`
        UPDATE execution_attempts SET status='ready' WHERE execution_id=?
      `).run(EXECUTION_ID);
    }
  });

  it("enforces exact round, tool, and wall-clock prechecks while keeping Agents independent", async () => {
    database.prepare(`
      UPDATE executions SET business_round_count=20 WHERE id=?
    `).run(EXECUTION_ID);
    const fetchMock = vi.fn().mockResolvedValue(response(action(), {
      completion_tokens: 1,
      prompt_tokens: 1,
      total_tokens: 2,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await run(EXECUTION_ID, 1, 20);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.prepare("SELECT reason_code AS reasonCode FROM executions WHERE id=?")
      .get(EXECUTION_ID)).toEqual({ reasonCode: "BUSINESS_ROUND_LIMIT" });

    const other = await run(SECOND_EXECUTION_ID, 1, 21);
    expect(other.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const otherVersion = (database.prepare(`
      SELECT version FROM executions WHERE id=?
    `).get(SECOND_EXECUTION_ID) as { version: number }).version;
    database.prepare("UPDATE executions SET tool_call_count=40 WHERE id=?")
      .run(SECOND_EXECUTION_ID);
    await run(SECOND_EXECUTION_ID, otherVersion, 211);
    expect(database.prepare("SELECT reason_code AS reasonCode FROM executions WHERE id=?")
      .get(SECOND_EXECUTION_ID)).toEqual({ reasonCode: "TOOL_CALL_LIMIT" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM execution_actions WHERE execution_id=?
    `).get(SECOND_EXECUTION_ID)).toEqual({ count: 1 });

    database.prepare(`
      UPDATE executions SET status='running',reason_code=NULL,resume_target=NULL,
        tool_call_count=40,business_round_count=1,version=50,
        first_running_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-900 seconds'),
        business_deadline_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?
    `).run(EXECUTION_ID);
    await run(EXECUTION_ID, 50, 22);
    expect(database.prepare("SELECT reason_code AS reasonCode FROM executions WHERE id=?")
      .get(EXECUTION_ID)).toEqual({ reasonCode: "EXECUTION_TIME_LIMIT" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM execution_actions WHERE execution_id=?
    `).get(EXECUTION_ID)).toEqual({ count: 0 });
  });
});
