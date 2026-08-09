import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as runService from "@/src/adapters/outbound/sqlite/public-collaboration/run-service";
import { CollaborationError } from "@/src/modules/public-collaboration";
import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { seedMissionInitializationForMission as initializeMissionDeliveryTx } from "@/tests/fixtures/review/mission-initialization";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type ControlAction = "pause" | "continue" | "retry" | "stop";
type ControlInput = {
  action: ControlAction;
  expectedVersion: number;
  operationId: string;
};
type ControlResult = {
  body: { run: { status: string; pauseCategory: string | null; version: number } };
  status: number;
};
type ControlRun = (
  databasePath: string,
  projectId: string,
  threadId: string,
  runId: string,
  input: ControlInput,
) => ControlResult;
type ControlRoute = {
  POST(
    request: Request,
    context: {
      params: Promise<{ projectId: string; threadId: string; runId: string }>;
    },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<ControlRoute>(
  "../../../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/control/route.ts",
);

let databasePath: string;
let threadId: string;
let runId: string;
let operationSequence: number;

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function control(input: ControlInput): ControlResult {
  const implementation = (runService as unknown as { controlThreadRun?: ControlRun })
    .controlThreadRun;
  expect(implementation, "tuple control service must exist").toBeTypeOf("function");
  return implementation!(databasePath, "project-1", threadId, runId, input);
}

function seedReadyRun(): void {
  const database = openDatabase(databasePath);
  const timestamp = "2026-07-30T00:00:00.000Z";
  try {
    database.exec(`
      INSERT INTO projects (
        id, name, created_at, workspace_path, workspace_key, version
      ) VALUES (
        'project-1', 'Project', '${timestamp}', 'D:\\workspace', 'd:/workspace', 1
      );
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv,
        api_key_tag, credential_version, credential_generation, key_id,
        api_key_mask, verified_at, version, created_at, updated_at
      ) VALUES (
        'provider-1', 'Local', 'http://127.0.0.1:4000/v1', 'model',
        'cipher', 'iv', 'tag', 1, 1, 'key-1', '***', '${timestamp}', 1,
        '${timestamp}', '${timestamp}'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text,
        accent_token, can_read, can_write, can_execute, max_tokens,
        max_handoffs, version, created_at, updated_at
      ) VALUES
        (
          'agent-a', 'Alpha', 'Peer', 'Prompt', 'provider-1', 'model', 'A',
          'sage', 1, 0, 0, 1000, 5, 1, '${timestamp}', '${timestamp}'
        ),
        (
          'agent-b', 'Beta', 'Peer', 'Prompt', 'provider-1', 'model', 'B',
          'sage', 1, 0, 0, 1000, 5, 1, '${timestamp}', '${timestamp}'
        );
      INSERT INTO project_memberships (project_id, agent_id, joined_at)
      VALUES ('project-1', 'agent-a', 'a'), ('project-1', 'agent-b', 'b');
      INSERT INTO missions (
        id, project_id, title, goal, version, created_at, updated_at
      ) VALUES (
        'mission-1', 'project-1', 'Mission', 'Goal', 1, '${timestamp}', '${timestamp}'
      );
    `);
    initializeMissionDeliveryTx(database, {
      id: "mission-1",
      projectId: "project-1",
      updatedAt: timestamp,
    });
  } finally {
    database.close();
  }
  threadId = createThread(databasePath, "project-1", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: operationId(),
    title: "Control thread",
  }).body.thread.id;
  runId = "run-control";
  const seeded = openDatabase(databasePath);
  try {
    seeded.exec("BEGIN IMMEDIATE");
    const thread = seeded.prepare(
      `SELECT next_fact_sequence AS factSequence
       FROM collaboration_threads WHERE project_id='project-1' AND id=?`,
    ).get(threadId) as { factSequence: number };
    const project = seeded.prepare(
      `SELECT next_activity_sequence AS activitySequence
       FROM collaboration_project_thread_sequences WHERE project_id='project-1'`,
    ).get() as { activitySequence: number };
    seeded.prepare(
      `INSERT INTO collaboration_runs(
         id,project_id,thread_id,status,current_agent_id,round_count,
         next_event_sequence,version,execution_epoch,pause_reason,pause_category,
         created_at,updated_at
       ) VALUES (?,'project-1',?,'running','agent-a',0,1,1,1,NULL,NULL,?,?)`,
    ).run(runId, threadId, timestamp, timestamp);
    seeded.prepare(
      `INSERT INTO collaboration_thread_facts(
         id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
         run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
       ) VALUES ('fact-link-control','project-1',?,?,?,'run_linked','system',NULL,
         ?,NULL,NULL,NULL,?,?)`,
    ).run(
      threadId,
      thread.factSequence,
      project.activitySequence,
      runId,
      JSON.stringify({ runId }),
      timestamp,
    );
    seeded.prepare(
      `UPDATE collaboration_threads
       SET next_fact_sequence=next_fact_sequence+1,last_activity_sequence=?
       WHERE project_id='project-1' AND id=?`,
    ).run(project.activitySequence, threadId);
    seeded.prepare(
      `UPDATE collaboration_project_thread_sequences
       SET next_activity_sequence=next_activity_sequence+1 WHERE project_id='project-1'`,
    ).run();
    seeded.exec("COMMIT");
  } catch (error) {
    if (seeded.isTransaction) seeded.exec("ROLLBACK");
    throw error;
  } finally {
    seeded.close();
  }
}

function forceRun(
  status: "running" | "waiting_owner" | "paused" | "failed" | "planned" | "stopped",
  pauseCategory: string | null = null,
  pauseReason: string | null = null,
): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `UPDATE collaboration_runs
         SET status = ?, pause_category = ?, pause_reason = ?
         WHERE project_id='project-1' AND thread_id=? AND id = ?`,
      )
      .run(status, pauseCategory, pauseReason, threadId, runId);
    if (pauseCategory === "provider_auth" || pauseCategory === "credential_unavailable") {
      const timestamp = "2026-07-30T00:00:00.000Z";
      const operation =
        pauseCategory === "provider_auth"
          ? "00000000-0000-4000-8000-000000009901"
          : "00000000-0000-4000-8000-000000009902";
      database
        .prepare(
          `INSERT INTO collaboration_operations (
             id, project_id, thread_id, run_id, kind, request_hash, status,
             http_status, response_json, response_schema_version, created_at, updated_at
           ) VALUES (?, 'project-1', ?, ?, 'advance', 'failure-hash', 'completed',
             500, '{"error":{"code":"INTERNAL_ERROR","message":"Failure."}}', 7, ?, ?)`,
        )
        .run(operation, threadId, runId, timestamp, timestamp);
      database
        .prepare(
          `INSERT INTO collaboration_attempts (
             id, project_id, thread_id, run_id, agent_id, operation_id, status,
             lease_token, lease_expires_at, prompt_hash, acquire_execution_epoch,
             acquire_context_hash, included_message_sequence, error_category,
             failure_provider_id, failure_provider_version,
             failure_credential_version, failure_credential_generation,
             failure_verified_at, started_at, finished_at
           )
           SELECT ?, 'project-1', ?, ?, 'agent-a', ?, 'failed',
             'failure-lease', ?, 'failure-prompt', 1, 'failure-context', 0, ?,
             providers.id, providers.version, providers.credential_version,
             providers.credential_generation, providers.verified_at, ?, ?
           FROM providers WHERE providers.id = 'provider-1'`,
        )
        .run(
          `failure-attempt-${pauseCategory}`,
          threadId,
          runId,
          operation,
          timestamp,
          pauseCategory,
          timestamp,
          timestamp,
        );
    }
  } finally {
    database.close();
  }
}

function rawRun(): {
  status: string;
  version: number;
  executionEpoch: number;
  pauseCategory: string | null;
} {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT status, version, execution_epoch AS executionEpoch,
                pause_category AS pauseCategory
         FROM collaboration_runs WHERE id = ?`,
      )
      .get(runId) as ReturnType<typeof rawRun>;
  } finally {
    database.close();
  }
}

function expectCode(operation: () => unknown, code: string, currentVersion?: number): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect(error).toMatchObject({
      code,
      ...(currentVersion === undefined ? {} : { details: { currentVersion } }),
    });
  }
}

async function route(): Promise<ControlRoute> {
  const load =
    routeModules[
      "../../../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/control/route.ts"
    ];
  expect(load, "tuple run control route must exist").toBeTypeOf("function");
  return load!();
}

async function post(input: ControlInput): Promise<Response> {
  return (await route()).POST(
    new Request(
      `http://localhost/api/projects/project-1/threads/${threadId}/runs/${runId}/control`,
      {
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
      method: "POST",
      },
    ),
    { params: Promise.resolve({ projectId: "project-1", runId, threadId }) },
  );
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  operationSequence = 400;
  seedReadyRun();
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("collaboration run control service", () => {
  it("pauses and continues only a manual pause while incrementing version and epoch", () => {
    const paused = control({
      action: "pause",
      expectedVersion: 1,
      operationId: operationId(),
    });
    expect(paused).toMatchObject({
      status: 200,
      body: { run: { pauseCategory: "manual", status: "paused", version: 2 } },
    });
    expect(rawRun()).toEqual({
      executionEpoch: 2,
      pauseCategory: "manual",
      status: "paused",
      version: 2,
    });
    expectCode(
      () =>
        control({
          action: "retry",
          expectedVersion: 2,
          operationId: operationId(),
        }),
      "RUN_STATE_CONFLICT",
    );

    const resumed = control({
      action: "continue",
      expectedVersion: 2,
      operationId: operationId(),
    });
    expect(resumed).toMatchObject({
      status: 200,
      body: { run: { pauseCategory: null, status: "running", version: 3 } },
    });
    expect(rawRun()).toEqual({
      executionEpoch: 3,
      pauseCategory: null,
      status: "running",
      version: 3,
    });

    const stopped = control({
      action: "stop",
      expectedVersion: 3,
      operationId: operationId(),
    });
    expect(stopped.body.run).toMatchObject({ status: "stopped", version: 4 });
    expect(rawRun()).toEqual({
      executionEpoch: 4,
      pauseCategory: null,
      status: "stopped",
      version: 4,
    });
  });

  it("requires a later provider re-verification before retrying provider auth", () => {
    forceRun("paused", "provider_auth");
    expectCode(
      () =>
        control({
          action: "continue",
          expectedVersion: 1,
          operationId: operationId(),
        }),
      "RUN_STATE_CONFLICT",
    );

    expectCode(
      () =>
        control({
          action: "retry",
          expectedVersion: 1,
          operationId: operationId(),
        }),
      "CREDENTIAL_UNAVAILABLE",
    );

    const repaired = openDatabase(databasePath);
    repaired
      .prepare(
        `UPDATE providers
         SET verified_at = '2026-07-30T01:00:00.000Z', version = version + 1
         WHERE id = 'provider-1'`,
      )
      .run();
    repaired.close();
    expect(
      control({
        action: "retry",
        expectedVersion: 1,
        operationId: operationId(),
      }).body.run,
    ).toMatchObject({ pauseCategory: null, status: "running", version: 2 });
    expect(rawRun()).toMatchObject({ executionEpoch: 2, version: 2 });
  });

  it("rejects provider auth retry after only non-connection provider fields change", () => {
    forceRun("paused", "provider_auth");
    const renamed = openDatabase(databasePath);
    renamed
      .prepare(
        `UPDATE providers
         SET name = 'Renamed provider', version = version + 1
         WHERE id = 'provider-1'`,
      )
      .run();
    renamed.close();

    expectCode(
      () =>
        control({
          action: "retry",
          expectedVersion: 1,
          operationId: operationId(),
        }),
      "CREDENTIAL_UNAVAILABLE",
    );
  });

  it("requires credential-unavailable recovery to replace a still-corrupt credential", () => {
    forceRun("paused", "credential_unavailable");
    const corrupt = openDatabase(databasePath);
    corrupt
      .prepare(
        `UPDATE providers
         SET verified_at = '2026-07-30T01:00:00.000Z',
             version = version + 1,
             credential_generation = credential_generation + 1
         WHERE id = 'provider-1'`,
      )
      .run();
    corrupt.close();
    expectCode(
      () =>
        control({
          action: "retry",
          expectedVersion: 1,
          operationId: operationId(),
        }),
      "CREDENTIAL_UNAVAILABLE",
    );

    process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 29).toString("base64url");
    const credential = createCredentialVault().encrypt("provider-1", "repaired-provider-key");
    const repaired = openDatabase(databasePath);
    repaired
      .prepare(
        `UPDATE providers
         SET api_key_cipher = ?, api_key_iv = ?, api_key_tag = ?,
             credential_version = ?, key_id = ?, api_key_mask = ?,
             verified_at = '2026-07-30T02:00:00.000Z',
             version = version + 1,
             credential_generation = credential_generation + 1
         WHERE id = 'provider-1'`,
      )
      .run(
        credential.apiKeyCipher,
        credential.apiKeyIv,
        credential.apiKeyTag,
        credential.credentialVersion,
        credential.keyId,
        credential.apiKeyMask,
      );
    repaired.close();
    expect(
      control({
        action: "retry",
        expectedVersion: 1,
        operationId: operationId(),
      }).body.run,
    ).toMatchObject({ pauseCategory: null, status: "running", version: 2 });
  });

  it("requires retry, not continue, for internal failures", () => {
    forceRun("failed", "internal_failure");
    expectCode(
      () =>
        control({
          action: "continue",
          expectedVersion: 1,
          operationId: operationId(),
        }),
      "RUN_STATE_CONFLICT",
    );
    expect(
      control({
        action: "retry",
        expectedVersion: 1,
        operationId: operationId(),
      }).body.run,
    ).toMatchObject({ status: "running", version: 2 });
    expect(rawRun()).toMatchObject({ executionEpoch: 2, version: 2 });
  });

  it("blocks budget retry until the configured token boundary is raised", () => {
    forceRun("paused", "boundary_reached", "tokens");
    const database = openDatabase(databasePath);
    database.prepare("UPDATE agents SET max_tokens = 0 WHERE id = 'agent-a'").run();
    database.close();

    expectCode(
      () =>
        control({
          action: "retry",
          expectedVersion: 1,
          operationId: operationId(),
        }),
      "BOUNDARY_REACHED",
    );

    const repaired = openDatabase(databasePath);
    repaired.prepare("UPDATE agents SET max_tokens = 1 WHERE id = 'agent-a'").run();
    repaired.close();
    expect(
      control({
        action: "retry",
        expectedVersion: 1,
        operationId: operationId(),
      }).body.run,
    ).toMatchObject({ status: "running", version: 2 });
  });

  it.each(["planned", "stopped"] as const)(
    "keeps a %s run terminal for every control action",
    (status) => {
      forceRun(status);
      for (const action of ["pause", "continue", "retry", "stop"] as const) {
        expectCode(
          () =>
            control({
              action,
              expectedVersion: 1,
              operationId: operationId(),
            }),
          "RUN_STATE_CONFLICT",
        );
      }
      expect(rawRun()).toMatchObject({ executionEpoch: 1, status, version: 1 });
    },
  );

  it("enforces expectedVersion and exactly replays a completed operation", () => {
    const input = {
      action: "pause" as const,
      expectedVersion: 1,
      operationId: operationId(),
    };
    const first = control(input);
    expectCode(
      () =>
        control({
          action: "stop",
          expectedVersion: 1,
          operationId: operationId(),
        }),
      "RUN_STATE_CONFLICT",
      2,
    );

    const replay = control(input);
    expect(replay).toEqual(first);
    expect(rawRun()).toMatchObject({ executionEpoch: 2, version: 2 });
    expectCode(
      () => control({ ...input, action: "stop" }),
      "OPERATION_CONFLICT",
    );
  });
});

describe("collaboration run control API", () => {
  it("allows only one concurrent expectedVersion CAS winner", async () => {
    const [pause, stop] = await Promise.all([
      post({ action: "pause", expectedVersion: 1, operationId: operationId() }),
      post({ action: "stop", expectedVersion: 1, operationId: operationId() }),
    ]);
    const responses = [
      { body: await pause.json(), status: pause.status },
      { body: await stop.json(), status: stop.status },
    ].sort((left, right) => left.status - right.status);

    expect(responses[0]).toMatchObject({
      body: { run: { version: 2 } },
      status: 200,
    });
    expect(responses[1]).toEqual({
      body: {
        error: {
          code: "RUN_STATE_CONFLICT",
          currentVersion: 2,
          message: "Collaboration run version is stale.",
        },
      },
      status: 409,
    });
    expect(rawRun()).toMatchObject({ executionEpoch: 2, version: 2 });
  });
});
