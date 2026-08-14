import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { declareStaged } from "@/src/adapters/outbound/sqlite/safe-execution/action-orchestrator";
import { ExecutionError } from "@/src/modules/safe-execution";
import { executeWriteToolAction } from "@/src/adapters/outbound/workspace/file-tools";
import { executeCommandProcessAction } from "@/src/adapters/outbound/workspace/process-runner";
import {
  createWindowsVerifiedExecutionAdapters,
  refreshSandboxManifest,
} from "@/src/adapters/outbound/workspace/windows-verified-execution-adapter";
import { execV7Fixture } from "@/tests/fixtures/execution/current-graph";

const PROJECT_ID = "manifest-project";
const EXECUTION_ID = "manifest-execution";
const ATTEMPT_ID = "manifest-attempt";
const POLICY_HASH =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const NOW = "2026-08-01T01:00:00.000Z";

let root: string;
let workspace: string;
let sandbox: string;
let baselinePath: string;
let currentPath: string;
let databasePath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cool-ai-write-stage-"));
  workspace = join(root, "workspace");
  sandbox = join(root, "sandbox");
  baselinePath = join(root, "baseline.json");
  currentPath = join(root, "current.json");
  databasePath = join(root, "cockpit.sqlite");
  mkdirSync(workspace);
  mkdirSync(sandbox);
  mkdirSync(join(workspace, "work"));
  mkdirSync(join(sandbox, "work"));
  writeFileSync(join(workspace, "README.md"), "before\n");
  writeFileSync(join(sandbox, "README.md"), "before\n");
});

afterEach(() => rmSync(root, { force: true, recursive: true }));

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function operationId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function seedDatabase(initialHash: string): DatabaseSync {
  const database = openDatabase(databasePath);
  execV7Fixture(databasePath, database, `
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Manifest','${NOW}','${workspace.replaceAll("'", "''")}',
      '${workspace.replaceAll("'", "''").toLocaleLowerCase("en-US")}',1);
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
      id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES ('${EXECUTION_ID}','${PROJECT_ID}','run','mission','work','agent','policy',
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
      '${sandbox.replaceAll("'", "''")}','${baselinePath.replaceAll("'", "''")}',
      '${currentPath.replaceAll("'", "''")}',
      '${initialHash}','${initialHash}','{}','{}','${"c".repeat(64)}',
      'policy',1,'${POLICY_HASH}','${NOW}',NULL);
  `);
  return database;
}

function seedWriteAction(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,
      action_count,final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES ('${operationId(41)}','${PROJECT_ID}','${EXECUTION_ID}','advance',
      '${"a".repeat(64)}',1,1,NULL,'pending',NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO execution_actions (
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,overall_deadline_at,created_at
    ) VALUES ('write-action','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',
      '${operationId(41)}',0,'file_write','pending','${"a".repeat(64)}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes'),'${NOW}');
  `);
}

function seedStagedDecision(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,
      action_count,final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES ('model-operation','${PROJECT_ID}','${EXECUTION_ID}','advance',
      '${"b".repeat(64)}',1,1,0,'completed',200,'{}','${NOW}','${NOW}');
    INSERT INTO execution_actions (
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,result_json,overall_deadline_at,created_at,started_at,finished_at
    ) VALUES ('model-action','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',
      'model-operation',0,'model','succeeded','${"b".repeat(64)}',
      '{"nextAction":{"type":"staged"},"summary":"ready"}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes'),'${NOW}','${NOW}','${NOW}');
  `);
}

function seedCommandAction(database: DatabaseSync, scriptPath: string, index: number): void {
  const executable = realpathSync(process.execPath).replaceAll("\\", "/");
  const stat = statSync(executable);
  const executableIdentity = sha256(JSON.stringify({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    path: executable,
    size: stat.size,
  }));
  const request = JSON.stringify({
    args: [scriptPath],
    executable,
    executableIdentity,
    expectedEffect: "write RESULT.md",
    type: "command",
    workdir: ".",
  }).replaceAll("'", "''");
  database.exec(`
    INSERT INTO project_validation_policy_entries (
      id,project_id,revision_id,position,executable,executable_identity,args_json,
      workdir,required,tuple_hash
    ) VALUES ('command-policy-${index}','${PROJECT_ID}','policy',0,
      '${executable.replaceAll("'", "''")}','${executableIdentity}',
      '${JSON.stringify([scriptPath]).replaceAll("'", "''")}','.',1,'${sha256(`tuple-${index}`)}');
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,
      action_count,final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES ('${operationId(index)}','${PROJECT_ID}','${EXECUTION_ID}','advance',
      '${"e".repeat(64)}',1,1,NULL,'pending',NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO execution_actions (
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,overall_deadline_at,created_at
    ) VALUES ('command-action','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',
      '${operationId(index)}',0,'command','pending','${"e".repeat(64)}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes'),'${NOW}');
    INSERT INTO execution_tool_calls (
      id,project_id,execution_id,attempt_id,action_id,business_round,type,
      request_hash,status,public_request_json,public_result_json,
      before_sandbox_hash,after_sandbox_hash,started_at,finished_at
    ) VALUES ('command-tool','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',
      'command-action',1,'command','${"e".repeat(64)}','requested','${request}',
      NULL,NULL,NULL,'${NOW}',NULL);
  `);
}

function stageRow(database: DatabaseSync) {
  const version = (database.prepare(
    "SELECT version FROM executions WHERE id=?",
  ).get(EXECUTION_ID) as { version: number }).version;
  return {
    agentId: "agent",
    attemptId: ATTEMPT_ID,
    attemptNo: 1,
    attemptStatus: "acting",
    businessDeadlineAt: "2099-01-01T00:00:00.000Z",
    businessRound: 1,
    executionRoot: root,
    frozenPrivateJson: "{}",
    projectId: PROJECT_ID,
    sandboxRoot: sandbox,
    status: "running",
    version,
    workspaceRoot: workspace,
  } as const;
}

function expectNoStageOrphans(database: DatabaseSync, operation: string): void {
  expect(database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM execution_actions
       WHERE kind='stage_compute' AND status='running') AS running,
      (SELECT COUNT(*) FROM execution_operations
       WHERE id=? AND status='pending') AS pending,
      (SELECT COUNT(*) FROM execution_staged_results) AS stagedResults,
      (SELECT COUNT(*) FROM execution_staged_observations) AS observations,
      (SELECT COUNT(*) FROM execution_staged_files) AS stagedFiles
  `).get(operation)).toEqual({
    observations: 0,
    pending: 0,
    running: 0,
    stagedFiles: 0,
    stagedResults: 0,
  });
}

async function persistBaselineAndCurrent(
  adapters: ReturnType<typeof createWindowsVerifiedExecutionAdapters>,
) {
  const baseline = await refreshSandboxManifest({
    fileAdapter: adapters.fileAdapter,
    sandboxRoot: workspace,
  });
  const current = await refreshSandboxManifest({
    fileAdapter: adapters.fileAdapter,
    sandboxRoot: sandbox,
  });
  expect(current.hash).toBe(baseline.hash);
  writeFileSync(baselinePath, JSON.stringify({ entries: baseline.entries, hash: baseline.hash }));
  writeFileSync(currentPath, JSON.stringify({ entries: current.entries, hash: current.hash }));
  return { baseline, current };
}

describe("verified sandbox manifest lifecycle", () => {
  it("persists strict baseline and current manifest identities across reopen", async () => {
    const adapters = createWindowsVerifiedExecutionAdapters();
    const { baseline, current } = await persistBaselineAndCurrent(adapters);
    expect(current.entries[0]).toEqual(expect.objectContaining({
      identity: expect.any(String),
      modeTag: "file",
      path: "README.md",
      sha256: sha256("before\n"),
      size: 7,
    }));
    expect(baseline.entries[0]?.identity).not.toBe(current.entries[0]?.identity);
    const database = seedDatabase(current.hash);
    database.close();

    const reopened = openDatabase(databasePath);
    try {
      expect(reopened.prepare(`
        SELECT baseline_manifest_path AS baselinePath,sandbox_manifest_path AS currentPath
        FROM execution_attempts WHERE id=?
      `).get(ATTEMPT_ID)).toEqual({ baselinePath, currentPath });
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
        entries: Array<{ identity?: string }>;
      };
      const current = JSON.parse(readFileSync(currentPath, "utf8")) as {
        entries: Array<{ identity?: string }>;
      };
      expect(baseline.entries[0]?.identity).toBe(
        (await refreshSandboxManifest({
          fileAdapter: adapters.fileAdapter,
          sandboxRoot: workspace,
        })).entries[0]?.identity,
      );
      expect(current.entries[0]?.identity).toBe(
        (await refreshSandboxManifest({
          fileAdapter: adapters.fileAdapter,
          sandboxRoot: sandbox,
        })).entries[0]?.identity,
      );
    } finally {
      reopened.close();
    }
  });

  it("marks same bytes with a new canonical identity stale after reopen", async () => {
    const adapters = createWindowsVerifiedExecutionAdapters();
    const { baseline, current } = await persistBaselineAndCurrent(adapters);
    const database = seedDatabase(current.hash);
    seedStagedDecision(database);
    writeFileSync(join(sandbox, "RESULT.md"), "changed\n");
    writeFileSync(join(sandbox, "README.md"), "after\n");
    const replacement = join(workspace, "README.replacement");
    writeFileSync(replacement, "before\n");
    rmSync(join(workspace, "README.md"));
    renameSync(replacement, join(workspace, "README.md"));
    const replaced = await refreshSandboxManifest({
      fileAdapter: adapters.fileAdapter,
      sandboxRoot: workspace,
    });
    expect(replaced.hash).toBe(baseline.hash);
    expect(replaced.entries[0]?.identity).not.toBe(baseline.entries[0]?.identity);
    database.close();

    const reopened = openDatabase(databasePath);
    try {
      const version = (reopened.prepare(
        "SELECT version FROM executions WHERE id=?",
      ).get(EXECUTION_ID) as { version: number }).version;
      const result = await declareStaged(
        databasePath,
        reopened,
        EXECUTION_ID,
        {
          agentId: "agent",
          attemptId: ATTEMPT_ID,
          attemptNo: 1,
          attemptStatus: "acting",
          businessDeadlineAt: "2099-01-01T00:00:00.000Z",
          businessRound: 1,
          executionRoot: root,
          frozenPrivateJson: "{}",
          projectId: PROJECT_ID,
          sandboxRoot: sandbox,
          status: "running",
          version,
          workspaceRoot: workspace,
        },
        operationId(420),
        "4".repeat(64),
        createWindowsVerifiedExecutionAdapters().stagingAdapter,
      );
      expect(result.status).toBe(409);
      expect(reopened.prepare(
        "SELECT status,reason_code AS reasonCode FROM executions WHERE id=?",
      ).get(EXECUTION_ID)).toEqual({ reasonCode: "STALE_EXECUTION", status: "stale" });
    } finally {
      reopened.close();
    }
  });

  it("terminalizes acquired stage actions and receipts when the adapter throws", { timeout: 15_000 }, async () => {
    const adapters = createWindowsVerifiedExecutionAdapters();
    const initial = await refreshSandboxManifest({
      fileAdapter: adapters.fileAdapter,
      sandboxRoot: sandbox,
    });
    writeFileSync(baselinePath, JSON.stringify({ entries: initial.entries, hash: initial.hash }));
    writeFileSync(currentPath, JSON.stringify({ entries: initial.entries, hash: initial.hash }));
    const database = seedDatabase(initial.hash);
    seedStagedDecision(database);
    writeFileSync(join(sandbox, "RESULT.md"), "changed\n");
    const version = (database.prepare(
      "SELECT version FROM executions WHERE id=?",
    ).get(EXECUTION_ID) as { version: number }).version;
    try {
      const result = await declareStaged(
        databasePath,
        database,
        EXECUTION_ID,
        {
          agentId: "agent",
          attemptId: ATTEMPT_ID,
          attemptNo: 1,
          attemptStatus: "acting",
          businessDeadlineAt: "2099-01-01T00:00:00.000Z",
          businessRound: 1,
          executionRoot: root,
          frozenPrivateJson: "{}",
          projectId: PROJECT_ID,
          sandboxRoot: sandbox,
          status: "running",
          version,
          workspaceRoot: workspace,
        },
        operationId(421),
        "5".repeat(64),
        {
          ...adapters.stagingAdapter,
          async refreshSandboxManifest() {
            throw new ExecutionError(
              "SANDBOX_UNVERIFIABLE",
              422,
              "injected adapter failure",
            );
          },
        },
      );
      expect(result).toMatchObject({
        body: { error: { code: "SANDBOX_UNVERIFIABLE" } },
        status: 422,
      });
      expectNoStageOrphans(database, operationId(421));
      expect(database.prepare(`
        SELECT e.status,e.reason_code AS reasonCode,a.status AS attemptStatus
        FROM executions e JOIN execution_attempts a ON a.execution_id=e.id
        WHERE e.id=?
      `).get(EXECUTION_ID)).toEqual({
        attemptStatus: "ready",
        reasonCode: "SANDBOX_UNVERIFIABLE",
        status: "paused",
      });
    } finally {
      database.close();
    }
  });

  it("matches the no-changes and stale-validation stage exit rows", async () => {
    for (const scenario of ["no-changes", "validation-stale"] as const) {
      const scenarioRoot = mkdtempSync(join(tmpdir(), `cool-ai-stage-${scenario}-`));
      const previous = { baselinePath, currentPath, databasePath, root, sandbox, workspace };
      root = scenarioRoot;
      workspace = join(root, "workspace");
      sandbox = join(root, "sandbox");
      baselinePath = join(root, "baseline.json");
      currentPath = join(root, "current.json");
      databasePath = join(root, "cockpit.sqlite");
      mkdirSync(workspace);
      mkdirSync(sandbox);
      writeFileSync(join(workspace, "README.md"), "before\n");
      writeFileSync(join(sandbox, "README.md"), "before\n");
      const adapters = createWindowsVerifiedExecutionAdapters();
      const initial = await refreshSandboxManifest({
        fileAdapter: adapters.fileAdapter,
        sandboxRoot: sandbox,
      });
      writeFileSync(baselinePath, JSON.stringify({ entries: initial.entries, hash: initial.hash }));
      writeFileSync(currentPath, JSON.stringify({ entries: initial.entries, hash: initial.hash }));
      const database = seedDatabase(initial.hash);
      seedStagedDecision(database);
      if (scenario === "validation-stale") {
        writeFileSync(join(sandbox, "RESULT.md"), "changed\n");
        database.prepare(`
          INSERT INTO project_validation_policy_entries (
            id,project_id,revision_id,position,executable,executable_identity,
            args_json,workdir,required,tuple_hash
          ) VALUES ('required','${PROJECT_ID}','policy',0,'node','${"e".repeat(64)}',
            '[]','.',1,'${"f".repeat(64)}')
        `).run();
      }
      const operation = operationId(scenario === "no-changes" ? 422 : 423);
      try {
        const result = await declareStaged(
          databasePath,
          database,
          EXECUTION_ID,
          stageRow(database),
          operation,
          "6".repeat(64),
          adapters.stagingAdapter,
        );
        const code = scenario === "no-changes" ? "STAGED_NO_CHANGES" : "VALIDATION_REQUIRED";
        expect(result).toMatchObject({
          body: { error: { code } },
          status: scenario === "no-changes" ? 409 : 422,
        });
        expectNoStageOrphans(database, operation);
        expect(database.prepare(`
          SELECT e.status,e.resume_target AS resumeTarget,e.reason_code AS reasonCode,
                 a.status AS attemptStatus
          FROM executions e JOIN execution_attempts a ON a.execution_id=e.id
          WHERE e.id=?
        `).get(EXECUTION_ID)).toEqual({
          attemptStatus: "ready",
          reasonCode: code,
          resumeTarget: "running",
          status: "paused",
        });
      } finally {
        database.close();
        rmSync(scenarioRoot, { force: true, recursive: true });
        ({ baselinePath, currentPath, databasePath, root, sandbox, workspace } = previous);
      }
    }
  });

  it("fails closed on strict manifest parse without orphaning stage facts", async () => {
    const adapters = createWindowsVerifiedExecutionAdapters();
    const initial = await refreshSandboxManifest({
      fileAdapter: adapters.fileAdapter,
      sandboxRoot: sandbox,
    });
    writeFileSync(baselinePath, JSON.stringify({
      entries: initial.entries.map(({ identity: _identity, ...entry }) => entry),
      hash: initial.hash,
    }));
    writeFileSync(currentPath, JSON.stringify({ entries: initial.entries, hash: initial.hash }));
    const database = seedDatabase(initial.hash);
    seedStagedDecision(database);
    writeFileSync(join(sandbox, "RESULT.md"), "changed\n");
    try {
      const result = await declareStaged(
        databasePath,
        database,
        EXECUTION_ID,
        stageRow(database),
        operationId(424),
        "7".repeat(64),
        adapters.stagingAdapter,
      );
      expect(result).toMatchObject({
        body: { error: { code: "SANDBOX_UNVERIFIABLE" } },
        status: 422,
      });
      expectNoStageOrphans(database, operationId(424));
      expect(database.prepare(`
        SELECT action.status AS actionStatus,action.error_code AS errorCode,
               operation.status AS receiptStatus,operation.http_status AS httpStatus,
               execution.status AS executionStatus,attempt.status AS attemptStatus
        FROM execution_actions action
        JOIN execution_operations operation ON operation.id=action.operation_id
        JOIN executions execution ON execution.id=action.execution_id
        JOIN execution_attempts attempt ON attempt.id=action.attempt_id
        WHERE action.operation_id=?
      `).get(operationId(424))).toEqual({
        actionStatus: "failed",
        attemptStatus: "ready",
        errorCode: "SANDBOX_UNVERIFIABLE",
        executionStatus: "paused",
        httpStatus: 422,
        receiptStatus: "completed",
      });
    } finally {
      database.close();
    }
  });

  it("reconciles lease loss, transaction injection, and a late finalizer", async () => {
    for (const scenario of ["lease", "transaction", "late"] as const) {
      const scenarioRoot = mkdtempSync(join(tmpdir(), `cool-ai-stage-${scenario}-`));
      const previous = { baselinePath, currentPath, databasePath, root, sandbox, workspace };
      root = scenarioRoot;
      workspace = join(root, "workspace");
      sandbox = join(root, "sandbox");
      baselinePath = join(root, "baseline.json");
      currentPath = join(root, "current.json");
      databasePath = join(root, "cockpit.sqlite");
      mkdirSync(workspace);
      mkdirSync(sandbox);
      writeFileSync(join(workspace, "README.md"), "before\n");
      writeFileSync(join(sandbox, "README.md"), "before\n");
      const adapters = createWindowsVerifiedExecutionAdapters();
      const initial = await refreshSandboxManifest({
        fileAdapter: adapters.fileAdapter,
        sandboxRoot: sandbox,
      });
      writeFileSync(baselinePath, JSON.stringify({ entries: initial.entries, hash: initial.hash }));
      writeFileSync(currentPath, JSON.stringify({ entries: initial.entries, hash: initial.hash }));
      const database = seedDatabase(initial.hash);
      seedStagedDecision(database);
      writeFileSync(join(sandbox, "RESULT.md"), "changed\n");
      const operation = operationId(
        scenario === "lease" ? 425 : scenario === "transaction" ? 426 : 427,
      );
      if (scenario === "transaction") {
        database.exec(`
          CREATE TRIGGER inject_stage_transaction
          BEFORE INSERT ON execution_staged_results
          BEGIN SELECT RAISE(ABORT,'injected stage transaction'); END
        `);
      }
      try {
        const result = await declareStaged(
          databasePath,
          database,
          EXECUTION_ID,
          stageRow(database),
          operation,
          "8".repeat(64),
          {
            ...adapters.stagingAdapter,
            async refreshSandboxManifest(input) {
              const refreshed = await adapters.stagingAdapter.refreshSandboxManifest!(input);
              if (scenario !== "transaction") {
                const action = database.prepare(`
                  SELECT id FROM execution_actions
                  WHERE operation_id=? AND kind='stage_compute' AND status='running'
                `).get(operation) as { id: string };
                if (scenario === "lease") {
                  database.prepare(`
                    UPDATE execution_actions
                    SET lease_expires_at='2020-01-01T00:00:00.000Z'
                    WHERE id=?
                  `).run(action.id);
                } else {
                  database.prepare(`
                    UPDATE execution_actions
                    SET status='interrupted',lease_token=NULL,lease_expires_at=NULL,
                        error_code='ACTION_LEASE_LOST',
                        finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                    WHERE id=?
                  `).run(action.id);
                  database.prepare(`
                    UPDATE execution_operations
                    SET status='completed',final_action_index=0,http_status=409,
                        response_json='{"error":{"code":"ACTION_LEASE_LOST"}}'
                    WHERE id=?
                  `).run(operation);
                }
              }
              return refreshed;
            },
          },
        );
        expect(result.status).toBe(scenario === "transaction" ? 500 : 409);
        expectNoStageOrphans(database, operation);
        expect(database.prepare(`
          SELECT action.status AS actionStatus,action.error_code AS errorCode,
                 operation.status AS receiptStatus,operation.http_status AS httpStatus,
                 execution.status AS executionStatus,attempt.status AS attemptStatus
          FROM execution_actions action
          JOIN execution_operations operation ON operation.id=action.operation_id
          JOIN executions execution ON execution.id=action.execution_id
          JOIN execution_attempts attempt ON attempt.id=action.attempt_id
          WHERE action.operation_id=?
        `).get(operation)).toEqual({
          actionStatus: scenario === "transaction" ? "failed" : "interrupted",
          attemptStatus: "failed",
          errorCode: scenario === "transaction" ? "INTERNAL_ERROR" : "ACTION_LEASE_LOST",
          executionStatus: "failed",
          httpStatus: scenario === "transaction" ? 500 : 409,
          receiptStatus: "completed",
        });
        if (scenario === "transaction") {
          database.exec("DROP TRIGGER inject_stage_transaction");
        }
        database.close();
        const reopened = openDatabase(databasePath);
        expectNoStageOrphans(reopened, operation);
        reopened.close();
      } finally {
        if (database.isOpen) database.close();
        rmSync(scenarioRoot, { force: true, recursive: true });
        ({ baselinePath, currentPath, databasePath, root, sandbox, workspace } = previous);
      }
    }
  });

  it("closes every production refresh handle exactly once on failure", async () => {
    const adapters = createWindowsVerifiedExecutionAdapters();
    const initial = await refreshSandboxManifest({
      fileAdapter: adapters.fileAdapter,
      sandboxRoot: sandbox,
    });
    writeFileSync(baselinePath, JSON.stringify({ entries: initial.entries, hash: initial.hash }));
    writeFileSync(currentPath, JSON.stringify({ entries: initial.entries, hash: initial.hash }));
    const database = seedDatabase(initial.hash);
    seedStagedDecision(database);
    writeFileSync(join(sandbox, "RESULT.md"), "changed\n");
    const closeCounts = new Map<unknown, number>();
    const countedFileAdapter = {
      ...adapters.fileAdapter,
      async close(handle: unknown) {
        closeCounts.set(handle, (closeCounts.get(handle) ?? 0) + 1);
        await adapters.fileAdapter.close(handle as never);
      },
    };
    try {
      const result = await declareStaged(
        databasePath,
        database,
        EXECUTION_ID,
        stageRow(database),
        operationId(428),
        "9".repeat(64),
        {
          ...adapters.stagingAdapter,
          async refreshSandboxManifest(input) {
            const refreshed = await refreshSandboxManifest({
              fileAdapter: countedFileAdapter,
              sandboxRoot: input.sandboxRoot,
            });
            throw new ExecutionError("SANDBOX_UNVERIFIABLE", 422, JSON.stringify(refreshed.hash));
          },
        },
      );
      expect(result.status).toBe(422);
      expect([...closeCounts.values()].every((count) => count === 1)).toBe(true);
      expectNoStageOrphans(database, operationId(428));
    } finally {
      database.close();
    }
  });

  it("refreshes a real write before/after and stages the refreshed tree exactly once", async () => {
    const adapters = createWindowsVerifiedExecutionAdapters();
    const initial = await refreshSandboxManifest({
      fileAdapter: adapters.fileAdapter,
      sandboxRoot: sandbox,
    });
    expect(initial.entries).toEqual([{
      identity: expect.any(String),
      modeTag: "file",
      path: "README.md",
      sha256: sha256("before\n"),
      size: 7,
    }]);
    writeFileSync(baselinePath, JSON.stringify({
      entries: initial.entries,
      hash: initial.hash,
    }));
    const database = seedDatabase(initial.hash);
    seedWriteAction(database);
    const canonicalBefore = readFileSync(join(workspace, "README.md"), "utf8");

    try {
      const written = await executeWriteToolAction({
        actionIndex: 0,
        content: "after\n",
        database,
        expectedHash: null,
        fs: adapters.fileAdapter,
        operationId: operationId(41),
        path: "work/RESULT.md",
        projectId: PROJECT_ID,
        sandboxRoot: sandbox,
      });
      expect(written.affectedRows).toBe(1);

      const current = await refreshSandboxManifest({
        fileAdapter: adapters.fileAdapter,
        sandboxRoot: sandbox,
      });
      expect(current.hash).not.toBe(initial.hash);
      expect(database.prepare(`
        SELECT sandbox_manifest_hash AS hash FROM execution_attempts WHERE id=?
      `).get(ATTEMPT_ID)).toEqual({ hash: current.hash });
      expect(database.prepare(`
        SELECT status,before_sandbox_hash AS beforeHash,after_sandbox_hash AS afterHash
        FROM execution_tool_calls WHERE action_id='write-action'
      `).get()).toEqual({
        afterHash: current.hash,
        beforeHash: initial.hash,
        status: "succeeded",
      });
      expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe(canonicalBefore);

      seedStagedDecision(database);
      const counted = {
        baselineEntries: adapters.stagingAdapter.baselineEntries,
        refreshCount: 0,
        async refreshSandboxManifest(input: { attemptId: string; sandboxRoot: string }) {
          this.refreshCount += 1;
          return refreshSandboxManifest({
            fileAdapter: adapters.fileAdapter,
            sandboxRoot: input.sandboxRoot,
          });
        },
        sandboxEntries: adapters.stagingAdapter.sandboxEntries,
      };
      const version = (database.prepare(
        "SELECT version FROM executions WHERE id=?",
      ).get(EXECUTION_ID) as { version: number }).version;
      const staged = await declareStaged(
        databasePath,
        database,
        EXECUTION_ID,
        {
          agentId: "agent",
          attemptId: ATTEMPT_ID,
          attemptNo: 1,
          attemptStatus: "acting",
          businessDeadlineAt: "2099-01-01T00:00:00.000Z",
          businessRound: 1,
          executionRoot: root,
          frozenPrivateJson: "{}",
          projectId: PROJECT_ID,
          sandboxRoot: sandbox,
          status: "running",
          version,
          workspaceRoot: workspace,
        },
        operationId(42),
        "d".repeat(64),
        counted,
      );

      expect(staged.status).toBe(200);
      expect(counted.refreshCount).toBe(1);
      expect(database.prepare(`
        SELECT sandbox_manifest_hash AS hash,observed_path_count AS observations,
               merge_file_count AS mergeFiles
        FROM execution_staged_results
      `).get()).toEqual({
        hash: current.hash,
        mergeFiles: 1,
        observations: 1,
      });
      expect(database.prepare(
        "SELECT path,kind FROM execution_staged_observations",
      ).get()).toEqual({ kind: "added", path: "work/RESULT.md" });
      expect(database.prepare(
        "SELECT path,staged_hash AS hash FROM execution_staged_files",
      ).get()).toEqual({ hash: sha256("after\n"), path: "work/RESULT.md" });
    } finally {
      database.close();
    }
  });

  it.each([0, 3])(
    "refreshes a confirmed command tree for exit code %s and records the real terminal state",
    async (exitCode) => {
      const scriptPath = join(sandbox, "mutate.mjs");
      writeFileSync(
        scriptPath,
        `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./COMMAND.md", import.meta.url), "command\\n");
process.exit(${exitCode});
`,
      );
      const adapters = createWindowsVerifiedExecutionAdapters();
      const initial = await refreshSandboxManifest({
        fileAdapter: adapters.fileAdapter,
        sandboxRoot: sandbox,
      });
      writeFileSync(baselinePath, JSON.stringify({
        entries: initial.entries,
        hash: initial.hash,
      }));
      const database = seedDatabase(initial.hash);
      seedCommandAction(database, scriptPath, 50 + exitCode);
      try {
        const executed = await executeCommandProcessAction({
          actionIndex: 0,
          authorizationSource: "standing_policy",
          database,
          manifestAdapter: adapters.fileAdapter,
          operationId: operationId(50 + exitCode),
          projectId: PROJECT_ID,
        });
        expect(executed.affectedRows).toBe(1);
        const current = await refreshSandboxManifest({
          fileAdapter: adapters.fileAdapter,
          sandboxRoot: sandbox,
        });
        expect(database.prepare(`
          SELECT status,before_sandbox_hash AS beforeHash,after_sandbox_hash AS afterHash
          FROM execution_tool_calls WHERE id='command-tool'
        `).get()).toEqual({
          afterHash: current.hash,
          beforeHash: initial.hash,
          status: exitCode === 0 ? "succeeded" : "failed",
        });
        expect(database.prepare(
          "SELECT sandbox_manifest_hash AS hash FROM execution_attempts WHERE id=?",
        ).get(ATTEMPT_ID)).toEqual({ hash: current.hash });
        expect(database.prepare(`
          SELECT sandbox_manifest_hash AS hash,exit_code AS exitCode,succeeded
          FROM execution_validation_results
        `).get()).toEqual({
          exitCode,
          hash: current.hash,
          succeeded: exitCode === 0 ? 1 : 0,
        });
        expect(database.prepare(
          "SELECT status FROM execution_actions WHERE id='command-action'",
        ).get()).toEqual({ status: exitCode === 0 ? "succeeded" : "failed" });
        expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("before\n");
      } finally {
        database.close();
      }
    },
  );

  it("post-refreshes a timed-out command only after confirmed tree termination", async () => {
    const scriptPath = join(sandbox, "timeout.mjs");
    writeFileSync(scriptPath, "setInterval(() => {}, 1000);\n");
    const adapters = createWindowsVerifiedExecutionAdapters();
    const initial = await refreshSandboxManifest({
      fileAdapter: adapters.fileAdapter,
      sandboxRoot: sandbox,
    });
    writeFileSync(baselinePath, JSON.stringify({ entries: initial.entries, hash: initial.hash }));
    const database = seedDatabase(initial.hash);
    seedCommandAction(database, scriptPath, 60);
    let now = 0;
    let spawned: (EventEmitter & {
      pid: number;
      stderr: PassThrough;
      stdout: PassThrough;
    }) | null = null;
    try {
      const executed = await executeCommandProcessAction({
        actionIndex: 0,
        authorizationSource: "standing_policy",
        clock: {
          clearInterval() {},
          clearTimeout() {},
          now: () => now,
          setInterval: () => 1,
          setTimeout(callback) {
            queueMicrotask(() => {
              now = 120_000;
              callback();
            });
            return 2;
          },
        },
        database,
        manifestAdapter: adapters.fileAdapter,
        operationId: operationId(60),
        processAdapter: {
          confirmTreeExited: async () => true,
          spawn() {
            writeFileSync(join(sandbox, "TIMEOUT.md"), "timed out\n");
            const child = new EventEmitter() as EventEmitter & {
              pid: number;
              stderr: PassThrough;
              stdout: PassThrough;
            };
            child.pid = 4160;
            child.stderr = new PassThrough();
            child.stdout = new PassThrough();
            spawned = child;
            return child;
          },
          async terminateTree(_pid) {
            spawned?.stderr.end();
            spawned?.stdout.end();
            spawned?.emit("close", null, "SIGKILL");
            return true;
          },
        },
        projectId: PROJECT_ID,
      });
      expect(executed.result?.status).toBe("timed_out");
      const current = await refreshSandboxManifest({
        fileAdapter: adapters.fileAdapter,
        sandboxRoot: sandbox,
      });
      expect(database.prepare(`
        SELECT status,before_sandbox_hash AS beforeHash,after_sandbox_hash AS afterHash
        FROM execution_tool_calls WHERE id='command-tool'
      `).get()).toEqual({
        afterHash: current.hash,
        beforeHash: initial.hash,
        status: "failed",
      });
      expect(database.prepare(
        "SELECT sandbox_manifest_hash AS hash FROM execution_attempts WHERE id=?",
      ).get(ATTEMPT_ID)).toEqual({ hash: current.hash });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM execution_validation_results",
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("drops a refreshed stage when the cached manifest CAS loses", async () => {
    const adapters = createWindowsVerifiedExecutionAdapters();
    const initial = await refreshSandboxManifest({
      fileAdapter: adapters.fileAdapter,
      sandboxRoot: sandbox,
    });
    writeFileSync(baselinePath, JSON.stringify({ entries: initial.entries, hash: initial.hash }));
    const database = seedDatabase(initial.hash);
    writeFileSync(join(sandbox, "RACE.md"), "external\n");
    seedStagedDecision(database);
    const version = (database.prepare(
      "SELECT version FROM executions WHERE id=?",
    ).get(EXECUTION_ID) as { version: number }).version;
    try {
      const result = await declareStaged(
        databasePath,
        database,
        EXECUTION_ID,
        {
          agentId: "agent",
          attemptId: ATTEMPT_ID,
          attemptNo: 1,
          attemptStatus: "acting",
          businessDeadlineAt: "2099-01-01T00:00:00.000Z",
          businessRound: 1,
          executionRoot: root,
          frozenPrivateJson: "{}",
          projectId: PROJECT_ID,
          sandboxRoot: sandbox,
          status: "running",
          version,
          workspaceRoot: workspace,
        },
        operationId(70),
        "7".repeat(64),
        {
          baselineEntries: adapters.stagingAdapter.baselineEntries,
          async refreshSandboxManifest(input) {
            const refreshed = await adapters.stagingAdapter.refreshSandboxManifest!(input);
            database.prepare(
              "UPDATE execution_attempts SET sandbox_manifest_hash=? WHERE id=?",
            ).run("f".repeat(64), ATTEMPT_ID);
            return refreshed;
          },
          sandboxEntries: adapters.stagingAdapter.sandboxEntries,
        },
      );
      expect(result).toMatchObject({
        body: { error: { code: "STALE_EXECUTION" } },
        status: 409,
      });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM execution_staged_results",
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM execution_staged_observations",
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM execution_staged_files",
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM execution_actions
        WHERE kind='stage_compute' AND status='succeeded'
      `).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
