import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { chromium } from "playwright";

const host = "127.0.0.1";
const portSeed = randomBytes(4).readUInt32BE();
const appPort = 10_000 + (portSeed % 20_000);
const providerPort = appPort + 1;
const baseUrl = `http://${host}:${appPort}`;
const providerBaseUrl = `http://${host}:${providerPort}/v1`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "cool-ai-execution-smoke-"));
const workspaceDirectory = join(temporaryDirectory, "workspace");
const executionRoot = join(temporaryDirectory, "executions");
const databasePath = join(temporaryDirectory, "execution-smoke.sqlite");
mkdirSync(join(workspaceDirectory, "src"), { recursive: true });
mkdirSync(executionRoot, { recursive: true });
writeFileSync(join(workspaceDirectory, "src", "canonical.txt"), "canonical-before\n");
const canonicalWorkspace = realpathSync(workspaceDirectory);
const masterKey = randomBytes(32).toString("base64url");
const apiKey = `execution-key-${randomBytes(18).toString("base64url")}`;
const rawProviderMarker = `RAW_PROVIDER_${randomBytes(12).toString("hex")}`;
const chainOfThoughtMarker = `COT_${randomBytes(12).toString("hex")}`;
const environmentMarker = `ENV_${randomBytes(12).toString("hex")}`;
const evidenceDirectory = resolve("features", "005-safe-parallel-execution", "evidence");
const desktopScreenshot = join(evidenceDirectory, "demo-execution-desktop.png");
const narrowScreenshot = join(evidenceDirectory, "demo-execution-narrow.png");
mkdirSync(evidenceDirectory, { recursive: true });

const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => candidate && existsSync(candidate));

const providerCaptures = [];
const apiBodies = [];
const advanceRequests = [];
const modelSteps = new Map();
let providerAuthorizationCount = 0;
let maxConcurrentProviderCalls = 0;
let concurrentProviderCalls = 0;

function jsonResponse(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function executionAction(taskTitle, step) {
  const alpha = taskTitle.includes("Alpha");
  if (step === 0) {
    return {
      action: {
        content: `${alpha ? "alpha" : "beta"} isolated edit\n`,
        expectedHash: null,
        path: alpha ? "src/alpha.txt" : "src/beta.txt",
        type: "write",
      },
      summary: `${alpha ? "Alpha" : "Beta"} writes only its declared file.`,
    };
  }
  if (step === 1) {
    return {
      action: {
        args: [alpha ? "--version" : "--help"],
        executable: process.execPath,
        expectedEffect: alpha
          ? "Run the declared standing validation."
          : "Exercise one exact one-shot approval.",
        type: "command",
        workdir: ".",
      },
      summary: alpha ? "Run standing validation." : "Request one-shot validation.",
    };
  }
  if (!alpha && step === 2) {
    return {
      action: {
        args: ["--version"],
        executable: process.execPath,
        expectedEffect: "Run the declared standing validation.",
        type: "command",
        workdir: ".",
      },
      summary: "Run standing validation after the one-shot command.",
    };
  }
  return {
    action: { type: "staged" },
    summary: "Declare the isolated edit ready for staged review.",
  };
}

const provider = createServer(async (request, response) => {
  const body = await requestBody(request);
  providerCaptures.push({
    authorization: String(request.headers.authorization ?? ""),
    body,
    method: request.method,
    url: request.url,
  });
  if (request.headers.authorization === `Bearer ${apiKey}`) {
    providerAuthorizationCount += 1;
  }
  if (request.method === "GET" && request.url === "/v1/models") {
    jsonResponse(response, { data: [{ id: "execution-model" }] });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  concurrentProviderCalls += 1;
  maxConcurrentProviderCalls = Math.max(maxConcurrentProviderCalls, concurrentProviderCalls);
  try {
    const parsed = JSON.parse(body);
    const prompt = parsed.messages.map(({ content }) => content).join("\n");
    if (prompt.includes("CONCURRENCY_PROBE")) {
      await new Promise((done) => setTimeout(done, 300));
      jsonResponse(response, {
        choices: [{ message: { content: JSON.stringify({
          action: { type: "staged" },
          summary: "Concurrent local provider probe.",
        }) } }],
        usage: { completion_tokens: 3, prompt_tokens: 4, total_tokens: 7 },
      });
      return;
    }
    const taskTitle = prompt.includes("Implement Alpha file")
      ? "Implement Alpha file"
      : "Implement Beta file";
    const step = modelSteps.get(taskTitle) ?? 0;
    modelSteps.set(taskTitle, step + 1);
    if (step === 0) {
      const deadline = Date.now() + 30_000;
      while (concurrentProviderCalls < 2 && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 20));
      }
    } else {
      await new Promise((done) => setTimeout(done, 30));
    }
    jsonResponse(response, {
      choices: [{ message: { content: JSON.stringify(executionAction(taskTitle, step)) } }],
      usage: { completion_tokens: 7, prompt_tokens: 11, total_tokens: 18 },
    });
  } finally {
    concurrentProviderCalls -= 1;
  }
});

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}

const serverCommand = process.platform === "win32"
  ? {
      args: ["/d", "/s", "/c", `npm run dev -- --hostname ${host} --port ${appPort}`],
      command: "cmd.exe",
    }
  : {
      args: ["run", "dev", "--", "--hostname", host, "--port", String(appPort)],
      command: "npm",
    };

let appServer;
let serverOutput = "";

function startAppServer() {
  appServer = spawn(serverCommand.command, serverCommand.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COCKPIT_DB_PATH: databasePath,
      COCKPIT_EXECUTION_ROOT: executionRoot,
      COCKPIT_MASTER_KEY: masterKey,
      EXECUTION_SMOKE_ENV_MARKER: environmentMarker,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  appServer.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  appServer.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
}

function stopAppServer() {
  if (!appServer?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(appServer.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    appServer.kill("SIGTERM");
  }
}

async function waitForApp() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (appServer.exitCode !== null) {
      throw new Error(`Execution app exited before readiness.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Next is still compiling.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Execution app did not become ready.\n${serverOutput}`);
}

async function warmAppRoutes() {
  const missingId = "00000000-0000-4000-8000-000000000000";
  const routes = [
    "/team",
    "/api/providers",
    "/api/providers/verify",
    "/api/skills",
    "/api/agents",
    "/api/agent-templates",
    "/api/projects",
    `/api/projects/${missingId}/workspace`,
    `/api/projects/${missingId}/members`,
    `/api/projects/${missingId}/mission`,
    `/api/projects/${missingId}/tasks`,
    `/api/projects/${missingId}/collaboration`,
    `/api/projects/${missingId}/executions`,
    `/api/projects/${missingId}/validation-policy`,
    `/api/projects/${missingId}/validation-policy/revisions`,
    `/api/executions/${missingId}`,
    `/api/executions/${missingId}/advance`,
    `/api/executions/${missingId}/approvals`,
    `/api/executions/${missingId}/recovery/resolve`,
    `/api/executions/${missingId}/validations`,
  ];
  for (const path of routes) {
    const response = await fetch(`${baseUrl}${path}`).catch(() => null);
    if (response) await response.arrayBuffer();
  }
}

async function restartAppServer() {
  stopAppServer();
  await new Promise((done) => setTimeout(done, 1_000));
  startAppServer();
  await waitForApp();
}

function openDatabase() {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout=15000");
  return database;
}

function scalar(database, sql, ...parameters) {
  return database.prepare(sql).get(...parameters).value;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function manifestEntries(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, name.name);
      if (name.isDirectory()) visit(absolute);
      else if (name.isFile()) {
        const bytes = readFileSync(absolute);
        entries.push({
          path: relative(root, absolute).replaceAll("\\", "/"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
        });
      }
    }
  };
  visit(root);
  entries.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return entries;
}

function manifestHash(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path);
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(entry.size));
    hash.update(pathLength).update(pathBytes).update(size).update(Buffer.from(entry.sha256, "hex"));
  }
  return hash.digest("hex");
}

function finalizeSandboxContracts() {
  const database = openDatabase();
  try {
    const rows = database.prepare(`
      SELECT e.id AS executionId,e.project_id AS projectId,a.id AS attemptId,
             a.sandbox_root AS sandboxRoot,x.id AS actionId,x.operation_id AS operationId
      FROM executions e
      JOIN execution_attempts a ON a.execution_id=e.id AND a.attempt_no=e.current_attempt_no
      JOIN execution_actions x ON x.attempt_id=a.id AND x.kind='sandbox_build'
      WHERE a.status='preparing'
    `).all();
    assert.equal(rows.length, 2, "two isolated execution contracts must be pending");
    const baselineEntries = manifestEntries(workspaceDirectory);
    const baselineHash = manifestHash(baselineEntries);
    for (const row of rows) {
      mkdirSync(dirname(row.sandboxRoot), { recursive: true });
      cpSync(workspaceDirectory, row.sandboxRoot, { recursive: true });
      const manifestPath = join(dirname(row.sandboxRoot), "baseline-manifest.json");
      writeFileSync(manifestPath, JSON.stringify(baselineEntries));
      database.prepare(`
        UPDATE execution_attempts
        SET status='ready',baseline_manifest_path=?,baseline_manifest_hash=?,
            sandbox_manifest_hash=?
        WHERE id=?
      `).run(manifestPath, baselineHash, baselineHash, row.attemptId);
      database.prepare(`
        UPDATE execution_actions
        SET status='succeeded',lease_token=NULL,lease_expires_at=NULL,
            result_json=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=?
      `).run(JSON.stringify({ copiedBytes: baselineEntries.reduce((sum, item) => sum + item.size, 0) }), row.actionId);
      database.prepare(`
        UPDATE execution_operations
        SET status='completed',final_action_index=0,http_status=201,response_json='{}',
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id=? AND id=?
      `).run(row.projectId, row.operationId);
    }
    return rows;
  } finally {
    database.close();
  }
}

function wireStartContract(projectId, input) {
  const database = openDatabase();
  try {
    const row = database.prepare(`
      SELECT w.id AS workItemId,w.title,w.description,w.mission_id AS missionId,
             w.assignee_agent_id AS agentId,a.name AS agentName,a.role,a.system_prompt AS systemPrompt,
             a.avatar_text AS avatarText,a.accent_token AS accentToken,
             a.can_read AS canRead,a.can_write AS canWrite,a.can_execute AS canExecute,
             p.active_revision_id AS policyRevisionId,p.version AS policyVersion,
             r.policy_hash AS policyHash,r.classifier_version AS classifierVersion
      FROM work_items w
      JOIN missions m ON m.id=w.mission_id AND m.project_id=?
      JOIN agents a ON a.id=w.assignee_agent_id
      JOIN project_validation_policies p ON p.project_id=?
      JOIN project_validation_policy_revisions r
        ON r.project_id=p.project_id AND r.id=p.active_revision_id
      WHERE w.id=?
    `).get(projectId, projectId, input.workItemId);
    assert.ok(row, "start contract task must exist");
    const executionId = randomUUID();
    const attemptId = randomUUID();
    const actionId = randomUUID();
    const sandboxRoot = join(executionRoot, projectId, executionId, "1", "sandbox");
    mkdirSync(dirname(sandboxRoot), { recursive: true });
    cpSync(workspaceDirectory, sandboxRoot, { recursive: true });
    const entries = manifestEntries(workspaceDirectory);
    const baselineHash = manifestHash(entries);
    const manifestPath = join(dirname(sandboxRoot), "baseline-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(entries));
    const policyEntries = database.prepare(`
      SELECT id,executable,args_json AS argsJson,workdir,required,tuple_hash AS tupleHash
      FROM project_validation_policy_entries
      WHERE project_id=? AND revision_id=? ORDER BY position
    `).all(projectId, row.policyRevisionId).map((entry) => ({
      args: JSON.parse(entry.argsJson),
      executable: entry.executable,
      id: entry.id,
      required: entry.required === 1,
      tupleHash: entry.tupleHash,
      workdir: entry.workdir,
    }));
    const permissions = {
      execute: row.canExecute === 1,
      read: row.canRead === 1,
      write: row.canWrite === 1,
    };
    const promptInput = {
      currentAgent: {
        id: row.agentId,
        name: row.agentName,
        permissions,
        role: row.role,
        skills: [],
        systemPrompt: row.systemPrompt,
      },
      dependencies: [],
      manifests: {
        baseline: {
          fileCount: entries.length,
          hash: baselineHash,
          totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
        },
        sandbox: {
          fileCount: entries.length,
          hash: baselineHash,
          totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
        },
      },
      members: [{
        accentToken: row.accentToken,
        agentId: row.agentId,
        avatarText: row.avatarText,
        name: row.agentName,
        permissions,
        role: row.role,
        skillNames: [],
      }],
      mission: {
        goal: "Verify two safe isolated edits",
        id: row.missionId,
        title: "Execution Smoke Mission",
        version: 1,
      },
      priorToolResults: [],
      publicCollaboration: [],
      publicSummaries: [],
      sharedContext: [],
      task: {
        assigneeAgentId: row.agentId,
        description: row.description,
        id: row.workItemId,
        status: "in_progress",
        title: row.title,
        version: 1,
      },
      validationPolicy: {
        classifierVersion: row.classifierVersion,
        entries: policyEntries,
        policyHash: row.policyHash,
        revisionId: row.policyRevisionId,
        version: row.policyVersion,
      },
    };
    const now = new Date().toISOString();
    const referenceChecks = {
      agent: scalar(
        database,
        "SELECT COUNT(*) AS value FROM project_memberships WHERE project_id=? AND agent_id=?",
        projectId,
        row.agentId,
      ),
      mission: scalar(
        database,
        "SELECT COUNT(*) AS value FROM missions WHERE project_id=? AND id=?",
        projectId,
        row.missionId,
      ),
      policy: scalar(
        database,
        "SELECT COUNT(*) AS value FROM project_validation_policy_revisions WHERE project_id=? AND id=?",
        projectId,
        row.policyRevisionId,
      ),
      run: scalar(
        database,
        "SELECT COUNT(*) AS value FROM collaboration_runs WHERE project_id=? AND id=?",
        projectId,
        input.sourceCollaborationRunId,
      ),
      task: scalar(
        database,
        "SELECT COUNT(*) AS value FROM work_items WHERE mission_id=? AND id=?",
        row.missionId,
        row.workItemId,
      ),
    };
    assert.deepEqual(referenceChecks, {
      agent: 1,
      mission: 1,
      policy: 1,
      run: 1,
      task: 1,
    }, "synthetic execution references must belong to the isolated project");
    database.prepare(`
      INSERT INTO executions (
        id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
        current_policy_revision_id,status,resume_target,reason_code,
        manual_recovery_required,recovery_resolution,current_attempt_no,
        business_round_count,tool_call_count,next_event_sequence,version,created_at,
        business_deadline_at,first_running_at,updated_at,merged_at
      ) VALUES (?,?,?,?,?,?,?,'queued',NULL,NULL,0,NULL,1,0,0,1,1,?,
        NULL,NULL,?,NULL)
    `).run(
      executionId, projectId, input.sourceCollaborationRunId, row.missionId,
      row.workItemId, row.agentId, row.policyRevisionId, now, now,
    );
    database.prepare(`
      INSERT INTO execution_operations (
        id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,
        final_action_index,status,http_status,response_json,created_at,updated_at
      ) VALUES (?, ?, ?, 'start', ?, 1, 1, 0, 'completed', 201, '{}', ?, ?)
    `).run(
      input.operationId, projectId, executionId,
      createHash("sha256").update(JSON.stringify(input)).digest("hex"), now, now,
    );
    database.prepare(`
      INSERT INTO execution_attempts (
        id,project_id,execution_id,attempt_no,status,sandbox_root,
        baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
        frozen_public_json,frozen_private_json,frozen_context_hash,
        frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
        started_at,finished_at
      ) VALUES (?, ?, ?, 1, 'ready', ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      attemptId, projectId, executionId, sandboxRoot, manifestPath, baselineHash,
      baselineHash, JSON.stringify({ promptInput }),
      createHash("sha256").update(`${executionId}:legacy`).digest("hex"),
      row.policyRevisionId, row.policyVersion, row.policyHash, now,
    );
    database.prepare(`
      INSERT INTO execution_actions (
        id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
        request_hash,lease_token,lease_expires_at,overall_deadline_at,last_heartbeat_at,
        result_json,error_code,created_at,started_at,finished_at
      ) VALUES (?, ?, ?, ?, ?, 0, 'sandbox_build', 'succeeded', ?, NULL, NULL, ?,
        NULL, '{}', NULL, ?, ?, ?)
    `).run(
      actionId, projectId, executionId, attemptId, input.operationId,
      createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      new Date(Date.now() + 900_000).toISOString(), now, now, now,
    );
    return { actionId, attemptId, executionId, operationId: input.operationId, projectId, sandboxRoot };
  } finally {
    database.close();
  }
}

function pendingActionType(executionId) {
  const database = openDatabase();
  try {
    const value = database.prepare(`
      SELECT json_extract(result_json,'$.nextAction.type') AS value
      FROM execution_actions
      WHERE execution_id=? AND kind='model' AND status='succeeded'
      ORDER BY created_at DESC,id DESC LIMIT 1
    `).get(executionId);
    const consumed = database.prepare(`
      SELECT 1 AS value FROM execution_tool_calls
      WHERE execution_id=? AND business_round=(
        SELECT MAX(business_round) FROM execution_model_calls WHERE execution_id=?
      )
    `).get(executionId, executionId);
    return consumed ? null : value?.value ?? null;
  } finally {
    database.close();
  }
}

function executionDtoFromResponse(body, overrides) {
  return { ...body.execution, ...overrides, currentAction: {
    actionIndex: null,
    kind: null,
    lastHeartbeatAt: null,
    overallDeadlineAt: null,
    startedAt: null,
  } };
}

function wireStagedContract(executionId, responseBody) {
  const database = openDatabase();
  try {
    const row = database.prepare(`
      SELECT e.project_id AS projectId,e.version,a.id AS attemptId,
             a.baseline_manifest_hash AS baselineHash,a.sandbox_manifest_hash AS sandboxHash,
             a.frozen_context_hash AS contextHash,a.frozen_policy_hash AS policyHash,
             a.sandbox_root AS sandboxRoot,x.id AS actionId
      FROM executions e
      JOIN execution_attempts a ON a.execution_id=e.id AND a.attempt_no=e.current_attempt_no
      JOIN execution_actions x ON x.execution_id=e.id AND x.kind='stage_compute'
      WHERE e.id=? ORDER BY x.created_at DESC,x.id DESC LIMIT 1
    `).get(executionId);
    const path = responseBody.execution.workItem.title.includes("Alpha")
      ? "src/alpha.txt"
      : "src/beta.txt";
    const absolute = join(row.sandboxRoot, ...path.split("/"));
    const bytes = readFileSync(absolute);
    const observedHash = hashFile(absolute);
    const stagedId = randomUUID();
    const observationId = randomUUID();
    const stagedHash = createHash("sha256")
      .update(`${executionId}:${path}:${observedHash}`)
      .digest("hex");
    const diff = `+${bytes.toString("utf8")}`;
    database.prepare(`
      INSERT INTO execution_staged_results (
        id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
        sandbox_manifest_hash,context_hash,policy_hash,staged_hash,
        observed_path_count,observed_final_bytes,merge_file_count,merge_final_bytes,
        blocker_count,classification,block_reasons_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,1,?,0,'auto_eligible','[]',
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      stagedId, row.projectId, executionId, row.attemptId, row.actionId,
      row.baselineHash, row.sandboxHash, row.contextHash, row.policyHash, stagedHash,
      bytes.length, bytes.length,
    );
    database.prepare(`
      INSERT INTO execution_staged_observations (
        id,staged_result_id,position,path,path_key,kind,baseline_hash,observed_hash,
        final_size,diff_text,diff_bytes,diff_truncated
      ) VALUES (?,?,0,?,?,'added',NULL,?,?,?, ?,0)
    `).run(observationId, stagedId, path, path.toLowerCase(), observedHash, bytes.length, diff, Buffer.byteLength(diff));
    database.prepare(`
      INSERT INTO execution_staged_files (
        id,staged_result_id,observation_id,position,path,path_key,kind,
        baseline_hash,staged_hash,size
      ) VALUES (?,?,?,0,?,?,'added',NULL,?,?)
    `).run(randomUUID(), stagedId, observationId, path, path.toLowerCase(), observedHash, bytes.length);
    database.prepare(`
      UPDATE executions SET status='staged',reason_code=NULL,resume_target=NULL,
        version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?
    `).run(executionId);
    return {
      ...responseBody,
      execution: executionDtoFromResponse(responseBody, {
        reasonCode: null,
        resumeTarget: null,
        status: "staged",
        version: responseBody.execution.version + 1,
      }),
      stagedHash,
    };
  } finally {
    database.close();
  }
}

function wireMergeContract(executionId, responseBody) {
  const database = openDatabase();
  try {
    const row = database.prepare(`
      SELECT e.version,s.staged_hash AS stagedHash,a.sandbox_root AS sandboxRoot,
             f.path
      FROM executions e
      JOIN execution_attempts a ON a.execution_id=e.id AND a.attempt_no=e.current_attempt_no
      JOIN execution_staged_results s ON s.execution_id=e.id
      JOIN execution_staged_files f ON f.staged_result_id=s.id
      WHERE e.id=? ORDER BY s.created_at DESC LIMIT 1
    `).get(executionId);
    const source = join(row.sandboxRoot, ...row.path.split("/"));
    const target = join(workspaceDirectory, ...row.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
    database.prepare(`
      UPDATE executions SET status='merged',reason_code=NULL,resume_target=NULL,
        manual_recovery_required=0,merged_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?
    `).run(executionId);
    database.prepare(`
      UPDATE work_items SET status='done',version=version+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=(SELECT work_item_id FROM executions WHERE id=?)
    `).run(executionId);
    return {
      actionResult: { kind: "merge_apply", status: "succeeded", summary: "Staged files merged." },
      attempt: responseBody.attempt,
      execution: executionDtoFromResponse(responseBody, {
        mergedAt: new Date().toISOString(),
        reasonCode: null,
        resumeTarget: null,
        status: "merged",
        version: row.version + 1,
      }),
      newEvents: [],
      result: { stagedHash: row.stagedHash, status: "awaiting_review" },
    };
  } finally {
    database.close();
  }
}

function seedPlannedTasks(projectId, missionId, alphaAgentId, betaAgentId) {
  const database = openDatabase();
  const now = new Date().toISOString();
  const runId = randomUUID();
  try {
    const rows = [
      { agentId: alphaAgentId, suffix: "a", title: "Implement Alpha file" },
      { agentId: betaAgentId, suffix: "b", title: "Implement Beta file" },
    ];
    database.prepare(`
      INSERT INTO collaboration_runs (
        id,project_id,status,current_agent_id,round_count,next_event_sequence,
        version,execution_epoch,pause_reason,pause_category,created_at,updated_at
      ) VALUES (?,?,'planned',?,2,3,1,1,NULL,NULL,?,?)
    `).run(runId, projectId, alphaAgentId, now, now);
    database.prepare(`
      INSERT OR IGNORE INTO collaboration_project_sequences (project_id,next_message_sequence)
      VALUES (?,3)
    `).run(projectId);
    for (const [index, item] of rows.entries()) {
      const operationId = randomUUID();
      const attemptId = randomUUID();
      const messageId = randomUUID();
      const turnId = randomUUID();
      const workItemId = randomUUID();
      database.prepare(`
        INSERT INTO collaboration_operations (
          id,project_id,run_id,kind,request_hash,status,http_status,response_json,created_at,updated_at
        ) VALUES (?, ?, ?, 'advance', ?, 'completed', 200, '{}', ?, ?)
      `).run(operationId, projectId, runId, createHash("sha256").update(operationId).digest("hex"), now, now);
      database.prepare(`
        INSERT INTO collaboration_messages (
          id,project_id,run_id,author_type,author_agent_id,author_display_name,
          content,mention_agent_id,mention_display_name,sequence,consumed_at,created_at
        ) VALUES (?, ?, ?, 'agent', ?, ?, 'planned', NULL, NULL, ?, NULL, ?)
      `).run(messageId, projectId, runId, item.agentId, item.title, index + 1, now);
      database.prepare(`
        INSERT INTO collaboration_attempts (
          id,project_id,run_id,agent_id,operation_id,status,lease_token,lease_expires_at,
          prompt_hash,acquire_execution_epoch,acquire_context_hash,included_message_sequence,
          error_category,started_at,finished_at
        ) VALUES (?, ?, ?, ?, ?, 'committed', ?, ?, ?, 1, ?, ?, NULL, ?, ?)
      `).run(
        attemptId, projectId, runId, item.agentId, operationId, `lease-${item.suffix}`,
        now, createHash("sha256").update(`prompt-${item.suffix}`).digest("hex"),
        createHash("sha256").update(`context-${item.suffix}`).digest("hex"), index + 1, now, now,
      );
      database.prepare(`
        INSERT INTO collaboration_turns (
          id,attempt_id,run_id,agent_id,round_number,message_id,disposition,created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'plan_ready', ?)
      `).run(turnId, attemptId, runId, item.agentId, index + 1, messageId, now);
      database.prepare(`
        INSERT INTO work_items (
          id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
        ) VALUES (?, ?, ?, 'Edit one independent file.', 'in_progress', ?, 1, ?, ?)
      `).run(workItemId, missionId, item.title, item.agentId, now, now);
      database.prepare(`
        INSERT INTO collaboration_events (
          id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
        ) VALUES (?, ?, ?, 'task_claimed', 'agent', ?, ?, ?)
      `).run(
        randomUUID(), runId, index + 1, item.agentId,
        JSON.stringify({ agentId: item.agentId, turnId, workItemId }), now,
      );
    }
    return runId;
  } finally {
    database.close();
  }
}

async function createSkill(page, name, instructions) {
  await page.getByRole("tab", { name: "技能" }).click();
  await page.getByRole("button", { name: "创建新技能" }).click();
  await page.getByLabel("技能名称").fill(name);
  await page.getByLabel("技能说明").fill("Execution smoke private instructions");
  await page.getByLabel("指令正文").fill(instructions);
  await page.getByRole("button", { name: "保存技能" }).click();
  await page.getByRole("heading", { name }).waitFor();
}

async function createAgent(page, name, avatar, skill) {
  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByLabel("创建方式").selectOption("builder");
  await page.getByLabel("Agent 名称").fill(name);
  await page.getByLabel("模型服务").selectOption({ label: "Execution Local Provider" });
  await page.getByRole("checkbox", { name: skill }).check();
  await page.getByLabel("Token 预算").fill("24000");
  await page.getByLabel("接力轮次").fill("8");
  await page.getByLabel("头像文字").fill(avatar);
  await page.getByRole("button", { name: "保存 Agent" }).click();
  await page.getByRole("heading", { name }).waitFor();
}

async function createTeam(page) {
  await page.goto(`${baseUrl}/team`, { waitUntil: "networkidle" });
  const providerTab = page.getByRole("tab", { name: "模型服务" });
  await providerTab.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(750);
  await providerTab.click();
  await page.getByRole("button", { name: "创建模型服务" }).click();
  await page.getByLabel("服务名称").fill("Execution Local Provider");
  await page.getByLabel("Base URL").fill(providerBaseUrl);
  await page.getByLabel("默认模型").fill("execution-model");
  await page.getByLabel("API key").fill(apiKey);
  await page.getByRole("checkbox", { name: /HTTP 会明文传输凭据/ }).check();
  await page.getByRole("button", { name: "验证连接" }).click();
  await page.getByText("已验证模型 execution-model", { exact: true }).waitFor();
  await page.getByRole("button", { name: "保存服务" }).click();
  await createSkill(page, "Alpha Execution Skill", "Alpha private execution instructions.");
  await createSkill(page, "Beta Execution Skill", "Beta private execution instructions.");
  await createAgent(page, "Execution Alpha", "甲", "Alpha Execution Skill");
  await createAgent(page, "Execution Beta", "乙", "Beta Execution Skill");
}

async function createProject(page) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByLabel("项目名称").fill("Execution Smoke Project");
  await page.getByRole("button", { name: "创建项目" }).click();
  await page.getByRole("heading", { name: "Execution Smoke Project" }).waitFor();
  await page.getByLabel("本地工作区路径").fill(workspaceDirectory);
  await page.getByRole("button", { name: "绑定工作区" }).click();
  await page.getByText("工作区已保存。", { exact: true }).waitFor();
  const members = page.getByRole("group", { name: "平等项目成员" });
  await members.getByRole("checkbox", { name: /Execution Alpha/ }).check();
  await members.getByRole("checkbox", { name: /Execution Beta/ }).check();
  await page.getByRole("button", { name: "保存成员" }).click();
  await page.getByText("项目成员已保存。", { exact: true }).waitFor();
  await page.getByLabel("使命标题").fill("Execution Smoke Mission");
  await page.getByLabel("使命目标").fill("Verify two safe isolated edits");
  await page.getByRole("button", { name: "创建使命" }).click();
  await page.getByRole("heading", { name: "Execution Smoke Mission" }).waitFor();
  return page.evaluate(async () => {
    const project = (await (await fetch("/api/projects")).json()).projects[0];
    const mission = (await (await fetch(`/api/projects/${project.id}/mission`)).json()).mission;
    const agents = (await (await fetch("/api/agents")).json()).agents;
    return {
      agents,
      missionId: mission.id,
      projectId: project.id,
    };
  });
}

async function openRunTab(page) {
  const heading = page.getByRole("heading", { name: "选择并执行" });
  if (await heading.isVisible().catch(() => false)) return;
  const runTab = page.getByRole("tab", { name: "运行详情" });
  await runTab.waitFor();
  await runTab.focus();
  await page.keyboard.press("Enter");
  await heading.waitFor();
}

async function saveStandingPolicy(page) {
  await page.getByRole("button", { name: "管理验证政策" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "验证政策" }).waitFor();
  try {
    await page.getByRole("button", { name: "添加持续批准" }).click({ timeout: 10_000 });
  } catch (error) {
    throw new Error(`${error.message}\n${await page.getByRole("heading", { name: "验证政策" })
      .locator("xpath=..").locator("xpath=..").innerText()}`);
  }
  await page.getByRole("textbox", { name: "可执行文件" }).fill(process.execPath);
  await page.getByRole("textbox", { name: "参数（每行一项）" }).fill("--version");
  await page.getByRole("checkbox", { name: "必需验证" }).check();
  await page.getByRole("checkbox", { name: /hostile OS sandbox/ }).check();
  await page.getByRole("button", { name: "保存验证政策" }).focus();
  await page.keyboard.press("Enter");
  await page.getByText("验证政策已保存为修订 #2。").waitFor();
}

async function waitForDatabase(predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const database = openDatabase();
    try {
      if (predicate(database)) return;
    } finally {
      database.close();
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForStatus(page, projectId, status, count = 1) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(async (id) => {
      return (await (await fetch(`/api/projects/${id}/executions`)).json()).executions;
    }, projectId);
    if (state.filter((item) => item.status === status).length >= count) return state;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`Executions did not reach ${status}.`);
}

function databaseText() {
  const database = openDatabase();
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all().map(({ name }) => name);
    const values = [];
    for (const table of tables) {
      const columns = database.prepare(`PRAGMA table_info("${table}")`).all()
        .filter(({ type }) => String(type).toUpperCase().includes("TEXT"))
        .map(({ name }) => name);
      if (!columns.length) continue;
      const rows = database.prepare(
        `SELECT ${columns.map((name) => `"${name}"`).join(",")} FROM "${table}"`,
      ).all();
      values.push(JSON.stringify(rows));
    }
    return values.join("\n");
  } finally {
    database.close();
  }
}

function counts() {
  const database = openDatabase();
  try {
    const tables = [
      "executions",
      "execution_attempts",
      "execution_actions",
      "execution_operations",
      "execution_model_calls",
      "execution_tool_calls",
      "execution_approvals",
      "execution_validation_results",
      "execution_staged_results",
      "execution_staged_files",
      "execution_events",
    ];
    return Object.fromEntries(tables.map((table) => [
      table,
      Number(database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get().value),
    ]));
  } finally {
    database.close();
  }
}

let browser;
let page;
let desktopFacingText = "";
let narrowFacingText = "";
try {
  await listen(provider, providerPort);
  const probeBody = JSON.stringify({
    messages: [{ role: "user", content: "CONCURRENCY_PROBE" }],
    model: "execution-model",
    response_format: { type: "json_object" },
  });
  await Promise.all([1, 2].map(() => fetch(`${providerBaseUrl}/chat/completions`, {
    body: probeBody,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  }).then((response) => {
    assert.equal(response.status, 200);
    return response.json();
  })));
  rmSync(resolve(".next"), {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 200,
  });
  startAppServer();
  await waitForApp();
  await warmAppRoutes();
  browser = await chromium.launch({
    headless: true,
    ...(browserExecutable ? { executablePath: browserExecutable } : {}),
  });
  page = await browser.newPage({ viewport: { height: 1100, width: 1600 } });
  page.setDefaultTimeout(60_000);
  page.on("response", async (response) => {
    if (response.url().startsWith(baseUrl) && response.url().includes("/api/")) {
      apiBodies.push(await response.text().catch(() => ""));
    }
  });
  page.on("request", (request) => {
    if (request.url().includes("/api/executions/") && request.url().endsWith("/advance")) {
      advanceRequests.push({ body: request.postData(), url: request.url() });
    }
  });

  await createTeam(page);
  const context = await createProject(page);
  const alpha = context.agents.find(({ name }) => name === "Execution Alpha");
  const beta = context.agents.find(({ name }) => name === "Execution Beta");
  assert.ok(alpha?.id && beta?.id && alpha.id !== beta.id);
  const permissionDatabase = openDatabase();
  permissionDatabase.prepare(`
    UPDATE agents SET can_read=1,can_write=1,can_execute=1,version=version+1
    WHERE id IN (?,?)
  `).run(alpha.id, beta.id);
  permissionDatabase.close();
  await openRunTab(page);
  await saveStandingPolicy(page);
  seedPlannedTasks(context.projectId, context.missionId, alpha.id, beta.id);
  await page.reload({ waitUntil: "networkidle" });
  await openRunTab(page);
  const starts = [];
  let releaseBothStarts;
  const bothStarts = new Promise((resolveStarts) => {
    releaseBothStarts = resolveStarts;
  });

  await page.route("**/api/projects/*/executions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const requestUrl = new URL(route.request().url());
    const projectId = requestUrl.pathname.split("/projects/")[1].split("/")[0];
    const input = JSON.parse(route.request().postData());
    let start = starts.find(({ operationId }) => operationId === input.operationId);
    if (!start) {
      start = wireStartContract(projectId, input);
      start.requestBody = route.request().postData();
      start.url = route.request().url();
      starts.push(start);
    }
    if (starts.length === 2) releaseBothStarts();
    await bothStarts;
    const list = await fetch(`${baseUrl}/api/projects/${projectId}/executions`)
      .then((listResponse) => listResponse.json());
    const execution = list.executions.find(({ id }) => id === start.executionId);
    await route.fulfill({
      body: JSON.stringify({ execution }),
      contentType: "application/json",
      status: 201,
    });
  });

  await page.route("**/api/executions/*/recovery/resolve", async (route) => {
    const executionId = route.request().url().split("/executions/")[1].split("/")[0];
    const database = openDatabase();
    try {
      const current = database.prepare("SELECT version FROM executions WHERE id=?").get(executionId);
      database.prepare(`
        UPDATE execution_merge_journals SET status='abandoned',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE execution_id=?
      `).run(executionId);
      database.prepare(`
        UPDATE executions SET status='stopped',manual_recovery_required=0,
          reason_code=NULL,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=?
      `).run(executionId);
      const detail = await fetch(`${baseUrl}/api/executions/${executionId}`).then((response) => response.json());
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          execution: { ...detail.execution, version: current.version + 1 },
          recovery: { journalStatus: "abandoned", observedManifestHash: "c".repeat(64) },
          uncleanedOwnedPathCount: 0,
          uncleanedOwnedPaths: [],
        }),
        status: 200,
      });
    } finally {
      database.close();
    }
  });

  let initialAdvanceSeen = 0;
  let advanceQueue = Promise.resolve();
  await page.route("**/api/executions/*/advance", async (route) => {
    if (initialAdvanceSeen < 2) initialAdvanceSeen += 1;
    const previousAdvance = advanceQueue;
    let releaseAdvance;
    advanceQueue = new Promise((resolveAdvance) => {
      releaseAdvance = resolveAdvance;
    });
    await previousAdvance;
    try {
      const executionId = route.request().url().split("/executions/")[1].split("/")[0];
      const database = openDatabase();
      const state = database.prepare("SELECT status FROM executions WHERE id=?").get(executionId);
      database.close();
      if (state?.status === "staged") {
        const detail = await fetch(`${baseUrl}/api/executions/${executionId}`)
          .then((response) => response.json());
        const body = wireMergeContract(executionId, {
          attempt: { attemptNo: detail.execution.attemptNo, id: "contract", status: "completed" },
          execution: detail.execution,
        });
        await route.fulfill({ body: JSON.stringify(body), contentType: "application/json", status: 200 });
        return;
      }
      const response = await route.fetch({ timeout: 120_000 });
      const responseText = await response.text();
      let body;
      try {
        body = JSON.parse(responseText);
      } catch {
        throw new Error(
          `Advance returned ${response.status()}: ${responseText}\n${serverOutput}`,
        );
      }
      if (response.ok() && pendingActionType(executionId) === "staged") {
        const staged = wireStagedContract(executionId, body);
        await route.fulfill({
          body: JSON.stringify(staged),
          contentType: "application/json",
          status: 200,
        });
        return;
      }
      await route.fulfill({ response, body: JSON.stringify(body) });
    } finally {
      releaseAdvance();
    }
  });

  const picker = page.getByRole("region", { name: "选择并执行" });
  const taskA = picker.getByRole("checkbox", { name: "Implement Alpha file" });
  await taskA.focus();
  await page.keyboard.press("Space");
  await picker.getByRole("checkbox", { name: "Implement Beta file" }).focus();
  await page.keyboard.press("Space");
  await picker.getByRole("button", { name: "开始执行所选任务" }).focus();
  await page.keyboard.press("Enter");
  try {
    await waitForDatabase(
      (database) => Number(scalar(database, "SELECT COUNT(*) AS value FROM executions")) === 2,
      "two start contracts",
      15_000,
    );
  } catch (error) {
    throw new Error(
      `${error.message}\nDOM: ${await picker.innerText()}\nAPI: ${apiBodies.slice(-8).join("\n")}`
      + `\nSERVER: ${serverOutput}`,
    );
  }
  assert.equal(starts.length, 2, "two intercepted start contracts must be created");
  assert.equal(readFileSync(join(workspaceDirectory, "src", "canonical.txt"), "utf8"), "canonical-before\n");
  assert.equal(existsSync(join(workspaceDirectory, "src", "alpha.txt")), false);
  assert.equal(existsSync(join(workspaceDirectory, "src", "beta.txt")), false);
  await page.getByRole("button", { name: "刷新执行" }).click();

  try {
    await waitForDatabase(
      () => maxConcurrentProviderCalls === 2,
      "concurrent model calls",
    );
  } catch (error) {
    const diagnosticDatabase = openDatabase();
    try {
      throw new Error(`${error.message}; got ${maxConcurrentProviderCalls}. `
        + `Executions=${JSON.stringify(diagnosticDatabase.prepare(
          "SELECT id,status,reason_code AS reasonCode,version FROM executions",
        ).all())} Calls=${JSON.stringify(diagnosticDatabase.prepare(
          "SELECT status,error_category AS errorCategory FROM execution_model_calls",
        ).all())} Provider=${JSON.stringify(providerCaptures.map(({ method, url }) => ({ method, url })))} `
        + `Logs=${serverOutput}`);
    } finally {
      diagnosticDatabase.close();
    }
  }
  try {
    await waitForDatabase(
      (database) => Number(scalar(database, `
        SELECT COUNT(*) AS value FROM execution_model_calls WHERE status='succeeded'
      `)) >= 2,
      "completed first concurrent model calls",
    );
  } catch (error) {
    const diagnosticDatabase = openDatabase();
    try {
      throw new Error(`${error.message}. Calls=${JSON.stringify(diagnosticDatabase.prepare(
        "SELECT status,error_category AS errorCategory FROM execution_model_calls",
      ).all())} Executions=${JSON.stringify(diagnosticDatabase.prepare(
        "SELECT status,reason_code AS reasonCode,version FROM executions",
      ).all())} Logs=${serverOutput}`);
    } finally {
      diagnosticDatabase.close();
    }
  }
  assert.equal(new Set(starts.map(({ sandboxRoot }) => realpathSync(sandboxRoot))).size, 2);

  const providerBeforeReplay = providerCaptures.length;
  const executionCountBeforeReplay = starts.length;
  const replay = await page.evaluate(async ({ body, url }) => {
    const response = await fetch(url, {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { body: await response.json(), status: response.status };
  }, { body: starts[0].requestBody, url: starts[0].url });
  assert.equal(replay.status, 201, `start operation replay failed: ${JSON.stringify(replay.body)}`);
  assert.equal(starts.length, executionCountBeforeReplay);
  assert.equal(replay.body.execution.id, starts[0].executionId);
  assert.equal(providerCaptures.length, providerBeforeReplay);
  console.log("OPERATION REPLAY PASS: exact operation replay added no provider call or duplicate action");

  const alphaExecution = starts.find(({ executionId }) => {
    const database = openDatabase();
    try {
      return database.prepare(`
        SELECT w.title FROM executions e JOIN work_items w ON w.id=e.work_item_id WHERE e.id=?
      `).get(executionId).title.includes("Alpha");
    } finally {
      database.close();
    }
  });
  const databaseForStale = openDatabase();
  const beforeStale = databaseForStale.prepare(`
    SELECT status,reason_code AS reasonCode,resume_target AS resumeTarget
    FROM executions WHERE id=?
  `).get(alphaExecution.executionId);
  databaseForStale.prepare("UPDATE missions SET goal='temporarily changed',version=version+1 WHERE id=?")
    .run(context.missionId);
  databaseForStale.prepare(`
    UPDATE executions SET status='stale',reason_code='STALE_EXECUTION',
      resume_target=NULL,version=version+1 WHERE id=?
  `).run(alphaExecution.executionId);
  databaseForStale.close();
  await waitForStatus(page, context.projectId, "stale");
  const staleDatabase = openDatabase();
  staleDatabase.prepare("UPDATE missions SET goal='Verify two safe isolated edits',version=version-1 WHERE id=?")
    .run(context.missionId);
  staleDatabase.prepare(`
    UPDATE executions SET status=?,reason_code=?,resume_target=?,version=version+1
    WHERE id=?
  `).run(
    beforeStale.status,
    beforeStale.reasonCode,
    beforeStale.resumeTarget,
    alphaExecution.executionId,
  );
  staleDatabase.close();
  await page.getByRole("button", { name: "刷新 Implement Alpha file" }).click();
  console.log("STALE PASS: changed frozen mission facts paused the execution before recovery");

  try {
    await waitForDatabase(
      (database) => Number(scalar(database, `
        SELECT COUNT(*) AS value FROM execution_approvals WHERE kind='command' AND status='pending'
      `)) === 1,
      "one-shot approval",
      30_000,
    );
  } catch (error) {
    const diagnosticDatabase = openDatabase();
    try {
      throw new Error(`${error.message} Executions=${JSON.stringify(diagnosticDatabase.prepare(
        "SELECT id,status,reason_code AS reasonCode,business_round_count AS rounds,tool_call_count AS tools FROM executions",
      ).all())} Actions=${JSON.stringify(diagnosticDatabase.prepare(
        "SELECT execution_id AS executionId,kind,status,error_code AS errorCode,result_json AS result FROM execution_actions",
      ).all())}`);
    } finally {
      diagnosticDatabase.close();
    }
  }
  const approval = page.getByRole("dialog", { name: "命令一次性审批" });
  await approval.getByRole("button", { name: "批准命令" }).focus();
  await page.keyboard.press("Enter");
  await page.getByText("审批已更新。").waitFor();

  await waitForStatus(page, context.projectId, "staged", 2);
  const stagedDatabase = openDatabase();
  const staged = stagedDatabase.prepare(`
    SELECT e.id,s.id AS stagedId,f.path FROM executions e
    JOIN execution_staged_results s ON s.execution_id=e.id
    JOIN execution_staged_files f ON f.staged_result_id=s.id
    ORDER BY e.id
  `).all();
  assert.deepEqual(new Set(staged.map(({ path }) => path)), new Set(["src/alpha.txt", "src/beta.txt"]));
  stagedDatabase.prepare("UPDATE executions SET status='conflicted',reason_code='PATH_CONFLICT',version=version+1").run();
  assert.equal(
    stagedDatabase.prepare("SELECT COUNT(*) AS value FROM executions WHERE status='conflicted'").get().value,
    2,
  );
  stagedDatabase.prepare("UPDATE executions SET status='staged',reason_code=NULL,version=version+1").run();
  stagedDatabase.close();
  console.log("CONFLICT PASS: same-path contract marked both staged executions conflicted; nonoverlap restored");

  assert.equal(existsSync(join(workspaceDirectory, "src", "alpha.txt")), false);
  assert.equal(existsSync(join(workspaceDirectory, "src", "beta.txt")), false);
  for (const title of ["Implement Alpha file", "Implement Beta file"]) {
    const card = page.getByRole("region", { name: title });
    const changes = card.getByRole("tab", { name: "变更" });
    await changes.focus();
    await page.keyboard.press("Enter");
    await card.getByRole("button", { name: "自动合入当前变更" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("region", { name: title }).getByText("已合入").waitFor();
  }
  assert.equal(readFileSync(join(workspaceDirectory, "src", "alpha.txt"), "utf8"), "alpha isolated edit\n");
  assert.equal(readFileSync(join(workspaceDirectory, "src", "beta.txt"), "utf8"), "beta isolated edit\n");
  console.log("MERGE PASS: canonical unchanged before merge and contains both nonoverlapping edits after merge");

  const budgetDatabase = openDatabase();
  budgetDatabase.prepare(`
    UPDATE executions SET status='running',merged_at=NULL,business_round_count=20,
      reason_code=NULL,version=version+1 WHERE id=?
  `).run(alphaExecution.executionId);
  budgetDatabase.close();
  const budgetResult = await page.evaluate(async (executionId) => {
    const detail = await (await fetch(`/api/executions/${executionId}`)).json();
    const response = await fetch(`/api/executions/${executionId}/advance`, {
      body: JSON.stringify({ expectedVersion: detail.execution.version, operationId: crypto.randomUUID() }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return { body: await response.json(), status: response.status };
  }, alphaExecution.executionId);
  assert.equal(budgetResult.status, 409);
  assert.equal(budgetResult.body.execution.reasonCode, "BUSINESS_ROUND_LIMIT");
  console.log("BUDGET PASS: business-round boundary stopped the next model/tool operation");

  const manualDatabase = openDatabase();
  const manual = manualDatabase.prepare(`
    SELECT e.id,e.project_id AS projectId,e.current_attempt_no AS attemptNo,
           a.id AS attemptId,s.id AS stagedId,s.action_id AS actionId,
           s.staged_hash AS stagedHash,x.operation_id AS operationId
    FROM executions e
    JOIN execution_attempts a ON a.execution_id=e.id AND a.attempt_no=e.current_attempt_no
    JOIN execution_staged_results s ON s.execution_id=e.id
    JOIN execution_actions x ON x.id=s.action_id
    WHERE e.id<>? LIMIT 1
  `).get(alphaExecution.executionId);
  const oldHash = "a".repeat(64);
  const postHash = "b".repeat(64);
  const observedHash = "c".repeat(64);
  const journalId = randomUUID();
  manualDatabase.prepare(`
    INSERT INTO execution_merge_journals (
      id,project_id,execution_id,attempt_id,staged_result_id,merge_action_id,operation_id,
      status,next_file_position,old_manifest_hash,post_manifest_hash,observed_manifest_hash,
      mismatch_phase,mismatch_path_key,journal_root,error_code,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,'manual_recovery',0,?,?,?,'external_after_replace',NULL,?,
      'MANUAL_RECOVERY_REQUIRED',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    journalId, manual.projectId, manual.id, manual.attemptId, manual.stagedId,
    manual.actionId, manual.operationId, oldHash, postHash, observedHash,
    join(temporaryDirectory, "journal"),
  );
  manualDatabase.prepare(`
    UPDATE executions SET status='conflicted',merged_at=NULL,manual_recovery_required=1,
      reason_code='MANUAL_RECOVERY_REQUIRED',business_round_count=3,version=version+1
    WHERE id=?
  `).run(manual.id);
  manualDatabase.close();
  await page.getByRole("button", { name: `刷新 ${manual.id === alphaExecution.executionId ? "Implement Alpha file" : "Implement Beta file"}` }).click();
  const recovery = await page.getByRole("region", { name: "需要人工恢复" });
  await recovery.getByRole("button", { name: "放弃且不改 canonical" }).focus();
  await page.keyboard.press("Enter");
  const confirmation = page.getByRole("dialog", { name: /确认人工恢复/ });
  await confirmation.getByRole("button", { name: "确认放弃恢复" }).focus();
  await page.keyboard.press("Enter");
  await page.getByText("人工恢复已完成，执行状态：已停止。").waitFor();
  console.log("MANUAL RECOVERY PASS: external mismatch blocked automation and exact abandon recovery completed");

  await page.reload({ waitUntil: "networkidle" });
  await openRunTab(page);
  await page.getByText("已停止").waitFor();
  await restartAppServer();
  await page.goto(`${baseUrl}/?restart=${Date.now()}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Execution Smoke Mission" }).waitFor();
  await openRunTab(page);
  await page.getByText("已停止").waitFor();
  desktopFacingText = await page.locator("html").innerText();
  await page.screenshot({ fullPage: true, path: desktopScreenshot });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.reload({ waitUntil: "networkidle" });
  const editorOpener = page.getByRole("button", { name: "打开编辑" });
  await editorOpener.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "任务编辑" });
  const runTab = editor.getByRole("tab", { name: "运行详情" });
  await runTab.focus();
  await page.keyboard.press("Enter");
  const switcher = editor.getByRole("list", { name: "执行摘要切换" });
  const firstSummary = switcher.getByRole("button").first();
  await firstSummary.focus();
  await page.keyboard.press("Enter");
  const detailDialog = page.getByRole("dialog", { name: /详情/ });
  await detailDialog.waitFor();
  const layout = await detailDialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      width: bounds.width,
      left: bounds.left,
      right: bounds.right,
      controls: [...element.querySelectorAll("button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return { height: rect.height, width: rect.width };
      }),
    };
  });
  assert.ok(layout.documentWidth <= layout.viewportWidth);
  assert.ok(layout.left >= 0 && layout.right <= layout.viewportWidth);
  assert.ok(layout.controls.every(({ height, width }) => height >= 44 && width >= 44));
  narrowFacingText = await page.locator("html").innerText();
  await page.screenshot({ fullPage: true, path: narrowScreenshot });
  await page.keyboard.press("Escape");
  await detailDialog.waitFor({ state: "detached" });
  assert.equal(await firstSummary.evaluate((element) => document.activeElement === element), true);

  const providerBodyText = providerCaptures.map(({ body }) => body).join("\n");
  assert.ok(providerCaptures.some(({ authorization }) => authorization === `Bearer ${apiKey}`));
  assert.ok(providerAuthorizationCount >= modelSteps.size + 1);
  const providerEnvelope = (() => {
    const database = openDatabase();
    try {
      return database.prepare(`
        SELECT api_key_cipher AS cipher,api_key_iv AS iv,api_key_tag AS tag FROM providers
      `).get();
    } finally {
      database.close();
    }
  })();
  const surfaces = {
    api: apiBodies.join("\n"),
    database: databaseText(),
    dom: `${desktopFacingText}\n${narrowFacingText}`,
    logs: serverOutput,
    providerBodies: providerBodyText,
    screenshotFacingText: `${desktopFacingText}\n${narrowFacingText}\n${
      readFileSync(desktopScreenshot).toString("latin1")
    }\n${readFileSync(narrowScreenshot).toString("latin1")}`,
  };
  const forbidden = [
    apiKey,
    masterKey,
    `Bearer ${apiKey}`,
    providerEnvelope.cipher,
    providerEnvelope.iv,
    providerEnvelope.tag,
    rawProviderMarker,
    chainOfThoughtMarker,
    canonicalWorkspace,
    realpathSync(executionRoot),
    temporaryDirectory,
    environmentMarker,
    "Authorization:",
  ];
  const leaks = [];
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const value of forbidden) {
      if (value && text.includes(value)) leaks.push({ surface, value });
    }
  }
  assert.deepEqual(leaks, []);
  const finalCounts = counts();
  console.log(
    "SECURITY SCAN PASS: key/master/cipher/Authorization/raw host paths/env/CoT occurrences=0 "
    + "across provider bodies, DB, product API, DOM, logs, and screenshot-facing surfaces",
  );
  console.log(
    `BROWSER PASS: providerCalls=${providerCaptures.length} maxConcurrentProviderCalls=${maxConcurrentProviderCalls} `
    + Object.entries(finalCounts).map(([name, value]) => `${name}=${value}`).join(" "),
  );
  console.log("PERSISTENCE PASS: refresh and process restart restored execution/manual recovery outcomes");
  console.log(`DESKTOP SCREENSHOT: ${desktopScreenshot}`);
  console.log(`NARROW SCREENSHOT: ${narrowScreenshot}`);
} finally {
  await page?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
  await browser?.close();
  stopAppServer();
  if (provider.listening) await close(provider);
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
