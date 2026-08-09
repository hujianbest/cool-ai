import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import { captureExecutionFrozenInput } from "@/src/server/execution/execution-frozen-input";
import {
  controlExecution,
  type ExecutionControlDependencies,
} from "@/src/server/execution/execution-control-service";
import { execV7Fixture } from "@/tests/fixtures/execution/current-graph";

type Identity = {
  finalPath: string;
  identity: string;
  kind: "directory" | "file" | "link" | "reparse" | "special";
  size: number;
};
type Node = { children?: Map<string, Node>; identity: Identity; bytes?: Uint8Array };
type Handle = { node: Node; opened: Identity };

class ReadOnlyAdapter {
  constructor(private readonly root: Node) {}
  async openRootDirectory(): Promise<Handle> {
    return { node: this.root, opened: { ...this.root.identity } };
  }
  async list(handle: Handle) {
    return [...(handle.node.children ?? new Map()).entries()].map(([name, node]) => ({
      identity: node.identity.identity,
      name,
    }));
  }
  async openChildNoFollow(parent: Handle, name: string): Promise<Handle> {
    const node = parent.node.children?.get(name);
    if (!node) throw new Error("missing");
    return { node, opened: { ...node.identity } };
  }
  async identity(handle: Handle): Promise<Identity> {
    return { ...handle.opened };
  }
  async currentIdentity(handle: Handle): Promise<Identity> {
    return { ...handle.node.identity };
  }
  async readFromHandle(handle: Handle, maximumBytes: number): Promise<Uint8Array> {
    return (handle.node.bytes ?? new Uint8Array()).slice(0, maximumBytes);
  }
  async close(): Promise<void> {}
}

type AdvanceModule = {
  advanceExecution(
    databasePath: string,
    executionId: string,
    input: unknown,
    dependencies: {
      fileAdapter: ReadOnlyAdapter;
      modelFaultInjector?: (point:
        | "after_call_terminal_commit"
        | "after_call_terminal_update"
        | "before_call_terminal_update") => void;
      onModelStarted?: (executionId: string) => void;
    },
  ): Promise<{ body: Record<string, unknown>; status: number }>;
};

type ApprovalModule = {
  decideExecutionApproval(
    databasePath: string,
    executionId: string,
    approvalId: string,
    input: {
      action: "approve";
      expectedVersion: number;
      operationId: string;
    },
  ): Promise<{ body: Record<string, unknown>; status: number }>;
};

const PROJECT_ID = "orchestrator-project";
const EXECUTION_ID = "execution-a";
const SECOND_EXECUTION_ID = "execution-b";
const HASH = "a".repeat(64);
const MASTER_KEY = Buffer.alloc(32, 41).toString("base64url");
const SANDBOX_ROOT = "verified://sandbox";
const operationId = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

let directory: string;
let databasePath: string;
let database: DatabaseSync;
let advance: AdvanceModule;
let approvals: ApprovalModule;
let adapter: ReadOnlyAdapter;
let servers: Server[];

function identity(value: string, kind: Identity["kind"], finalPath: string, size = 0): Identity {
  return { finalPath, identity: value, kind, size };
}

function seed(): void {
  const credential = createCredentialVault().encrypt("provider", "provider-secret");
  execV7Fixture(databasePath, database, `
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Orchestrator',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      'D:\\canonical','d:/canonical',1);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'provider','Provider','https://provider.example/v1','model',
      '${credential.apiKeyCipher}','${credential.apiKeyIv}','${credential.apiKeyTag}',
      1,1,'${credential.keyId}','${credential.apiKeyMask}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    );
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES
      ('agent-a','Agent A','Builder','private-a','provider','model','A','sage',
       1,1,1,100000,5,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ('agent-b','Agent B','Builder','private-b','provider','model','B','amber',
       1,1,1,100000,5,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO project_memberships (project_id,agent_id,joined_at) VALUES
      ('${PROJECT_ID}','agent-a',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ('${PROJECT_ID}','agent-b',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','${PROJECT_ID}','Mission','Ship',1,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES
      ('work-a','mission','Work A','Inspect','in_progress','agent-a',1,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      ('work-b','mission','Work B','Inspect','in_progress','agent-b',1,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO collaboration_runs (
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES ('run','${PROJECT_ID}','planned','agent-a',1,1,1,1,NULL,NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
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

function insertExecution(
  executionId: string,
  agentId: string,
  workItemId: string,
  attemptId: string,
): void {
  database.exec(`
    INSERT INTO executions (
      id,project_id,source_collaboration_run_id,source_collaboration_thread_id,
      mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES (
      '${executionId}','${PROJECT_ID}','run',(
        SELECT thread_id FROM collaboration_runs WHERE project_id='${PROJECT_ID}' AND id='run'
      ),'mission','${workItemId}','${agentId}','policy',
      'queued',NULL,NULL,0,NULL,1,0,0,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      NULL,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL
    );
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES (
      '${attemptId}','${PROJECT_ID}','${executionId}',1,'ready','${SANDBOX_ROOT}',
      NULL,'${HASH}','${HASH}','{}','{}','${HASH}','policy',1,
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL
    );
  `);
  refreshFrozenExecution(agentId, workItemId, attemptId);
}

function refreshFrozenExecution(
  agentId: string,
  workItemId: string,
  attemptId: string,
): void {
  const frozen = captureExecutionFrozenInput(database, {
    agentId,
    baselineManifestHash: HASH,
    missionId: "mission",
    projectId: PROJECT_ID,
    source: {
      projectId: PROJECT_ID,
      runId: "run",
      threadId: (database.prepare(
        `SELECT thread_id AS threadId FROM collaboration_runs
         WHERE project_id=? AND id='run'`,
      ).get(PROJECT_ID) as { threadId: string }).threadId,
    },
    workItemId,
  });
  database.prepare(`
    UPDATE execution_attempts
    SET frozen_public_json=?,frozen_private_json=?,frozen_context_hash=?
    WHERE id=?
  `).run(
    JSON.stringify(frozen.publicEnvelope),
    JSON.stringify(frozen.privateEnvelope),
    frozen.contextHash,
    attemptId,
  );
}

function refreshAllFrozenExecutions(): void {
  refreshFrozenExecution("agent-a", "work-a", "attempt-a");
  refreshFrozenExecution("agent-b", "work-b", "attempt-b");
}

function providerResponse(action: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      action,
      summary: "Visible summary",
    }) } }],
    usage: { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 },
  }), { headers: { "content-type": "application/json" }, status: 200 });
}

beforeEach(async () => {
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  directory = mkdtempSync(join(tmpdir(), "cool-ai-execution-orchestrator-"));
  databasePath = join(directory, "cockpit.sqlite");
  database = openDatabase(databasePath);
  servers = [];
  seed();
  const root: Node = {
    children: new Map([[
      "src",
      {
        children: new Map([[
          "index.ts",
          {
            bytes: Buffer.from("hello"),
            identity: identity("file", "file", "/sandbox/src/index.ts", 5),
          },
        ]]),
        identity: identity("src", "directory", "/sandbox/src"),
      },
    ]]),
    identity: identity("root", "directory", "/sandbox"),
  };
  adapter = new ReadOnlyAdapter(root);
  const modules = import.meta.glob<AdvanceModule>(
    "../src/server/execution/action-orchestrator.ts",
  );
  const load = modules["../src/server/execution/action-orchestrator.ts"];
  expect(load, "T-16 action orchestrator must exist").toBeTypeOf("function");
  advance = await load();
  approvals = await import(
    "@/src/server/execution/execution-approval-service"
  ) as ApprovalModule;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const server of servers) server.close();
  database.close();
  rmSync(directory, { force: true, recursive: true });
  delete process.env.COCKPIT_MASTER_KEY;
});

async function localProvider(
  respond: (body: string, requestIndex: number) => { body: unknown; status?: number },
): Promise<{ baseUrl: string; requestCount: () => number }> {
  let requests = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests += 1;
      const result = respond(Buffer.concat(chunks).toString("utf8"), requests);
      response.statusCode = result.status ?? 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requests,
  };
}

function modelFacts() {
  return database.prepare(`
    SELECT c.execution_id AS executionId,c.status,c.finished_at AS finishedAt,
           c.prompt_tokens AS promptTokens,c.total_tokens AS totalTokens,
           a.status AS actionStatus,o.status AS operationStatus
    FROM execution_model_calls c
    JOIN execution_actions a ON a.id=c.action_id
    JOIN execution_operations o ON o.project_id=a.project_id AND o.id=a.operation_id
    ORDER BY c.execution_id,c.call_index
  `).all() as Array<{
    actionStatus: string;
    executionId: string;
    finishedAt: string | null;
    operationStatus: string;
    promptTokens: number | null;
    status: string;
    totalTokens: number | null;
  }>;
}

function retryDependencies(): ExecutionControlDependencies {
  return {
    executionRoot: join(directory, "executions"),
    requestProcessTermination: () => true,
    sandboxExecutor: async (input) => {
      const retryDatabase = openDatabase(databasePath);
      try {
        retryDatabase.exec("BEGIN IMMEDIATE");
        retryDatabase.prepare(`
          UPDATE execution_actions SET status='succeeded',lease_token=NULL,
            lease_expires_at=NULL,result_json='{"status":"ready"}',
            finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND status='running'
        `).run(input.actionId);
        retryDatabase.prepare(`
          UPDATE execution_attempts SET status='ready' WHERE id=? AND status='preparing'
        `).run(input.attemptId);
        retryDatabase.prepare(`
          UPDATE execution_operations SET status='completed',final_action_index=0,
            http_status=200,response_json='{"execution":{"status":"queued"}}',
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE project_id=? AND id=? AND status='pending'
        `).run(input.projectId, input.operationId);
        retryDatabase.exec("COMMIT");
      } finally {
        retryDatabase.close();
      }
      throw new Error("sandbox-ready");
    },
  };
}

describe("client-driven execution advance orchestration", () => {
  it.each(["provider", "parse"] as const)(
    "terminalizes two real concurrent HTTP calls when one Agent has a %s failure",
    async (failure) => {
      const provider = await localProvider((body) => {
        const executionB = body.includes("work-b");
        const repairingInvalid = body.includes("The following response was invalid.");
        if (executionB && failure === "provider") {
          return { body: { error: "upstream" }, status: 500 };
        }
        const action = (executionB || repairingInvalid) && failure === "parse"
          ? { unexpected: true }
          : { path: "src", type: "list" };
        return {
          body: {
            choices: [{ message: { content: JSON.stringify({
              action,
              summary: "Visible summary",
            }) } }],
            usage: { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 },
          },
        };
      });
      database.prepare("UPDATE providers SET base_url=? WHERE id='provider'")
        .run(provider.baseUrl);
      refreshAllFrozenExecutions();

      const results = await Promise.all([
        advance.advanceExecution(
          databasePath,
          EXECUTION_ID,
          { expectedVersion: 1, operationId: operationId(100) },
          { fileAdapter: adapter },
        ),
        advance.advanceExecution(
          databasePath,
          SECOND_EXECUTION_ID,
          { expectedVersion: 1, operationId: operationId(101) },
          { fileAdapter: adapter },
        ),
      ]);

      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(failure === "provider" ? 502 : 409);
      const facts = modelFacts();
      expect(facts).toHaveLength(failure === "provider" ? 2 : 3);
      expect(facts.every(({ finishedAt, status }) =>
        finishedAt !== null && status !== "calling")).toBe(true);
      expect(facts.every(({ actionStatus, operationStatus }) =>
        ["succeeded", "failed"].includes(actionStatus) && operationStatus === "completed"))
        .toBe(true);
      expect(database.prepare(`
        SELECT count(*) AS count FROM execution_model_calls WHERE status='calling'
      `).get()).toEqual({ count: 0 });
      expect(provider.requestCount()).toBe(failure === "provider" ? 2 : 3);
    },
    10_000,
  );

  it.each([
    "before_call_terminal_update",
    "after_call_terminal_update",
    "after_call_terminal_commit",
  ] as const)(
    "reconciles a crash at %s and retries with a new call only",
    async (faultPoint) => {
      const provider = await localProvider(() => ({
        body: {
          choices: [{ message: { content: JSON.stringify({
            action: { path: "src", type: "list" },
            summary: "Visible summary",
          }) } }],
          usage: { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 },
        },
      }));
      database.prepare("UPDATE providers SET base_url=? WHERE id='provider'")
        .run(provider.baseUrl);
      refreshAllFrozenExecutions();
      const fault = new Error(`fault:${faultPoint}`);
      await expect(advance.advanceExecution(
        databasePath,
        EXECUTION_ID,
        { expectedVersion: 1, operationId: operationId(110) },
        {
          fileAdapter: adapter,
          modelFaultInjector: (point) => {
            if (point === faultPoint) throw fault;
          },
        },
      )).rejects.toBe(fault);
      expect(provider.requestCount()).toBe(1);
      expect(modelFacts()).toEqual([expect.objectContaining({
        actionStatus: "running",
        finishedAt: faultPoint === "after_call_terminal_commit" ? expect.any(String) : null,
        operationStatus: "pending",
        status: faultPoint === "after_call_terminal_commit" ? "succeeded" : "calling",
      })]);

      database.prepare(`
        UPDATE execution_actions SET lease_expires_at='2000-01-01T00:00:00.000Z'
        WHERE execution_id=? AND status='running'
      `).run(EXECUTION_ID);
      await expect(advance.advanceExecution(
        databasePath,
        EXECUTION_ID,
        { expectedVersion: 2, operationId: operationId(111) },
        { fileAdapter: adapter },
      )).rejects.toMatchObject({ code: "EXECUTION_STATE_CONFLICT" });
      expect(modelFacts()).toEqual([expect.objectContaining({
        actionStatus: "interrupted",
        finishedAt: expect.any(String),
        operationStatus: "completed",
        promptTokens: null,
        status: "interrupted",
        totalTokens: null,
      })]);
      expect(database.prepare(`
        SELECT status,resume_target AS resumeTarget,reason_code AS reasonCode,version
        FROM executions WHERE id=?
      `).get(EXECUTION_ID)).toEqual({
        reasonCode: "MODEL_ACTION_INTERRUPTED",
        resumeTarget: "running",
        status: "paused",
        version: 3,
      });

      const retry = controlExecution(databasePath, EXECUTION_ID, {
        action: "retry",
        expectedVersion: 3,
        operationId: operationId(112),
      }, retryDependencies());
      await expect(retry).rejects.toThrow("sandbox-ready");
      const retriedVersion = Number((database.prepare(
        "SELECT version FROM executions WHERE id=?",
      ).get(EXECUTION_ID) as { version: number }).version);
      const result = await advance.advanceExecution(
        databasePath,
        EXECUTION_ID,
        { expectedVersion: retriedVersion, operationId: operationId(113) },
        { fileAdapter: adapter },
      );
      expect(result.status).toBe(200);
      expect(provider.requestCount()).toBe(2);
      const calls = modelFacts();
      expect(calls).toHaveLength(2);
      expect(calls.find(({ status }) => status === "interrupted")).toMatchObject({
        status: "interrupted",
        promptTokens: null,
        totalTokens: null,
      });
      expect(calls.find(({ status }) => status === "succeeded")).toMatchObject({
        actionStatus: "succeeded",
        operationStatus: "completed",
        status: "succeeded",
      });
      expect(calls.every(({ finishedAt }) => finishedAt !== null)).toBe(true);
      expect(database.prepare(`
        SELECT count(*) AS count FROM execution_model_calls WHERE status='calling'
      `).get()).toEqual({ count: 0 });
    },
    10_000,
  );

  it("runs model primary/repair in one child, then executes its tool as a new operation", async () => {
    const invalid = new Response(JSON.stringify({
      choices: [{ message: { content: '{"summary":"invalid"}' } }],
      usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
    }), { headers: { "content-type": "application/json" }, status: 200 });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce(providerResponse({ path: "src", type: "list" })));

    const model = await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 1, operationId: operationId(1) },
      { fileAdapter: adapter },
    );
    expect(model.status).toBe(200);
    expect(database.prepare(`
      SELECT count(*) AS count FROM execution_actions WHERE operation_id=?
    `).get(operationId(1))).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT count(*) AS count FROM execution_model_calls
      WHERE action_id=(SELECT id FROM execution_actions WHERE operation_id=?)
    `).get(operationId(1))).toEqual({ count: 2 });
    expect(database.prepare("SELECT count(*) AS count FROM execution_tool_calls").get())
      .toEqual({ count: 0 });

    const version = Number((database.prepare(
      "SELECT version FROM executions WHERE id=?",
    ).get(EXECUTION_ID) as { version: number }).version);
    const tool = await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: version, operationId: operationId(2) },
      { fileAdapter: adapter },
    );
    expect(tool.status).toBe(200);
    expect(database.prepare(`
      SELECT kind,status FROM execution_actions WHERE operation_id=?
    `).get(operationId(2))).toEqual({ kind: "file_list", status: "succeeded" });
    expect(database.prepare(`
      SELECT type,status FROM execution_tool_calls
      WHERE action_id=(SELECT id FROM execution_actions WHERE operation_id=?)
    `).get(operationId(2))).toEqual({ status: "succeeded", type: "list" });

    const replay = await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: version, operationId: operationId(2) },
      { fileAdapter: adapter },
    );
    expect(replay).toEqual(tool);
    expect(database.prepare(`
      SELECT count(*) AS count FROM execution_actions WHERE operation_id=?
    `).get(operationId(2))).toEqual({ count: 1 });
  });

  it("allows two different executions to hold model actions concurrently but rejects a second action for one execution", async () => {
    const releases = new Map<string, () => void>();
    vi.stubGlobal("fetch", vi.fn((_url: string, request: RequestInit) => {
      const body = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> };
      const executionId = body.messages.some(({ content }) => content.includes("work-b"))
        ? SECOND_EXECUTION_ID
        : EXECUTION_ID;
      return new Promise<Response>((resolve) => {
        releases.set(executionId, () => resolve(providerResponse({ path: "src", type: "list" })));
      });
    }));

    const first = advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 1, operationId: operationId(10) },
      { fileAdapter: adapter },
    );
    const second = advance.advanceExecution(
      databasePath,
      SECOND_EXECUTION_ID,
      { expectedVersion: 1, operationId: operationId(11) },
      { fileAdapter: adapter },
    );
    await vi.waitFor(() => expect(releases.size).toBe(2));
    expect(database.prepare(`
      SELECT count(*) AS count FROM execution_actions WHERE status='running'
    `).get()).toEqual({ count: 2 });
    await expect(advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 2, operationId: operationId(12) },
      { fileAdapter: adapter },
    )).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
    releases.get(EXECUTION_ID)?.();
    releases.get(SECOND_EXECUTION_ID)?.();
    await Promise.all([first, second]);
  });

  it("creates waiting command approval and validates staged declaration without implementing full staging", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(providerResponse({
        args: ["--version"],
        executable: process.execPath,
        expectedEffect: "Print the runtime version.",
        type: "command",
        workdir: ".",
      }))
      .mockResolvedValueOnce(providerResponse({ type: "staged" })));

    await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 1, operationId: operationId(30) },
      { fileAdapter: adapter },
    );
    let version = Number((database.prepare(
      "SELECT version FROM executions WHERE id=?",
    ).get(EXECUTION_ID) as { version: number }).version);
    const command = await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: version, operationId: operationId(31) },
      { fileAdapter: adapter },
    );
    expect(command.status).toBe(200);
    expect(database.prepare(`
      SELECT status,reason_code AS reasonCode FROM executions WHERE id=?
    `).get(EXECUTION_ID)).toEqual({
      reasonCode: "COMMAND_APPROVAL_REQUIRED",
      status: "waiting_approval",
    });
    expect(database.prepare("SELECT status FROM execution_approvals").get())
      .toEqual({ status: "pending" });

    database.prepare(`
      UPDATE execution_approvals SET status='rejected',
        decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE execution_id=?
    `).run(EXECUTION_ID);
    database.prepare(`
      UPDATE execution_tool_calls SET status='rejected',
        public_result_json='{"code":"OWNER_REJECTED","status":"rejected","type":"command","toolCallId":"rejected"}',
        finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE execution_id=?
    `).run(EXECUTION_ID);
    database.prepare(`
      UPDATE executions SET status='running',reason_code=NULL,version=version+1
      WHERE id=?
    `).run(EXECUTION_ID);
    version = Number((database.prepare(
      "SELECT version FROM executions WHERE id=?",
    ).get(EXECUTION_ID) as { version: number }).version);
    await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: version, operationId: operationId(32) },
      { fileAdapter: adapter },
    );
    version = Number((database.prepare(
      "SELECT version FROM executions WHERE id=?",
    ).get(EXECUTION_ID) as { version: number }).version);
    const staged = await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: version, operationId: operationId(33) },
      { fileAdapter: adapter },
    );
    expect(staged.status).toBe(409);
    expect(database.prepare(`
      SELECT kind,status FROM execution_actions WHERE operation_id=?
    `).get(operationId(33))).toEqual({ kind: "stage_compute", status: "failed" });
    expect(database.prepare("SELECT count(*) AS count FROM execution_staged_results").get())
      .toEqual({ count: 0 });
  });

  it("binds a production one-shot request to the current manifest through approve and advance", async () => {
    const markerPath = join(directory, "production-one-shot.txt");
    const commandOperationId = operationId(41);
    database.prepare(`
      UPDATE execution_attempts SET sandbox_root=? WHERE execution_id=?
    `).run(directory, EXECUTION_ID);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(providerResponse({
      args: [
        "-e",
        `require("node:fs").appendFileSync(${JSON.stringify(markerPath)}, "spawned\\n")`,
      ],
      executable: process.execPath,
      expectedEffect: "Record one production one-shot spawn.",
      type: "command",
      workdir: ".",
    })));

    await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 1, operationId: operationId(40) },
      { fileAdapter: adapter },
    );
    const requestVersion = Number((database.prepare(
      "SELECT version FROM executions WHERE id=?",
    ).get(EXECUTION_ID) as { version: number }).version);
    const [requested, replayedRequest] = await Promise.all([
      advance.advanceExecution(
        databasePath,
        EXECUTION_ID,
        { expectedVersion: requestVersion, operationId: commandOperationId },
        { fileAdapter: adapter },
      ),
      advance.advanceExecution(
        databasePath,
        EXECUTION_ID,
        { expectedVersion: requestVersion, operationId: commandOperationId },
        { fileAdapter: adapter },
      ),
    ]);
    expect(requested.status).toBe(200);
    expect(replayedRequest).toEqual(requested);
    const approval = database.prepare(`
      SELECT approval.id,approval.input_hash AS inputHash,
             approval.request_hash AS requestHash,
             tool.before_sandbox_hash AS beforeHash,
             attempt.sandbox_manifest_hash AS manifestHash
      FROM execution_approvals approval
      JOIN execution_tool_calls tool ON tool.id=approval.tool_call_id
      JOIN execution_attempts attempt ON attempt.id=approval.attempt_id
      WHERE approval.execution_id=?
    `).get(EXECUTION_ID) as {
      beforeHash: string;
      id: string;
      inputHash: string;
      manifestHash: string;
      requestHash: string;
    };

    await approvals.decideExecutionApproval(
      databasePath,
      EXECUTION_ID,
      approval.id,
      {
        action: "approve",
        expectedVersion: requestVersion + 1,
        operationId: operationId(42),
      },
    );
    const executeOperationId = operationId(43);
    const executed = await advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: requestVersion + 2, operationId: executeOperationId },
      { fileAdapter: adapter },
    );

    expect(executed.status).toBe(200);
    expect(approval.inputHash).toBe(approval.manifestHash);
    expect(approval.beforeHash).toBe(approval.manifestHash);
    expect(approval.requestHash).not.toBe(approval.manifestHash);
    expect(database.prepare(`
      SELECT count(*) AS count FROM execution_actions
      WHERE operation_id=? AND kind='command'
    `).get(executeOperationId)).toEqual({ count: 1 });
    await expect(advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: requestVersion + 2, operationId: executeOperationId },
      { fileAdapter: adapter },
    )).resolves.toEqual(executed);
    expect(readFileSync(markerPath, "utf8")).toBe("spawned\n");
  });

  it("discards a provider result that arrives after execution control invalidates its lease", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      release = () => resolve(providerResponse({ path: "src", type: "list" }));
    })));
    const pending = advance.advanceExecution(
      databasePath,
      EXECUTION_ID,
      { expectedVersion: 1, operationId: operationId(20) },
      { fileAdapter: adapter },
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    database.prepare(`
      UPDATE executions SET status='paused',resume_target='running',version=version+1
      WHERE id=?
    `).run(EXECUTION_ID);
    database.prepare(`
      UPDATE execution_actions
      SET status='discarded',lease_token=NULL,lease_expires_at=NULL,
          finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE operation_id=? AND status='running'
    `).run(operationId(20));
    release();
    const result = await pending;
    expect(result.status).toBe(409);
    expect(database.prepare(`
      SELECT status,result_json AS resultJson FROM execution_actions WHERE operation_id=?
    `).get(operationId(20))).toEqual({ resultJson: null, status: "discarded" });
    expect(database.prepare(`
      SELECT status FROM execution_model_calls
      WHERE action_id=(SELECT id FROM execution_actions WHERE operation_id=?)
    `).get(operationId(20))).toEqual({ status: "discarded" });
  });
});
