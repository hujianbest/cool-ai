import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { saveValidationPolicy } from "@/src/adapters/outbound/sqlite/project-workspace/validation-policy-service";
import { execV7Fixture } from "@/tests/fixtures/execution/current-graph";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type PolicyCommand = {
  args: string[];
  entryId: string;
  executable: string;
  network: "loopback_only" | null;
  openPath: string | null;
  port: number | null;
  purpose: "preview" | "validation";
  timeoutSeconds: number;
  workdir: string;
};

type PolicyProcessModule = {
  classifyPolicyProcessCommand(
    databasePath: string,
    executionId: string,
    command: {
      args: string[];
      executable: string;
      executableIdentity: string;
      workdir: string;
    },
    context: {
      canonicalRoot: string;
      executionRoot: string;
      platform: "win32";
      sandboxRoot: string;
    },
  ): { decision: "denied" | "one_shot" | "standing_exact"; reasonCode: string | null };
  listExecutionPolicyCommands(
    databasePath: string,
    executionId: string,
  ): {
    commands: PolicyCommand[];
    executionId: string;
    executionVersion: number;
    policyRevisionId: string;
    projectId: string;
  };
  requestPolicyProcessApproval(
    databasePath: string,
    executionId: string,
    input: {
      command: {
        args: string[];
        executable: string;
        executableIdentity: string;
        workdir: string;
      };
      expectedExecutionVersion: number;
      operationId: string;
    },
    context: {
      canonicalRoot: string;
      executionRoot: string;
      platform: "win32";
      sandboxRoot: string;
    },
  ): { approvalId: string | null; decision: string; reasonCode: string | null };
  reconcilePolicyProcesses(databasePath: string): number;
  getPolicyProcess(
    databasePath: string,
    executionId: string,
    processId: string,
  ): {
    exitCode: number | null;
    id: string;
    previewUrl: string | null;
    reasonCode: string | null;
    status: string;
    stdout: { bytes: number; text: string; truncated: boolean };
    version: number;
  };
  startPolicyProcess(
    databasePath: string,
    executionId: string,
    input: {
      entryId: string;
      expectedExecutionVersion: number;
      operationId: string;
    },
    options: {
      runProcess(input: {
        args: string[];
        authorizationSource: "standing_policy";
        executable: string;
        heartbeat: () => boolean | Promise<boolean>;
        onOutputSnapshot?(
          stream: "stderr" | "stdout",
          output: {
            bytes: number;
            chunks: Array<{
              byteLength: number;
              byteOffset: number;
              sha256: string;
              text: string;
            }>;
            sha256: string;
            truncated: boolean;
          },
        ): void;
        registerTerminationRequest(request: (() => void) | null): void;
        sandboxRoot: string;
        timeoutMs: number;
        workdir: string;
      }): Promise<{
        authorizationSource: "standing_policy";
        durationMs: number;
        exitCode: number | null;
        status: "completed" | "lease_lost" | "termination_unconfirmed" | "timed_out";
        stderr: {
          bytes: number;
          chunks: Array<{ byteLength: number; byteOffset: number; sha256: string; text: string }>;
          sha256: string;
          truncated: boolean;
        };
        stdout: {
          bytes: number;
          chunks: Array<{ byteLength: number; byteOffset: number; sha256: string; text: string }>;
          sha256: string;
          truncated: boolean;
        };
      }>;
      verifyExecutableIdentity?(
        executable: string,
        expectedIdentity: string,
      ): boolean;
    },
  ): { id: string; status: string; version: number };
  startApprovedPolicyProcess(
    databasePath: string,
    executionId: string,
    input: {
      approvalId: string;
      expectedExecutionVersion: number;
      operationId: string;
    },
    executionRoot: string,
    options: {
      runProcess: never;
      verifyExecutableIdentity(executable: string, expectedIdentity: string): boolean;
    },
  ): { id: string; status: string };
  startPolicyProcessSession(
    databasePath: string,
    executionId: string,
    input: {
      entryId: string;
      expectedExecutionVersion: number;
      operationId: string;
    },
    options: {
      checkPortAvailable(port: number): Promise<boolean>;
      probeReady(port: number): Promise<boolean>;
      runProcess: PolicyProcessModule["startPolicyProcess"] extends (
        ...args: infer _Arguments
      ) => unknown ? never : never;
      verifyExecutableIdentity(executable: string, expectedIdentity: string): boolean;
    },
  ): Promise<{ id: string; status: string }>;
  stopPolicyProcess(
    databasePath: string,
    executionId: string,
    processId: string,
    expectedVersion: number,
  ): { id: string; status: string };
};

const NOW = "2026-08-19T10:00:00.000Z";
const IDENTITY = "a".repeat(64);
let databasePath: string;
let module: PolicyProcessModule;

beforeEach(async () => {
  databasePath = memoryDatabasePath();
  try {
    module = await import(
      "@/src/adapters/outbound/sqlite/safe-execution/policy-process-service"
    ) as PolicyProcessModule;
  } catch {
    expect.fail("The policy process service is unavailable.");
  }
});

afterEach(() => {});

function resolver(executable: string) {
  return { executable: `C:/verified-tools/${executable}.exe`, executableIdentity: IDENTITY };
}

function seedExecution(): { entryId: string; projectId: string; sandboxRoot: string } {
  const project = createProject("Policy process", databasePath);
  const frozen = saveValidationPolicy(databasePath, project.id, {
    entries: [{
      args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4173"],
      executable: "npm",
      network: "loopback_only",
      openPath: "/",
      port: 4173,
      purpose: "preview",
      required: false,
      timeoutSeconds: 600,
      workdir: ".",
    }],
    expectedVersion: 1,
    operationId: "20000000-0000-4000-8000-000000000001",
    warningAccepted: true,
  }, { resolveExecutable: resolver }).policy;
  saveValidationPolicy(databasePath, project.id, {
    entries: [{
      args: ["test"],
      executable: "node",
      required: true,
      workdir: ".",
    }],
    expectedVersion: 2,
    operationId: "20000000-0000-4000-8000-000000000002",
    warningAccepted: true,
  }, { resolveExecutable: resolver });

  const sandboxRoot = "C:/execution-root/project/execution/attempt/sandbox";
  const database = openDatabase(databasePath);
  try {
    execV7Fixture(databasePath, database, `
      UPDATE projects SET workspace_path='C:/workspace',workspace_key='workspace-key'
      WHERE id='${project.id}';
      INSERT INTO providers (
        id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
        credential_version,credential_generation,key_id,api_key_mask,verified_at,
        version,created_at,updated_at
      ) VALUES ('provider','Provider','https://example.invalid','model','c','i','t',
        1,1,'key','***','${NOW}',1,'${NOW}','${NOW}');
      INSERT INTO agents (
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
      ) VALUES ('agent','Agent','Role','Prompt','provider','model','A','sage',
        1,1,1,4096,2,1,'${NOW}','${NOW}');
      INSERT INTO project_memberships VALUES ('${project.id}','agent','${NOW}');
      INSERT INTO missions VALUES ('mission','${project.id}','Mission','Goal',1,'${NOW}','${NOW}');
      INSERT INTO work_items VALUES (
        'work','mission','Work','Description','todo','agent',1,'${NOW}','${NOW}'
      );
      INSERT INTO collaboration_runs (
        id,project_id,status,current_agent_id,round_count,next_event_sequence,
        version,execution_epoch,pause_reason,pause_category,created_at,updated_at
      ) VALUES ('run','${project.id}','planned','agent',0,1,1,1,NULL,NULL,'${NOW}','${NOW}');
      INSERT INTO executions (
        id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
        current_policy_revision_id,status,current_attempt_no,version,created_at,updated_at
      ) VALUES (
        'execution','${project.id}','run','mission','work','agent',
        '${frozen.revisionId}','running',1,4,'${NOW}','${NOW}'
      );
      INSERT INTO execution_attempts (
        id,project_id,execution_id,attempt_no,status,sandbox_root,frozen_public_json,
        frozen_private_json,frozen_context_hash,sandbox_manifest_hash,frozen_policy_revision_id,
        frozen_policy_version,frozen_policy_hash,started_at
      ) VALUES (
        'attempt','${project.id}','execution',1,'ready','${sandboxRoot}','{}','{}',
        '${"b".repeat(64)}','${"c".repeat(64)}','${frozen.revisionId}',${frozen.version},
        '${frozen.policyHash}','${NOW}'
      );
    `);
  } finally {
    database.close();
  }
  return { entryId: frozen.entries[0]!.id, projectId: project.id, sandboxRoot };
}

describe("policy process authorization", () => {
  it("lists only the frozen revision and continues an approved one-shot command", async () => {
    const seeded = seedExecution();
    const catalog = module.listExecutionPolicyCommands(databasePath, "execution");

    expect(catalog).toMatchObject({
      executionId: "execution",
      executionVersion: 4,
      policyRevisionId: expect.any(String),
      projectId: seeded.projectId,
    });
    expect(catalog.commands).toEqual([
      expect.objectContaining({
        args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4173"],
        entryId: seeded.entryId,
        executable: "npm.exe",
        network: "loopback_only",
        openPath: "/",
        port: 4173,
        purpose: "preview",
        timeoutSeconds: 600,
        workdir: ".",
      }),
    ]);
    expect(JSON.stringify(catalog)).not.toContain("C:/verified-tools");

    const context = {
      canonicalRoot: "C:/workspace",
      executionRoot: "C:/execution-root",
      platform: "win32" as const,
      sandboxRoot: seeded.sandboxRoot,
    };
    expect(module.classifyPolicyProcessCommand(databasePath, "execution", {
      args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4173"],
      executable: "C:/verified-tools/npm.exe",
      executableIdentity: IDENTITY,
      workdir: ".",
    }, context)).toEqual({ decision: "standing_exact", reasonCode: null });
    expect(module.classifyPolicyProcessCommand(databasePath, "execution", {
      args: ["test"],
      executable: "C:/verified-tools/node.exe",
      executableIdentity: IDENTITY,
      workdir: ".",
    }, context)).toEqual({ decision: "one_shot", reasonCode: null });
    expect(module.classifyPolicyProcessCommand(databasePath, "execution", {
      args: ["publish"],
      executable: "C:/verified-tools/npm.exe",
      executableIdentity: IDENTITY,
      workdir: ".",
    }, context)).toEqual({
      decision: "denied",
      reasonCode: "DEPLOY_PUBLISH_PUSH_DENIED",
    });

    const requested = module.requestPolicyProcessApproval(databasePath, "execution", {
      command: {
        args: ["test"],
        executable: "C:/verified-tools/node.exe",
        executableIdentity: IDENTITY,
        workdir: ".",
      },
      expectedExecutionVersion: 4,
      operationId: "20000000-0000-4000-8000-000000000004",
    }, context);
    expect(requested).toMatchObject({
      approvalId: expect.any(String),
      decision: "one_shot",
      reasonCode: null,
    });
    const approvalDatabase = openDatabase(databasePath);
    try {
      expect(approvalDatabase.prepare(`
        SELECT status FROM execution_approvals WHERE id=?
      `).get(requested.approvalId)).toEqual({ status: "pending" });
      expect(approvalDatabase.prepare(`
        SELECT actor_type AS actorType FROM execution_events
        WHERE type='approval_requested'
      `).get()).toEqual({ actorType: "owner" });
      approvalDatabase.prepare(`
        UPDATE execution_approvals SET status='approved',decided_at=?
        WHERE id=? AND status='pending'
      `).run(NOW, requested.approvalId);
      approvalDatabase.prepare(`
        UPDATE executions SET version=version+1
        WHERE id='execution' AND status='waiting_approval'
      `).run();
    } finally {
      approvalDatabase.close();
    }

    const approved = module.startApprovedPolicyProcess(databasePath, "execution", {
      approvalId: requested.approvalId!,
      expectedExecutionVersion: 6,
      operationId: "20000000-0000-4000-8000-000000000008",
    }, "C:/execution-root", {
      runProcess: (() => Promise.resolve({
        authorizationSource: "one_shot",
        durationMs: 5,
        exitCode: 0,
        status: "completed",
        stderr: { bytes: 0, chunks: [], sha256: "0".repeat(64), truncated: false },
        stdout: { bytes: 0, chunks: [], sha256: "0".repeat(64), truncated: false },
      })) as never,
      verifyExecutableIdentity: () => true,
    });
    expect(approved).toMatchObject({
      id: expect.any(String),
      status: "running",
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const consumedDatabase = openDatabase(databasePath);
    try {
      expect(consumedDatabase.prepare(`
        SELECT status FROM execution_approvals WHERE id=?
      `).get(requested.approvalId)).toEqual({ status: "consumed" });
      expect(consumedDatabase.prepare(`
        SELECT authorization_source AS authorizationSource,status
        FROM execution_policy_processes WHERE id=?
      `).get(approved.id)).toEqual({
        authorizationSource: "one_shot",
        status: "completed",
      });
    } finally {
      consumedDatabase.close();
    }
  });

  it("starts one exact frozen command, persists bounded output, and replays the operation", async () => {
    const seeded = seedExecution();
    let finish: ((value: {
      authorizationSource: "standing_policy";
      durationMs: number;
      exitCode: number;
      status: "completed";
      stderr: {
        bytes: number;
        chunks: never[];
        sha256: string;
        truncated: boolean;
      };
      stdout: {
        bytes: number;
        chunks: Array<{ byteLength: number; byteOffset: number; sha256: string; text: string }>;
        sha256: string;
        truncated: boolean;
      };
    }) => void) | undefined;
    const runProcess = ({ onOutputSnapshot, registerTerminationRequest, timeoutMs }: {
      onOutputSnapshot?(
        stream: "stderr" | "stdout",
        output: {
          bytes: number;
          chunks: Array<{ byteLength: number; byteOffset: number; sha256: string; text: string }>;
          sha256: string;
          truncated: boolean;
        },
      ): void;
      registerTerminationRequest(request: (() => void) | null): void;
      timeoutMs: number;
    }) => {
      expect(timeoutMs).toBe(600_000);
      registerTerminationRequest(() => {});
      onOutputSnapshot?.("stdout", {
        bytes: 4,
        chunks: [{
          byteLength: 4,
          byteOffset: 0,
          sha256: "3".repeat(64),
          text: "live",
        }],
        sha256: "4".repeat(64),
        truncated: false,
      });
      return new Promise<Parameters<NonNullable<typeof finish>>[0]>((resolve) => {
        finish = resolve;
      });
    };
    const operationId = "20000000-0000-4000-8000-000000000003";
    const started = module.startPolicyProcess(databasePath, "execution", {
      entryId: seeded.entryId,
      expectedExecutionVersion: 4,
      operationId,
    }, {
      runProcess: runProcess as never,
      verifyExecutableIdentity: () => true,
    });
    expect(started).toMatchObject({ id: expect.any(String), status: "running" });
    expect(module.getPolicyProcess(databasePath, "execution", started.id)).toMatchObject({
      status: "running",
      stdout: { bytes: 4, text: "live", truncated: false },
    });
    expect(module.startPolicyProcess(databasePath, "execution", {
      entryId: seeded.entryId,
      expectedExecutionVersion: 4,
      operationId,
    }, {
      runProcess: runProcess as never,
      verifyExecutableIdentity: () => true,
    })).toEqual(started);

    finish?.({
      authorizationSource: "standing_policy",
      durationMs: 25,
      exitCode: 0,
      status: "completed",
      stderr: { bytes: 0, chunks: [], sha256: "0".repeat(64), truncated: false },
      stdout: {
        bytes: 5,
        chunks: [{
          byteLength: 5,
          byteOffset: 0,
          sha256: "1".repeat(64),
          text: "ready",
        }],
        sha256: "2".repeat(64),
        truncated: false,
      },
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    expect(module.getPolicyProcess(databasePath, "execution", started.id)).toMatchObject({
      exitCode: 0,
      id: started.id,
      status: "completed",
      stdout: { bytes: 5, text: "ready", truncated: false },
    });
    const auditDatabase = openDatabase(databasePath);
    try {
      expect(auditDatabase.prepare(`
        SELECT type,actor_type AS actorType FROM execution_events
        WHERE type LIKE 'policy_process_%' ORDER BY sequence
      `).all()).toEqual([
        { actorType: "owner", type: "policy_process_started" },
        { actorType: "system", type: "policy_process_finished" },
      ]);
      expect(auditDatabase.prepare(`
        SELECT COUNT(*) AS count FROM audit_event_outbox
        WHERE event_type LIKE 'policy_process_%'
      `).get()).toEqual({ count: 2 });
    } finally {
      auditDatabase.close();
    }
  });

  it("stops an active process and reconciles orphaned processes as interrupted", async () => {
    const seeded = seedExecution();
    let terminate: (() => void) | undefined;
    const completed = {
      authorizationSource: "standing_policy" as const,
      durationMs: 10,
      exitCode: 0,
      status: "completed" as const,
      stderr: { bytes: 0, chunks: [] as never[], sha256: "0".repeat(64), truncated: false },
      stdout: { bytes: 0, chunks: [] as never[], sha256: "0".repeat(64), truncated: false },
    };
    const started = module.startPolicyProcess(databasePath, "execution", {
      entryId: seeded.entryId,
      expectedExecutionVersion: 4,
      operationId: "20000000-0000-4000-8000-000000000005",
    }, {
      runProcess: (({ registerTerminationRequest }: {
        registerTerminationRequest(request: (() => void) | null): void;
      }) => new Promise((resolve) => {
        terminate = () => resolve(completed);
        registerTerminationRequest(terminate);
      })) as never,
      verifyExecutableIdentity: () => true,
    });

    expect(module.stopPolicyProcess(
      databasePath,
      "execution",
      started.id,
      started.version,
    )).toMatchObject({
      id: started.id,
      status: "stopping",
    });
    expect(terminate).toBeTypeOf("function");
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    expect(module.getPolicyProcess(databasePath, "execution", started.id).status).toBe("stopped");

    const database = openDatabase(databasePath);
    try {
      database.prepare(`
        UPDATE execution_policy_processes
        SET status='running',reason_code=NULL,finished_at=NULL
        WHERE id=?
      `).run(started.id);
    } finally {
      database.close();
    }
    expect(module.reconcilePolicyProcesses(databasePath)).toBe(1);
    expect(module.getPolicyProcess(databasePath, "execution", started.id)).toMatchObject({
      reasonCode: "PROCESS_HOST_RESTARTED",
      status: "interrupted",
    });
  });

  it("rejects an occupied frozen port and derives preview readiness server-side", async () => {
    const seeded = seedExecution();
    await expect(module.startPolicyProcessSession(databasePath, "execution", {
      entryId: seeded.entryId,
      expectedExecutionVersion: 4,
      operationId: "20000000-0000-4000-8000-000000000006",
    }, {
      checkPortAvailable: async () => false,
      probeReady: async () => false,
      runProcess: (() => Promise.reject(new Error("must not spawn"))) as never,
      verifyExecutableIdentity: () => true,
    })).rejects.toMatchObject({ code: "PREVIEW_PORT_UNAVAILABLE" });

    const started = await module.startPolicyProcessSession(databasePath, "execution", {
      entryId: seeded.entryId,
      expectedExecutionVersion: 4,
      operationId: "20000000-0000-4000-8000-000000000007",
    }, {
      checkPortAvailable: async () => true,
      probeReady: async () => true,
      runProcess: (() => new Promise(() => {})) as never,
      verifyExecutableIdentity: () => true,
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    expect(module.getPolicyProcess(databasePath, "execution", started.id)).toMatchObject({
      previewUrl: "http://127.0.0.1:4173/",
      status: "ready",
    });
  });
});
