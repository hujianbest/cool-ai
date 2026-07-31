import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { openDatabase } from "@/src/server/db";
import { reconcileSandboxBuildAction } from "@/src/server/execution/execution-actions";
import {
  createProductionSandboxExecutor,
} from "@/src/server/execution/sandbox-executor";
import { startExecution } from "@/src/server/execution/execution-service";
import { cleanupOwnedSandbox } from "@/src/server/execution/sandbox-snapshot";
import { createWindowsNativeReadAdapter } from "@/src/server/execution/windows-native-read-adapter";

const PROJECT_ID = "sandbox-orchestrator-project";
const RUN_ID = "sandbox-orchestrator-run";
const WORK_ITEM_ID = "sandbox-orchestrator-work";
const OPERATION_ID = "00000000-0000-4000-8000-000000000040";
const NOW = "2026-08-01T00:00:00.000Z";
const EMPTY_POLICY_HASH =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

let root: string;
let workspace: string;
let executionRoot: string;
let databasePath: string;
let originalCanonicalHash: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cool-ai-sandbox-orchestrator-"));
  workspace = join(root, "workspace");
  executionRoot = join(root, "executions");
  databasePath = join(root, "cockpit.sqlite");
  mkdirSync(workspace);
  mkdirSync(executionRoot);
  writeFileSync(join(workspace, "README.md"), "canonical stays unchanged\n");
  originalCanonicalHash = canonicalHash();
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_EXECUTION_ROOT = executionRoot;
  seedEligibleTask();
});

afterEach(() => {
  expect(canonicalHash()).toBe(originalCanonicalHash);
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_EXECUTION_ROOT;
  rmSync(root, { force: true, recursive: true });
});

function canonicalHash(): string {
  return createHash("sha256")
    .update(readFileSync(join(workspace, "README.md")))
    .digest("hex");
}

function seedEligibleTask(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
      VALUES ('${PROJECT_ID}','Sandbox orchestrator','${NOW}','placeholder','placeholder',1);
      INSERT INTO providers (
        id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
        credential_version,credential_generation,key_id,api_key_mask,verified_at,
        version,created_at,updated_at
      ) VALUES (
        'sandbox-provider','Provider','http://127.0.0.1:4000/v1','model',
        'cipher','iv','tag',1,1,'key','***','${NOW}',1,'${NOW}','${NOW}'
      );
      INSERT INTO agents (
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
      ) VALUES (
        'sandbox-agent','Agent','Builder','private','sandbox-provider','model','A','sage',
        1,1,1,1000,5,1,'${NOW}','${NOW}'
      );
      INSERT INTO project_memberships (project_id,agent_id,joined_at)
      VALUES ('${PROJECT_ID}','sandbox-agent','${NOW}');
      INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
      VALUES ('sandbox-mission','${PROJECT_ID}','Mission','Goal',1,'${NOW}','${NOW}');
      INSERT INTO work_items (
        id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
      ) VALUES (
        '${WORK_ITEM_ID}','sandbox-mission','Work','','in_progress','sandbox-agent',
        1,'${NOW}','${NOW}'
      );
      INSERT INTO collaboration_runs (
        id,project_id,status,current_agent_id,round_count,next_event_sequence,
        version,execution_epoch,pause_reason,pause_category,created_at,updated_at
      ) VALUES (
        '${RUN_ID}','${PROJECT_ID}','planned','sandbox-agent',1,3,1,1,NULL,NULL,
        '${NOW}','${NOW}'
      );
      INSERT INTO collaboration_project_sequences (project_id,next_message_sequence)
      VALUES ('${PROJECT_ID}',2);
      INSERT INTO collaboration_operations (
        id,project_id,run_id,kind,request_hash,status,http_status,response_json,created_at,updated_at
      ) VALUES (
        'sandbox-plan-operation','${PROJECT_ID}','${RUN_ID}','advance','plan-hash',
        'completed',200,'{}','${NOW}','${NOW}'
      );
      INSERT INTO collaboration_messages (
        id,project_id,run_id,author_type,author_agent_id,author_display_name,
        content,mention_agent_id,mention_display_name,sequence,consumed_at,created_at
      ) VALUES (
        'sandbox-plan-message','${PROJECT_ID}','${RUN_ID}','agent','sandbox-agent',
        'Agent','ready',NULL,NULL,1,NULL,'${NOW}'
      );
      INSERT INTO collaboration_attempts (
        id,project_id,run_id,agent_id,operation_id,status,lease_token,lease_expires_at,
        prompt_hash,acquire_execution_epoch,acquire_context_hash,included_message_sequence,
        error_category,started_at,finished_at
      ) VALUES (
        'sandbox-plan-attempt','${PROJECT_ID}','${RUN_ID}','sandbox-agent',
        'sandbox-plan-operation','committed','plan-lease','${NOW}','prompt',1,'context',
        1,NULL,'${NOW}','${NOW}'
      );
      INSERT INTO collaboration_turns (
        id,attempt_id,run_id,agent_id,round_number,message_id,disposition,created_at
      ) VALUES (
        'sandbox-plan-turn','sandbox-plan-attempt','${RUN_ID}','sandbox-agent',1,
        'sandbox-plan-message','plan_ready','${NOW}'
      );
      INSERT INTO collaboration_events (
        id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
      ) VALUES (
        'sandbox-claim','${RUN_ID}',1,'task_claimed','agent','sandbox-agent',
        '{"turnId":"sandbox-plan-turn","workItemId":"${WORK_ITEM_ID}","agentId":"sandbox-agent"}',
        '${NOW}'
      );
      INSERT INTO project_validation_policy_revisions (
        id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
        classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
      ) VALUES (
        'sandbox-policy','${PROJECT_ID}',NULL,'system',1,'${EMPTY_POLICY_HASH}',
        1,0,2,0,'${NOW}'
      );
      INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
      VALUES ('${PROJECT_ID}','sandbox-policy',1,'${NOW}');
    `);
    database.prepare(
      "UPDATE projects SET workspace_path=?,workspace_key=? WHERE id=?",
    ).run(workspace, workspace.toLocaleLowerCase("en-US"), PROJECT_ID);
  } finally {
    database.close();
  }
}

function addSecondEligibleTask(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO providers (
        id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
        credential_version,credential_generation,key_id,api_key_mask,verified_at,
        version,created_at,updated_at
      ) VALUES (
        'sandbox-provider-b','Provider B','http://127.0.0.1:4001/v1','model',
        'cipher','iv','tag',1,1,'key','***','${NOW}',1,'${NOW}','${NOW}'
      );
      INSERT INTO agents (
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
      ) VALUES (
        'sandbox-agent-b','Agent B','Builder','private','sandbox-provider-b','model','B','amber',
        1,1,1,1000,5,1,'${NOW}','${NOW}'
      );
      INSERT INTO project_memberships (project_id,agent_id,joined_at)
      VALUES ('${PROJECT_ID}','sandbox-agent-b','${NOW}');
      INSERT INTO work_items (
        id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
      ) VALUES (
        'sandbox-orchestrator-work-b','sandbox-mission','Work B','','in_progress',
        'sandbox-agent-b',1,'${NOW}','${NOW}'
      );
      INSERT INTO collaboration_operations (
        id,project_id,run_id,kind,request_hash,status,http_status,response_json,created_at,updated_at
      ) VALUES (
        'sandbox-plan-operation-b','${PROJECT_ID}','${RUN_ID}','advance','plan-hash-b',
        'completed',200,'{}','${NOW}','${NOW}'
      );
      INSERT INTO collaboration_messages (
        id,project_id,run_id,author_type,author_agent_id,author_display_name,
        content,mention_agent_id,mention_display_name,sequence,consumed_at,created_at
      ) VALUES (
        'sandbox-plan-message-b','${PROJECT_ID}','${RUN_ID}','agent','sandbox-agent-b',
        'Agent B','ready',NULL,NULL,2,NULL,'${NOW}'
      );
      INSERT INTO collaboration_attempts (
        id,project_id,run_id,agent_id,operation_id,status,lease_token,lease_expires_at,
        prompt_hash,acquire_execution_epoch,acquire_context_hash,included_message_sequence,
        error_category,started_at,finished_at
      ) VALUES (
        'sandbox-plan-attempt-b','${PROJECT_ID}','${RUN_ID}','sandbox-agent-b',
        'sandbox-plan-operation-b','committed','plan-lease-b','${NOW}','prompt-b',1,
        'context-b',2,NULL,'${NOW}','${NOW}'
      );
      INSERT INTO collaboration_turns (
        id,attempt_id,run_id,agent_id,round_number,message_id,disposition,created_at
      ) VALUES (
        'sandbox-plan-turn-b','sandbox-plan-attempt-b','${RUN_ID}','sandbox-agent-b',2,
        'sandbox-plan-message-b','plan_ready','${NOW}'
      );
      INSERT INTO collaboration_events (
        id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
      ) VALUES (
        'sandbox-claim-b','${RUN_ID}',2,'task_claimed','agent','sandbox-agent-b',
        '{"turnId":"sandbox-plan-turn-b","workItemId":"sandbox-orchestrator-work-b","agentId":"sandbox-agent-b"}',
        '${NOW}'
      );
    `);
  } finally {
    database.close();
  }
}

function input(operationId = OPERATION_ID, workItemId = WORK_ITEM_ID) {
  return { operationId, sourceCollaborationRunId: RUN_ID, workItemId };
}

async function startWith(
  executor = createProductionSandboxExecutor(),
  operationId = OPERATION_ID,
  workItemId = WORK_ITEM_ID,
) {
  return startExecution(
    databasePath,
    PROJECT_ID,
    input(operationId, workItemId),
    executor,
    executionRoot,
  );
}

function sandboxFacts(): {
  actionId: string;
  actionStatus: string;
  attemptStatus: string;
  baselineHash: string | null;
  executionStatus: string;
  leaseToken: string | null;
  operationStatus: string;
  sandboxRoot: string;
} {
  const database = openDatabase(databasePath);
  try {
    return database.prepare(`
      SELECT x.status AS executionStatus,t.status AS attemptStatus,
             t.baseline_manifest_hash AS baselineHash,t.sandbox_root AS sandboxRoot,
             a.id AS actionId,a.status AS actionStatus,a.lease_token AS leaseToken,
             o.status AS operationStatus
      FROM executions x
      JOIN execution_attempts t ON t.execution_id=x.id
      JOIN execution_actions a ON a.attempt_id=t.id
      JOIN execution_operations o ON o.project_id=x.project_id AND o.id=a.operation_id
      ORDER BY x.created_at,x.id LIMIT 1
    `).get() as ReturnType<typeof sandboxFacts>;
  } finally {
    database.close();
  }
}

function deferred() {
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { entered, enteredPromise, promise, release };
}

async function postStart(operationId = OPERATION_ID, workItemId = WORK_ITEM_ID): Promise<Response> {
  const route = await import("@/app/api/projects/[projectId]/executions/route");
  return route.POST(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/executions`, {
      body: JSON.stringify({
        operationId,
        sourceCollaborationRunId: RUN_ID,
        workItemId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ projectId: PROJECT_ID }) },
  );
}

describe("production sandbox executor orchestration", () => {
  it("starts through the public route without a test executor override", async () => {
    const response = await postStart();

    expect(response.status).toBe(201);
    const body = await response.json() as { execution: { id: string; status: string } };
    expect(body.execution.status).toBe("queued");

    const database = openDatabase(databasePath);
    try {
      const attempt = database.prepare(`
        SELECT status,sandbox_root AS sandboxRoot,baseline_manifest_path AS manifestPath,
               baseline_manifest_hash AS baselineHash,sandbox_manifest_hash AS sandboxHash
        FROM execution_attempts WHERE execution_id=?
      `).get(body.execution.id) as {
        baselineHash: string;
        manifestPath: string;
        sandboxHash: string;
        sandboxRoot: string;
        status: string;
      };
      expect(attempt.status).toBe("ready");
      expect(attempt.baselineHash).toBe(attempt.sandboxHash);
      expect(existsSync(attempt.manifestPath)).toBe(true);
      expect(readFileSync(join(attempt.sandboxRoot, "README.md"), "utf8"))
        .toBe("canonical stays unchanged\n");
      expect(database.prepare(
        "SELECT status FROM execution_actions WHERE execution_id=?",
      ).get(body.execution.id)).toEqual({ status: "succeeded" });
      expect(database.prepare(`
        SELECT status,http_status AS httpStatus FROM execution_operations
        WHERE project_id=? AND id=?
      `).get(PROJECT_ID, OPERATION_ID)).toEqual({ status: "completed", httpStatus: 201 });
    } finally {
      database.close();
    }
    expect(readFileSync(join(workspace, "README.md"), "utf8"))
      .toBe("canonical stays unchanged\n");
  });

  it("persists the exact preflight failure without exposing a partial success", async () => {
    const base = createWindowsNativeReadAdapter();
    const result = await startWith(createProductionSandboxExecutor({
      async createAdapter() {
        return {
          ...base,
          list(handle: Parameters<typeof base.list>[0]) {
            return base.list(handle).map((entry, index) => index === 0
              ? {
                  ...entry,
                  attributes: { ...entry.attributes, reparsePoint: true },
                }
              : entry);
          },
        };
      },
    }));

    expect(result).toMatchObject({
      body: { error: { code: "SPECIAL_FILE_REJECTED" } },
      status: 422,
    });
    expect(sandboxFacts()).toMatchObject({
      actionStatus: "failed",
      attemptStatus: "interrupted",
      baselineHash: null,
      executionStatus: "paused",
      operationStatus: "completed",
    });
    expect(existsSync(sandboxFacts().sandboxRoot)).toBe(false);
  });

  it.each(["after-action", "after-attempt"] as const)(
    "rolls back all four success facts when finalization faults %s",
    async (faultPhase) => {
      await expect(startWith(createProductionSandboxExecutor({
        onPhase(phase) {
          if (phase === faultPhase) throw new Error(`fault at ${phase}`);
        },
      }))).rejects.toThrow(`fault at ${faultPhase}`);

      expect(sandboxFacts()).toMatchObject({
        actionStatus: "running",
        attemptStatus: "preparing",
        baselineHash: null,
        executionStatus: "queued",
        operationStatus: "pending",
      });
    },
  );

  it("reopens and reconciles a crash after verified rename", async () => {
    await expect(startWith(createProductionSandboxExecutor({
      onPhase(phase) {
        if (phase === "after-snapshot") throw new Error("simulated process exit");
      },
    }))).rejects.toThrow("simulated process exit");

    const before = sandboxFacts();
    expect(existsSync(before.sandboxRoot)).toBe(true);
    const adapter = createWindowsNativeReadAdapter();
    const handle = adapter.openRootDirectory(before.sandboxRoot);
    const identity = adapter.identity(handle);
    adapter.close(handle);
    expect(await cleanupOwnedSandbox({
      expectedRootIdentity: `${identity.volumeSerialNumber}:${identity.fileId}`,
      platform: adapter,
      sandboxRoot: before.sandboxRoot,
    })).toBe(true);

    let database = openDatabase(databasePath);
    database.prepare(`
      UPDATE execution_actions
      SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second')
      WHERE id=?
    `).run(before.actionId);
    database.close();
    database = openDatabase(databasePath);
    try {
      expect(reconcileSandboxBuildAction(database, {
        actionId: before.actionId,
        body: { error: { code: "SANDBOX_ACTION_INTERRUPTED", message: "Sandbox build interrupted." } },
        cleanupConfirmed: true,
        httpStatus: 409,
        projectId: PROJECT_ID,
        reason: "SANDBOX_ACTION_INTERRUPTED",
      })).toEqual({ affectedRows: 1 });
    } finally {
      database.close();
    }
    expect(sandboxFacts()).toMatchObject({
      actionStatus: "interrupted",
      attemptStatus: "interrupted",
      executionStatus: "paused",
      operationStatus: "completed",
    });
    expect(existsSync(before.sandboxRoot)).toBe(false);
  });

  it("replays the committed 201 after the first response is lost", async () => {
    let snapshots = 0;
    const executor = createProductionSandboxExecutor({
      onPhase(phase) {
        if (phase === "after-snapshot") snapshots += 1;
        if (phase === "after-commit") throw new Error("response transport lost");
      },
    });
    await expect(startWith(executor)).rejects.toThrow("response transport lost");

    expect(sandboxFacts()).toMatchObject({
      actionStatus: "succeeded",
      attemptStatus: "ready",
      operationStatus: "completed",
    });
    const replay = await startWith(executor);
    expect(replay.status).toBe(201);
    expect(snapshots).toBe(1);
  });

  it("lets reconcile defeat a late finalizer without restoring ready or 201", async () => {
    const hold = deferred();
    const executor = createProductionSandboxExecutor({
      onPhase(phase) {
        if (phase === "after-manifest") {
          hold.entered();
          return hold.promise;
        }
      },
    });
    const late = startWith(executor);
    await hold.enteredPromise;
    const before = sandboxFacts();
    const adapter = createWindowsNativeReadAdapter();
    const handle = adapter.openRootDirectory(before.sandboxRoot);
    const identity = adapter.identity(handle);
    adapter.close(handle);
    expect(await cleanupOwnedSandbox({
      expectedRootIdentity: `${identity.volumeSerialNumber}:${identity.fileId}`,
      platform: adapter,
      sandboxRoot: before.sandboxRoot,
    })).toBe(true);
    const database = openDatabase(databasePath);
    try {
      database.prepare(`
        UPDATE execution_actions
        SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second')
        WHERE id=?
      `).run(before.actionId);
      expect(reconcileSandboxBuildAction(database, {
        actionId: before.actionId,
        body: { error: { code: "SANDBOX_ACTION_INTERRUPTED", message: "Sandbox build interrupted." } },
        cleanupConfirmed: true,
        httpStatus: 409,
        projectId: PROJECT_ID,
        reason: "SANDBOX_ACTION_INTERRUPTED",
      })).toEqual({ affectedRows: 1 });
    } finally {
      database.close();
    }
    hold.release();
    await expect(late).rejects.toMatchObject({ code: "SANDBOX_ACTION_INTERRUPTED" });
    expect(sandboxFacts()).toMatchObject({
      actionStatus: "interrupted",
      attemptStatus: "interrupted",
      baselineHash: null,
      executionStatus: "paused",
      operationStatus: "completed",
    });
  });

  it("runs one snapshot for same-operation concurrency and then replays 201", async () => {
    const hold = deferred();
    let snapshots = 0;
    const executor = createProductionSandboxExecutor({
      onPhase(phase) {
        if (phase === "after-snapshot") {
          snapshots += 1;
          hold.entered();
          return hold.promise;
        }
      },
    });
    const first = startWith(executor);
    await hold.enteredPromise;
    await expect(startWith(executor)).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
    hold.release();
    expect((await first).status).toBe(201);
    expect((await startWith(executor)).status).toBe(201);
    expect(snapshots).toBe(1);
  });

  it("creates two independent sandboxes for different eligible operations", async () => {
    addSecondEligibleTask();
    const secondOperation = "00000000-0000-4000-8000-000000000041";
    const [first, second] = await Promise.all([
      postStart(),
      postStart(secondOperation, "sandbox-orchestrator-work-b"),
    ]);

    expect([first.status, second.status]).toEqual([201, 201]);
    const database = openDatabase(databasePath);
    try {
      const attempts = database.prepare(`
        SELECT status,sandbox_root AS sandboxRoot
        FROM execution_attempts ORDER BY sandbox_root
      `).all() as Array<{ sandboxRoot: string; status: string }>;
      expect(attempts).toHaveLength(2);
      expect(new Set(attempts.map(({ sandboxRoot }) => sandboxRoot)).size).toBe(2);
      for (const attempt of attempts) {
        expect(attempt.status).toBe("ready");
        expect(readFileSync(join(attempt.sandboxRoot, "README.md"), "utf8"))
          .toBe("canonical stays unchanged\n");
      }
    } finally {
      database.close();
    }
  });
});
