import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollaborationError } from "@/src/server/collaboration/collaboration-errors";
import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import { appendAgentMessageFactTx } from "@/src/server/collaboration/thread-service";
import { openDatabase } from "@/src/server/db";
import { seedV7AdvanceFixture } from "@/tests/v7-advance-fixture";

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
  tuple: { projectId: string; threadId: string; runId: string },
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
let threadId: string;
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
  return implementation!(
    databasePath,
    { projectId: PROJECT_ID, runId: RUN_ID, threadId },
    input,
    customDependencies,
  );
}

function seedReadyRun(): void {
  threadId = seedV7AdvanceFixture(databasePath, {
    agentId: AGENT_ID,
    agentPrompt: "alpha-private-prompt",
    missionId: "mission-acquire",
    now: FIXED_NOW,
    ownerMessage: "Please make a plan",
    projectId: PROJECT_ID,
    projectName: "Acquire Project",
    providerId: "provider-acquire",
    runId: RUN_ID,
    secondAgentId: "agent-beta",
    secondAgentPrompt: "beta-private-prompt",
    threadCreateOperationId: "00000000-0000-4000-8000-000000000890",
  });
}

function completedAdvanceBody(attemptId: string): string {
  return JSON.stringify({
    attempt: { id: attemptId, status: "committed" },
    attemptStatus: "committed",
    events: [],
    run: {
      createdAt: FIXED_NOW,
      currentAgentId: AGENT_ID,
      id: RUN_ID,
      pauseCategory: null,
      projectId: PROJECT_ID,
      roundCount: 0,
      status: "running",
      threadId,
      updatedAt: FIXED_NOW,
      version: 1,
    },
  });
}

function insertCommittedAttempt(
  database: ReturnType<typeof openDatabase>,
  attemptId: string,
  operation: string,
): void {
  database.prepare(
    `INSERT INTO collaboration_operations(
       id,project_id,thread_id,run_id,kind,request_hash,status,http_status,
       response_json,response_schema_version,created_at,updated_at
     ) VALUES (?,?,?,?,'advance','prior','completed',200,?,7,?,?)`,
  ).run(
    operation,
    PROJECT_ID,
    threadId,
    RUN_ID,
    completedAdvanceBody(attemptId),
    FIXED_NOW,
    FIXED_NOW,
  );
  database.prepare(
    `INSERT INTO collaboration_attempts(
       id,project_id,thread_id,run_id,agent_id,operation_id,status,lease_token,
       lease_expires_at,prompt_hash,acquire_execution_epoch,acquire_context_hash,
       included_message_sequence,error_category,started_at,finished_at
     ) VALUES (?,?,?,?,?,?,'committed',? ,?,'prompt',7,'context',1,NULL,?,?)`,
  ).run(
    attemptId,
    PROJECT_ID,
    threadId,
    RUN_ID,
    AGENT_ID,
    operation,
    `token-${attemptId}`,
    FIXED_NOW,
    FIXED_NOW,
    FIXED_NOW,
  );
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
      insertCommittedAttempt(
        database,
        "existing-attempt",
        "00000000-0000-4000-8000-000000000700",
      );
      database.prepare(
        `INSERT INTO collaboration_messages(
           id,project_id,thread_id,run_id,author_type,author_agent_id,
           author_display_name,content,mention_agent_id,mention_display_name,
           sequence,consumed_at,created_at
         ) VALUES ('agent-message',?,?,?,'agent',?,'Alpha','Question',
                   NULL,NULL,2,NULL,?)`,
      ).run(PROJECT_ID, threadId, RUN_ID, AGENT_ID, FIXED_NOW);
      database.prepare(
        `INSERT INTO collaboration_turns(
           id,project_id,thread_id,attempt_id,run_id,agent_id,round_number,
           message_id,disposition,created_at
         ) VALUES ('decision-turn',?,?, 'existing-attempt',?,?,1,
                   'agent-message','decision_request',?)`,
      ).run(PROJECT_ID, threadId, RUN_ID, AGENT_ID, FIXED_NOW);
      database.prepare(
        `INSERT INTO decision_requests(
           id,project_id,thread_id,run_id,turn_id,requesting_agent_id,question,
           options_json,status,answer,answer_message_id,version,created_at,answered_at
         ) VALUES ('decision-open',?,?,?,'decision-turn',?,'Choose?','["A","B"]',
                   'open',NULL,NULL,1,?,NULL)`,
      ).run(PROJECT_ID, threadId, RUN_ID, AGENT_ID, FIXED_NOW);
      appendAgentMessageFactTx(database, {
        agentId: AGENT_ID,
        factId: "fact-agent-message",
        messageId: "agent-message",
        projectId: PROJECT_ID,
        runId: RUN_ID,
        threadId,
        timestamp: FIXED_NOW,
      });
      database.prepare(
        `UPDATE collaboration_project_sequences
         SET next_message_sequence=next_message_sequence+1
         WHERE project_id=? AND thread_id=?`,
      ).run(PROJECT_ID, threadId);
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
            insertCommittedAttempt(database, `prior-attempt-${index}`, priorOperation);
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
                     id,project_id,thread_id,run_id,author_type,author_agent_id,
                     author_display_name, content, mention_agent_id, mention_display_name,
                     sequence, consumed_at, created_at
                   ) VALUES (?,?,?,?,'agent',?,'Alpha','handoff',NULL,NULL,
                             ?, NULL, ?)`,
                )
                .run(
                  `handoff-message-${index}`,
                  PROJECT_ID,
                  threadId,
                  RUN_ID,
                  AGENT_ID,
                  index + 1,
                  FIXED_NOW,
                );
              database
                .prepare(
                  `INSERT INTO collaboration_turns (
                     id,project_id,thread_id,attempt_id,run_id,agent_id,
                     round_number,message_id,
                     disposition, created_at
                   ) VALUES (?,?,?,?,?,?,?,?,'handoff',?)`,
                )
                .run(
                  `handoff-turn-${index}`,
                  PROJECT_ID,
                  threadId,
                  `prior-attempt-${index}`,
                  RUN_ID,
                  AGENT_ID,
                  index,
                  `handoff-message-${index}`,
                  FIXED_NOW,
                );
              appendAgentMessageFactTx(database, {
                agentId: AGENT_ID,
                factId: `fact-handoff-message-${index}`,
                messageId: `handoff-message-${index}`,
                projectId: PROJECT_ID,
                runId: RUN_ID,
                threadId,
                timestamp: FIXED_NOW,
              });
              database.prepare(
                `UPDATE collaboration_project_sequences
                 SET next_message_sequence=next_message_sequence+1
                 WHERE project_id=? AND thread_id=?`,
              ).run(PROJECT_ID, threadId);
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
