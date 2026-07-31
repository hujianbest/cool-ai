import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import {
  captureExecutionFrozenInput,
  staleExecutionIfFrozenInputChanged,
} from "@/src/server/execution/execution-frozen-input";

type AdvanceModule = {
  advanceExecution(
    databasePath: string,
    executionId: string,
    input: unknown,
    dependencies: { fileAdapter: object },
  ): Promise<{ body: Record<string, unknown>; status: number }>;
};

const PROJECT_ID = "stale-project";
const EXECUTION_ID = "stale-execution";
const ATTEMPT_ID = "stale-attempt";
const HASH = "a".repeat(64);
const POLICY_HASH = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const MASTER_KEY = Buffer.alloc(32, 53).toString("base64url");
const operationId = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

let directory: string;
let databasePath: string;
let database: DatabaseSync;
let advance: AdvanceModule;

function providerResponse(type: "list" | "staged" = "list"): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          action: type === "list" ? { path: ".", type: "list" } : { type: "staged" },
          summary: "Visible summary",
        }),
      },
    }],
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
  }), { headers: { "content-type": "application/json" }, status: 200 });
}

function rotateCredential(secret: string): void {
  const credential = createCredentialVault().encrypt("provider", secret);
  database.prepare(`
    UPDATE providers
    SET api_key_cipher=?,api_key_iv=?,api_key_tag=?,key_id=?,api_key_mask=?,
        credential_generation=credential_generation+1,
        verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id='provider'
  `).run(
    credential.apiKeyCipher,
    credential.apiKeyIv,
    credential.apiKeyTag,
    credential.keyId,
    credential.apiKeyMask,
  );
}

function seed(): void {
  const credential = createCredentialVault().encrypt("provider", "first-provider-key");
  database.prepare(`
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES (?, 'Stale', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      'D:\\canonical', 'd:/canonical', 1)
  `).run(PROJECT_ID);
  database.prepare(`
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'provider','Provider','https://provider.example/v1','model',?,?,?,1,1,?,?,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    )
  `).run(
    credential.apiKeyCipher,
    credential.apiKeyIv,
    credential.apiKeyTag,
    credential.keyId,
    credential.apiKeyMask,
  );
  database.exec(`
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES (
      'agent','Agent','Builder','private','provider','model','A','sage',
      1,1,1,100000,5,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now')
    );
    INSERT INTO project_memberships (project_id,agent_id,joined_at)
    VALUES ('${PROJECT_ID}','agent',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','${PROJECT_ID}','Mission','Ship',1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES (
      'work','mission','Original title','Original description','in_progress','agent',1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    );
    INSERT INTO collaboration_runs (
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES ('run','${PROJECT_ID}','planned','agent',1,1,1,1,NULL,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES ('policy','${PROJECT_ID}',NULL,'system',1,'${POLICY_HASH}',1,0,2,0,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
    VALUES ('${PROJECT_ID}','policy',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  `);
  const frozen = captureExecutionFrozenInput(database, {
    agentId: "agent",
    baselineManifestHash: HASH,
    missionId: "mission",
    projectId: PROJECT_ID,
    sourceCollaborationRunId: "run",
    workItemId: "work",
  });
  database.prepare(`
    INSERT INTO executions (
      id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES (
      ?,?,'run','mission','work','agent','policy','queued',NULL,NULL,0,NULL,1,0,0,1,1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL
    )
  `).run(EXECUTION_ID, PROJECT_ID);
  database.prepare(`
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES (
      ?,?,?,1,'ready','verified://sandbox',NULL,?,?,?,?,?,
      'policy',1,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL
    )
  `).run(
    ATTEMPT_ID,
    PROJECT_ID,
    EXECUTION_ID,
    HASH,
    HASH,
    JSON.stringify(frozen.publicEnvelope),
    JSON.stringify(frozen.privateEnvelope),
    frozen.contextHash,
    POLICY_HASH,
  );
}

beforeEach(async () => {
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  directory = mkdtempSync(join(tmpdir(), "cool-ai-stale-context-"));
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

describe("execution frozen-input staleness", () => {
  it("atomically stales before a model action when task input changes", async () => {
    database.prepare(`
      UPDATE work_items SET title='Changed title',version=version+1 WHERE id='work'
    `).run();
    const fetchMock = vi.fn().mockResolvedValue(providerResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 1, operationId: operationId(1) },
      { fileAdapter: {} },
    );

    expect(result.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.prepare(`
      SELECT status,reason_code AS reasonCode FROM executions WHERE id=?
    `).get(EXECUTION_ID)).toEqual({
      reasonCode: "STALE_EXECUTION",
      status: "stale",
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM execution_actions WHERE execution_id=?
    `).get(EXECUTION_ID)).toEqual({ count: 0 });
  });

  it.each([
    ["dependencies", () => database.exec(`
      INSERT INTO work_items (
        id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
      ) VALUES ('dependency','mission','Dependency','Required','done','agent',1,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT INTO work_item_dependencies (work_item_id,depends_on_id)
      VALUES ('work','dependency');
    `)],
    ["mission", () => database.prepare(
      "UPDATE missions SET goal='Changed goal',version=version+1 WHERE id='mission'",
    ).run()],
    ["shared memory", () => database.exec(`
      INSERT INTO memory_entries (
        id,project_id,type,content,source_type,source_ref,created_by,supersedes_id,created_at
      ) VALUES ('memory','${PROJECT_ID}','decision','Use strict mode','owner_input',
        'owner','owner',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `)],
    ["project members", () => database.exec(`
      INSERT INTO agents (
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
      ) VALUES ('other','Other','Reviewer','other-private','provider','model','O','amber',
        1,0,0,1000,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT INTO project_memberships (project_id,agent_id,joined_at)
      VALUES ('${PROJECT_ID}','other',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `)],
    ["Agent identity, prompt, and permissions", () => database.prepare(`
      UPDATE agents SET name='Changed Agent',system_prompt='changed-private',
        can_write=0,version=version+1 WHERE id='agent'
    `).run()],
    ["ordered skill contents", () => database.exec(`
      INSERT INTO skills (id,name,description,instructions,version,created_at,updated_at)
      VALUES ('skill','Skill','Description','Changed instructions',1,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT INTO agent_skills (agent_id,skill_id,position) VALUES ('agent','skill',0);
    `)],
    ["provider endpoint", () => database.prepare(
      "UPDATE providers SET base_url='https://other.example/v1' WHERE id='provider'",
    ).run()],
    ["provider model", () => database.prepare(
      "UPDATE agents SET model='other-model',version=version+1 WHERE id='agent'",
    ).run()],
    ["validation policy revision", () => database.prepare(`
      UPDATE project_validation_policies SET version=version+1 WHERE project_id=?
    `).run(PROJECT_ID)],
    ["workspace baseline", () => database.prepare(`
      UPDATE execution_attempts SET baseline_manifest_hash=? WHERE id=?
    `).run("b".repeat(64), ATTEMPT_ID)],
  ])("stales when %s changes", (_label, mutate) => {
    mutate();
    const result = staleExecutionIfFrozenInputChanged(database, EXECUTION_ID);
    expect(result.disposition).toBe("stale");
    expect(database.prepare("SELECT status FROM executions WHERE id=?").get(EXECUTION_ID))
      .toEqual({ status: "stale" });
  });

  it("ignores pure credential rotation and acquires the latest verified key", async () => {
    rotateCredential("second-provider-key");
    const fetchMock = vi.fn().mockResolvedValue(providerResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 1, operationId: operationId(20) },
      { fileAdapter: {} },
    );

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer second-provider-key",
    });
  });

  it("atomically completes the frozen workspace baseline before the first action", () => {
    const preSandbox = captureExecutionFrozenInput(database, {
      agentId: "agent",
      baselineManifestHash: null,
      missionId: "mission",
      projectId: PROJECT_ID,
      sourceCollaborationRunId: "run",
      workItemId: "work",
    });
    database.prepare(`
      UPDATE execution_attempts
      SET frozen_public_json=?,frozen_private_json=?,frozen_context_hash=?
      WHERE id=?
    `).run(
      JSON.stringify(preSandbox.publicEnvelope),
      JSON.stringify(preSandbox.privateEnvelope),
      preSandbox.contextHash,
      ATTEMPT_ID,
    );

    const result = staleExecutionIfFrozenInputChanged(database, EXECUTION_ID);
    expect(result.disposition).toBe("current");
    expect(result.frozenHash).not.toBe(preSandbox.contextHash);
    const stored = database.prepare(`
      SELECT frozen_public_json AS publicJson,frozen_context_hash AS contextHash
      FROM execution_attempts WHERE id=?
    `).get(ATTEMPT_ID) as { contextHash: string; publicJson: string };
    expect(stored.contextHash).toBe(result.frozenHash);
    expect(JSON.parse(stored.publicJson).facts.workspaceBaselineHash).toBe(HASH);
  });

  it("pauses without creating an action when the current credential is unavailable", async () => {
    database.prepare("UPDATE providers SET api_key_cipher='not-valid' WHERE id='provider'").run();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 1, operationId: operationId(21) },
      { fileAdapter: {} },
    );

    expect(result.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.prepare(`
      SELECT status,reason_code AS reasonCode FROM executions WHERE id=?
    `).get(EXECUTION_ID)).toEqual({
      reasonCode: "CREDENTIAL_UNAVAILABLE",
      status: "paused",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM execution_actions").get())
      .toEqual({ count: 0 });
  });

  it("keeps an acquired key in flight and discards a late result after noncredential change", async () => {
    let release!: () => void;
    let observedAuthorization = "";
    vi.stubGlobal("fetch", vi.fn((_url: string, request: RequestInit) => {
      observedAuthorization = String((request.headers as Record<string, string>).Authorization);
      return new Promise<Response>((resolve) => {
        release = () => resolve(providerResponse());
      });
    }));
    const pending = advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 1, operationId: operationId(22) },
      { fileAdapter: {} },
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    rotateCredential("second-provider-key");
    database.prepare("UPDATE agents SET system_prompt='changed' WHERE id='agent'").run();
    release();

    const result = await pending;
    expect(observedAuthorization).toBe("Bearer first-provider-key");
    expect(result.status).toBe(409);
    expect(database.prepare(`
      SELECT status,result_json AS resultJson FROM execution_actions WHERE operation_id=?
    `).get(operationId(22))).toEqual({ resultJson: null, status: "discarded" });
    expect(database.prepare(`
      SELECT status,total_tokens AS totalTokens FROM execution_model_calls
    `).get()).toEqual({ status: "discarded", totalTokens: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM execution_tool_calls").get())
      .toEqual({ count: 0 });
  });

  it("expires unused approvals while retaining prior usage and tool previews read-only", () => {
    database.exec(`
      UPDATE executions SET status='waiting_approval' WHERE id='${EXECUTION_ID}';
      INSERT INTO execution_tool_calls (
        id,project_id,execution_id,attempt_id,action_id,business_round,type,
        request_hash,status,public_request_json,public_result_json,
        before_sandbox_hash,after_sandbox_hash,started_at,finished_at
      ) VALUES (
        'requested','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',NULL,1,'command',
        '${HASH}','waiting_approval','{}',NULL,NULL,NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL
      );
      INSERT INTO execution_approvals (
        id,project_id,execution_id,attempt_id,tool_call_id,kind,status,
        request_hash,input_hash,staged_hash,public_request_json,
        decided_at,consumed_at,created_at
      ) VALUES (
        'approval','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}','requested',
        'command','approved','${HASH}','${HASH}',NULL,'{}',
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now')
      );
      INSERT INTO execution_tool_calls (
        id,project_id,execution_id,attempt_id,action_id,business_round,type,
        request_hash,status,public_request_json,public_result_json,
        before_sandbox_hash,after_sandbox_hash,started_at,finished_at
      ) VALUES (
        'preview','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',NULL,2,'command',
        '${HASH}','succeeded','{}','{"code":null,"stdout":"preview"}',NULL,NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
      );
      UPDATE missions SET goal='changed',version=version+1 WHERE id='mission';
    `);

    const result = staleExecutionIfFrozenInputChanged(database, EXECUTION_ID);
    expect(result.disposition).toBe("stale");
    expect(database.prepare("SELECT status FROM execution_approvals WHERE id='approval'").get())
      .toEqual({ status: "expired" });
    expect(database.prepare("SELECT status FROM execution_tool_calls WHERE id='requested'").get())
      .toEqual({ status: "discarded" });
    expect(database.prepare(`
      SELECT status,public_result_json AS resultJson FROM execution_tool_calls WHERE id='preview'
    `).get()).toEqual({
      resultJson: '{"code":null,"stdout":"preview"}',
      status: "succeeded",
    });
  });

  it("checks frozen input before a staged action and exposes the same merge boundary", async () => {
    database.exec(`
      INSERT INTO execution_operations (
        id,project_id,execution_id,kind,request_hash,has_external_actions,
        action_count,final_action_index,status,http_status,response_json,created_at,updated_at
      ) VALUES (
        '${operationId(30)}','${PROJECT_ID}','${EXECUTION_ID}','advance','${HASH}',
        1,1,0,'completed',200,'{}',
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
      );
      INSERT INTO execution_actions (
        id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
        request_hash,lease_token,lease_expires_at,overall_deadline_at,last_heartbeat_at,
        result_json,error_code,created_at,started_at,finished_at
      ) VALUES (
        'model-staged','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',
        '${operationId(30)}',0,'model','succeeded','${HASH}',NULL,NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now','+900 seconds'),NULL,
        '{"nextAction":{"type":"staged"},"summary":"stage"}',NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now')
      );
      UPDATE missions SET title='Changed before stage',version=version+1 WHERE id='mission';
    `);
    const stage = await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 1, operationId: operationId(31) },
      { fileAdapter: {} },
    );
    expect(stage.status).toBe(409);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM execution_actions WHERE kind='stage_compute'
    `).get()).toEqual({ count: 0 });

    database.prepare(`
      UPDATE executions SET status='staged',reason_code=NULL,version=version+1 WHERE id=?
    `).run(EXECUTION_ID);
    const mergeBoundary = staleExecutionIfFrozenInputChanged(database, EXECUTION_ID);
    expect(mergeBoundary.disposition).toBe("stale");
    expect(database.prepare("SELECT status FROM executions WHERE id=?").get(EXECUTION_ID))
      .toEqual({ status: "stale" });
  });
});
