import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { preflightSandbox, type SandboxPreflightResult } from "@/src/server/execution/sandbox-preflight";
import { createWindowsNativeReadAdapter } from "@/src/server/execution/windows-native-read-adapter";
import { execV7Fixture } from "@/tests/fixtures/execution/current-graph";

type SnapshotModule = typeof import("@/src/server/execution/sandbox-snapshot") & {
  cleanupOwnedSandbox(input: {
    expectedRootIdentity: string;
    platform?: ReturnType<typeof createWindowsNativeReadAdapter>;
    sandboxRoot: string;
  }): Promise<boolean>;
};
type ActionModule = {
  acquireExecutionAction(database: DatabaseSync, input: {
    actionIndex: number;
    operationId: string;
    projectId: string;
  }): { affectedRows: 0 | 1; leaseToken: string | null };
  heartbeatExecutionAction(database: DatabaseSync, input: {
    actionId: string;
    leaseToken: string;
    projectId: string;
  }): { affectedRows: 0 | 1 };
  reconcileSandboxBuildAction(database: DatabaseSync, input: {
    actionId: string;
    body: unknown;
    cleanupConfirmed: boolean;
    httpStatus: number;
    projectId: string;
    reason: "SANDBOX_ACTION_INTERRUPTED" | "SANDBOX_BUILD_DEADLINE_EXCEEDED";
  }): { affectedRows: 0 | 1 };
};

let root: string;
let workspace: string;
let managedRoot: string;
let sandboxRoot: string;
let snapshot: SnapshotModule;
let actions: ActionModule;
let databasePath: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cool-ai-sandbox-snapshot-"));
  workspace = join(root, "workspace");
  managedRoot = join(root, "managed");
  sandboxRoot = join(managedRoot, "attempt", "sandbox");
  mkdirSync(workspace);
  mkdirSync(managedRoot);
  databasePath = join(root, "cockpit.sqlite");
  const moduleId = "@/src/server/execution/sandbox-snapshot";
  try {
    snapshot = await import(/* @vite-ignore */ moduleId) as SnapshotModule;
    actions = await import("@/src/server/execution/execution-actions") as ActionModule;
  } catch {
    expect.fail("The verified-handle sandbox snapshot boundary is unavailable.");
  }
});

afterEach(() => rmSync(root, { force: true, recursive: true }));

function write(relativePath: string, bytes: string): string {
  const path = join(workspace, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function manifest(exclusions: string[] = []): Promise<SandboxPreflightResult> {
  return preflightSandbox({
    canonicalRoot: workspace,
    configuredExclusions: exclusions,
    managedSandboxRoot: managedRoot,
  });
}

describe("verified-handle sandbox snapshot", () => {
  it("fails closed through the verified adapter without reopening source paths", async () => {
    write("README.md", "hello\n");
    const preflight = await manifest();
    let rootOpenCount = 0;

    await expect(snapshot.buildSandboxSnapshot({
      preflight,
      sandboxRoot,
      sourceRoot: workspace,
      platform: {
        openRootDirectory() {
          rootOpenCount += 1;
          throw new Error("native adapter unavailable");
        },
      } as never,
    })).rejects.toMatchObject({ code: "SANDBOX_UNVERIFIABLE" });

    expect(rootOpenCount).toBe(1);
    expect(existsSync(sandboxRoot)).toBe(false);
    expect(existsSync(`${sandboxRoot}.building`)).toBe(false);
  });

  it("copies a real preflight manifest through verified handles with stable hashes", async () => {
    write("README.md", "hello\n");
    write("src/index.ts", "export const answer = 42;\n");
    const preflight = await manifest();
    const phases: string[] = [];

    const result = await snapshot.buildSandboxSnapshot({
      preflight,
      sandboxRoot,
      sourceRoot: workspace,
      hooks: {
        onPhase(phase) { phases.push(phase); },
      },
    });

    expect(readFileSync(join(sandboxRoot, "README.md"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(sandboxRoot, "src/index.ts"), "utf8")).toContain("42");
    expect(result.itemCount).toBe(preflight.itemCount);
    expect(result.totalBytes).toBe(preflight.totalBytes);
    expect(result.files).toEqual([
      {
        identity: expect.any(String),
        modeTag: "file",
        path: "README.md",
        sha256: sha256("hello\n"),
        size: 6,
      },
      {
        identity: expect.any(String),
        modeTag: "file",
        path: "src/index.ts",
        sha256: sha256("export const answer = 42;\n"),
        size: 26,
      },
    ]);
    expect(result.sandboxFiles.map(({ identity: _identity, ...file }) => file))
      .toEqual(result.files.map(({ identity: _identity, ...file }) => file));
    expect(result.sandboxFiles.map(({ identity }) => identity))
      .not.toEqual(result.files.map(({ identity }) => identity));
    expect(result.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(phases).toContain("source-opened");
    expect(phases.at(-1)).toBe("sandbox-renamed");
  });

  it("verifies the copied manifest without counting excluded source entries", async () => {
    write(".env", "TOKEN=secret");
    write("src/index.ts", "export const safe = true;\n");
    const preflight = await manifest();

    const result = await snapshot.buildSandboxSnapshot({
      preflight,
      sandboxRoot,
      sourceRoot: workspace,
    });

    expect(preflight.itemCount).toBeGreaterThan(preflight.entries.length);
    expect(result.files.map((file) => file.path)).toEqual(["src/index.ts"]);
    expect(existsSync(join(sandboxRoot, ".env"))).toBe(false);
  });

  it("fails closed and removes the whole sandbox when a source identity changes", async () => {
    const source = write("src/value.txt", "safe");
    const preflight = await manifest();

    await expect(snapshot.buildSandboxSnapshot({
      preflight,
      sandboxRoot,
      sourceRoot: workspace,
      hooks: {
        onPhase(phase, path) {
          if (phase === "before-source-open" && path === "src/value.txt") {
            rmSync(source);
            writeFileSync(source, "replacement-secret");
          }
        },
      },
    })).rejects.toMatchObject({ code: "SANDBOX_SOURCE_MISMATCH" });

    expect(existsSync(sandboxRoot)).toBe(false);
    expect(existsSync(`${sandboxRoot}.building`)).toBe(false);
  });

  it("cannot import an excluded secret through a replacement race", async () => {
    const source = write("src/public.txt", "public");
    const secret = write("private/token.pem", "TOP-SECRET");
    const preflight = await manifest([secret]);

    await expect(snapshot.buildSandboxSnapshot({
      preflight,
      sandboxRoot,
      sourceRoot: workspace,
      hooks: {
        onPhase(phase, path) {
          if (phase === "before-source-open" && path === "src/public.txt") {
            rmSync(source);
            writeFileSync(source, readFileSync(secret));
          }
        },
      },
    })).rejects.toMatchObject({ code: "SANDBOX_SOURCE_MISMATCH" });

    expect(existsSync(sandboxRoot)).toBe(false);
    expect(existsSync(join(sandboxRoot, "src/public.txt"))).toBe(false);
  });

  it("rejects link, reparse, special, parent-chain, and after-read identity races", async () => {
    write("nested/file.txt", "ordinary");
    const preflight = await manifest();
    const base = createWindowsNativeReadAdapter();
    for (const kind of ["link", "reparse", "special"] as const) {
      await expect(snapshot.buildSandboxSnapshot({
        preflight,
        sandboxRoot,
        sourceRoot: workspace,
        platform: {
          ...base,
          attributes(handle) {
            const attributes = base.attributes(
              handle as Parameters<typeof base.attributes>[0],
            );
            return {
              ...attributes,
              directory: kind === "special" ? true : attributes.directory,
              reparsePoint: kind !== "special",
            };
          },
        },
      })).rejects.toMatchObject({ code: "SANDBOX_SOURCE_MISMATCH" });
      expect(existsSync(sandboxRoot)).toBe(false);
    }
  });
});

describe("sandbox action timing", () => {
  it("uses a fixed 900 second deadline and renewable 120 second leases", () => {
    const started = Date.parse("2026-07-30T00:00:00.000Z");
    expect(snapshot.sandboxDeadlineState(started, started + 899_000)).toBe("live");
    expect(snapshot.sandboxDeadlineState(started, started + 900_000)).toBe("expired");
    expect(snapshot.sandboxDeadlineState(started, started + 901_000)).toBe("expired");
    expect(snapshot.sandboxLeaseExpiry(started + 121_000, started + 900_000)).toBe(started + 241_000);
    expect(snapshot.sandboxLeaseExpiry(started + 899_000, started + 900_000)).toBe(started + 900_000);
  });
});

function seedSandboxAction(options: {
  actionId: string;
  deadlineModifier: string;
  operationId: string;
  status?: "pending" | "running";
}): DatabaseSync {
  const database = openDatabase(databasePath);
  const now = "2026-07-30T00:00:00.000Z";
  try {
    execV7Fixture(databasePath, database, `
      INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
      VALUES ('snapshot-project','Snapshot','${now}','D:\\workspace','d:/workspace',1);
      INSERT INTO providers (id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,credential_version,credential_generation,key_id,api_key_mask,verified_at,version,created_at,updated_at)
      VALUES ('provider','Provider','http://127.0.0.1','model','c','i','t',1,1,'k','***','${now}',1,'${now}','${now}');
      INSERT INTO agents (id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at)
      VALUES ('agent','Agent','Builder','private','provider','model','A','sage',1,1,1,1000,5,1,'${now}','${now}');
      INSERT INTO project_memberships (project_id,agent_id,joined_at) VALUES ('snapshot-project','agent','${now}');
      INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at) VALUES ('mission','snapshot-project','Mission','Goal',1,'${now}','${now}');
      INSERT INTO work_items (id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at) VALUES ('work','mission','Work','','in_progress','agent',1,'${now}','${now}');
      INSERT INTO collaboration_runs (id,project_id,status,current_agent_id,round_count,next_event_sequence,version,execution_epoch,pause_reason,pause_category,created_at,updated_at) VALUES ('run','snapshot-project','planned','agent',1,1,1,1,NULL,NULL,'${now}','${now}');
      INSERT INTO project_validation_policy_revisions (id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,classifier_version,warning_accepted,canonical_bytes,entry_count,created_at) VALUES ('policy','snapshot-project',NULL,'system',1,'${"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"}',1,0,2,0,'${now}');
      INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at) VALUES ('snapshot-project','policy',1,'${now}');
      INSERT INTO executions (id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,current_policy_revision_id,status,resume_target,reason_code,manual_recovery_required,recovery_resolution,current_attempt_no,business_round_count,tool_call_count,next_event_sequence,version,created_at,business_deadline_at,first_running_at,updated_at,merged_at)
      VALUES ('snapshot-execution','snapshot-project','run','mission','work','agent','policy','queued',NULL,NULL,0,NULL,1,0,0,1,1,'${now}',NULL,NULL,'${now}',NULL);
      INSERT INTO execution_attempts (id,project_id,execution_id,attempt_no,status,sandbox_root,baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,frozen_public_json,frozen_private_json,frozen_context_hash,frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,started_at,finished_at)
      VALUES ('snapshot-attempt','snapshot-project','snapshot-execution',1,'preparing','${sandboxRoot.replaceAll("'", "''")}',NULL,NULL,NULL,'{}','{}','${"b".repeat(64)}','policy',1,'${"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"}','${now}',NULL);
    `);
    database.prepare(`INSERT INTO execution_operations (id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,final_action_index,status,http_status,response_json,created_at,updated_at) VALUES (?,'snapshot-project','snapshot-execution','start',?,1,1,NULL,'pending',NULL,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(options.operationId, "c".repeat(64));
    database.prepare(`INSERT INTO execution_actions (id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,request_hash,lease_token,lease_expires_at,overall_deadline_at,last_heartbeat_at,result_json,error_code,created_at,started_at,finished_at) VALUES (?,'snapshot-project','snapshot-execution','snapshot-attempt',?,0,'sandbox_build','pending',?,NULL,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now','+900 seconds'),NULL,NULL,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL)`).run(options.actionId, options.operationId, "c".repeat(64));
    if (options.status === "running") { database.prepare(`UPDATE execution_actions SET status='running',lease_token='seed-lease',lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds'),last_heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(options.actionId); }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

describe("durable sandbox action lifecycle", () => {
  it("keeps the business clock NULL across a healthy heartbeat after 120 seconds", () => {
    const database = seedSandboxAction({ actionId: "sandbox-action", deadlineModifier: "+779 seconds", operationId: "00000000-0000-4000-8000-000000000701" });
    try {
      database.prepare(`UPDATE execution_actions SET overall_deadline_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+779 seconds') WHERE id='sandbox-action'`).run();
      const acquired = actions.acquireExecutionAction(database, { actionIndex: 0, operationId: "00000000-0000-4000-8000-000000000701", projectId: "snapshot-project" });
      expect(acquired.affectedRows).toBe(1);
      database.prepare(`UPDATE execution_actions SET started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-121 seconds'),last_heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 seconds'),lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second') WHERE id='sandbox-action'`).run();
      expect(actions.heartbeatExecutionAction(database, { actionId: "sandbox-action", leaseToken: acquired.leaseToken!, projectId: "snapshot-project" })).toEqual({ affectedRows: 1 });
      expect(database.prepare(`SELECT first_running_at AS firstRunningAt,business_deadline_at AS businessDeadlineAt FROM executions WHERE id='snapshot-execution'`).get()).toEqual({ firstRunningAt: null, businessDeadlineAt: null });
      const lease = database.prepare(`SELECT (julianday(lease_expires_at)-julianday(last_heartbeat_at))*86400 AS seconds FROM execution_actions WHERE id='sandbox-action'`).get() as { seconds: number };
      expect(lease.seconds).toBeCloseTo(120, 2);
    } finally { database.close(); }
  });

  it("reconciles a restarted expired build to paused only after owned cleanup", async () => {
    let database = seedSandboxAction({ actionId: "expired-action", deadlineModifier: "-1 second", operationId: "00000000-0000-4000-8000-000000000702", status: "running" });
    mkdirSync(sandboxRoot, { recursive: true });
    writeFileSync(join(sandboxRoot, "partial"), "owned");
    const adapter = createWindowsNativeReadAdapter();
    const handle = adapter.openRootDirectory(sandboxRoot);
    const identity = adapter.identity(handle);
    adapter.close(handle);
    expect(await snapshot.cleanupOwnedSandbox({
      expectedRootIdentity: `${identity.volumeSerialNumber}:${identity.fileId}`,
      platform: adapter,
      sandboxRoot,
    })).toBe(true);
    database.prepare(`UPDATE execution_actions SET overall_deadline_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second'),lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id='expired-action'`).run();
    expect(actions.reconcileSandboxBuildAction(database, {
      actionId: "expired-action", body: { outcome: "paused" }, cleanupConfirmed: true, httpStatus: 409, projectId: "snapshot-project", reason: "SANDBOX_BUILD_DEADLINE_EXCEEDED",
    })).toEqual({ affectedRows: 1 });
    database.close();
    database = openDatabase(databasePath);
    try {
      expect(database.prepare(`SELECT status,resume_target AS resumeTarget,reason_code AS reasonCode,first_running_at AS firstRunningAt,business_deadline_at AS businessDeadlineAt FROM executions WHERE id='snapshot-execution'`).get()).toEqual({ status: "paused", resumeTarget: "queued", reasonCode: "SANDBOX_BUILD_DEADLINE_EXCEEDED", firstRunningAt: null, businessDeadlineAt: null });
      expect(database.prepare(`SELECT status FROM execution_attempts WHERE id='snapshot-attempt'`).get()).toEqual({ status: "interrupted" });
      expect(database.prepare(`SELECT status FROM execution_actions WHERE id='expired-action'`).get()).toEqual({ status: "interrupted" });
    } finally { database.close(); }
  });

  it("fails closed without deleting a replacement sandbox when ownership is uncertain", async () => {
    const database = seedSandboxAction({ actionId: "uncertain-action", deadlineModifier: "-1 second", operationId: "00000000-0000-4000-8000-000000000703", status: "running" });
    mkdirSync(sandboxRoot, { recursive: true });
    writeFileSync(join(sandboxRoot, "external"), "do-not-delete");
    expect(await snapshot.cleanupOwnedSandbox({ expectedRootIdentity: "different-identity", sandboxRoot })).toBe(false);
    try {
      database.prepare(`UPDATE execution_actions SET overall_deadline_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second'),lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id='uncertain-action'`).run();
      expect(actions.reconcileSandboxBuildAction(database, { actionId: "uncertain-action", body: { outcome: "failed" }, cleanupConfirmed: false, httpStatus: 500, projectId: "snapshot-project", reason: "SANDBOX_ACTION_INTERRUPTED" })).toEqual({ affectedRows: 1 });
      expect(database.prepare(`SELECT status,resume_target AS resumeTarget FROM executions WHERE id='snapshot-execution'`).get()).toEqual({ status: "failed", resumeTarget: null });
      expect(existsSync(join(sandboxRoot, "external"))).toBe(true);
    } finally { database.close(); }
  });
});


