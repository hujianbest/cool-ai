import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentTurn } from "@/src/server/collaboration/agent-turn-schema";
import { getCollaboration } from "@/src/server/collaboration/run-service";
import type { StructuredTurnResult } from "@/src/server/collaboration/structured-repair";
import {
  acquireAdvance,
  finalizeAdvance,
} from "@/src/server/collaboration/turn-orchestrator";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  execV7Fixture,
  execV7TupleStatements,
} from "@/tests/fixtures/execution/current-graph";

const NOW = "2026-07-30T06:00:00.000Z";
const PROJECT_ID = "project-usage";
const RUN_ID = "run-usage";
const AGENT_A = "agent-usage-a";
const AGENT_B = "agent-usage-b";

let databasePath: string;
let threadId: string;
let directory: string;
let operationSequence: number;
let uuidSequence: number;

function dependencies() {
  return {
    clock: () => new Date(NOW),
    randomUUID: () => {
      uuidSequence += 1;
      return `15000000-0000-4000-8000-${uuidSequence.toString().padStart(12, "0")}`;
    },
  };
}

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function seedReadyRun(): void {
  const database = openDatabase(databasePath);
  try {
    threadId = execV7Fixture(databasePath, database, `
      INSERT INTO projects (
        id, name, created_at, workspace_path, workspace_key, version
      ) VALUES (
        '${PROJECT_ID}', 'Usage Project', '${NOW}',
        'D:\\workspace', 'd:/workspace', 1
      );
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv,
        api_key_tag, credential_version, credential_generation, key_id,
        api_key_mask, verified_at, version, created_at, updated_at
      ) VALUES (
        'provider-usage', 'Local', 'http://127.0.0.1:4000/v1', 'model',
        'cipher', 'iv', 'tag', 1, 1, 'key', '***', '${NOW}', 1, '${NOW}', '${NOW}'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text,
        accent_token, can_read, can_write, can_execute, max_tokens,
        max_handoffs, version, created_at, updated_at
      ) VALUES
        (
          '${AGENT_A}', 'Alpha', 'Planner', 'private-a', 'provider-usage',
          'model', 'A', 'sage', 1, 1, 0, 100, 2, 1, '${NOW}', '${NOW}'
        ),
        (
          '${AGENT_B}', 'Beta', 'Reviewer', 'private-b', 'provider-usage',
          'model', 'B', 'gold', 1, 1, 0, 100, 2, 1, '${NOW}', '${NOW}'
        );
      INSERT INTO project_memberships (project_id, agent_id, joined_at) VALUES
        ('${PROJECT_ID}', '${AGENT_A}', 'a'),
        ('${PROJECT_ID}', '${AGENT_B}', 'b');
      INSERT INTO missions (
        id, project_id, title, goal, version, created_at, updated_at
      ) VALUES (
        'mission-usage', '${PROJECT_ID}', 'Mission', 'Budget safely', 1, '${NOW}', '${NOW}'
      );
      INSERT INTO collaboration_runs (
        id, project_id, status, current_agent_id, round_count,
        next_event_sequence, version, execution_epoch, pause_reason,
        pause_category, created_at, updated_at
      ) VALUES (
        '${RUN_ID}', '${PROJECT_ID}', 'running', '${AGENT_A}', 0,
        1, 1, 1, NULL, NULL, '${NOW}', '${NOW}'
      );
      INSERT INTO collaboration_project_sequences (
        project_id, next_message_sequence
      ) VALUES ('${PROJECT_ID}', 2);
      INSERT INTO collaboration_messages (
        id, project_id, run_id, author_type, author_agent_id,
        author_display_name, content, mention_agent_id, mention_display_name,
        sequence, consumed_at, created_at
      ) VALUES (
        'owner-usage', '${PROJECT_ID}', '${RUN_ID}', 'owner', NULL,
        'Owner', 'Prepare the plan', NULL, NULL, 1, NULL, '${NOW}'
      );
    `).get(PROJECT_ID)!;
  } finally {
    database.close();
  }
}

function insertCall(input: {
  agentId: string;
  callIndex?: number;
  completionTokens: number | null;
  kind?: "primary" | "repair";
  promptTokens: number | null;
  status: "succeeded" | "provider_failed" | "response_invalid" | "usage_invalid";
  suffix: string;
  totalTokens: number | null;
}): string {
  const database = openDatabase(databasePath);
  const attemptId = `attempt-${input.suffix}`;
  const priorOperation = `10000000-0000-4000-8000-${input.suffix.padStart(12, "0")}`;
  try {
    database
      .prepare(
        `INSERT INTO collaboration_operations (
           id, project_id, thread_id, run_id, kind, request_hash, status,
           http_status, response_json, response_schema_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'advance', 'prior', 'completed', 200, '{}', 7, ?, ?)`,
      )
      .run(priorOperation, PROJECT_ID, threadId, RUN_ID, NOW, NOW);
    database
      .prepare(
        `INSERT INTO collaboration_attempts (
           id, project_id, thread_id, run_id, agent_id, operation_id, status,
           lease_token, lease_expires_at, prompt_hash, acquire_execution_epoch,
           acquire_context_hash, included_message_sequence, error_category,
           started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, ?, 'prompt', 1, 'context', 1,
                   NULL, ?, ?)`,
      )
      .run(
        attemptId,
        PROJECT_ID,
        threadId,
        RUN_ID,
        input.agentId,
        priorOperation,
        `lease-${input.suffix}`,
        NOW,
        NOW,
        NOW,
      );
    database
      .prepare(
        `INSERT INTO collaboration_model_calls (
           id, attempt_id, kind, call_index, status, prompt_tokens,
           completion_tokens, total_tokens, error_category, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `call-${input.suffix}`,
        attemptId,
        input.kind ?? "primary",
        input.callIndex ?? 1,
        input.status,
        input.promptTokens,
        input.completionTokens,
        input.totalTokens,
        input.status === "usage_invalid"
          ? "usage_invalid"
          : input.status === "provider_failed"
            ? "provider_unreachable"
            : null,
        NOW,
      );
    return attemptId;
  } finally {
    database.close();
  }
}

function validResult(turn: AgentTurn, totalTokens: number): StructuredTurnResult {
  const usage = {
    completionTokens: Math.floor(totalTokens / 2),
    promptTokens: Math.ceil(totalTokens / 2),
    totalTokens,
  };
  return {
    calls: [
      {
        kind: "primary",
        result: {
          content: "{}",
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
    turn,
    usage: [{ kind: "primary", usage, usageReported: true }],
  };
}

function invalidSuccessUsageResult(): StructuredTurnResult {
  return {
    calls: [
      {
        kind: "primary",
        result: {
          content: null,
          error: {
            category: "usage_invalid",
            code: "PROVIDER_RESPONSE_INVALID",
            correlationId: "usage-correlation",
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

function handoffTurn(): AgentTurn {
  return {
    claim: null,
    disposition: {
      reason: "Beta should review next.",
      summary: "The initial plan is ready for review.",
      targetAgentId: AGENT_B,
      type: "handoff",
    },
    message: "I prepared the first draft.",
    tasks: [
      {
        clientKey: "must-not-persist",
        dependsOnKeys: [],
        description: "This action must be discarded after crossing the token budget.",
        title: "Discard this task",
      },
    ],
  };
}

function acquire() {
  return acquireAdvance(
    databasePath,
    { projectId: PROJECT_ID, runId: RUN_ID, threadId },
    { operationId: operationId() },
    dependencies(),
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-usage-"));
  databasePath = join(directory, "cockpit.sqlite");
  operationSequence = 1500;
  uuidSequence = 0;
  seedReadyRun();
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("persisted collaboration usage aggregate", () => {
  it("includes valid primary, repair, and provider-error usage by run and Agent while separating repair, handoff, round, and unreported counts", () => {
    const primaryAttempt = insertCall({
      agentId: AGENT_A,
      completionTokens: 4,
      promptTokens: 6,
      status: "succeeded",
      suffix: "1",
      totalTokens: 10,
    });
    insertCall({
      agentId: AGENT_A,
      completionTokens: 2,
      kind: "repair",
      promptTokens: 3,
      status: "response_invalid",
      suffix: "2",
      totalTokens: 5,
    });
    insertCall({
      agentId: AGENT_A,
      completionTokens: 3,
      promptTokens: 4,
      status: "provider_failed",
      suffix: "3",
      totalTokens: 7,
    });
    insertCall({
      agentId: AGENT_A,
      completionTokens: null,
      promptTokens: null,
      status: "provider_failed",
      suffix: "4",
      totalTokens: null,
    });
    insertCall({
      agentId: AGENT_A,
      completionTokens: null,
      promptTokens: null,
      status: "usage_invalid",
      suffix: "5",
      totalTokens: null,
    });
    insertCall({
      agentId: AGENT_B,
      completionTokens: 5,
      promptTokens: 6,
      status: "succeeded",
      suffix: "6",
      totalTokens: 11,
    });

    const database = openDatabase(databasePath);
    try {
      execV7TupleStatements(database, `
        UPDATE collaboration_runs SET round_count = 3 WHERE id = '${RUN_ID}';
        INSERT INTO collaboration_messages (
          id, project_id, run_id, author_type, author_agent_id,
          author_display_name, content, mention_agent_id, mention_display_name,
          sequence, consumed_at, created_at
        ) VALUES (
          'handoff-usage-message', '${PROJECT_ID}', '${RUN_ID}', 'agent', '${AGENT_A}',
          'Alpha', 'handoff', NULL, NULL, 2, NULL, '${NOW}'
        );
        INSERT INTO collaboration_turns (
          id, attempt_id, run_id, agent_id, round_number, message_id,
          disposition, created_at
        ) VALUES (
          'handoff-usage-turn', '${primaryAttempt}', '${RUN_ID}', '${AGENT_A}', 1,
          'handoff-usage-message', 'handoff', '${NOW}'
        );
      `);
    } finally {
      database.close();
    }

    const response = getCollaboration(databasePath, PROJECT_ID);
    expect(response.run?.roundCount).toBe(3);
    expect(response.usage).toEqual({
      byAgent: [
        {
          agentId: AGENT_A,
          completionTokens: 9,
          handoffs: 1,
          promptTokens: 13,
          totalTokens: 22,
        },
        {
          agentId: AGENT_B,
          completionTokens: 5,
          handoffs: 0,
          promptTokens: 6,
          totalTokens: 11,
        },
      ],
      completionTokens: 14,
      promptTokens: 19,
      repairCalls: 1,
      totalTokens: 33,
      unreportedCalls: 2,
    });
  });
});

describe("collaboration budget boundaries", () => {
  it.each([
    ["tokens", "UPDATE agents SET max_tokens = 0 WHERE id = ?", AGENT_A],
    ["rounds", "UPDATE collaboration_runs SET round_count = 50 WHERE id = ?", RUN_ID],
  ] as const)(
    "pauses before HTTP when the %s value is already at its inclusive limit",
    (boundary, sql, value) => {
      const database = openDatabase(databasePath);
      database.prepare(sql).run(value);
      database.close();

      const result = acquire();
      expect(result).toMatchObject({
        boundary,
        kind: "paused",
        run: { status: "paused" },
      });
      const verify = openDatabase(databasePath);
      try {
        expect(
          verify
            .prepare(
              `SELECT
                 (SELECT COUNT(*) FROM collaboration_attempts WHERE run_id = ?) AS attempts,
                 (SELECT COUNT(*) FROM collaboration_events
                    WHERE run_id = ? AND type = 'model_call_started') AS started`,
            )
            .get(RUN_ID, RUN_ID),
        ).toEqual({ attempts: 0, started: 0 });
      } finally {
        verify.close();
      }
    },
  );

  it("pauses before HTTP when committed outgoing handoffs equal maxHandoffs", () => {
    const attemptId = insertCall({
      agentId: AGENT_A,
      completionTokens: 1,
      promptTokens: 1,
      status: "succeeded",
      suffix: "20",
      totalTokens: 2,
    });
    const database = openDatabase(databasePath);
    try {
      execV7TupleStatements(database, `
        UPDATE agents SET max_handoffs = 1 WHERE id = '${AGENT_A}';
        INSERT INTO collaboration_messages (
          id, project_id, run_id, author_type, author_agent_id,
          author_display_name, content, mention_agent_id, mention_display_name,
          sequence, consumed_at, created_at
        ) VALUES (
          'prior-handoff-message', '${PROJECT_ID}', '${RUN_ID}', 'agent', '${AGENT_A}',
          'Alpha', 'handoff', NULL, NULL, 2, NULL, '${NOW}'
        );
        INSERT INTO collaboration_turns (
          id, attempt_id, run_id, agent_id, round_number, message_id,
          disposition, created_at
        ) VALUES (
          'prior-handoff-turn', '${attemptId}', '${RUN_ID}', '${AGENT_A}', 1,
          'prior-handoff-message', 'handoff', '${NOW}'
        );
      `);
    } finally {
      database.close();
    }

    expect(acquire()).toMatchObject({
      boundary: "handoffs",
      kind: "paused",
      run: { status: "paused" },
    });
  });

  it("persists the crossing call and budget event but discards every business action", () => {
    const database = openDatabase(databasePath);
    database.prepare("UPDATE agents SET max_tokens = 10 WHERE id = ?").run(AGENT_A);
    database.close();

    const acquired = acquire();
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    const response = finalizeAdvance(
      databasePath,
      { projectId: PROJECT_ID, runId: RUN_ID, threadId },
      {
        attemptId: acquired.attempt.id,
        leaseToken: acquired.attempt.leaseToken,
        result: validResult(handoffTurn(), 11),
      },
      dependencies(),
    );
    expect(response).toMatchObject({
      affectedRows: 1,
      body: {
        attemptStatus: "discarded",
        run: { pauseCategory: "boundary_reached", roundCount: 0, status: "paused" },
      },
      status: 200,
    });

    const verify = openDatabase(databasePath);
    try {
      const state = verify
        .prepare(
          `SELECT
             (SELECT status FROM collaboration_attempts WHERE id = ?) AS attemptStatus,
             (SELECT COUNT(*) FROM collaboration_model_calls WHERE attempt_id = ?) AS calls,
             (SELECT COALESCE(SUM(total_tokens), 0)
                FROM collaboration_model_calls WHERE attempt_id = ?) AS tokens,
             (SELECT COUNT(*) FROM collaboration_turns WHERE run_id = ?) AS turns,
             (SELECT COUNT(*) FROM collaboration_messages
                WHERE run_id = ? AND author_type = 'agent') AS agentMessages,
             (SELECT COUNT(*) FROM work_items
                WHERE mission_id = 'mission-usage') AS tasks`,
        )
        .get(
          acquired.attempt.id,
          acquired.attempt.id,
          acquired.attempt.id,
          RUN_ID,
          RUN_ID,
        );
      expect(state).toEqual({
        agentMessages: 0,
        attemptStatus: "discarded",
        calls: 1,
        tasks: 0,
        tokens: 11,
        turns: 0,
      });
      const budgetEvent = verify
        .prepare(
          `SELECT payload_json AS payload
           FROM collaboration_events
           WHERE run_id = ? AND type = 'boundary_paused'
           ORDER BY sequence DESC LIMIT 1`,
        )
        .get(RUN_ID) as { payload: string };
      expect(JSON.parse(budgetEvent.payload)).toEqual({
        agentId: AGENT_A,
        boundary: "tokens",
        limit: 10,
        value: 11,
      });
    } finally {
      verify.close();
    }
  });

  it("categorizes invalid usage on an otherwise successful response without committing actions", () => {
    const acquired = acquire();
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;

    const response = finalizeAdvance(
      databasePath,
      { projectId: PROJECT_ID, runId: RUN_ID, threadId },
      {
        attemptId: acquired.attempt.id,
        leaseToken: acquired.attempt.leaseToken,
        result: invalidSuccessUsageResult(),
      },
      dependencies(),
    );
    expect(response).toMatchObject({
      body: {
        error: {
          category: "usage_invalid",
          code: "PROVIDER_RESPONSE_INVALID",
        },
      },
      status: 502,
    });

    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT calls.status, calls.total_tokens AS totalTokens,
                    attempts.status AS attemptStatus,
                    runs.status AS runStatus, runs.pause_category AS pauseCategory,
                    (SELECT COUNT(*) FROM collaboration_turns WHERE run_id = ?) AS turns
             FROM collaboration_model_calls AS calls
             JOIN collaboration_attempts AS attempts ON attempts.id = calls.attempt_id
             JOIN collaboration_runs AS runs ON runs.id = attempts.run_id
             WHERE calls.attempt_id = ?`,
          )
          .get(RUN_ID, acquired.attempt.id),
      ).toEqual({
        attemptStatus: "failed",
        pauseCategory: "usage_invalid",
        runStatus: "paused",
        status: "usage_invalid",
        totalTokens: null,
        turns: 0,
      });
    } finally {
      database.close();
    }
  });
});
