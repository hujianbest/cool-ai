

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollaborationError } from "@/src/modules/public-collaboration";
import { canonicalRequestHash } from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import type { StructuredTurnResult } from "@/src/modules/public-collaboration";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type Dependencies = {
  clock: () => Date;
  randomUUID: () => string;
  commitBusinessTurn?: (
    database: DatabaseSync,
    input: {
      agentId: string;
      attemptId: string;
      runId: string;
      timestamp: string;
      turn: NonNullable<StructuredTurnResult["turn"]>;
    },
  ) => void;
};

type FinalizeResponse = {
  affectedRows: 1;
  body:
    | {
        attemptStatus: "committed" | "discarded";
        run: { id: string; status: string; roundCount: number };
      }
    | { error: { code: string; message: string; category?: string } };
  status: number;
};

type OrchestratorModule = {
  acquireAdvance?: (
    databasePath: string,
    tuple: { projectId: string; threadId: string; runId: string },
    input: { operationId: string },
    dependencies: Pick<Dependencies, "clock" | "randomUUID">,
  ) => {
    kind: "acquired";
    attempt: { id: string; leaseToken: string; operationId: string };
  };
  finalizeAdvance?: (
    databasePath: string,
    tuple: { projectId: string; threadId: string; runId: string },
    input: {
      attemptId: string;
      leaseToken: string;
      result: StructuredTurnResult;
    },
    dependencies: Dependencies,
  ) => FinalizeResponse;
};

const modules = import.meta.glob<OrchestratorModule>(
  "../../../src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator.ts",
);

const PROJECT_ID = "project-finalize";
const RUN_ID = "run-finalize";
const AGENT_ID = "agent-alpha";
const NOW = "2026-07-30T02:00:00.000Z";
const OPERATION_ID = "00000000-0000-4000-8000-000000001000";

let databasePath: string;
let threadId: string;
let uuidSequence: number;

function dependencies(
  overrides: Partial<Dependencies> = {},
): Dependencies {
  return {
    clock: () => new Date(NOW),
    randomUUID: () => {
      uuidSequence += 1;
      return `20000000-0000-4000-8000-${uuidSequence.toString().padStart(12, "0")}`;
    },
    ...overrides,
  };
}

function validResult(): StructuredTurnResult {
  const usage = { completionTokens: 3, promptTokens: 7, totalTokens: 10 };
  return {
    calls: [
      {
        kind: "primary",
        result: {
          content: '{"valid":true}',
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
      disposition: {
        reason: "Review next",
        summary: "Planning complete",
        targetAgentId: "agent-beta",
        type: "handoff",
      },
      message: "I prepared the plan.",
      tasks: [],
    },
    usage: [{ kind: "primary", usage, usageReported: true }],
  };
}

function providerFailure(
  category:
    | "provider_auth"
    | "provider_timeout"
    | "provider_upstream"
    | "provider_unreachable",
  code:
    | "PROVIDER_AUTH"
    | "PROVIDER_TIMEOUT"
    | "PROVIDER_UPSTREAM"
    | "PROVIDER_UNREACHABLE",
  httpStatus: 401 | 502 | 504,
): StructuredTurnResult {
  return {
    calls: [
      {
        kind: "primary",
        result: {
          content: null,
          error: {
            category,
            code,
            correlationId: "public-correlation",
            httpStatus,
          },
          httpStatus: null,
          status: "provider_failed",
          usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 },
          usageReported: true,
        },
      },
    ],
    pauseCategory: null,
    status: "provider_failed",
    turn: null,
    usage: [
      {
        kind: "primary",
        usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 },
        usageReported: true,
      },
    ],
  };
}

function usageFailure(): StructuredTurnResult {
  return {
    calls: [
      {
        kind: "primary",
        result: {
          content: null,
          error: {
            category: "usage_invalid",
            code: "PROVIDER_RESPONSE_INVALID",
            correlationId: "public-correlation",
            httpStatus: 502,
          },
          httpStatus: 200,
          status: "usage_invalid",
          usage: null,
          usageReported: false,
        },
      },
    ],
    pauseCategory: null,
    status: "provider_failed",
    turn: null,
    usage: [{ kind: "primary", usage: null, usageReported: false }],
  };
}

function schemaFailure(): StructuredTurnResult {
  const primaryUsage = { completionTokens: 2, promptTokens: 3, totalTokens: 5 };
  const repairUsage = { completionTokens: 4, promptTokens: 6, totalTokens: 10 };
  return {
    calls: [
      {
        kind: "primary",
        result: {
          content: '{"invalid":1}',
          error: null,
          httpStatus: 200,
          status: "succeeded",
          usage: primaryUsage,
          usageReported: true,
        },
      },
      {
        kind: "repair",
        result: {
          content: '{"stillInvalid":1}',
          error: null,
          httpStatus: 200,
          status: "succeeded",
          usage: repairUsage,
          usageReported: true,
        },
      },
    ],
    pauseCategory: "structured_output_invalid",
    status: "paused",
    turn: null,
    usage: [
      { kind: "primary", usage: primaryUsage, usageReported: true },
      { kind: "repair", usage: repairUsage, usageReported: true },
    ],
  };
}

function seedReadyRun(): void {
  threadId = seedV7AdvanceFixture(databasePath, {
    agentId: AGENT_ID,
    agentPrompt: "alpha-private",
    missionId: "mission-finalize",
    now: NOW,
    ownerMessage: "Please plan",
    projectId: PROJECT_ID,
    projectName: "Finalize Project",
    providerId: "provider-finalize",
    runId: RUN_ID,
    secondAgentId: "agent-beta",
    secondAgentPrompt: "beta-private",
    threadCreateOperationId: "00000000-0000-4000-8000-000000000990",
  });
}

async function orchestrator(): Promise<Required<OrchestratorModule>> {
  const load = modules["../../../src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator.ts"];
  expect(load).toBeTypeOf("function");
  const implementation = await load!();
  expect(implementation.acquireAdvance).toBeTypeOf("function");
  expect(
    implementation.finalizeAdvance,
    "T-10 finalizeAdvance must exist",
  ).toBeTypeOf("function");
  return implementation as Required<OrchestratorModule>;
}

async function acquire() {
  const implementation = await orchestrator();
  const result = implementation.acquireAdvance(
    databasePath,
    { projectId: PROJECT_ID, runId: RUN_ID, threadId },
    { operationId: OPERATION_ID },
    dependencies(),
  );
  expect(result.kind).toBe("acquired");
  return result.attempt;
}

async function finalize(
  result: StructuredTurnResult,
  overrides: Partial<Dependencies> = {},
  inputOverrides: Partial<{ attemptId: string; leaseToken: string }> = {},
): Promise<FinalizeResponse> {
  const implementation = await orchestrator();
  const attempt = attemptRow();
  return implementation.finalizeAdvance(
    databasePath,
    { projectId: PROJECT_ID, runId: RUN_ID, threadId },
    {
      attemptId: inputOverrides.attemptId ?? attempt.id,
      leaseToken: inputOverrides.leaseToken ?? attempt.leaseToken,
      result,
    },
    dependencies(overrides),
  );
}

function attemptRow(): { id: string; leaseToken: string } {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT id, lease_token AS leaseToken
         FROM collaboration_attempts WHERE run_id = ?`,
      )
      .get(RUN_ID) as { id: string; leaseToken: string };
  } finally {
    database.close();
  }
}

function durableState(): {
  attemptErrorCategory: string | null;
  attemptStatus: string;
  calls: number;
  events: number;
  receiptJson: string | null;
  receiptStatus: string;
  receiptHttpStatus: number | null;
  runPauseCategory: string | null;
  runStatus: string;
  rounds: number;
  turns: number;
  usage: number;
} {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT
           (SELECT error_category FROM collaboration_attempts WHERE run_id = ?) AS attemptErrorCategory,
           (SELECT status FROM collaboration_attempts WHERE run_id = ?) AS attemptStatus,
           (SELECT COUNT(*) FROM collaboration_model_calls AS calls
             JOIN collaboration_attempts AS attempts ON attempts.id = calls.attempt_id
             WHERE attempts.run_id = ?) AS calls,
           (SELECT COUNT(*) FROM collaboration_events WHERE run_id = ?) AS events,
           (SELECT response_json FROM collaboration_operations
             WHERE project_id = ? AND id = ?) AS receiptJson,
           (SELECT status FROM collaboration_operations
             WHERE project_id = ? AND id = ?) AS receiptStatus,
           (SELECT http_status FROM collaboration_operations
             WHERE project_id = ? AND id = ?) AS receiptHttpStatus,
           (SELECT pause_category FROM collaboration_runs WHERE id = ?) AS runPauseCategory,
           (SELECT status FROM collaboration_runs WHERE id = ?) AS runStatus,
           (SELECT round_count FROM collaboration_runs WHERE id = ?) AS rounds,
           (SELECT COUNT(*) FROM collaboration_turns WHERE run_id = ?) AS turns,
           (SELECT COALESCE(SUM(calls.total_tokens), 0)
             FROM collaboration_model_calls AS calls
             JOIN collaboration_attempts AS attempts ON attempts.id = calls.attempt_id
             WHERE attempts.run_id = ?) AS usage`,
      )
      .get(
        RUN_ID,
        RUN_ID,
        RUN_ID,
        RUN_ID,
        PROJECT_ID,
        OPERATION_ID,
        PROJECT_ID,
        OPERATION_ID,
        PROJECT_ID,
        OPERATION_ID,
        RUN_ID,
        RUN_ID,
        RUN_ID,
        RUN_ID,
        RUN_ID,
      ) as ReturnType<typeof durableState>;
  } finally {
    database.close();
  }
}

function receipt(): { body: unknown; status: number } {
  const state = durableState();
  return {
    body: JSON.parse(state.receiptJson!),
    status: state.receiptHttpStatus!,
  };
}

function mutate(sql: string, ...values: SQLInputValue[]): void {
  const database = openDatabase(databasePath);
  try {
    database.prepare(sql).run(...values);
  } finally {
    database.close();
  }
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  uuidSequence = 0;
  seedReadyRun();
});

afterEach(() => {
});

describe("attempt finalize CAS", () => {
  it("commits only with calling status, token, live lease, running epoch, and recomputed context hash", async () => {
    const committer = vi.fn();
    await acquire();
    const response = await finalize(validResult(), {
      commitBusinessTurn: committer,
    });

    expect(response).toMatchObject({
      affectedRows: 1,
      body: {
        attemptStatus: "committed",
        run: { roundCount: 1, status: "running" },
      },
      status: 200,
    });
    expect(committer).toHaveBeenCalledTimes(1);
    expect(durableState()).toMatchObject({
      attemptStatus: "committed",
      calls: 1,
      receiptStatus: "completed",
      rounds: 1,
      runStatus: "running",
      usage: 10,
    });
    expect(receipt()).toEqual({ body: response.body, status: response.status });
  });

  it.each([
    ["pause", "paused", 8, NOW],
    ["stop", "stopped", 8, NOW],
    ["epoch", "running", 8, NOW],
    ["expired", "running", 7, "2026-07-30T02:03:00.000Z"],
  ] as const)(
    "%s discards business results while retaining allowed call audit",
    async (_case, status, epoch, clock) => {
      const committer = vi.fn();
      await acquire();
      mutate(
        `UPDATE collaboration_runs
         SET status = ?, execution_epoch = ? WHERE id = ?`,
        status,
        epoch,
        RUN_ID,
      );
      const response = await finalize(validResult(), {
        clock: () => new Date(clock),
        commitBusinessTurn: committer,
      });

      expect(response).toMatchObject({
        affectedRows: 1,
        body: { attemptStatus: "discarded" },
        status: 200,
      });
      expect(committer).not.toHaveBeenCalled();
      expect(durableState()).toMatchObject({
        attemptStatus: "discarded",
        calls: 1,
        rounds: 0,
        turns: 0,
        usage: 10,
      });
      expect(receipt()).toEqual({ body: response.body, status: 200 });
    },
  );

  it("discards on recomputed context hash mismatch and pauses the running run", async () => {
    const committer = vi.fn();
    await acquire();
    mutate(
      "UPDATE missions SET goal = 'Changed during provider call', version = version + 1 WHERE project_id = ?",
      PROJECT_ID,
    );
    const response = await finalize(validResult(), {
      commitBusinessTurn: committer,
    });

    expect(response).toMatchObject({
      affectedRows: 1,
      body: {
        attemptStatus: "discarded",
        run: { status: "paused" },
      },
      status: 200,
    });
    expect(committer).not.toHaveBeenCalled();
    expect(durableState()).toMatchObject({
      calls: 1,
      rounds: 0,
      runStatus: "paused",
      turns: 0,
      usage: 10,
    });
  });

  it("rejects a mismatched lease token with affected rows zero and no durable writes", async () => {
    await acquire();
    const before = durableState();
    const response = await finalize(
      validResult(),
      {},
      { leaseToken: "wrong-token" },
    );

    expect(response).toMatchObject({
      affectedRows: 0,
      status: 409,
    });
    expect(durableState()).toEqual(before);
  });

  it.each([
    [
      "provider",
      providerFailure("provider_timeout", "PROVIDER_TIMEOUT", 504),
      504,
      "PROVIDER_TIMEOUT",
      "provider_timeout",
      5,
      1,
    ],
    [
      "usage",
      usageFailure(),
      502,
      "PROVIDER_RESPONSE_INVALID",
      "usage_invalid",
      0,
      1,
    ],
    [
      "schema",
      schemaFailure(),
      400,
      "STRUCTURED_OUTPUT_INVALID",
      "structured_output_invalid",
      15,
      2,
    ],
  ] as const)(
    "persists exact public %s failure, completes pending receipt, and records every call/valid usage",
    async (_case, result, status, code, category, tokens, calls) => {
      await acquire();
      const response = await finalize(result);

      expect(response).toMatchObject({
        affectedRows: 1,
        body: { error: { category, code } },
        status,
      });
      expect(durableState()).toMatchObject({
        attemptStatus: "failed",
        calls,
        receiptStatus: "completed",
        rounds: 0,
        runStatus: "paused",
        turns: 0,
        usage: tokens,
      });
      expect(receipt()).toEqual({ body: response.body, status });
    },
  );

  it("rolls back a business failure, then completes the pending receipt in a short failure transaction", async () => {
    await acquire();
    const response = await finalize(validResult(), {
      commitBusinessTurn: (database) => {
        database
          .prepare(
            `INSERT INTO collaboration_messages (
               id,project_id,thread_id,run_id,author_type,author_agent_id,
               author_display_name, content, mention_agent_id,
               mention_display_name, sequence, consumed_at, created_at
             ) VALUES (
               'must-rollback',?,?,?,'agent',?,'Alpha','rollback me',
               NULL, NULL, 2, NULL, ?
             )`,
          )
          .run(PROJECT_ID, threadId, RUN_ID, AGENT_ID, NOW);
        throw new CollaborationError(
          "ACTION_INVALID",
          400,
          "Agent action is invalid.",
          { category: "action_invalid" },
        );
      },
    });

    expect(response).toMatchObject({
      affectedRows: 1,
      body: {
        error: { category: "action_invalid", code: "ACTION_INVALID" },
      },
      status: 400,
    });
    const database = openDatabase(databasePath);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM collaboration_messages WHERE id = 'must-rollback'")
        .get(),
    ).toEqual({ count: 0 });
    database.close();
    expect(durableState()).toMatchObject({
      attemptStatus: "failed",
      calls: 1,
      receiptStatus: "completed",
      rounds: 0,
      runStatus: "paused",
      turns: 0,
      usage: 10,
    });
    expect(receipt()).toEqual({ body: response.body, status: 400 });
  });

  it.each([
    [
      "unexpected business exception",
      () => {
        throw new Error("secret persistence detail");
      },
    ],
    [
      "SQLite persistence exception",
      (database: DatabaseSync) => {
        database.exec("INSERT INTO missing_finalize_table VALUES (1)");
      },
    ],
  ])(
    "durably sanitizes %s as failed/internal_failure and makes a late finalizer a no-op",
    async (_case, fail) => {
      await acquire();
      const first = await finalize(validResult(), { commitBusinessTurn: fail });

      expect(first).toMatchObject({
        affectedRows: 1,
        body: {
          error: {
            category: "internal_failure",
            code: "INTERNAL_ERROR",
          },
        },
        status: 500,
      });
      expect(JSON.stringify(first.body)).not.toContain("secret persistence detail");
      expect(durableState()).toMatchObject({
        attemptErrorCategory: "internal_failure",
        attemptStatus: "failed",
        receiptStatus: "completed",
        runPauseCategory: "internal_failure",
        runStatus: "failed",
      });
      expect(receipt()).toEqual({ body: first.body, status: 500 });

      const before = durableState();
      const late = await finalize(schemaFailure());
      expect(late).toEqual({ ...first, affectedRows: 0 });
      expect(durableState()).toEqual(before);
    },
  );

  it("persists provider credential and verification generations on auth failure", async () => {
    await acquire();
    await finalize(providerFailure("provider_auth", "PROVIDER_AUTH", 401));
    const database = openDatabase(databasePath);
    try {
      const columns = (
        database.prepare("PRAGMA table_info(collaboration_attempts)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name);
      expect(columns).toEqual(expect.arrayContaining([
        "failure_provider_id",
        "failure_provider_version",
        "failure_credential_version",
        "failure_credential_generation",
        "failure_verified_at",
      ]));
      expect(
        database
          .prepare(
            `SELECT failure_provider_id AS providerId,
                    failure_provider_version AS providerVersion,
                    failure_credential_version AS credentialVersion,
                    failure_credential_generation AS credentialGeneration,
                    failure_verified_at AS verifiedAt
             FROM collaboration_attempts WHERE run_id = ?`,
          )
          .get(RUN_ID),
      ).toEqual({
        credentialGeneration: 1,
        credentialVersion: 1,
        providerId: "provider-finalize",
        providerVersion: 1,
        verifiedAt: NOW,
      });
    } finally {
      database.close();
    }
  });

  it.each([
    ["committed", validResult()],
    [
      "failed",
      providerFailure("provider_auth", "PROVIDER_AUTH", 401),
    ],
    ["discarded", validResult()],
  ] as const)(
    "a late finalizer after a %s terminal attempt reads the durable receipt and changes nothing",
    async (terminal, result) => {
      await acquire();
      if (terminal === "discarded") {
        mutate(
          "UPDATE collaboration_runs SET status = 'stopped', execution_epoch = execution_epoch + 1 WHERE id = ?",
          RUN_ID,
        );
      }
      const first = await finalize(result);
      const before = durableState();
      const second = await finalize(schemaFailure());

      expect(second).toEqual({ ...first, affectedRows: 0 });
      expect(durableState()).toEqual(before);
    },
  );

  it("keeps the advance receipt request hash and identity unchanged", async () => {
    await acquire();
    await finalize(validResult());
    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT kind, request_hash AS requestHash, run_id AS runId
             FROM collaboration_operations
             WHERE project_id = ? AND id = ?`,
          )
          .get(PROJECT_ID, OPERATION_ID),
      ).toEqual({
        kind: "advance",
        requestHash: canonicalRequestHash({}),
        runId: RUN_ID,
      });
    } finally {
      database.close();
    }
  });
});
