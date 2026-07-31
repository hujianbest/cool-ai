import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";
import {
  discardExecutionAction,
  reconcileExecutionAction,
} from "@/src/server/execution/execution-actions";

type Clock = {
  clearInterval(handle: unknown): void;
  clearTimeout(handle: unknown): void;
  now(): number;
  setInterval(callback: () => void, milliseconds: number): unknown;
  setTimeout(callback: () => void, milliseconds: number): unknown;
};

type SpawnOptions = {
  cwd: string;
  detached: boolean;
  env: Record<string, string>;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: true;
};

type Child = EventEmitter & {
  pid?: number;
  stderr: PassThrough;
  stdout: PassThrough;
};

type ProcessAdapter = {
  confirmTreeExited(pid: number): Promise<boolean>;
  spawn(executable: string, args: string[], options: SpawnOptions): Child;
  terminateTree(pid: number): Promise<boolean>;
};

type ProcessResult = {
  authorizationSource: "one_shot" | "standing_policy";
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
};

type RunnerModule = {
  buildMinimalProcessEnvironment(input: {
    platform?: NodeJS.Platform;
    sandboxRoot: string;
    systemEnvironment?: NodeJS.ProcessEnv;
  }): Record<string, string>;
  executeCommandProcessAction(input: {
    actionIndex: number;
    authorizationSource: "one_shot" | "standing_policy";
    clock?: Clock;
    database: DatabaseSync;
    hooks?: { afterProcess?: () => void | Promise<void> };
    operationId: string;
    processAdapter?: ProcessAdapter;
    projectId: string;
    secretValues?: string[];
  }): Promise<{ affectedRows: 0 | 1; result: ProcessResult | null }>;
  runDirectProcess(input: {
    args: string[];
    authorizationSource: "one_shot" | "standing_policy";
    clock?: Clock;
    executable: string;
    heartbeat: () => boolean | Promise<boolean>;
    processAdapter?: ProcessAdapter;
    sandboxRoot: string;
    secretValues?: string[];
    workdir: string;
  }): Promise<ProcessResult>;
};

class FakeClock implements Clock {
  private current = 0;
  private nextId = 1;
  private readonly intervals = new Map<number, { callback: () => void; due: number; every: number }>();
  private readonly timeouts = new Map<number, { callback: () => void; due: number }>();

  clearInterval(handle: unknown): void {
    this.intervals.delete(Number(handle));
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(Number(handle));
  }

  now(): number {
    return this.current;
  }

  setInterval(callback: () => void, milliseconds: number): unknown {
    const id = this.nextId++;
    this.intervals.set(id, { callback, due: this.current + milliseconds, every: milliseconds });
    return id;
  }

  setTimeout(callback: () => void, milliseconds: number): unknown {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, due: this.current + milliseconds });
    return id;
  }

  async advanceTo(milliseconds: number): Promise<void> {
    while (true) {
      const timeout = [...this.timeouts.entries()]
        .filter(([, timer]) => timer.due <= milliseconds)
        .sort((left, right) => left[1].due - right[1].due)[0];
      const interval = [...this.intervals.entries()]
        .filter(([, timer]) => timer.due <= milliseconds)
        .sort((left, right) => left[1].due - right[1].due)[0];
      const next = !timeout ? interval
        : !interval ? timeout
          : timeout[1].due <= interval[1].due ? timeout : interval;
      if (!next) break;
      const [id, timer] = next;
      this.current = timer.due;
      if ("every" in timer) {
        timer.due += (timer as { every: number }).every;
        timer.callback();
      } else {
        this.timeouts.delete(id);
        timer.callback();
      }
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
    }
    this.current = milliseconds;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
}

function fakeChild(pid = 4321): Child {
  const child = new EventEmitter() as Child;
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

let directory: string;
let sandboxRoot: string;
let runner: RunnerModule;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-process-runner-"));
  sandboxRoot = join(directory, "sandbox");
  mkdirSync(join(sandboxRoot, ".cockpit-home"), { recursive: true });
  mkdirSync(join(sandboxRoot, ".cockpit-tmp"), { recursive: true });
  mkdirSync(join(sandboxRoot, "work"), { recursive: true });
  const moduleId = "@/src/server/execution/process-runner";
  try {
    runner = await import(/* @vite-ignore */ moduleId) as RunnerModule;
  } catch {
    expect.fail("The direct process runner is unavailable.");
  }
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

function script(name: string, source: string): string {
  const path = join(directory, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  return path;
}

function seedCommandAction(databasePath: string): void {
  const database = openDatabase(databasePath);
  const now = "2026-07-30T04:00:00.000Z";
  const hash = "a".repeat(64);
  try {
    database.exec(`
      INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
      VALUES ('process-project','Process','${now}','${sandboxRoot.replaceAll("'", "''")}','process-key',1);
      INSERT INTO providers (
        id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
        credential_version,credential_generation,key_id,api_key_mask,verified_at,
        version,created_at,updated_at
      ) VALUES ('provider','Provider','http://127.0.0.1','model','cipher-secret','iv','tag',
        1,1,'master-secret','***','${now}',1,'${now}','${now}');
      INSERT INTO agents (
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
      ) VALUES ('agent','Agent','Builder','private','provider','model','A','sage',
        1,1,1,1000,5,1,'${now}','${now}');
      INSERT INTO project_memberships (project_id,agent_id,joined_at)
      VALUES ('process-project','agent','${now}');
      INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
      VALUES ('mission','process-project','Mission','Goal',1,'${now}','${now}');
      INSERT INTO work_items (
        id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
      ) VALUES ('work','mission','Work','','in_progress','agent',1,'${now}','${now}');
      INSERT INTO collaboration_runs (
        id,project_id,status,current_agent_id,round_count,next_event_sequence,
        version,execution_epoch,pause_reason,pause_category,created_at,updated_at
      ) VALUES ('run','process-project','planned','agent',1,1,1,1,NULL,NULL,'${now}','${now}');
      INSERT INTO project_validation_policy_revisions (
        id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
        classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
      ) VALUES ('policy','process-project',NULL,'system',1,
        '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        1,0,2,0,'${now}');
      INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
      VALUES ('process-project','policy',1,'${now}');
      INSERT INTO executions (
        id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
        current_policy_revision_id,status,resume_target,reason_code,
        manual_recovery_required,recovery_resolution,current_attempt_no,
        business_round_count,tool_call_count,next_event_sequence,version,created_at,
        business_deadline_at,first_running_at,updated_at,merged_at
      ) VALUES ('execution','process-project','run','mission','work','agent','policy',
        'running',NULL,NULL,0,NULL,1,1,1,1,1,'${now}',
        strftime('%Y-%m-%dT%H:%M:%fZ','now','+900 seconds'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),'${now}',NULL);
      INSERT INTO execution_attempts (
        id,project_id,execution_id,attempt_no,status,sandbox_root,
        baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
        frozen_public_json,frozen_private_json,frozen_context_hash,
        frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
        started_at,finished_at
      ) VALUES ('attempt','process-project','execution',1,'acting',
        '${sandboxRoot.replaceAll("'", "''")}',NULL,NULL,NULL,'{}','{}','${"c".repeat(64)}',
        'policy',1,'${"d".repeat(64)}','${now}',NULL);
      INSERT INTO execution_operations (
        id,project_id,execution_id,kind,request_hash,has_external_actions,
        action_count,final_action_index,status,http_status,response_json,created_at,updated_at
      ) VALUES ('00000000-0000-4000-8000-000000000013','process-project','execution',
        'advance','${hash}',1,1,NULL,'pending',NULL,NULL,'${now}','${now}');
      INSERT INTO execution_actions (
        id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
        request_hash,overall_deadline_at,created_at
      ) VALUES ('command-action','process-project','execution','attempt',
        '00000000-0000-4000-8000-000000000013',0,'command','pending','${hash}',
        strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds'),'${now}');
      INSERT INTO execution_tool_calls (
        id,project_id,execution_id,attempt_id,action_id,business_round,type,
        request_hash,status,public_request_json,public_result_json,
        before_sandbox_hash,after_sandbox_hash,started_at,finished_at
      ) VALUES ('command-tool','process-project','execution','attempt','command-action',1,
        'command','${hash}','requested',
        '{"type":"command","executable":"${process.execPath.replaceAll("\\", "\\\\")}","args":[],"workdir":".","expectedEffect":"test"}',
        NULL,NULL,NULL,'${now}',NULL);
    `);
  } finally {
    database.close();
  }
}

function seedConsumedOneShot(databasePath: string): void {
  seedCommandAction(databasePath);
  const database = openDatabase(databasePath);
  const hash = "a".repeat(64);
  try {
    database.exec(`
      UPDATE execution_attempts
      SET baseline_manifest_hash='${hash}',sandbox_manifest_hash='${hash}'
      WHERE id='attempt';
      UPDATE execution_tool_calls SET before_sandbox_hash='${hash}'
      WHERE id='command-tool';
      INSERT INTO execution_approvals (
        id,project_id,execution_id,attempt_id,tool_call_id,kind,status,
        request_hash,input_hash,staged_hash,public_request_json,
        decided_at,consumed_at,created_at
      ) VALUES (
        'command-approval','process-project','execution','attempt','command-tool',
        'command','consumed','${hash}','${hash}',NULL,'{}',
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now')
      );
    `);
  } finally {
    database.close();
  }
}

describe("direct process runner", () => {
  it("spawns executable and args directly in sandbox with fixed minimal environment", async () => {
    const childScript = script("inspect-child.mjs", `
      let stdin = "";
      process.stdin.on("data", chunk => { stdin += chunk });
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          argv: process.argv.slice(2),
          cwd: process.cwd(),
          env: process.env,
          stdin
        }));
      }, 10);
    `);
    let passedEnvironment: Record<string, string> | null = null;
    const adapter: ProcessAdapter = {
      confirmTreeExited: async () => true,
      spawn(executable, args, options) {
        passedEnvironment = options.env;
        return spawn(
          executable,
          args,
          options as unknown as import("node:child_process").SpawnOptions,
        ) as unknown as Child;
      },
      terminateTree: async () => true,
    };
    const result = await runner.runDirectProcess({
      args: [childScript, "literal && argument", "%SECRET_TOKEN%"],
      authorizationSource: "standing_policy",
      executable: process.execPath,
      heartbeat: () => true,
      processAdapter: adapter,
      sandboxRoot,
      secretValues: ["do-not-leak"],
      workdir: "work",
    });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(result.stdout.chunks.map((chunk) => chunk.text).join("")) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      stdin: string;
    };
    expect(observed.argv).toEqual(["literal && argument", "%SECRET_TOKEN%"]);
    expect(resolve(observed.cwd)).toBe(resolve(sandboxRoot, "work"));
    expect(observed.stdin).toBe("");
    expect(observed.env).toEqual(expect.objectContaining({
      CI: "1",
      HOME: join(sandboxRoot, ".cockpit-home"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
      TEMP: join(sandboxRoot, ".cockpit-tmp"),
      TMP: join(sandboxRoot, ".cockpit-tmp"),
      TMPDIR: join(sandboxRoot, ".cockpit-tmp"),
      USERPROFILE: join(sandboxRoot, ".cockpit-home"),
    }));
    for (const forbidden of ["SECRET_TOKEN", "API_KEY", "COCKPIT_MASTER_KEY"]) {
      expect(observed.env).not.toHaveProperty(forbidden);
    }
    for (const forbidden of ["PATH", "PATHEXT", "COMSPEC", "SECRET_TOKEN", "API_KEY", "COCKPIT_MASTER_KEY"]) {
      expect(passedEnvironment).not.toHaveProperty(forbidden);
    }
  });

  it("heartbeats every 30 seconds but terminates the tree at the independent exact 120 second deadline", async () => {
    const clock = new FakeClock();
    const child = fakeChild();
    const heartbeatAt: number[] = [];
    const spawnCalls: Array<{ args: string[]; executable: string; options: SpawnOptions }> = [];
    let terminateAt: number | null = null;
    const adapter: ProcessAdapter = {
      confirmTreeExited: async () => true,
      spawn(executable, args, options) {
        spawnCalls.push({ args, executable, options });
        return child;
      },
      async terminateTree() {
        terminateAt = clock.now();
        child.stdout.end();
        child.stderr.end();
        child.emit("close", null, "SIGKILL");
        return true;
      },
    };
    const pending = runner.runDirectProcess({
      args: ["child.mjs"],
      authorizationSource: "one_shot",
      clock,
      executable: "C:\\runtime\\node.exe",
      heartbeat: () => {
        heartbeatAt.push(clock.now());
        return true;
      },
      processAdapter: adapter,
      sandboxRoot,
      workdir: ".",
    });

    await clock.advanceTo(119_999);
    expect(heartbeatAt).toEqual([30_000, 60_000, 90_000]);
    expect(terminateAt).toBeNull();
    await clock.advanceTo(120_000);
    await expect(pending).resolves.toEqual(expect.objectContaining({
      authorizationSource: "one_shot",
      durationMs: 120_000,
      exitCode: null,
      status: "timed_out",
    }));
    expect(terminateAt).toBe(120_000);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual(expect.objectContaining({
      args: ["child.mjs"],
      executable: "C:\\runtime\\node.exe",
      options: expect.objectContaining({
        cwd: sandboxRoot,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    }));
  });

  it("fails closed when heartbeat loses the lease and tree termination cannot be confirmed", async () => {
    const clock = new FakeClock();
    const child = fakeChild();
    const adapter: ProcessAdapter = {
      confirmTreeExited: async () => false,
      spawn: () => child,
      terminateTree: async () => false,
    };
    const pending = runner.runDirectProcess({
      args: [],
      authorizationSource: "standing_policy",
      clock,
      executable: "harmless",
      heartbeat: () => false,
      processAdapter: adapter,
      sandboxRoot,
      workdir: ".",
    });
    await clock.advanceTo(30_000);
    await expect(pending).resolves.toEqual(expect.objectContaining({
      authorizationSource: "standing_policy",
      status: "termination_unconfirmed",
    }));
  });

  it("terminates and reaps a real harmless child tree through the platform adapter", async () => {
    const grandchild = script("tree/grandchild.mjs", "setInterval(() => {}, 1000);");
    const parent = script("tree/parent.mjs", `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], {
        stdio: "ignore",
        windowsHide: true
      });
      process.stdout.write(String(child.pid) + "\\n");
      setInterval(() => {}, 1000);
    `);
    const clock = new FakeClock();
    const pending = runner.runDirectProcess({
      args: [parent],
      authorizationSource: "standing_policy",
      clock,
      executable: process.execPath,
      heartbeat: () => true,
      sandboxRoot,
      workdir: ".",
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    await clock.advanceTo(120_000);
    const result = await pending;
    expect(result.status).toBe("timed_out");
    expect(result.stdout.chunks.map((chunk) => chunk.text).join("")).toMatch(/^\d+\n$/u);
  });

  it("caps each stream at 1 MiB, redacts secrets, marks truncation, hashes, and emits UTF-8-safe 64 KiB chunks", async () => {
    const secret = "provider-live-secret";
    const childScript = script("large-output.mjs", `
      const secret = ${JSON.stringify(secret)};
      process.stdout.write("Authorization: Bearer " + secret + "\\n");
      process.stdout.write("api_key=" + secret + "\\n");
      process.stdout.write("€".repeat(400000));
      process.stderr.write("master_key=" + secret + "\\n");
      process.stderr.write("x".repeat(1100000));
    `);
    const result = await runner.runDirectProcess({
      args: [childScript],
      authorizationSource: "one_shot",
      executable: process.execPath,
      heartbeat: () => true,
      sandboxRoot,
      secretValues: [secret],
      workdir: ".",
    });

    for (const stream of [result.stdout, result.stderr]) {
      expect(stream.bytes).toBeLessThanOrEqual(1_048_576);
      expect(stream.truncated).toBe(true);
      expect(stream.chunks.length).toBeLessThanOrEqual(17);
      expect(stream.chunks.map((chunk) => chunk.byteOffset)).toEqual(
        stream.chunks.map((_, index, chunks) =>
          chunks.slice(0, index).reduce((total, chunk) => total + chunk.byteLength, 0)),
      );
      for (const chunk of stream.chunks) {
        expect(chunk.byteLength).toBeLessThanOrEqual(65_536);
        expect(Buffer.byteLength(chunk.text, "utf8")).toBe(chunk.byteLength);
        expect(chunk.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(chunk.text).not.toContain("\uFFFD");
      }
      expect(stream.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    const persisted = JSON.stringify(result);
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED:CREDENTIAL]");
    expect(persisted).toContain("[TRUNCATED]");
  });

  it("persists redacted chunks and exact receipt only inside the winning terminal CAS", async () => {
    const databasePath = join(directory, "process.sqlite");
    seedCommandAction(databasePath);
    const database = openDatabase(databasePath);
    const child = fakeChild();
    const adapter: ProcessAdapter = {
      confirmTreeExited: async () => true,
      spawn: () => {
        setImmediate(() => {
          child.stdout.end("Authorization: Bearer database-secret\nhello");
          child.stderr.end("warning");
          child.emit("close", 0, null);
        });
        return child;
      },
      terminateTree: async () => true,
    };
    try {
      const executed = await runner.executeCommandProcessAction({
        actionIndex: 0,
        authorizationSource: "standing_policy",
        database,
        operationId: "00000000-0000-4000-8000-000000000013",
        processAdapter: adapter,
        projectId: "process-project",
        secretValues: ["database-secret", "cipher-secret", "master-secret"],
      });
      expect(executed.affectedRows).toBe(1);
      expect(executed.result).toEqual(expect.objectContaining({
        authorizationSource: "standing_policy",
        durationMs: expect.any(Number),
        exitCode: 0,
        status: "completed",
      }));
      const operation = database.prepare(`
        SELECT status,http_status AS httpStatus,response_json AS responseJson
        FROM execution_operations WHERE id='00000000-0000-4000-8000-000000000013'
      `).get() as { httpStatus: number; responseJson: string; status: string };
      expect(operation).toEqual({
        httpStatus: 200,
        responseJson: JSON.stringify({ result: executed.result }),
        status: "completed",
      });
      const tool = database.prepare(`
        SELECT status,public_result_json AS resultJson FROM execution_tool_calls
        WHERE id='command-tool'
      `).get() as { resultJson: string; status: string };
      expect(tool.status).toBe("succeeded");
      expect(JSON.parse(tool.resultJson)).toEqual(executed.result);
      const artifacts = database.prepare(`
        SELECT name,path,content_bytes AS bytes,sha256,truncated
        FROM execution_artifacts ORDER BY name
      `).all() as Array<{ bytes: number; name: string; path: string; sha256: string; truncated: number }>;
      expect(artifacts.map((artifact) => artifact.name)).toEqual(["stderr", "stdout"]);
      expect(artifacts.every((artifact) => artifact.path.includes("command-action"))).toBe(true);
      expect(database.prepare("SELECT COUNT(*) AS count FROM execution_artifact_chunks").get())
        .toEqual({ count: 2 });
      expect(JSON.stringify(database.prepare("SELECT * FROM execution_artifact_chunks").all()))
        .not.toContain("database-secret");
      expect(database.prepare("SELECT COUNT(*) AS count FROM execution_validation_results").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM execution_staged_results").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("terminalizes a synchronous spawn exception without orphaning the action or receipt", async () => {
    const databasePath = join(directory, "spawn-exception.sqlite");
    seedCommandAction(databasePath);
    const database = openDatabase(databasePath);
    const adapter: ProcessAdapter = {
      confirmTreeExited: async () => true,
      spawn: () => {
        throw new Error("spawn failed before process start");
      },
      terminateTree: async () => true,
    };
    try {
      await runner.executeCommandProcessAction({
        actionIndex: 0,
        authorizationSource: "standing_policy",
        database,
        operationId: "00000000-0000-4000-8000-000000000013",
        processAdapter: adapter,
        projectId: "process-project",
      }).catch(() => undefined);

      expect(database.prepare(`
        SELECT status,error_code AS errorCode FROM execution_actions
        WHERE id='command-action'
      `).get()).toEqual({ errorCode: "COMMAND_PROCESS_FAILED", status: "failed" });
      expect(database.prepare(`
        SELECT status,http_status AS httpStatus FROM execution_operations
        WHERE id='00000000-0000-4000-8000-000000000013'
      `).get()).toEqual({ httpStatus: 500, status: "completed" });
      expect(database.prepare(`
        SELECT status,resume_target AS resumeTarget,reason_code AS reasonCode
        FROM executions WHERE id='execution'
      `).get()).toEqual({
        reasonCode: "COMMAND_PROCESS_FAILED",
        resumeTarget: "running",
        status: "paused",
      });
      expect(database.prepare("SELECT status FROM execution_attempts WHERE id='attempt'").get())
        .toEqual({ status: "ready" });
      expect(database.prepare("SELECT status FROM execution_tool_calls WHERE id='command-tool'").get())
        .toEqual({ status: "failed" });
      expect(database.prepare(`
        SELECT count(*) AS count FROM execution_actions WHERE status='running'
      `).get()).toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT count(*) AS count FROM execution_operations WHERE status='pending'
      `).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it.each([
    ["approval input", "UPDATE execution_approvals SET input_hash=? WHERE id='command-approval'"],
    ["tool input", "UPDATE execution_tool_calls SET before_sandbox_hash=? WHERE id='command-tool'"],
    ["action request", "UPDATE execution_actions SET request_hash=? WHERE id='command-action'"],
    ["tool action link", "UPDATE execution_tool_calls SET action_id=NULL WHERE id='command-tool'"],
  ] as const)("rejects %s tamper before spawn and terminalizes authorization", async (_label, mutation) => {
    const databasePath = join(directory, `tamper-${_label.replace(" ", "-")}.sqlite`);
    seedConsumedOneShot(databasePath);
    const database = openDatabase(databasePath);
    let spawnCount = 0;
    const adapter: ProcessAdapter = {
      confirmTreeExited: async () => true,
      spawn: () => {
        spawnCount += 1;
        return fakeChild();
      },
      terminateTree: async () => true,
    };
    try {
      if (mutation.includes("?")) {
        database.prepare(mutation).run("b".repeat(64));
      } else {
        database.prepare(mutation).run();
      }
      await runner.executeCommandProcessAction({
        actionIndex: 0,
        authorizationSource: "one_shot",
        database,
        operationId: "00000000-0000-4000-8000-000000000013",
        processAdapter: adapter,
        projectId: "process-project",
      });
      expect(spawnCount).toBe(0);
      expect(database.prepare(`
        SELECT status,error_code AS errorCode FROM execution_actions
        WHERE id='command-action'
      `).get()).toEqual({
        errorCode: "COMMAND_AUTHORIZATION_INVALID",
        status: "failed",
      });
      expect(database.prepare(`
        SELECT status,http_status AS httpStatus FROM execution_operations
        WHERE id='00000000-0000-4000-8000-000000000013'
      `).get()).toEqual({ httpStatus: 409, status: "completed" });
      expect(database.prepare(`
        SELECT count(*) AS count FROM execution_actions WHERE status='running'
      `).get()).toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT count(*) AS count FROM execution_operations WHERE status='pending'
      `).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it.each(["stop", "reconcile"] as const)(
    "drops late process facts after %s wins and preserves its exact receipt",
    async (winner) => {
      const databasePath = join(directory, `${winner}.sqlite`);
      seedCommandAction(databasePath);
      const database = openDatabase(databasePath);
      const child = fakeChild();
      const winningBody = { outcome: winner, winner: "controller" };
      const adapter: ProcessAdapter = {
        confirmTreeExited: async () => true,
        spawn: () => {
          setImmediate(() => {
            child.stdout.end("late output");
            child.stderr.end();
            child.emit("close", 0, null);
          });
          return child;
        },
        terminateTree: async () => true,
      };
      try {
        const executed = await runner.executeCommandProcessAction({
          actionIndex: 0,
          authorizationSource: "standing_policy",
          database,
          hooks: {
            afterProcess() {
              if (winner === "stop") {
                expect(discardExecutionAction(database, {
                  actionId: "command-action",
                  body: winningBody,
                  httpStatus: 200,
                  projectId: "process-project",
                })).toEqual({ affectedRows: 1 });
                return;
              }
              database.prepare(`
                UPDATE execution_actions
                SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second')
                WHERE id='command-action'
              `).run();
              expect(reconcileExecutionAction(database, {
                actionId: "command-action",
                body: winningBody,
                errorCode: "ACTION_LEASE_EXPIRED",
                httpStatus: 409,
                projectId: "process-project",
              })).toEqual({ affectedRows: 1 });
            },
          },
          operationId: "00000000-0000-4000-8000-000000000013",
          processAdapter: adapter,
          projectId: "process-project",
        });
        expect(executed).toEqual({ affectedRows: 0, result: null });
        expect(database.prepare(`
          SELECT status,http_status AS httpStatus,response_json AS responseJson
          FROM execution_operations WHERE id='00000000-0000-4000-8000-000000000013'
        `).get()).toEqual({
          httpStatus: winner === "stop" ? 200 : 409,
          responseJson: JSON.stringify(winningBody),
          status: "completed",
        });
        expect(database.prepare("SELECT COUNT(*) AS count FROM execution_artifacts").get())
          .toEqual({ count: 0 });
        expect(database.prepare(`
          SELECT status,public_result_json AS resultJson FROM execution_tool_calls
          WHERE id='command-tool'
        `).get()).toEqual({ resultJson: null, status: "requested" });
      } finally {
        database.close();
      }
    },
  );

  it("fails the attempt closed and creates no validation or stage when tree termination is unconfirmed", async () => {
    const databasePath = join(directory, "unconfirmed.sqlite");
    seedCommandAction(databasePath);
    const database = openDatabase(databasePath);
    const clock = new FakeClock();
    const child = fakeChild();
    const adapter: ProcessAdapter = {
      confirmTreeExited: async () => false,
      spawn: () => child,
      terminateTree: async () => false,
    };
    try {
      const pending = runner.executeCommandProcessAction({
        actionIndex: 0,
        authorizationSource: "standing_policy",
        clock,
        database,
        operationId: "00000000-0000-4000-8000-000000000013",
        processAdapter: adapter,
        projectId: "process-project",
      });
      await clock.advanceTo(120_000);
      const executed = await pending;
      expect(executed).toEqual(expect.objectContaining({
        affectedRows: 1,
        result: expect.objectContaining({ status: "termination_unconfirmed" }),
      }));
      expect(database.prepare(`
        SELECT status,reason_code AS reasonCode FROM executions WHERE id='execution'
      `).get()).toEqual({
        reasonCode: "PROCESS_TERMINATION_UNCONFIRMED",
        status: "failed",
      });
      expect(database.prepare(`
        SELECT status FROM execution_attempts WHERE id='attempt'
      `).get()).toEqual({ status: "failed" });
      expect(database.prepare(`
        SELECT status,http_status AS httpStatus FROM execution_operations
        WHERE id='00000000-0000-4000-8000-000000000013'
      `).get()).toEqual({ httpStatus: 503, status: "completed" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM execution_validation_results").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM execution_staged_results").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
