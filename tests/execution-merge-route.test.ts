import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import {
  setMergeExecutionAdapterForTests,
  setMergeExecutionHooksForTests,
} from "@/src/server/execution/merge-service";
import { ExecutionError } from "@/src/server/execution/execution-service";
import { createWindowsVerifiedMergeAdapter } from "@/src/server/execution/merge-verified-adapter";
import { saveValidationPolicy } from "@/src/server/execution/validation-policy-service";
import { recoveryMergeFileStatuses } from "@/src/shared/execution-contracts";
import { execV7Fixture } from "@/tests/v7-fixture-graph";

const PROJECT_ID = "merge-route-project";
const RUN_ID = "merge-route-run";
const WORK_ITEM_ID = "merge-route-work";
const MASTER_KEY = Buffer.alloc(32, 45).toString("base64url");
const EMPTY_POLICY_HASH =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const NOW = "2026-08-01T04:00:00.000Z";

let root: string;
let workspace: string;
let executionRoot: string;
let databasePath: string;
let mergePoints: string[];
let sourceThreadId: string;

const operationId = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function providerResponse(action: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          action,
          summary: `perform ${String(action.type)}`,
        }),
      },
    }],
    usage: { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 },
  }), { headers: { "content-type": "application/json" }, status: 200 });
}

function seedEligibleTask(): void {
  const credential = createCredentialVault().encrypt("merge-route-provider", "test-secret");
  const database = openDatabase(databasePath);
  try {
    sourceThreadId = execV7Fixture(databasePath, database, `
      INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
      VALUES ('${PROJECT_ID}','Merge route','${NOW}','placeholder','placeholder',1);
      INSERT INTO providers (
        id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
        credential_version,credential_generation,key_id,api_key_mask,verified_at,
        version,created_at,updated_at
      ) VALUES (
        'merge-route-provider','Provider','http://provider.example/v1','model',
        '${credential.apiKeyCipher}','${credential.apiKeyIv}','${credential.apiKeyTag}',
        1,1,'${credential.keyId}','${credential.apiKeyMask}','${NOW}',1,'${NOW}','${NOW}'
      );
      INSERT INTO agents (
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
      ) VALUES (
        'merge-route-agent','Agent','Builder','private','merge-route-provider','model','A','sage',
        1,1,1,10000,5,1,'${NOW}','${NOW}'
      );
      INSERT INTO project_memberships (project_id,agent_id,joined_at)
      VALUES ('${PROJECT_ID}','merge-route-agent','${NOW}');
      INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
      VALUES ('merge-route-mission','${PROJECT_ID}','Mission','Ship',1,'${NOW}','${NOW}');
      INSERT INTO mission_delivery_heads(
        mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
        generation_lease_token,generation_lease_expires_at,last_error_code,
        next_event_sequence,version,updated_at
      ) VALUES ('merge-route-mission','${PROJECT_ID}',1,'ongoing',
        NULL,NULL,NULL,NULL,NULL,2,1,'${NOW}');
      INSERT INTO review_events(
        id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
      ) VALUES ('merge-route-review-init','${PROJECT_ID}','merge-route-mission',1,
        'mission_review_initialized','system',NULL,
        '{"contextVersion":1,"headVersion":1,"missionId":"merge-route-mission"}','${NOW}');
      INSERT INTO work_items (
        id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
      ) VALUES (
        '${WORK_ITEM_ID}','merge-route-mission','Merge route work','','in_progress',
        'merge-route-agent',1,'${NOW}','${NOW}'
      );
      INSERT INTO collaboration_runs (
        id,project_id,status,current_agent_id,round_count,next_event_sequence,
        version,execution_epoch,pause_reason,pause_category,created_at,updated_at
      ) VALUES (
        '${RUN_ID}','${PROJECT_ID}','planned','merge-route-agent',1,2,1,1,NULL,NULL,
        '${NOW}','${NOW}'
      );
      INSERT INTO collaboration_project_sequences (project_id,next_message_sequence)
      VALUES ('${PROJECT_ID}',2);
      INSERT INTO collaboration_operations (
        id,project_id,run_id,kind,request_hash,status,http_status,response_json,created_at,updated_at
      ) VALUES (
        'merge-route-plan-operation','${PROJECT_ID}','${RUN_ID}','advance','plan-hash',
        'completed',200,'{}','${NOW}','${NOW}'
      );
      INSERT INTO collaboration_messages (
        id,project_id,run_id,author_type,author_agent_id,author_display_name,
        content,mention_agent_id,mention_display_name,sequence,consumed_at,created_at
      ) VALUES (
        'merge-route-plan-message','${PROJECT_ID}','${RUN_ID}','agent','merge-route-agent',
        'Agent','ready',NULL,NULL,1,NULL,'${NOW}'
      );
      INSERT INTO collaboration_attempts (
        id,project_id,run_id,agent_id,operation_id,status,lease_token,lease_expires_at,
        prompt_hash,acquire_execution_epoch,acquire_context_hash,included_message_sequence,
        error_category,started_at,finished_at
      ) VALUES (
        'merge-route-plan-attempt','${PROJECT_ID}','${RUN_ID}','merge-route-agent',
        'merge-route-plan-operation','committed','plan-lease','${NOW}','prompt',1,'context',
        1,NULL,'${NOW}','${NOW}'
      );
      INSERT INTO collaboration_turns (
        id,attempt_id,run_id,agent_id,round_number,message_id,disposition,created_at
      ) VALUES (
        'merge-route-plan-turn','merge-route-plan-attempt','${RUN_ID}','merge-route-agent',1,
        'merge-route-plan-message','plan_ready','${NOW}'
      );
      INSERT INTO collaboration_events (
        id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
      ) VALUES (
        'merge-route-claim','${RUN_ID}',1,'task_claimed','agent','merge-route-agent',
        '{"turnId":"merge-route-plan-turn","workItemId":"${WORK_ITEM_ID}","agentId":"merge-route-agent"}',
        '${NOW}'
      );
      INSERT INTO project_validation_policy_revisions (
        id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
        classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
      ) VALUES (
        'merge-route-policy','${PROJECT_ID}',NULL,'system',1,'${EMPTY_POLICY_HASH}',
        1,0,2,0,'${NOW}'
      );
      INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
      VALUES ('${PROJECT_ID}','merge-route-policy',1,'${NOW}');
    `).get(PROJECT_ID)!;
    database.prepare(
      "UPDATE projects SET workspace_path=?,workspace_key=? WHERE id=?",
    ).run(workspace, workspace.toLocaleLowerCase("en-US"), PROJECT_ID);
  } finally {
    database.close();
  }
}

async function postStart(): Promise<Response> {
  const route = await import("@/app/api/projects/[projectId]/executions/route");
  return route.POST(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/executions`, {
      body: JSON.stringify({
        operationId: operationId(1),
        source: {
          projectId: PROJECT_ID,
          runId: RUN_ID,
          threadId: sourceThreadId,
        },
        workItemId: WORK_ITEM_ID,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ projectId: PROJECT_ID }) },
  );
}

async function getDetail(executionId: string) {
  const route = await import("@/app/api/executions/[executionId]/route");
  const response = await route.GET(
    new Request(`http://localhost/api/executions/${executionId}`),
    { params: Promise.resolve({ executionId }) },
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    execution: { manualRecoveryRequired: boolean; status: string; version: number };
    recovery: {
      journalId: string | null;
      journalStatus: string | null;
      mismatchPathKey: string | null;
      mismatchPhase: string | null;
      observedManifestHash: string | null;
      oldManifestHash: string | null;
      postManifestHash: string | null;
      required: boolean;
    };
    staged: { stagedHash: string } | null;
  }>;
}

async function getRecoveryFiles(executionId: string): Promise<Response> {
  const route = await import("@/app/api/executions/[executionId]/recovery/files/route");
  return route.GET(
    new Request(`http://localhost/api/executions/${executionId}/recovery/files?limit=20`),
    { params: Promise.resolve({ executionId }) },
  );
}

async function postAdvance(
  executionId: string,
  expectedVersion: number,
  operation: number,
): Promise<Response> {
  const route = await import("@/app/api/executions/[executionId]/advance/route");
  return route.POST(
    new Request(`http://localhost/api/executions/${executionId}/advance`, {
      body: JSON.stringify({ expectedVersion, operationId: operationId(operation) }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ executionId }) },
  );
}

async function postApproval(
  executionId: string,
  approvalId: string,
  expectedVersion: number,
): Promise<Response> {
  const route = await import("@/app/api/executions/[executionId]/approvals/[approvalId]/route");
  return route.POST(
    new Request(`http://localhost/api/executions/${executionId}/approvals/${approvalId}`, {
      body: JSON.stringify({
        action: "approve",
        expectedVersion,
        operationId: operationId(7),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ approvalId, executionId }) },
  );
}

async function createRealStagedExecution(): Promise<{
  executionId: string;
  stagedHash: string;
  version: number;
}> {
  const start = await postStart();
  expect(start.status).toBe(201);
  const started = await start.json() as { execution: { id: string } };
  const executionId = started.execution.id;
  let detail = await getDetail(executionId);

  for (const operation of [2, 3, 4, 5]) {
    const response = await postAdvance(executionId, detail.execution.version, operation);
    const failure = response.ok ? null : await response.clone().json();
    expect({ failure, operation, status: response.status }).toEqual({
      failure: null,
      operation,
      status: 200,
    });
    detail = await getDetail(executionId);
  }

  expect(detail.execution.status).toBe("staged");
  expect(detail.staged?.stagedHash).toMatch(/^[0-9a-f]{64}$/u);

  const approvalsRoute = await import("@/app/api/executions/[executionId]/approvals/route");
  const approvalsResponse = await approvalsRoute.GET(
    new Request(`http://localhost/api/executions/${executionId}/approvals`),
    { params: Promise.resolve({ executionId }) },
  );
  const approvals = await approvalsResponse.json() as {
    items: Array<{ id: string; kind: string; status: string }>;
  };
  const approval = approvals.items.find(({ kind, status }) =>
    kind === "staged_merge" && status === "pending");
  expect(approval).toBeDefined();
  const approved = await postApproval(executionId, approval!.id, detail.execution.version);
  expect(approved.status).toBe(200);
  detail = await getDetail(executionId);
  return {
    executionId,
    stagedHash: detail.staged!.stagedHash,
    version: detail.execution.version,
  };
}

async function postMerge(
  executionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const routes = import.meta.glob("../app/api/executions/[executionId]/merge/route.ts");
  const load = routes["../app/api/executions/[executionId]/merge/route.ts"];
  if (!load) {
    return Response.json(
      { error: { code: "ROUTE_NOT_FOUND", message: "Merge route is unavailable." } },
      { status: 404 },
    );
  }
  const route = await load() as {
    POST(request: Request, context: { params: Promise<{ executionId: string }> }): Promise<Response>;
  };
  return route.POST(
    new Request(`http://localhost/api/executions/${executionId}/merge`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ executionId }) },
  );
}

async function postRecovery(
  executionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const route = await import("@/app/api/executions/[executionId]/recovery/resolve/route");
  return route.POST(
    new Request(`http://localhost/api/executions/${executionId}/recovery/resolve`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ executionId }) },
  );
}

beforeEach(() => {
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  root = mkdtempSync(join(tmpdir(), "cool-ai-merge-route-"));
  workspace = join(root, "workspace");
  executionRoot = join(root, "executions");
  databasePath = join(root, "cockpit.sqlite");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "src"));
  mkdirSync(executionRoot);
  writeFileSync(join(workspace, "README.md"), "before\n");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_EXECUTION_ROOT = executionRoot;
  seedEligibleTask();
  mergePoints = [];
  setMergeExecutionHooksForTests({
    point({ point }) {
      mergePoints.push(point);
    },
  });
  const commandArgs = [
    "-e",
    'require("node:fs").writeFileSync("src/RESULT.md", "after\\n")',
  ];
  const policy = saveValidationPolicy(databasePath, PROJECT_ID, {
    entries: [{
      args: commandArgs,
      executable: process.execPath,
      required: false,
      workdir: ".",
    }],
    expectedVersion: 1,
    operationId: operationId(90),
    warningAccepted: true,
  });
  expect(policy.outcome).toBe("saved");
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(providerResponse({
      args: commandArgs,
      executable: process.execPath,
      expectedEffect: "Write the merge fixture result.",
      type: "command",
      workdir: ".",
    }))
    .mockResolvedValueOnce(providerResponse({ type: "staged" })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMergeExecutionAdapterForTests(undefined);
  setMergeExecutionHooksForTests(undefined);
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_EXECUTION_ROOT;
  delete process.env.COCKPIT_MASTER_KEY;
  if (existsSync(root)) rmSync(root, { force: true, recursive: true });
});

describe("T-45 production merge route", () => {
  it("merges a real staged execution reached only through public production routes", async () => {
    const staged = await createRealStagedExecution();
    expect(existsSync(join(workspace, "src", "RESULT.md"))).toBe(false);
    const wrongRoute = await postAdvance(staged.executionId, staged.version, 27);
    expect(wrongRoute.status).toBe(409);
    expect(await wrongRoute.json()).toMatchObject({
      error: { code: "EXECUTION_STATE_CONFLICT" },
    });

    const response = await postMerge(staged.executionId, {
      expectedVersion: staged.version,
      operationId: operationId(8),
      stagedHash: staged.stagedHash,
    });

    const body = await response.json();
    const database = openDatabase(databasePath);
    const journal = database.prepare(`
      SELECT status,mismatch_phase AS mismatchPhase,error_code AS errorCode,
             observed_manifest_hash AS observedManifestHash,
             old_manifest_hash AS oldManifestHash,post_manifest_hash AS postManifestHash
      FROM execution_merge_journals WHERE execution_id=?
    `).get(staged.executionId);
    database.close();
    expect({ body, journal, mergePoints, status: response.status }).toMatchObject({
      status: 200,
      journal: { errorCode: null, mismatchPhase: null, status: "completed" },
      mergePoints: expect.arrayContaining(["before_finalize"]),
      body: {
      execution: { id: staged.executionId, status: "merged" },
      result: { status: "awaiting_review" },
      },
    });
    expect(readFileSync(join(workspace, "src", "RESULT.md"), "utf8")).toBe("after\n");
  });

  it("strictly rejects unknown and oversized input before creating an operation", async () => {
    const unknown = await postMerge("missing", {
      expectedVersion: 1,
      extra: true,
      operationId: operationId(20),
      stagedHash: "a".repeat(64),
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });

    const oversized = await postMerge("missing", {
      expectedVersion: 1,
      operationId: operationId(21),
      padding: "x".repeat(128 * 1024),
      stagedHash: "a".repeat(64),
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });

    const database = openDatabase(databasePath);
    expect(database.prepare(
      "SELECT count(*) AS count FROM execution_operations WHERE kind='merge'",
    ).get()).toEqual({ count: 0 });
    database.close();
  });

  it("replays the exact successful receipt once and rejects a changed payload", async () => {
    const staged = await createRealStagedExecution();
    const request = {
      expectedVersion: staged.version,
      operationId: operationId(22),
      stagedHash: staged.stagedHash,
    };
    const first = await postMerge(staged.executionId, request);
    const firstText = await first.text();
    expect(first.status).toBe(200);
    const replay = await postMerge(staged.executionId, request);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstText);

    const conflict = await postMerge(staged.executionId, {
      ...request,
      expectedVersion: staged.version + 1,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "OPERATION_CONFLICT" } });

    const database = openDatabase(databasePath);
    expect(database.prepare(`
      SELECT
        (SELECT count(*) FROM execution_operations WHERE id=?) AS operations,
        (SELECT count(*) FROM execution_actions WHERE operation_id=?) AS actions,
        (SELECT count(*) FROM execution_merge_journals WHERE operation_id=?) AS journals
    `).get(request.operationId, request.operationId, request.operationId)).toEqual({
      actions: 1,
      journals: 1,
      operations: 1,
    });
    database.close();
  });

  it("durably maps a normal pre-acquire conflict and replays it without side effects", async () => {
    const staged = await createRealStagedExecution();
    const request = {
      expectedVersion: staged.version + 1,
      operationId: operationId(23),
      stagedHash: staged.stagedHash,
    };
    const first = await postMerge(staged.executionId, request);
    const firstText = await first.text();
    expect(first.status).toBe(409);
    expect(JSON.parse(firstText)).toMatchObject({
      error: { code: "EXECUTION_STATE_CONFLICT" },
    });
    const replay = await postMerge(staged.executionId, request);
    expect(await replay.text()).toBe(firstText);

    const database = openDatabase(databasePath);
    expect(database.prepare(`
      SELECT has_external_actions AS hasExternalActions,status,http_status AS httpStatus
      FROM execution_operations WHERE id=?
    `).get(request.operationId)).toEqual({
      hasExternalActions: 0,
      httpStatus: 409,
      status: "completed",
    });
    expect(database.prepare(
      "SELECT count(*) AS count FROM execution_actions WHERE operation_id=?",
    ).get(request.operationId)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM execution_merge_journals WHERE operation_id=?",
    ).get(request.operationId)).toEqual({ count: 0 });
    database.close();
  });

  it("turns repeatable capability preflight failure into one completed 422 receipt", async () => {
    const staged = await createRealStagedExecution();
    const base = createWindowsVerifiedMergeAdapter();
    let preflights = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    setMergeExecutionAdapterForTests({
      ...base,
      async assertCapability() {
        preflights += 1;
        if (preflights === 2) release();
        await bothEntered;
        throw new ExecutionError(
          "SANDBOX_UNVERIFIABLE",
          422,
          "Injected capability failure.",
        );
      },
    });
    const request = {
      expectedVersion: staged.version,
      operationId: operationId(24),
      stagedHash: staged.stagedHash,
    };
    const [first, concurrent] = await Promise.all([
      postMerge(staged.executionId, request),
      postMerge(staged.executionId, request),
    ]);
    const firstText = await first.text();
    expect(first.status).toBe(422);
    expect(JSON.parse(firstText)).toMatchObject({ error: { code: "SANDBOX_UNVERIFIABLE" } });
    expect(concurrent.status).toBe(422);
    expect(await concurrent.text()).toBe(firstText);
    const replay = await postMerge(staged.executionId, request);
    expect(await replay.text()).toBe(firstText);
    expect(preflights).toBe(2);

    const database = openDatabase(databasePath);
    expect(database.prepare(`
      SELECT has_external_actions AS hasExternalActions,status,http_status AS httpStatus
      FROM execution_operations WHERE id=?
    `).get(request.operationId)).toEqual({
      hasExternalActions: 0,
      httpStatus: 422,
      status: "completed",
    });
    expect(database.prepare(
      "SELECT count(*) AS count FROM execution_actions WHERE operation_id=?",
    ).get(request.operationId)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM execution_merge_journals WHERE operation_id=?",
    ).get(request.operationId)).toEqual({ count: 0 });
    database.close();
  });

  it("reads durable manual detail and files before resolving only through public routes", async () => {
    const staged = await createRealStagedExecution();
    let injected = false;
    setMergeExecutionHooksForTests({
      point({ path, point }) {
        if (!injected && point === "after_replace" && path === "src/RESULT.md") {
          injected = true;
          writeFileSync(join(workspace, "src", "RESULT.md"), "external\n");
        }
      },
    });
    const merge = await postMerge(staged.executionId, {
      expectedVersion: staged.version,
      operationId: operationId(25),
      stagedHash: staged.stagedHash,
    });
    expect(merge.status).toBe(409);
    expect(await merge.json()).toMatchObject({ error: { code: "MANUAL_RECOVERY_REQUIRED" } });
    expect(readFileSync(join(workspace, "src", "RESULT.md"), "utf8")).toBe("external\n");

    const recovery = await getDetail(staged.executionId);
    expect(recovery).toMatchObject({
      execution: {
        manualRecoveryRequired: true,
        status: "conflicted",
      },
      recovery: {
        journalId: expect.any(String),
        journalStatus: "manual_recovery",
        mismatchPathKey: "src/result.md",
        mismatchPhase: expect.any(String),
        observedManifestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        oldManifestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        postManifestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        required: true,
      },
    });
    const filesResponse = await getRecoveryFiles(staged.executionId);
    expect(filesResponse.status).toBe(200);
    expect(await filesResponse.json()).toMatchObject({
      items: [{
        isMismatch: true,
        oldHash: null,
        path: "src/RESULT.md",
        pathKey: "src/result.md",
        postHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }],
    });

    const ordinaryMutation = await postAdvance(
      staged.executionId,
      recovery.execution.version,
      27,
    );
    expect(ordinaryMutation.status).toBe(409);
    expect(await ordinaryMutation.json()).toMatchObject({
      error: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    const listRoute = await import("@/app/api/projects/[projectId]/executions/route");
    const listResponse = await listRoute.GET(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/executions`),
      { params: Promise.resolve({ projectId: PROJECT_ID }) },
    );
    expect(listResponse.status).toBe(409);
    expect(await listResponse.json()).toMatchObject({
      error: { code: "MERGE_RECOVERY_REQUIRED" },
    });
    setMergeExecutionHooksForTests(undefined);

    const resolved = await postRecovery(staged.executionId, {
      action: "abandon",
      expectedVersion: recovery.execution.version,
      observedManifestHash: recovery.recovery.observedManifestHash,
      operationId: operationId(26),
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      execution: { id: staged.executionId, status: "stopped" },
      recovery: { journalStatus: "abandoned" },
    });
    expect(readFileSync(join(workspace, "src", "RESULT.md"), "utf8")).toBe("external\n");
  });

  it("returns a real temp_ready manual file through the public recovery route", async () => {
    const staged = await createRealStagedExecution();
    let injected = false;
    setMergeExecutionHooksForTests({
      point({ path, point }) {
        if (!injected && point === "after_temp_write" && path === "src/RESULT.md") {
          injected = true;
          throw new ExecutionError(
            "MERGE_RECOVERY_REQUIRED",
            409,
            "fault after durable canonical temp registration",
          );
        }
      },
    });

    const merge = await postMerge(staged.executionId, {
      expectedVersion: staged.version,
      operationId: operationId(47),
      stagedHash: staged.stagedHash,
    });
    expect(merge.status).toBe(409);
    expect(await merge.json()).toMatchObject({
      error: { code: "MANUAL_RECOVERY_REQUIRED" },
    });

    const detail = await getDetail(staged.executionId);
    expect(detail.recovery.journalStatus).toBe("manual_recovery");
    const filesResponse = await getRecoveryFiles(staged.executionId);
    expect(filesResponse.status).toBe(200);
    expect(await filesResponse.json()).toMatchObject({
      items: [{
        path: "src/RESULT.md",
        status: "temp_ready",
      }],
    });

    const descriptorDatabase = new DatabaseSync(databasePath);
    const descriptors = descriptorDatabase.prepare(`
      SELECT canonical_temp_ref_json AS tempRef,post_target_ref_json AS postTarget
      FROM execution_merge_files
    `).get() as { postTarget: string; tempRef: string };
    descriptorDatabase.close();
    for (const status of recoveryMergeFileStatuses) {
      const changed = new DatabaseSync(databasePath);
      changed.prepare(`
        UPDATE execution_merge_files
        SET status=?,canonical_temp_ref_json=?,post_target_ref_json=?
      `).run(
        status,
        status === "pending" ? null : descriptors.tempRef,
        status === "pending" ? null : descriptors.postTarget,
      );
      changed.close();

      const parsed = await getRecoveryFiles(staged.executionId);
      expect(parsed.status).toBe(200);
      expect(await parsed.json()).toMatchObject({ items: [{ status }] });
    }

    for (const invalidStatus of ["unknown", "TEMP_READY", "Temp_Ready", "pending"]) {
      const corrupt = new DatabaseSync(databasePath);
      corrupt.exec("PRAGMA ignore_check_constraints=ON");
      corrupt.prepare(`
        UPDATE execution_merge_files
        SET status=?,canonical_temp_ref_json=?,post_target_ref_json=?
      `).run(invalidStatus, descriptors.tempRef, descriptors.postTarget);
      corrupt.close();

      const rejected = await getRecoveryFiles(staged.executionId);
      expect(rejected.status).toBe(500);
      expect(await rejected.text()).not.toContain(invalidStatus);

      const restore = new DatabaseSync(databasePath);
      restore.exec("PRAGMA ignore_check_constraints=ON");
      restore.prepare(`
        UPDATE execution_merge_files
        SET status='temp_ready',canonical_temp_ref_json=?,post_target_ref_json=?
      `).run(descriptors.tempRef, descriptors.postTarget);
      restore.close();
    }

    openDatabase(databasePath).close();
    const reopened = await getRecoveryFiles(staged.executionId);
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({
      items: [{ status: "temp_ready" }],
    });
  });
});
