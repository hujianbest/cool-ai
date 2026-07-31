import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";
import {
  CLASSIFIER_VERSION,
  commandTupleHash,
  type CommandPolicyContext,
} from "@/src/server/execution/command-policy";

type CommandRequest = {
  args: string[];
  executable: string;
  executableIdentity: string;
  expectedEffect: string;
  workdir: string;
};

type CommandRequestResult = {
  actionId: string | null;
  approvalId: string | null;
  decision: "denied" | "one_shot" | "standing_exact";
  reasonCode: string | null;
  requestHash: string;
  toolCallId: string | null;
};

type CommandRequestModule = {
  requestExecutionCommand(input: {
    command: CommandRequest;
    contextHash: string;
    database: DatabaseSync;
    expectedVersion: number;
    inputHash: string;
    operationId: string;
    policyContext: CommandPolicyContext;
    projectId: string;
  }): CommandRequestResult;
};

const PROJECT_ID = "command-project";
const EXECUTION_ID = "command-execution";
const ATTEMPT_ID = "command-attempt";
const POLICY_ID = "command-policy";
const EXECUTABLE = "C:/verified/node.exe";
const IDENTITY = "a".repeat(64);
const INPUT_HASH = "b".repeat(64);
const CONTEXT_HASH = "c".repeat(64);
const POLICY_HASH = "d".repeat(64);
const NOW = "2026-07-30T04:00:00.000Z";
const POLICY_CONTEXT: CommandPolicyContext = {
  canonicalRoot: "D:/project",
  executionRoot: "D:/executions",
  platform: "win32",
  sandboxRoot: "D:/executions/p/e/1/sandbox",
};

let directory: string;
let databasePath: string;
let commandRequest: CommandRequestModule;
let operationSequence = 0;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cool-ai-command-request-"));
  databasePath = join(directory, "cockpit.sqlite");
  operationSequence = 0;
  try {
    commandRequest = await import("@/src/server/execution/command-request") as CommandRequestModule;
  } catch {
    expect.fail("The T-12 command request service is unavailable.");
  }
});

afterEach(() => rmSync(directory, { force: true, recursive: true }));

describe("command request classification and durable facts", () => {
  it("creates a direct pending command action only for an exact frozen standing tuple", () => {
    const database = seedDatabase({ canExecute: true, standing: true });
    try {
      const command = standardCommand();
      const result = request(database, command);

      expect(result).toMatchObject({
        actionId: expect.any(String),
        approvalId: null,
        decision: "standing_exact",
        reasonCode: null,
        toolCallId: expect.any(String),
      });
      expect(database.prepare(`
        SELECT kind,status,request_hash AS requestHash
        FROM execution_actions
      `).get()).toEqual({
        kind: "command",
        requestHash: result.requestHash,
        status: "pending",
      });
      expect(database.prepare("SELECT count(*) AS count FROM execution_approvals").get())
        .toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT status,action_id AS actionId,request_hash AS requestHash,
               public_request_json AS publicRequest
        FROM execution_tool_calls
      `).get()).toMatchObject({
        actionId: result.actionId,
        requestHash: result.requestHash,
        status: "requested",
      });

      const publicRequest = JSON.parse(String((database.prepare(
        "SELECT public_request_json AS value FROM execution_tool_calls",
      ).get() as { value: string }).value));
      expect(publicRequest).toEqual({
        agentPermission: "execute",
        args: command.args,
        attemptId: ATTEMPT_ID,
        attemptNo: 1,
        classifierVersion: CLASSIFIER_VERSION,
        contextHash: CONTEXT_HASH,
        executable: command.executable,
        executableIdentity: command.executableIdentity,
        expectedEffect: command.expectedEffect,
        inputHash: INPUT_HASH,
        policySource: {
          hash: POLICY_HASH,
          revisionId: POLICY_ID,
          version: 1,
        },
        riskReasons: [],
        type: "command",
        workdir: command.workdir,
      });
      expect(database.prepare(`
        SELECT status,reason_code AS reasonCode FROM executions
      `).get()).toEqual({ reasonCode: null, status: "running" });
    } finally {
      database.close();
    }
  });

  it("turns a near-match or unlisted mechanically allowed command into one hash-bound request", () => {
    const database = seedDatabase({ canExecute: true, standing: true });
    try {
      const command = standardCommand({ args: ["test", "--changed"] });
      const result = request(database, command);
      expect(result).toMatchObject({
        actionId: null,
        approvalId: expect.any(String),
        decision: "one_shot",
        reasonCode: null,
      });
      expect(database.prepare("SELECT count(*) AS count FROM execution_actions").get())
        .toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT status,request_hash AS requestHash,input_hash AS inputHash,
               public_request_json AS publicRequest
        FROM execution_approvals
      `).get()).toMatchObject({
        inputHash: INPUT_HASH,
        requestHash: result.requestHash,
        status: "pending",
      });
      expect(database.prepare(`
        SELECT status,action_id AS actionId FROM execution_tool_calls
      `).get()).toEqual({ actionId: null, status: "waiting_approval" });
      expect(database.prepare(`
        SELECT status,resume_target AS resumeTarget,reason_code AS reasonCode
        FROM executions
      `).get()).toEqual({
        reasonCode: "COMMAND_APPROVAL_REQUIRED",
        resumeTarget: null,
        status: "waiting_approval",
      });

      const approvalRequest = JSON.parse(String((database.prepare(
        "SELECT public_request_json AS value FROM execution_approvals",
      ).get() as { value: string }).value));
      expect(approvalRequest).toMatchObject({
        agentPermission: "execute",
        args: command.args,
        attemptId: ATTEMPT_ID,
        attemptNo: 1,
        contextHash: CONTEXT_HASH,
        executable: command.executable,
        expectedEffect: command.expectedEffect,
        inputHash: INPUT_HASH,
        policySource: {
          hash: POLICY_HASH,
          revisionId: POLICY_ID,
          version: 1,
        },
        requestHash: result.requestHash,
        workdir: command.workdir,
      });
    } finally {
      database.close();
    }
  });

  it("enforces one open request per execution", () => {
    const database = seedDatabase({ canExecute: true, standing: false });
    try {
      request(database, standardCommand());
      database.prepare(`
        UPDATE executions SET status='running',reason_code=NULL,version=version+1
      `).run();
      expect(() => request(database, standardCommand({ args: ["test", "--other"] }), 3))
        .toThrowError(expect.objectContaining({ code: "APPROVAL_STATE_CONFLICT" }));
      expect(database.prepare(`
        SELECT count(*) AS count FROM execution_approvals
        WHERE status IN ('pending','approved')
      `).get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it.each([
    ["shell", standardCommand({ executable: "cmd.exe", args: ["/c", "npm", "test"] }),
      "SHELL_EXECUTABLE_DENIED"],
    ["path escape", standardCommand({ args: ["--output=D:/project/dist"] }),
      "PATH_ESCAPE_DENIED"],
    ["canonical deploy", standardCommand({ executable: "C:/tools/npm.exe", args: ["publish"] }),
      "DEPLOY_PUBLISH_PUSH_DENIED"],
    ["unknown path syntax", standardCommand({ args: ["--prefix"] }),
      "UNKNOWN_PATH_SYNTAX_DENIED"],
  ])("denies %s with zero command actions or approval requests", (_label, command, code) => {
    const database = seedDatabase({ canExecute: true, standing: false });
    try {
      const result = request(database, command);
      expect(result).toMatchObject({
        actionId: null,
        approvalId: null,
        decision: "denied",
        reasonCode: code,
        toolCallId: null,
      });
      expect(database.prepare("SELECT count(*) AS count FROM execution_actions").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT count(*) AS count FROM execution_approvals").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT count(*) AS count FROM execution_tool_calls").get())
        .toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT status,resume_target AS resumeTarget,reason_code AS reasonCode
        FROM executions
      `).get()).toEqual({
        reasonCode: code,
        resumeTarget: "running",
        status: "paused",
      });
    } finally {
      database.close();
    }
  });

  it("routes unknown non-path behavior to one-shot approval", () => {
    const database = seedDatabase({ canExecute: true, standing: false });
    try {
      const result = request(database, standardCommand({
        args: ["https://example.invalid/archive", "--retry", "2"],
        executable: "C:/tools/curl.exe",
      }));
      expect(result.decision).toBe("one_shot");
      const persisted = JSON.parse(String((database.prepare(
        "SELECT public_request_json AS value FROM execution_approvals",
      ).get() as { value: string }).value));
      expect(persisted.riskReasons).toContain("UNKNOWN_NON_PATH_BEHAVIOR");
      expect(persisted.parseResult).toBe("unknown_non_path");
    } finally {
      database.close();
    }
  });

  it("never creates an owner-approvable request when execute permission is missing", () => {
    const database = seedDatabase({ canExecute: false, standing: true });
    try {
      const result = request(database, standardCommand());
      expect(result).toMatchObject({
        actionId: null,
        approvalId: null,
        decision: "denied",
        reasonCode: "AGENT_PERMISSION_REQUIRED",
        toolCallId: null,
      });
      expect(database.prepare("SELECT count(*) AS count FROM execution_actions").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT count(*) AS count FROM execution_approvals").get())
        .toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT status,resume_target AS resumeTarget,reason_code AS reasonCode
        FROM executions
      `).get()).toEqual({
        reasonCode: "AGENT_PERMISSION_REQUIRED",
        resumeTarget: "running",
        status: "paused",
      });
    } finally {
      database.close();
    }
  });
});

function standardCommand(overrides: Partial<CommandRequest> = {}): CommandRequest {
  return {
    args: ["test", "--runInBand"],
    executable: EXECUTABLE,
    executableIdentity: IDENTITY,
    expectedEffect: "Run the isolated test suite.",
    workdir: ".",
    ...overrides,
  };
}

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${String(operationSequence).padStart(12, "0")}`;
}

function request(
  database: DatabaseSync,
  command: CommandRequest,
  expectedVersion = 1,
): CommandRequestResult {
  return commandRequest.requestExecutionCommand({
    command,
    contextHash: CONTEXT_HASH,
    database,
    expectedVersion,
    inputHash: INPUT_HASH,
    operationId: operationId(),
    policyContext: POLICY_CONTEXT,
    projectId: PROJECT_ID,
  });
}

function seedDatabase(input: { canExecute: boolean; standing: boolean }): DatabaseSync {
  const database = openDatabase(databasePath);
  const policyEntry = input.standing
    ? {
        args: ["test", "--runInBand"],
        executable: EXECUTABLE,
        executableIdentity: IDENTITY,
        required: true,
        workdir: ".",
      }
    : null;
  const tupleHash = policyEntry ? commandTupleHash(policyEntry) : null;
  const policyCanonical = policyEntry ? JSON.stringify([{
    args: policyEntry.args,
    classifierVersion: CLASSIFIER_VERSION,
    executable: policyEntry.executable,
    executableIdentity: policyEntry.executableIdentity,
    required: policyEntry.required,
    workdir: policyEntry.workdir,
  }]) : "[]";
  const canonicalBytes = Buffer.byteLength(policyCanonical, "utf8");
  database.exec(`
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Command','${NOW}','D:\\project','d:/project',1);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'provider','Provider','http://127.0.0.1','model','c','i','t',1,1,'k','***',
      '${NOW}',1,'${NOW}','${NOW}'
    );
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES (
      'agent','Agent','Builder','private','provider','model','A','sage',
      1,1,${input.canExecute ? 1 : 0},1000,5,1,'${NOW}','${NOW}'
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
    ) VALUES (
      'run','${PROJECT_ID}','planned','agent',1,1,1,1,NULL,NULL,'${NOW}','${NOW}'
    );
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES (
      '${POLICY_ID}','${PROJECT_ID}',NULL,'system',1,'${POLICY_HASH}',
      ${CLASSIFIER_VERSION},0,${canonicalBytes},${policyEntry ? 1 : 0},'${NOW}'
    );
    INSERT INTO project_validation_policies (
      project_id,active_revision_id,version,updated_at
    ) VALUES ('${PROJECT_ID}','${POLICY_ID}',1,'${NOW}');
    INSERT INTO executions (
      id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES (
      '${EXECUTION_ID}','${PROJECT_ID}','run','mission','work','agent','${POLICY_ID}',
      'running',NULL,NULL,0,NULL,1,1,0,1,1,'${NOW}',
      '2099-01-01T00:15:00.000Z','2099-01-01T00:00:00.000Z','${NOW}',NULL
    );
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES (
      '${ATTEMPT_ID}','${PROJECT_ID}','${EXECUTION_ID}',1,'acting',
      '${POLICY_CONTEXT.sandboxRoot}',NULL,NULL,NULL,'{}','{}','${CONTEXT_HASH}',
      '${POLICY_ID}',1,'${POLICY_HASH}','${NOW}',NULL
    );
  `);
  if (policyEntry && tupleHash) {
    database.prepare(`
      INSERT INTO project_validation_policy_entries (
        id,project_id,revision_id,position,executable,executable_identity,args_json,
        workdir,required,tuple_hash
      ) VALUES ('policy-entry',?,?,?,?,?,?,?,?,?)
    `).run(
      PROJECT_ID,
      POLICY_ID,
      0,
      policyEntry.executable,
      policyEntry.executableIdentity,
      JSON.stringify(policyEntry.args),
      policyEntry.workdir,
      1,
      tupleHash,
    );
  }
  return database;
}

