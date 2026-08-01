import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollaborationError } from "@/src/server/collaboration/collaboration-errors";
import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import { createV6FixtureDatabaseOpener } from "@/tests/v6-fixture-db";

const openDatabase = createV6FixtureDatabaseOpener({
  missingDeliveryHeadMissionIds: ["mission-acquire"],
  missingReviewHeadResultIds: [],
});

type AcquireDependencies = {
  clock: () => Date;
  randomUUID: () => string;
};

type AcquiredAdvance = {
  kind: "acquired";
  attempt: {
    id: string;
    operationId: string;
    leaseToken: string;
    leaseExpiresAt: string;
    promptHash: string;
    acquireExecutionEpoch: number;
    acquireContextHash: string;
    includedMessageSequence: number;
  };
  prompt: {
    agentId: string;
    promptHash: string;
    contextHash: string;
    includedMessageSequence: number;
    messages: ReadonlyArray<{ role: string; content: string }>;
  };
};

type PausedAdvance = {
  kind: "paused";
  boundary: "rounds" | "tokens" | "handoffs";
  run: { status: "paused"; pauseCategory: string | null };
};

type AcquireAdvance = (
  databasePath: string,
  runId: string,
  input: { operationId: string },
  dependencies: AcquireDependencies,
) => AcquiredAdvance | PausedAdvance;

type TurnOrchestratorModule = {
  acquireAdvance?: AcquireAdvance;
};

const orchestratorModules =
  import.meta.glob<TurnOrchestratorModule>("../src/server/collaboration/turn-orchestrator.ts");

const PROJECT_ID = "project-acquire";
const RUN_ID = "run-acquire";
const AGENT_ID = "agent-alpha";
const FIXED_NOW = "2026-07-30T01:02:03.000Z";

let directory: string;
let databasePath: string;
let operationSequence: number;
let uuidSequence: number;

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function dependencies(): AcquireDependencies {
  return {
    clock: () => new Date(FIXED_NOW),
    randomUUID: () => {
      uuidSequence += 1;
      return `10000000-0000-4000-8000-${uuidSequence.toString().padStart(12, "0")}`;
    },
  };
}

async function acquire(
  input: { operationId: string },
  customDependencies = dependencies(),
): Promise<AcquiredAdvance | PausedAdvance> {
  const load =
    orchestratorModules["../src/server/collaboration/turn-orchestrator.ts"];
  expect(load, "T-9 turn orchestrator must exist").toBeTypeOf("function");
  const implementation = (await load!()).acquireAdvance;
  expect(implementation, "T-9 acquireAdvance must exist").toBeTypeOf("function");
  return implementation!(databasePath, RUN_ID, input, customDependencies);
}

function seedReadyRun(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO projects (
        id, name, created_at, workspace_path, workspace_key, version
      ) VALUES (
        '${PROJECT_ID}', 'Acquire Project', '${FIXED_NOW}',
        'D:\\workspace', 'd:/workspace', 1
      );
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv,
        api_key_tag, credential_version, credential_generation, key_id,
        api_key_mask, verified_at, version, created_at, updated_at
      ) VALUES (
        'provider-acquire', 'Local', 'http://127.0.0.1:4000/v1', 'model',
        'cipher', 'iv', 'tag', 1, 1, 'key-1', '***', '${FIXED_NOW}', 1,
        '${FIXED_NOW}', '${FIXED_NOW}'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text,
        accent_token, can_read, can_write, can_execute, max_tokens,
        max_handoffs, version, created_at, updated_at
      ) VALUES
        (
          '${AGENT_ID}', 'Alpha', 'Planner', 'alpha-private-prompt',
          'provider-acquire', 'model', 'A', 'sage', 1, 0, 0, 1000, 2, 1,
          '${FIXED_NOW}', '${FIXED_NOW}'
        ),
        (
          'agent-beta', 'Beta', 'Reviewer', 'beta-private-prompt',
          'provider-acquire', 'model', 'B', 'gold', 1, 0, 0, 1000, 2, 1,
          '${FIXED_NOW}', '${FIXED_NOW}'
        );
      INSERT INTO project_memberships (project_id, agent_id, joined_at) VALUES
        ('${PROJECT_ID}', '${AGENT_ID}', 'a'),
        ('${PROJECT_ID}', 'agent-beta', 'b');
      INSERT INTO missions (
        id, project_id, title, goal, version, created_at, updated_at
      ) VALUES (
        'mission-acquire', '${PROJECT_ID}', 'Mission', 'Build safely', 1,
        '${FIXED_NOW}', '${FIXED_NOW}'
      );
      INSERT INTO collaboration_runs (
        id, project_id, status, current_agent_id, round_count,
        next_event_sequence, version, execution_epoch, pause_reason,
        pause_category, created_at, updated_at
      ) VALUES (
        '${RUN_ID}', '${PROJECT_ID}', 'running', '${AGENT_ID}', 0,
        1, 1, 7, NULL, NULL, '${FIXED_NOW}', '${FIXED_NOW}'
      );
      INSERT INTO collaboration_project_sequences (
        project_id, next_message_sequence
      ) VALUES ('${PROJECT_ID}', 2);
      INSERT INTO collaboration_messages (
        id, project_id, run_id, author_type, author_agent_id,
        author_display_name, content, mention_agent_id, mention_display_name,
        sequence, consumed_at, created_at
      ) VALUES (
        'message-owner', '${PROJECT_ID}', '${RUN_ID}', 'owner', NULL,
        'Owner', 'Please make a plan', NULL, NULL, 1, NULL, '${FIXED_NOW}'
      );
    `);
  } finally {
    database.close();
  }
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(CollaborationError);
  expect(error).toMatchObject({ code });
}

function rawCounts(): {
  attempts: number;
  calling: number;
  operations: number;
  startedEvents: number;
} {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM collaboration_attempts WHERE run_id = ?) AS attempts,
           (SELECT COUNT(*) FROM collaboration_attempts
             WHERE run_id = ? AND status = 'calling') AS calling,
           (SELECT COUNT(*) FROM collaboration_operations
             WHERE run_id = ?) AS operations,
           (SELECT COUNT(*) FROM collaboration_events
             WHERE run_id = ? AND type = 'model_call_started') AS startedEvents`,
      )
      .get(RUN_ID, RUN_ID, RUN_ID, RUN_ID) as ReturnType<typeof rawCounts>;
  } finally {
    database.close();
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "turn-acquire-"));
  databasePath = join(directory, "cockpit.sqlite");
  operationSequence = 900;
  uuidSequence = 0;
  seedReadyRun();
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("advance operation acquisition", () => {
  it("atomically stores an immutable prompt snapshot, hashes, epoch, sequence, lease, event, and pending receipt", async () => {
    const operation = operationId();
    const result = await acquire({ operationId: operation });
    expect(result.kind).toBe("acquired");
    if (result.kind !== "acquired") return;

    expect(Object.isFrozen(result.prompt)).toBe(true);
    expect(Object.isFrozen(result.prompt.messages)).toBe(true);
    expect(result.prompt.agentId).toBe(AGENT_ID);
    expect(JSON.stringify(result.prompt.messages)).toContain("Please make a plan");
    expect(JSON.stringify(result.prompt.messages)).toContain("alpha-private-prompt");
    expect(JSON.stringify(result.prompt.messages)).not.toContain("beta-private-prompt");

    const database = openDatabase(databasePath);
    try {
      const attempt = database
        .prepare(
          `SELECT id, operation_id AS operationId, status,
                  lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
                  prompt_hash AS promptHash,
                  acquire_execution_epoch AS acquireExecutionEpoch,
                  acquire_context_hash AS acquireContextHash,
                  included_message_sequence AS includedMessageSequence,
                  started_at AS startedAt
           FROM collaboration_attempts WHERE run_id = ?`,
        )
        .get(RUN_ID) as AcquiredAdvance["attempt"] & {
        status: string;
        startedAt: string;
      };
      expect(attempt).toEqual({
        acquireContextHash: result.prompt.contextHash,
        acquireExecutionEpoch: 7,
        id: result.attempt.id,
        includedMessageSequence: 1,
        leaseExpiresAt: "2026-07-30T01:04:03.000Z",
        leaseToken: result.attempt.leaseToken,
        operationId: operation,
        promptHash: result.prompt.promptHash,
        startedAt: FIXED_NOW,
        status: "calling",
      });
      expect(attempt.leaseToken).not.toBe(attempt.id);

      const receipt = database
        .prepare(
          `SELECT run_id AS runId, kind, request_hash AS requestHash, status,
                  http_status AS httpStatus, response_json AS responseJson
           FROM collaboration_operations WHERE project_id = ? AND id = ?`,
        )
        .get(PROJECT_ID, operation);
      expect(receipt).toEqual({
        httpStatus: null,
        kind: "advance",
        requestHash: canonicalRequestHash({}),
        responseJson: null,
        runId: RUN_ID,
        status: "pending",
      });

      const event = database
        .prepare(
          `SELECT type, actor_type AS actorType, actor_id AS actorId,
                  payload_json AS payloadJson, created_at AS createdAt
           FROM collaboration_events
           WHERE run_id = ? AND type = 'model_call_started'`,
        )
        .get(RUN_ID) as {
        type: string;
        actorType: string;
        actorId: string | null;
        payloadJson: string;
        createdAt: string;
      };
      expect(event).toMatchObject({
        actorId: AGENT_ID,
        actorType: "agent",
        createdAt: FIXED_NOW,
        type: "model_call_started",
      });
      expect(JSON.parse(event.payloadJson)).toEqual({
        agentId: AGENT_ID,
        attemptId: result.attempt.id,
        kind: "primary",
      });

      database
        .prepare("UPDATE collaboration_messages SET content = 'changed later' WHERE id = 'message-owner'")
        .run();
      expect(JSON.stringify(result.prompt.messages)).toContain("Please make a plan");
      expect(JSON.stringify(result.prompt.messages)).not.toContain("changed later");
    } finally {
      database.close();
    }
  });

  it("returns operation in progress for a repeated pending advance without duplicating work", async () => {
    const operation = operationId();
    await acquire({ operationId: operation });

    let repeated: unknown;
    try {
      await acquire({ operationId: operation });
    } catch (error) {
      repeated = error;
    }
    expectCode(repeated, "OPERATION_IN_PROGRESS");
    expect(rawCounts()).toEqual({
      attempts: 1,
      calling: 1,
      operations: 1,
      startedEvents: 1,
    });
  });

  it.each([
    ["paused", "RUN_STATE_CONFLICT"],
    ["waiting_owner", "RUN_STATE_CONFLICT"],
    ["stopped", "RUN_STATE_CONFLICT"],
  ] as const)("guards a %s run before creating an attempt", async (status, code) => {
    const database = openDatabase(databasePath);
    database.prepare("UPDATE collaboration_runs SET status = ? WHERE id = ?").run(status, RUN_ID);
    database.close();

    let failure: unknown;
    try {
      await acquire({ operationId: operationId() });
    } catch (error) {
      failure = error;
    }
    expectCode(failure, code);
    expect(rawCounts().attempts).toBe(0);
  });

  it("guards an open decision and another calling attempt", async () => {
    const database = openDatabase(databasePath);
    try {
      database.exec(`
        INSERT INTO collaboration_operations (
          id, project_id, run_id, kind, request_hash, status,
          http_status, response_json, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-000000000700', '${PROJECT_ID}', '${RUN_ID}',
          'advance', 'hash', 'pending', NULL, NULL, '${FIXED_NOW}', '${FIXED_NOW}'
        );
        INSERT INTO collaboration_attempts (
          id, project_id, run_id, agent_id, operation_id, status, lease_token,
          lease_expires_at, prompt_hash, acquire_execution_epoch,
          acquire_context_hash, included_message_sequence, error_category,
          started_at, finished_at
        ) VALUES (
          'existing-attempt', '${PROJECT_ID}', '${RUN_ID}', '${AGENT_ID}',
          '00000000-0000-4000-8000-000000000700', 'committed', 'old-token',
          '2026-07-30T01:00:00.000Z', 'prompt', 7, 'context', 1, NULL,
          '${FIXED_NOW}', '${FIXED_NOW}'
        );
        INSERT INTO collaboration_messages (
          id, project_id, run_id, author_type, author_agent_id,
          author_display_name, content, mention_agent_id, mention_display_name,
          sequence, consumed_at, created_at
        ) VALUES (
          'agent-message', '${PROJECT_ID}', '${RUN_ID}', 'agent', '${AGENT_ID}',
          'Alpha', 'Question', NULL, NULL, 2, NULL, '${FIXED_NOW}'
        );
        INSERT INTO collaboration_turns (
          id, attempt_id, run_id, agent_id, round_number, message_id,
          disposition, created_at
        ) VALUES (
          'decision-turn', 'existing-attempt', '${RUN_ID}', '${AGENT_ID}', 1,
          'agent-message', 'decision_request', '${FIXED_NOW}'
        );
        INSERT INTO decision_requests (
          id, run_id, turn_id, requesting_agent_id, question, options_json,
          status, answer, answer_message_id, version, created_at, answered_at
        ) VALUES (
          'decision-open', '${RUN_ID}', 'decision-turn', '${AGENT_ID}',
          'Choose?', '["A","B"]', 'open', NULL, NULL, 1, '${FIXED_NOW}', NULL
        );
      `);
    } finally {
      database.close();
    }

    let decisionFailure: unknown;
    try {
      await acquire({ operationId: operationId() });
    } catch (error) {
      decisionFailure = error;
    }
    expectCode(decisionFailure, "RUN_STATE_CONFLICT");

    const update = openDatabase(databasePath);
    update.prepare("DELETE FROM decision_requests WHERE id = 'decision-open'").run();
    update
      .prepare(
        `UPDATE collaboration_attempts
         SET status = 'calling', finished_at = NULL,
             lease_expires_at = '2999-01-01T00:00:00.000Z'
         WHERE id = 'existing-attempt'`,
      )
      .run();
    update.close();

    let callingFailure: unknown;
    try {
      await acquire({ operationId: operationId() });
    } catch (error) {
      callingFailure = error;
    }
    expectCode(callingFailure, "TURN_IN_PROGRESS");
    expect(rawCounts().calling).toBe(1);
  });

  it("serializes concurrent advances so exactly one calling attempt is acquired", async () => {
    const results = await Promise.allSettled([
      acquire({ operationId: operationId() }),
      acquire({ operationId: operationId() }),
    ]);

    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((item) => item.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expectCode(rejected.reason, "TURN_IN_PROGRESS");
    }
    expect(rawCounts()).toEqual({
      attempts: 1,
      calling: 1,
      operations: 2,
      startedEvents: 1,
    });
  });

  it.each([
    ["rounds", 50],
    ["tokens", 1000],
    ["handoffs", 2],
  ] as const)(
    "pauses at the %s pre-boundary, completes the receipt, and starts no call",
    async (boundary, value) => {
      const database = openDatabase(databasePath);
      try {
        if (boundary === "rounds") {
          database.prepare("UPDATE collaboration_runs SET round_count = 50 WHERE id = ?").run(RUN_ID);
        } else {
          for (let index = 1; index <= (boundary === "handoffs" ? 2 : 1); index += 1) {
            const priorOperation = `00000000-0000-4000-8000-${(800 + index)
              .toString()
              .padStart(12, "0")}`;
            database
              .prepare(
                `INSERT INTO collaboration_operations (
                   id, project_id, run_id, kind, request_hash, status,
                   http_status, response_json, created_at, updated_at
                 ) VALUES (?, ?, ?, 'advance', 'prior', 'completed', 200, '{}', ?, ?)`,
              )
              .run(priorOperation, PROJECT_ID, RUN_ID, FIXED_NOW, FIXED_NOW);
            database
              .prepare(
                `INSERT INTO collaboration_attempts (
                   id, project_id, run_id, agent_id, operation_id, status,
                   lease_token, lease_expires_at, prompt_hash,
                   acquire_execution_epoch, acquire_context_hash,
                   included_message_sequence, error_category, started_at, finished_at
                 ) VALUES (?, ?, ?, ?, ?, 'committed', ?, ?, 'prompt', 7, 'context', 1,
                           NULL, ?, ?)`,
              )
              .run(
                `prior-attempt-${index}`,
                PROJECT_ID,
                RUN_ID,
                AGENT_ID,
                priorOperation,
                `prior-token-${index}`,
                FIXED_NOW,
                FIXED_NOW,
                FIXED_NOW,
              );
            if (boundary === "tokens") {
              database
                .prepare(
                  `INSERT INTO collaboration_model_calls (
                     id, attempt_id, kind, call_index, status, prompt_tokens,
                     completion_tokens, total_tokens, error_category, created_at
                   ) VALUES (?, ?, 'primary', 1, 'succeeded', 600, 400, 1000, NULL, ?)`,
                )
                .run(`call-${index}`, `prior-attempt-${index}`, FIXED_NOW);
            } else {
              database
                .prepare(
                  `INSERT INTO collaboration_messages (
                     id, project_id, run_id, author_type, author_agent_id,
                     author_display_name, content, mention_agent_id, mention_display_name,
                     sequence, consumed_at, created_at
                   ) VALUES (?, ?, ?, 'agent', ?, 'Alpha', 'handoff', NULL, NULL,
                             ?, NULL, ?)`,
                )
                .run(`handoff-message-${index}`, PROJECT_ID, RUN_ID, AGENT_ID, index + 1, FIXED_NOW);
              database
                .prepare(
                  `INSERT INTO collaboration_turns (
                     id, attempt_id, run_id, agent_id, round_number, message_id,
                     disposition, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, 'handoff', ?)`,
                )
                .run(
                  `handoff-turn-${index}`,
                  `prior-attempt-${index}`,
                  RUN_ID,
                  AGENT_ID,
                  index,
                  `handoff-message-${index}`,
                  FIXED_NOW,
                );
            }
          }
        }
      } finally {
        database.close();
      }

      const operation = operationId();
      const result = await acquire({ operationId: operation });
      expect(result).toMatchObject({
        boundary,
        kind: "paused",
        run: { pauseCategory: "boundary_reached", status: "paused" },
      });

      const verify = openDatabase(databasePath);
      try {
        const receipt = verify
          .prepare(
            `SELECT status, http_status AS httpStatus, response_json AS responseJson
             FROM collaboration_operations WHERE project_id = ? AND id = ?`,
          )
          .get(PROJECT_ID, operation) as {
          status: string;
          httpStatus: number | null;
          responseJson: string | null;
        };
        expect(receipt.status).toBe("completed");
        expect(receipt.httpStatus).toBe(200);
        expect(JSON.parse(receipt.responseJson!)).toMatchObject({
          boundary,
          run: { pauseCategory: "boundary_reached", status: "paused" },
        });
        const event = verify
          .prepare(
            `SELECT payload_json AS payloadJson
             FROM collaboration_events WHERE run_id = ? AND type = 'boundary_paused'`,
          )
          .get(RUN_ID) as { payloadJson: string };
        expect(JSON.parse(event.payloadJson)).toEqual({
          agentId: AGENT_ID,
          boundary,
          limit: boundary === "rounds" ? 50 : boundary === "tokens" ? 1000 : 2,
          value,
        });
      } finally {
        verify.close();
      }
      expect(rawCounts().calling).toBe(0);
      expect(rawCounts().startedEvents).toBe(0);
    },
  );
});
