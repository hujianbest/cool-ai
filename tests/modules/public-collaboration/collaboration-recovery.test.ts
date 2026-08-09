import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StructuredTurnResult } from "@/src/modules/public-collaboration";
import {
  createThread,
  startThreadRun,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import type { ProjectThreadRunTuple } from "@/src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { seedMissionInitializationForMission as initializeMissionDeliveryTx } from "@/tests/fixtures/review/mission-initialization";

type RecoveryModule = {
  acquireAdvance: (
    databasePath: string,
    tuple: ProjectThreadRunTuple,
    input: { operationId: string },
    dependencies: Dependencies,
  ) => { kind: "acquired"; attempt: { id: string; leaseToken: string } };
  finalizeAdvance: (
    databasePath: string,
    tuple: ProjectThreadRunTuple,
    input: { attemptId: string; leaseToken: string; result: StructuredTurnResult },
    dependencies: Dependencies,
  ) => { affectedRows: number; body: unknown; status: number };
  recoverRun: (
    databasePath: string,
    tuple: ProjectThreadRunTuple,
    input: { operationId: string },
    dependencies: Dependencies,
  ) => { body: { attempt: { id: string; status: string }; run: { status: string } }; status: number };
};

type Dependencies = { clock: () => Date; randomUUID: () => string };

const modules = import.meta.glob<RecoveryModule>(
  "../../../src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator.ts",
);
const PROJECT_ID = "project-recovery";
let RUN_ID: string;
let THREAD_ID: string;
const AGENT_ID = "agent-recovery";
const ACQUIRED_AT = "2026-07-30T01:00:00.000Z";
const EXPIRED_AT = "2026-07-30T01:02:00.001Z";
const ADVANCE_ID = "00000000-0000-4000-8000-000000001100";
const RECOVER_ID = "00000000-0000-4000-8000-000000001101";

let directory: string;
let databasePath: string;
let uuid = 0;

function dependencies(now: string): Dependencies {
  return {
    clock: () => new Date(now),
    randomUUID: () => {
      uuid += 1;
      return `30000000-0000-4000-8000-${uuid.toString().padStart(12, "0")}`;
    },
  };
}

async function implementation(): Promise<RecoveryModule> {
  const load = modules["../../../src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator.ts"];
  expect(load).toBeTypeOf("function");
  const module = await load!();
  expect(module.recoverRun, "T-11 recoverRun must exist").toBeTypeOf("function");
  return module;
}

function seed(): void {
  const credential = createCredentialVault().encrypt(
    "provider-recovery",
    "provider-secret-recovery",
  );
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO projects (
        id, name, created_at, workspace_path, workspace_key, version
      ) VALUES (
        '${PROJECT_ID}', 'Recovery', '${ACQUIRED_AT}',
        'D:\\workspace', 'd:/workspace', 1
      );
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv,
        api_key_tag, credential_version, credential_generation, key_id,
        api_key_mask, verified_at, version, created_at, updated_at
      ) VALUES (
        'provider-recovery', 'Local', 'http://127.0.0.1:4000/v1', 'model',
        '${credential.apiKeyCipher}', '${credential.apiKeyIv}',
        '${credential.apiKeyTag}', 1, 1, '${credential.keyId}',
        '${credential.apiKeyMask}', '${ACQUIRED_AT}', 1,
        '${ACQUIRED_AT}', '${ACQUIRED_AT}'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text,
        accent_token, can_read, can_write, can_execute, max_tokens,
        max_handoffs, version, created_at, updated_at
      ) VALUES
        (
          '${AGENT_ID}', 'Alpha', 'Peer', 'private', 'provider-recovery',
          'model', 'A', 'sage', 1, 0, 0, 1000, 3, 1,
          '${ACQUIRED_AT}', '${ACQUIRED_AT}'
        ),
        (
          'agent-beta', 'Beta', 'Peer', 'private-beta', 'provider-recovery',
          'model', 'B', 'gold', 1, 0, 0, 1000, 3, 1,
          '${ACQUIRED_AT}', '${ACQUIRED_AT}'
        );
      INSERT INTO project_memberships (project_id, agent_id, joined_at) VALUES
        ('${PROJECT_ID}', '${AGENT_ID}', 'a'),
        ('${PROJECT_ID}', 'agent-beta', 'b');
      INSERT INTO missions (
        id, project_id, title, goal, version, created_at, updated_at
      ) VALUES (
        'mission-recovery', '${PROJECT_ID}', 'Mission', 'Recover safely', 1,
        '${ACQUIRED_AT}', '${ACQUIRED_AT}'
      );
    `);
    initializeMissionDeliveryTx(database, {
      id: "mission-recovery",
      projectId: PROJECT_ID,
      updatedAt: ACQUIRED_AT,
    });
  } finally {
    database.close();
  }
  THREAD_ID = createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [AGENT_ID, "agent-beta"],
    operationId: "00000000-0000-4000-8000-000000001098",
    title: "Recovery",
  }).body.thread.id;
  RUN_ID = startThreadRun(databasePath, PROJECT_ID, THREAD_ID, {
    message: "Recover this collaboration",
    operationId: "00000000-0000-4000-8000-000000001099",
  }).body.run.id;
}

function tuple(): ProjectThreadRunTuple {
  return { projectId: PROJECT_ID, runId: RUN_ID, threadId: THREAD_ID };
}

async function acquire() {
  const module = await implementation();
  return module.acquireAdvance(
    databasePath,
    tuple(),
    { operationId: ADVANCE_ID },
    dependencies(ACQUIRED_AT),
  ).attempt;
}

function facts() {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT
           (SELECT status FROM collaboration_attempts WHERE run_id = ?) AS attemptStatus,
           (SELECT error_category FROM collaboration_attempts WHERE run_id = ?) AS errorCategory,
           (SELECT status FROM collaboration_runs WHERE id = ?) AS runStatus,
           (SELECT pause_category FROM collaboration_runs WHERE id = ?) AS pauseCategory,
           (SELECT COUNT(*) FROM collaboration_events
              WHERE run_id = ? AND type = 'attempt_interrupted') AS interruptedEvents,
           (SELECT COUNT(*) FROM collaboration_model_calls AS calls
              JOIN collaboration_attempts AS attempts ON attempts.id = calls.attempt_id
              WHERE attempts.run_id = ?) AS calls,
           (SELECT COUNT(*) FROM collaboration_model_calls AS calls
              JOIN collaboration_attempts AS attempts ON attempts.id = calls.attempt_id
              WHERE attempts.run_id = ? AND calls.total_tokens IS NULL) AS unreported,
           (SELECT status FROM collaboration_operations
              WHERE project_id = ? AND id = ?) AS advanceReceipt,
           (SELECT http_status FROM collaboration_operations
              WHERE project_id = ? AND id = ?) AS advanceHttpStatus,
           (SELECT response_json FROM collaboration_operations
              WHERE project_id = ? AND id = ?) AS advanceResponse,
           (SELECT COUNT(*) FROM collaboration_turns WHERE run_id = ?) AS turns`
      )
      .get(
        RUN_ID,
        RUN_ID,
        RUN_ID,
        RUN_ID,
        RUN_ID,
        RUN_ID,
        RUN_ID,
        PROJECT_ID,
        ADVANCE_ID,
        PROJECT_ID,
        ADVANCE_ID,
        PROJECT_ID,
        ADVANCE_ID,
        RUN_ID,
      ) as {
      attemptStatus: string;
      errorCategory: string | null;
      runStatus: string;
      pauseCategory: string | null;
      interruptedEvents: number;
      calls: number;
      unreported: number;
      advanceReceipt: string;
      advanceHttpStatus: number | null;
      advanceResponse: string | null;
      turns: number;
    };
  } finally {
    database.close();
  }
}

function validResult(): StructuredTurnResult {
  const usage = { completionTokens: 4, promptTokens: 6, totalTokens: 10 };
  return {
    calls: [
      {
        kind: "primary",
        result: {
          content: '{"ok":true}',
          error: null,
          httpStatus: 200,
          status: "succeeded",
          usage,
          usageReported: true,
        },
      },
    ],
    pauseCategory: null,
    status: "completed",
    turn: {
      claim: null,
      disposition: { type: "plan_ready" },
      message: "Late result",
      tasks: [],
    },
    usage: [{ kind: "primary", usage, usageReported: true }],
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-recovery-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 30).toString("base64url");
  uuid = 0;
  seed();
});

afterEach(() => {
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("expired collaboration attempt reconciliation", () => {
  it("leaves an unexpired attempt calling and durably completes recover's own receipt", async () => {
    await acquire();
    const module = await implementation();
    const first = module.recoverRun(
      databasePath,
      tuple(),
      { operationId: RECOVER_ID },
      dependencies("2026-07-30T01:01:59.999Z"),
    );
    const replay = module.recoverRun(
      databasePath,
      tuple(),
      { operationId: RECOVER_ID },
      dependencies(EXPIRED_AT),
    );

    expect(first).toMatchObject({
      body: { attempt: { status: "calling" }, run: { status: "running" } },
      status: 200,
    });
    expect(replay).toEqual(first);
    expect(facts()).toMatchObject({
      attemptStatus: "calling",
      interruptedEvents: 0,
      runStatus: "running",
    });
  });

  it("CAS-reconciles an expired call exactly once and completes the original advance", async () => {
    await acquire();
    const module = await implementation();
    const first = module.recoverRun(
      databasePath,
      tuple(),
      { operationId: RECOVER_ID },
      dependencies(EXPIRED_AT),
    );
    const second = module.recoverRun(
      databasePath,
      tuple(),
      { operationId: "00000000-0000-4000-8000-000000001102" },
      dependencies(EXPIRED_AT),
    );

    expect(first).toMatchObject({
      body: { attempt: { status: "interrupted" }, run: { status: "paused" } },
      status: 200,
    });
    expect(second).toMatchObject({
      body: { attempt: { status: "interrupted" }, run: { status: "paused" } },
      status: 200,
    });
    const state = facts();
    expect(state).toMatchObject({
      advanceHttpStatus: 200,
      advanceReceipt: "completed",
      attemptStatus: "interrupted",
      calls: 1,
      errorCategory: "interrupted",
      interruptedEvents: 1,
      pauseCategory: "interrupted",
      runStatus: "paused",
      turns: 0,
      unreported: 1,
    });
    expect(JSON.parse(state.advanceResponse!)).toMatchObject({
      attemptStatus: "interrupted",
      run: { status: "paused" },
    });
  });

  it("is restart-safe and concurrent recover calls remain idempotent", async () => {
    await acquire();
    const module = await implementation();
    const results = await Promise.all([
      Promise.resolve().then(() =>
        module.recoverRun(
          databasePath,
          tuple(),
          { operationId: RECOVER_ID },
          dependencies(EXPIRED_AT),
        ),
      ),
      Promise.resolve().then(() =>
        module.recoverRun(
          databasePath,
          tuple(),
          { operationId: "00000000-0000-4000-8000-000000001103" },
          dependencies(EXPIRED_AT),
        ),
      ),
    ]);

    expect(results[0]).toMatchObject({ body: { attempt: { status: "interrupted" } } });
    expect(results[1]).toMatchObject({ body: { attempt: { status: "interrupted" } } });
    expect(facts()).toMatchObject({
      attemptStatus: "interrupted",
      calls: 1,
      interruptedEvents: 1,
      unreported: 1,
    });

    const restarted = await implementation();
    expect(
      restarted.recoverRun(
        databasePath,
        tuple(),
        { operationId: "00000000-0000-4000-8000-000000001104" },
        dependencies(EXPIRED_AT),
      ),
    ).toMatchObject({ body: { attempt: { status: "interrupted" } } });
  });

  it("rejects a late provider result without changing durable recovery facts", async () => {
    const attempt = await acquire();
    const module = await implementation();
    module.recoverRun(
      databasePath,
      tuple(),
      { operationId: RECOVER_ID },
      dependencies(EXPIRED_AT),
    );
    const before = facts();
    const late = module.finalizeAdvance(
      databasePath,
      tuple(),
      { attemptId: attempt.id, leaseToken: attempt.leaseToken, result: validResult() },
      dependencies(EXPIRED_AT),
    );

    expect(late).toMatchObject({
      affectedRows: 0,
      body: { attemptStatus: "interrupted" },
      status: 200,
    });
    expect(facts()).toEqual(before);
  });
});
/*
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalRequestHash } from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

type RecoveryModule = {
  reconcileExpiredAttempt?: (
    databasePath: string,
    runId: string,
    dependencies: { clock: () => Date; randomUUID: () => string },
  ) => {
    affectedRows: 0 | 1;
    attempt: { id: string; status: "calling" | "interrupted" };
    run: { status: string; pauseCategory: string | null };
  };
  recoverRun?: (
    databasePath: string,
    runId: string,
    input: { operationId: string },
    dependencies: { clock: () => Date; randomUUID: () => string },
  ) => {
    body: {
      attempt: { id: string; status: "calling" | "interrupted" };
      run: { status: string; pauseCategory: string | null };
    };
    status: number;
  };
};

const modules = import.meta.glob<RecoveryModule>(
  "../../../src/adapters/outbound/sqlite/public-collaboration/recovery-service.ts",
);
const PROJECT_ID = "project-recovery";
const RUN_ID = "run-recovery";
const ATTEMPT_ID = "attempt-recovery";
const ADVANCE_ID = "00000000-0000-4000-8000-000000001101";
const RECOVER_ID = "00000000-0000-4000-8000-000000001102";
const STARTED_AT = "2026-07-30T03:00:00.000Z";
const EXPIRES_AT = "2026-07-30T03:02:00.000Z";
const AFTER_EXPIRY = "2026-07-30T03:02:00.001Z";

let directory: string;
let databasePath: string;
let uuidSequence: number;

function dependencies(now = AFTER_EXPIRY) {
  return {
    clock: () => new Date(now),
    randomUUID: () => {
      uuidSequence += 1;
      return `30000000-0000-4000-8000-${uuidSequence.toString().padStart(12, "0")}`;
    },
  };
}

function seedCallingAttempt(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO projects (
        id, name, created_at, workspace_path, workspace_key, version
      ) VALUES (
        '${PROJECT_ID}', 'Recovery Project', '${STARTED_AT}',
        'D:\\workspace', 'd:/workspace', 1
      );
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv,
        api_key_tag, credential_version, credential_generation, key_id,
        api_key_mask, verified_at, version, created_at, updated_at
      ) VALUES (
        'provider-recovery', 'Local', 'http://127.0.0.1:4000/v1', 'model',
        'cipher', 'iv', 'tag', 1, 1, 'key-1', '***', '${STARTED_AT}', 1,
        '${STARTED_AT}', '${STARTED_AT}'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text,
        accent_token, can_read, can_write, can_execute, max_tokens,
        max_handoffs, version, created_at, updated_at
      ) VALUES (
        'agent-recovery', 'Alpha', 'Planner', 'private',
        'provider-recovery', 'model', 'A', 'sage', 1, 0, 0, 1000, 2, 1,
        '${STARTED_AT}', '${STARTED_AT}'
      );
      INSERT INTO collaboration_runs (
        id, project_id, status, current_agent_id, round_count,
        next_event_sequence, version, execution_epoch, pause_reason,
        pause_category, created_at, updated_at
      ) VALUES (
        '${RUN_ID}', '${PROJECT_ID}', 'running', 'agent-recovery', 0,
        1, 1, 7, NULL, NULL, '${STARTED_AT}', '${STARTED_AT}'
      );
      INSERT INTO collaboration_operations (
        id, project_id, run_id, kind, request_hash, status,
        http_status, response_json, created_at, updated_at
      ) VALUES (
        '${ADVANCE_ID}', '${PROJECT_ID}', '${RUN_ID}', 'advance',
        '${canonicalRequestHash({})}', 'pending', NULL, NULL,
        '${STARTED_AT}', '${STARTED_AT}'
      );
      INSERT INTO collaboration_attempts (
        id, project_id, run_id, agent_id, operation_id, status,
        lease_token, lease_expires_at, prompt_hash, acquire_execution_epoch,
        acquire_context_hash, included_message_sequence, error_category,
        started_at, finished_at
      ) VALUES (
        '${ATTEMPT_ID}', '${PROJECT_ID}', '${RUN_ID}', 'agent-recovery',
        '${ADVANCE_ID}', 'calling', 'lease-recovery', '${EXPIRES_AT}',
        'prompt', 7, 'context', 0, NULL, '${STARTED_AT}', NULL
      );
    `);
  } finally {
    database.close();
  }
}

async function recovery(): Promise<Required<RecoveryModule>> {
  const load = modules["../../../src/adapters/outbound/sqlite/public-collaboration/recovery-service.ts"];
  expect(load, "T-11 recovery service must exist").toBeTypeOf("function");
  const implementation = await load!();
  expect(implementation.reconcileExpiredAttempt).toBeTypeOf("function");
  expect(implementation.recoverRun).toBeTypeOf("function");
  return implementation as Required<RecoveryModule>;
}

function state() {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT
          (SELECT status FROM collaboration_attempts WHERE id = ?) AS attemptStatus,
          (SELECT error_category FROM collaboration_attempts WHERE id = ?) AS attemptError,
          (SELECT status FROM collaboration_runs WHERE id = ?) AS runStatus,
          (SELECT pause_category FROM collaboration_runs WHERE id = ?) AS pauseCategory,
          (SELECT version FROM collaboration_runs WHERE id = ?) AS runVersion,
          (SELECT COUNT(*) FROM collaboration_events
             WHERE run_id = ? AND type = 'attempt_interrupted') AS interruptedEvents,
          (SELECT COUNT(*) FROM collaboration_model_calls
             WHERE attempt_id = ?) AS callRows,
          (SELECT COUNT(*) FROM collaboration_model_calls
             WHERE attempt_id = ? AND prompt_tokens IS NULL
               AND completion_tokens IS NULL AND total_tokens IS NULL
               AND error_category = 'interrupted') AS unreportedCalls,
          (SELECT status FROM collaboration_operations
             WHERE project_id = ? AND id = ?) AS advanceReceiptStatus,
          (SELECT http_status FROM collaboration_operations
             WHERE project_id = ? AND id = ?) AS advanceHttpStatus,
          (SELECT response_json FROM collaboration_operations
             WHERE project_id = ? AND id = ?) AS advanceResponse`,
      )
      .get(
        ATTEMPT_ID,
        ATTEMPT_ID,
        RUN_ID,
        RUN_ID,
        RUN_ID,
        RUN_ID,
        ATTEMPT_ID,
        ATTEMPT_ID,
        PROJECT_ID,
        ADVANCE_ID,
        PROJECT_ID,
        ADVANCE_ID,
        PROJECT_ID,
        ADVANCE_ID,
      ) as {
      attemptStatus: string;
      attemptError: string | null;
      runStatus: string;
      pauseCategory: string | null;
      runVersion: number;
      interruptedEvents: number;
      callRows: number;
      unreportedCalls: number;
      advanceReceiptStatus: string;
      advanceHttpStatus: number | null;
      advanceResponse: string | null;
    };
  } finally {
    database.close();
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-recovery-"));
  databasePath = join(directory, "cockpit.sqlite");
  uuidSequence = 0;
  seedCallingAttempt();
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("expired calling attempt reconciliation", () => {
  it("CASes calling to interrupted exactly once, pauses the run, emits one event, and durably completes advance", async () => {
    const service = await recovery();
    const first = service.reconcileExpiredAttempt(
      databasePath,
      RUN_ID,
      dependencies(),
    );
    const second = service.reconcileExpiredAttempt(
      databasePath,
      RUN_ID,
      dependencies(),
    );

    expect(first).toMatchObject({
      affectedRows: 1,
      attempt: { id: ATTEMPT_ID, status: "interrupted" },
      run: { pauseCategory: "interrupted", status: "paused" },
    });
    expect(second).toEqual({ ...first, affectedRows: 0 });
    const durable = state();
    expect(durable).toMatchObject({
      advanceHttpStatus: 200,
      advanceReceiptStatus: "completed",
      attemptError: "interrupted",
      attemptStatus: "interrupted",
      callRows: 1,
      interruptedEvents: 1,
      pauseCategory: "interrupted",
      runStatus: "paused",
      runVersion: 2,
      unreportedCalls: 1,
    });
    expect(JSON.parse(durable.advanceResponse!)).toMatchObject({
      attemptStatus: "interrupted",
      run: { pauseCategory: "interrupted", status: "paused" },
    });
  });

  it("leaves an unexpired lease calling and writes no recovery facts", async () => {
    const service = await recovery();
    const result = service.reconcileExpiredAttempt(
      databasePath,
      RUN_ID,
      dependencies("2026-07-30T03:01:59.999Z"),
    );

    expect(result).toMatchObject({
      affectedRows: 0,
      attempt: { status: "calling" },
      run: { status: "running" },
    });
    expect(state()).toMatchObject({
      advanceReceiptStatus: "pending",
      attemptStatus: "calling",
      callRows: 0,
      interruptedEvents: 0,
      runStatus: "running",
    });
  });

  it("survives reopening the database and concurrent reconciliation remains idempotent", async () => {
    const service = await recovery();
    const results = await Promise.all([
      Promise.resolve().then(() =>
        service.reconcileExpiredAttempt(databasePath, RUN_ID, dependencies()),
      ),
      Promise.resolve().then(() =>
        service.reconcileExpiredAttempt(databasePath, RUN_ID, dependencies()),
      ),
    ]);

    expect(results.filter((result) => result.affectedRows === 1)).toHaveLength(1);
    expect(results.filter((result) => result.affectedRows === 0)).toHaveLength(1);
    expect(state()).toMatchObject({
      attemptStatus: "interrupted",
      callRows: 1,
      interruptedEvents: 1,
      unreportedCalls: 1,
    });
  });

  it("completes and exactly replays recover's own independent receipt", async () => {
    const service = await recovery();
    const input = { operationId: RECOVER_ID };
    const first = service.recoverRun(databasePath, RUN_ID, input, dependencies());
    const replay = service.recoverRun(databasePath, RUN_ID, input, dependencies());

    expect(first).toMatchObject({
      body: {
        attempt: { status: "interrupted" },
        run: { pauseCategory: "interrupted", status: "paused" },
      },
      status: 200,
    });
    expect(replay).toEqual(first);
    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT kind, status, http_status AS httpStatus,
                    response_json AS responseJson
             FROM collaboration_operations
             WHERE project_id = ? AND id = ?`,
          )
          .get(PROJECT_ID, RECOVER_ID),
      ).toEqual({
        httpStatus: 200,
        kind: "recover",
        responseJson: JSON.stringify(first.body),
        status: "completed",
      });
    } finally {
      database.close();
    }
  });
});
*/
