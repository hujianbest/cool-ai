import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireAdvance } from "@/src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator";
import {
  createThread,
  startThreadRun,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { seedMissionInitializationForMission as initializeMissionDeliveryTx } from "@/tests/fixtures/review/mission-initialization";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

type GetRoute = {
  GET(
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ): Promise<Response>;
};
type PostRoute = {
  POST(
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<GetRoute | PostRoute>([
  "../../../app/api/projects/[projectId]/threads/[threadId]/route.ts",
  "../../../app/api/projects/[projectId]/threads/[threadId]/messages/route.ts",
  "../../../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/recover/route.ts",
]);

const PROJECT_ID = "project-recovery-api";
let RUN_ID: string;
let THREAD_ID: string;
const AGENT_ID = "agent-recovery-api";
const NOW = "2026-07-30T01:00:00.000Z";
const ADVANCE_ID = "00000000-0000-4000-8000-000000001200";

let directory: string;
let databasePath: string;
let uuid = 0;

function seed(): void {
  const credential = createCredentialVault().encrypt(
    "provider-recovery-api",
    "provider-secret-recovery-api",
  );
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO projects (
        id, name, created_at, workspace_path, workspace_key, version
      ) VALUES (
        '${PROJECT_ID}', 'Recovery API', '${NOW}',
        'D:\\workspace', 'd:/workspace', 1
      );
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv,
        api_key_tag, credential_version, credential_generation, key_id,
        api_key_mask, verified_at, version, created_at, updated_at
      ) VALUES (
        'provider-recovery-api', 'Local', 'http://127.0.0.1:4000/v1', 'model',
        '${credential.apiKeyCipher}', '${credential.apiKeyIv}',
        '${credential.apiKeyTag}', 1, 1, '${credential.keyId}',
        '${credential.apiKeyMask}', '${NOW}', 1, '${NOW}', '${NOW}'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text,
        accent_token, can_read, can_write, can_execute, max_tokens,
        max_handoffs, version, created_at, updated_at
      ) VALUES
        (
          '${AGENT_ID}', 'Alpha', 'Peer', 'private', 'provider-recovery-api',
          'model', 'A', 'sage', 1, 0, 0, 1000, 3, 1, '${NOW}', '${NOW}'
        ),
        (
          'agent-beta-api', 'Beta', 'Peer', 'private-beta', 'provider-recovery-api',
          'model', 'B', 'gold', 1, 0, 0, 1000, 3, 1, '${NOW}', '${NOW}'
        );
      INSERT INTO project_memberships (project_id, agent_id, joined_at) VALUES
        ('${PROJECT_ID}', '${AGENT_ID}', 'a'),
        ('${PROJECT_ID}', 'agent-beta-api', 'b');
      INSERT INTO missions (
        id, project_id, title, goal, version, created_at, updated_at
      ) VALUES (
        'mission-recovery-api', '${PROJECT_ID}', 'Mission', 'Recover safely', 1,
        '${NOW}', '${NOW}'
      );
    `);
    initializeMissionDeliveryTx(database, {
      id: "mission-recovery-api",
      projectId: PROJECT_ID,
      updatedAt: NOW,
    });
  } finally {
    database.close();
  }
  THREAD_ID = createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [AGENT_ID, "agent-beta-api"],
    operationId: "00000000-0000-4000-8000-000000001198",
    title: "Recovery API",
  }).body.thread.id;
  RUN_ID = startThreadRun(databasePath, PROJECT_ID, THREAD_ID, {
    message: "Recover API",
    operationId: "00000000-0000-4000-8000-000000001199",
  }).body.run.id;
}

function acquireExpired(): void {
  acquireAdvance(
    databasePath,
    { projectId: PROJECT_ID, runId: RUN_ID, threadId: THREAD_ID },
    { operationId: ADVANCE_ID },
    {
      clock: () => new Date(NOW),
      randomUUID: () => {
        uuid += 1;
        return `40000000-0000-4000-8000-${uuid.toString().padStart(12, "0")}`;
      },
    },
  );
  const database = openDatabase(databasePath);
  try {
    database
      .prepare("UPDATE collaboration_attempts SET lease_expires_at = ? WHERE run_id = ?")
      .run("2000-01-01T00:00:00.000Z", RUN_ID);
  } finally {
    database.close();
  }
}

async function loadRoute<T extends GetRoute | PostRoute>(path: string): Promise<T> {
  const load = routeModules[path];
  expect(load, `${path} must exist`).toBeTypeOf("function");
  return (await load!()) as T;
}

async function readCollaboration(): Promise<Response> {
  const route = await loadRoute<GetRoute>(
    "../../../app/api/projects/[projectId]/threads/[threadId]/route.ts",
  );
  return route.GET(
    new Request(
      `http://localhost/api/projects/${PROJECT_ID}/threads/${THREAD_ID}?run=${RUN_ID}`,
    ),
    { params: Promise.resolve({ projectId: PROJECT_ID, threadId: THREAD_ID }) },
  );
}

async function postMessage(operationId: string): Promise<Response> {
  const route = await loadRoute<PostRoute>(
    "../../../app/api/projects/[projectId]/threads/[threadId]/messages/route.ts",
  );
  return route.POST(
    new Request(
      `http://localhost/api/projects/${PROJECT_ID}/threads/${THREAD_ID}/messages`,
      {
      body: JSON.stringify({ content: "Mutation triggers recovery", operationId }),
      headers: { "content-type": "application/json" },
      method: "POST",
      },
    ),
    { params: Promise.resolve({ projectId: PROJECT_ID, threadId: THREAD_ID }) },
  );
}

async function recover(operationId: string): Promise<Response> {
  const route = await loadRoute<PostRoute>(
    "../../../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/recover/route.ts",
  );
  return route.POST(
    new Request(
      `http://localhost/api/projects/${PROJECT_ID}/threads/${THREAD_ID}/runs/${RUN_ID}/recover`,
      {
      body: JSON.stringify({ operationId }),
      headers: { "content-type": "application/json" },
      method: "POST",
      },
    ),
    {
      params: Promise.resolve({
        projectId: PROJECT_ID,
        runId: RUN_ID,
        threadId: THREAD_ID,
      }),
    },
  );
}

function state() {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT
           (SELECT status FROM collaboration_attempts WHERE run_id = ?) AS attemptStatus,
           (SELECT status FROM collaboration_runs WHERE id = ?) AS runStatus,
           (SELECT COUNT(*) FROM collaboration_events
              WHERE run_id = ? AND type = 'attempt_interrupted') AS events,
           (SELECT COUNT(*) FROM collaboration_model_calls AS calls
              JOIN collaboration_attempts AS attempts ON attempts.id = calls.attempt_id
              WHERE attempts.run_id = ?) AS calls`
      )
      .get(RUN_ID, RUN_ID, RUN_ID, RUN_ID) as {
      attemptStatus: string;
      runStatus: string;
      events: number;
      calls: number;
    };
  } finally {
    database.close();
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-recovery-api-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 31).toString("base64url");
  uuid = 0;
  seed();
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("collaboration recovery API triggers", () => {
  it("reconciles an expired attempt before returning collaboration read facts", async () => {
    acquireExpired();
    const response = await readCollaboration();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      selectedRun: { pauseCategory: "interrupted", status: "paused" },
    });
    expect(state()).toEqual({
      attemptStatus: "interrupted",
      calls: 1,
      events: 1,
      runStatus: "paused",
    });
  });

  it("keeps a thread message independent from run recovery and replays it", async () => {
    acquireExpired();
    const operationId = "00000000-0000-4000-8000-000000001201";
    const first = await postMessage(operationId);
    const firstBody = await first.json();
    const replay = await postMessage(operationId);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstBody);
    expect(firstBody).toMatchObject({
      message: { content: "Mutation triggers recovery", runId: null },
      run: null,
    });
    expect(state()).toMatchObject({
      attemptStatus: "calling",
      events: 0,
      runStatus: "running",
    });
  });

  it("explicit recover completes and replays its own receipt without duplicating facts", async () => {
    acquireExpired();
    const operationId = "00000000-0000-4000-8000-000000001202";
    const first = await recover(operationId);
    const firstBody = await first.json();
    const replay = await recover(operationId);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(firstBody).toMatchObject({
      attempt: { status: "interrupted" },
      run: { pauseCategory: "interrupted", status: "paused" },
    });
    expect(state()).toEqual({
      attemptStatus: "interrupted",
      calls: 1,
      events: 1,
      runStatus: "paused",
    });
  });

  it("rejects reusing an advance operation id at the recover endpoint", async () => {
    acquireExpired();

    const response = await recover(ADVANCE_ID);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "OPERATION_CONFLICT",
        message: "Operation id was already used for different input.",
      },
    });
  });
});
/*
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalRequestHash } from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";

type ReadRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};
type MessageRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};
type RecoverRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ runId: string }> },
  ): Promise<Response>;
};

const readModules = import.meta.glob<ReadRoute>(
  "../../../app/api/projects/[projectId]/collaboration/route.ts",
);
const messageModules = import.meta.glob<MessageRoute>(
  "../../../app/api/projects/[projectId]/messages/route.ts",
);
const recoverModules = import.meta.glob<RecoverRoute>(
  "../../../app/api/runs/[runId]/recover/route.ts",
);

const PROJECT_ID = "project-recovery-api";
const RUN_ID = "run-recovery-api";
const ATTEMPT_ID = "attempt-recovery-api";
const ADVANCE_ID = "00000000-0000-4000-8000-000000001111";
const EXPIRED_AT = "2000-01-01T00:00:00.000Z";
const TIMESTAMP = "2026-07-30T04:00:00.000Z";

let directory: string;
let databasePath: string;

function seed(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO projects (
        id, name, created_at, workspace_path, workspace_key, version
      ) VALUES (
        '${PROJECT_ID}', 'Recovery API', '${TIMESTAMP}',
        'D:\\workspace', 'd:/workspace', 1
      );
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv,
        api_key_tag, credential_version, credential_generation, key_id,
        api_key_mask, verified_at, version, created_at, updated_at
      ) VALUES (
        'provider-recovery-api', 'Local', 'http://127.0.0.1:4000/v1', 'model',
        'cipher', 'iv', 'tag', 1, 1, 'key-1', '***', '${TIMESTAMP}', 1,
        '${TIMESTAMP}', '${TIMESTAMP}'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text,
        accent_token, can_read, can_write, can_execute, max_tokens,
        max_handoffs, version, created_at, updated_at
      ) VALUES
        (
          'agent-recovery-api', 'Alpha', 'Planner', 'private',
          'provider-recovery-api', 'model', 'A', 'sage', 1, 0, 0, 1000, 2, 1,
          '${TIMESTAMP}', '${TIMESTAMP}'
        ),
        (
          'agent-recovery-api-b', 'Beta', 'Reviewer', 'private',
          'provider-recovery-api', 'model', 'B', 'gold', 1, 0, 0, 1000, 2, 1,
          '${TIMESTAMP}', '${TIMESTAMP}'
        );
      INSERT INTO project_memberships (project_id, agent_id, joined_at) VALUES
        ('${PROJECT_ID}', 'agent-recovery-api', 'a'),
        ('${PROJECT_ID}', 'agent-recovery-api-b', 'b');
      INSERT INTO missions (
        id, project_id, title, goal, version, created_at, updated_at
      ) VALUES (
        'mission-recovery-api', '${PROJECT_ID}', 'Mission', 'Recover', 1,
        '${TIMESTAMP}', '${TIMESTAMP}'
      );
      INSERT INTO collaboration_runs (
        id, project_id, status, current_agent_id, round_count,
        next_event_sequence, version, execution_epoch, pause_reason,
        pause_category, created_at, updated_at
      ) VALUES (
        '${RUN_ID}', '${PROJECT_ID}', 'running', 'agent-recovery-api', 0,
        1, 1, 7, NULL, NULL, '${TIMESTAMP}', '${TIMESTAMP}'
      );
      INSERT INTO collaboration_project_sequences (
        project_id, next_message_sequence
      ) VALUES ('${PROJECT_ID}', 1);
      INSERT INTO collaboration_operations (
        id, project_id, run_id, kind, request_hash, status,
        http_status, response_json, created_at, updated_at
      ) VALUES (
        '${ADVANCE_ID}', '${PROJECT_ID}', '${RUN_ID}', 'advance',
        '${canonicalRequestHash({})}', 'pending', NULL, NULL,
        '${TIMESTAMP}', '${TIMESTAMP}'
      );
      INSERT INTO collaboration_attempts (
        id, project_id, run_id, agent_id, operation_id, status,
        lease_token, lease_expires_at, prompt_hash, acquire_execution_epoch,
        acquire_context_hash, included_message_sequence, error_category,
        started_at, finished_at
      ) VALUES (
        '${ATTEMPT_ID}', '${PROJECT_ID}', '${RUN_ID}', 'agent-recovery-api',
        '${ADVANCE_ID}', 'calling', 'lease-api', '${EXPIRED_AT}',
        'prompt', 7, 'context', 0, NULL, '${TIMESTAMP}', NULL
      );
    `);
  } finally {
    database.close();
  }
}

function resetCalling(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec("DELETE FROM collaboration_model_calls; DELETE FROM collaboration_events;");
    database
      .prepare(
        `UPDATE collaboration_runs
         SET status = 'running', pause_category = NULL, pause_reason = NULL,
             version = 1, next_event_sequence = 1`,
      )
      .run();
    database
      .prepare(
        `UPDATE collaboration_attempts
         SET status = 'calling', error_category = NULL, finished_at = NULL`,
      )
      .run();
    database
      .prepare(
        `UPDATE collaboration_operations
         SET status = 'pending', http_status = NULL, response_json = NULL
         WHERE id = ?`,
      )
      .run(ADVANCE_ID);
  } finally {
    database.close();
  }
}

function facts() {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT
          (SELECT status FROM collaboration_attempts WHERE id = ?) AS attemptStatus,
          (SELECT status FROM collaboration_runs WHERE id = ?) AS runStatus,
          (SELECT pause_category FROM collaboration_runs WHERE id = ?) AS pauseCategory,
          (SELECT COUNT(*) FROM collaboration_events
             WHERE run_id = ? AND type = 'attempt_interrupted') AS events`,
      )
      .get(ATTEMPT_ID, RUN_ID, RUN_ID, RUN_ID) as {
      attemptStatus: string;
      runStatus: string;
      pauseCategory: string | null;
      events: number;
    };
  } finally {
    database.close();
  }
}

async function readRoute(): Promise<ReadRoute> {
  return readModules["../../../app/api/projects/[projectId]/collaboration/route.ts"]!();
}

async function messageRoute(): Promise<MessageRoute> {
  return messageModules["../../../app/api/projects/[projectId]/messages/route.ts"]!();
}

async function recoverRoute(): Promise<RecoverRoute> {
  const load = recoverModules["../../../app/api/runs/[runId]/recover/route.ts"];
  expect(load, "T-11 recover API route must exist").toBeTypeOf("function");
  return load!();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-recovery-api-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  seed();
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("collaboration recovery triggers", () => {
  it("reconciles an expired attempt before returning collaboration read state", async () => {
    const response = await (await readRoute()).GET(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/collaboration`),
      { params: Promise.resolve({ projectId: PROJECT_ID }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      run: { pauseCategory: "interrupted", status: "paused" },
    });
    expect(facts()).toEqual({
      attemptStatus: "interrupted",
      events: 1,
      pauseCategory: "interrupted",
      runStatus: "paused",
    });
  });

  it("reconciles before a relevant message mutation and preserves the mutation", async () => {
    const response = await (await messageRoute()).POST(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/messages`, {
        body: JSON.stringify({
          content: "Are you still there?",
          operationId: "00000000-0000-4000-8000-000000001112",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ projectId: PROJECT_ID }) },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      message: { content: "Are you still there?", runId: RUN_ID },
      run: { pauseCategory: "interrupted", status: "paused" },
    });
    expect(facts()).toMatchObject({
      attemptStatus: "interrupted",
      events: 1,
      runStatus: "paused",
    });
  });

  it("explicit recover completes and replays its receipt while repeated calls stay idempotent", async () => {
    const route = await recoverRoute();
    const operationId = "00000000-0000-4000-8000-000000001113";
    const request = () =>
      new Request(`http://localhost/api/runs/${RUN_ID}/recover`, {
        body: JSON.stringify({ operationId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    const context = { params: Promise.resolve({ runId: RUN_ID }) };
    const first = await route.POST(request(), context);
    const firstBody = await first.json();
    const replay = await route.POST(request(), context);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstBody);
    expect(firstBody).toMatchObject({
      attempt: { status: "interrupted" },
      run: { pauseCategory: "interrupted", status: "paused" },
    });
    expect(facts().events).toBe(1);

    resetCalling();
    const freshOperation = "00000000-0000-4000-8000-000000001114";
    const restarted = await route.POST(
      new Request(`http://localhost/api/runs/${RUN_ID}/recover`, {
        body: JSON.stringify({ operationId: freshOperation }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ runId: RUN_ID }) },
    );
    expect(restarted.status).toBe(200);
    expect(facts().attemptStatus).toBe("interrupted");
  });
});
*/
