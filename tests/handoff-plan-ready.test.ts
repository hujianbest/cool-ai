import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentTurn } from "@/src/server/collaboration/agent-turn-schema";
import { commitAgentTaskActionsTx } from "@/src/server/collaboration/action-committer";
import type { StructuredTurnResult } from "@/src/server/collaboration/structured-repair";
import {
  acquireAdvance,
  finalizeAdvance,
} from "@/src/server/collaboration/turn-orchestrator";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";

const NOW = "2026-07-30T04:00:00.000Z";
const PROJECT_ID = "project-handoff";
const RUN_ID = "run-handoff";
const AGENT_A = "agent-handoff-a";
const AGENT_B = "agent-handoff-b";
const MISSION_ID = "mission-handoff";

let directory: string;
let databasePath: string;
let threadId: string;
let operationSequence: number;
let uuidSequence: number;

function dependencies() {
  return {
    clock: () => new Date(NOW),
    randomUUID: () => {
      uuidSequence += 1;
      return `14000000-0000-4000-8000-${uuidSequence.toString().padStart(12, "0")}`;
    },
  };
}

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function handoff(
  agentId: string,
  targetAgentId: string,
  overrides: Partial<AgentTurn> = {},
): AgentTurn {
  return {
    claim: null,
    disposition: {
      reason: `The next contribution belongs to ${targetAgentId}`,
      summary: `Continue the mission after ${agentId}`,
      targetAgentId,
      type: "handoff",
    },
    message: `Committed conclusion from ${agentId}`,
    tasks: [],
    ...overrides,
  };
}

function planReady(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    claim: null,
    disposition: { type: "plan_ready" },
    message: "The collaborative plan is ready for execution.",
    tasks: [],
    ...overrides,
  };
}

function result(turn: AgentTurn): StructuredTurnResult {
  const usage = { completionTokens: 3, promptTokens: 7, totalTokens: 10 };
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

function advance(turn: AgentTurn) {
  const acquired = acquireAdvance(
    databasePath,
    { projectId: PROJECT_ID, runId: RUN_ID, threadId },
    { operationId: operationId() },
    dependencies(),
  );
  expect(acquired.kind).toBe("acquired");
  if (acquired.kind !== "acquired") throw new Error("Expected an acquired turn.");
  return finalizeAdvance(
    databasePath,
    { projectId: PROJECT_ID, runId: RUN_ID, threadId },
    {
      attemptId: acquired.attempt.id,
      leaseToken: acquired.attempt.leaseToken,
      result: result(turn),
    },
    dependencies(),
  );
}

function withCommit(turn: AgentTurn, existingDatabase?: DatabaseSync): void {
  const database = existingDatabase ?? openDatabase(databasePath);
  database
    .prepare(
      `INSERT OR IGNORE INTO collaboration_operations (
         id, project_id, thread_id, run_id, kind, request_hash, status,
         http_status, response_json, response_schema_version, created_at, updated_at
       ) VALUES (
         'direct-operation', ?, ?, ?, 'advance', 'hash', 'pending',
         NULL, NULL, NULL, ?, ?
       )`,
    )
    .run(PROJECT_ID, threadId, RUN_ID, NOW, NOW);
  database
    .prepare(
      `INSERT OR IGNORE INTO collaboration_attempts (
         id, project_id, thread_id, run_id, agent_id, operation_id, status,
         lease_token, lease_expires_at, prompt_hash, acquire_execution_epoch,
         acquire_context_hash, included_message_sequence, error_category,
         started_at, finished_at
       ) VALUES (
         'direct-attempt', ?, ?, ?, ?, 'direct-operation', 'calling',
         'lease', '2099-01-01T00:00:00.000Z', 'prompt', 1,
         'context', 0, NULL, ?, NULL
       )`,
    )
    .run(PROJECT_ID, threadId, RUN_ID, AGENT_A, NOW);
  database.exec("BEGIN IMMEDIATE");
  try {
    commitAgentTaskActionsTx(database, {
      agentId: AGENT_A,
      attemptId: "direct-attempt",
      runId: RUN_ID,
      timestamp: NOW,
      turn,
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    if (!existingDatabase) database.close();
  }
}

function snapshot(): {
  attempts: number;
  currentAgentId: string;
  events: Array<{ payload: Record<string, unknown>; sequence: number; type: string }>;
  messages: number;
  missionVersion: number;
  nextEventSequence: number;
  nextMessageSequence: number;
  roundCount: number;
  runStatus: string;
  runVersion: number;
  tasks: Array<{ assigneeAgentId: string | null; status: string; version: number }>;
  turns: number;
} {
  const database = openDatabase(databasePath);
  try {
    const run = database
      .prepare(
        `SELECT status AS runStatus, current_agent_id AS currentAgentId,
                round_count AS roundCount, next_event_sequence AS nextEventSequence,
                version AS runVersion
         FROM collaboration_runs WHERE id = ?`,
      )
      .get(RUN_ID) as {
      currentAgentId: string;
      nextEventSequence: number;
      roundCount: number;
      runStatus: string;
      runVersion: number;
    };
    const mission = database
      .prepare("SELECT version AS missionVersion FROM missions WHERE project_id = ?")
      .get(PROJECT_ID) as { missionVersion: number };
    const sequence = database
      .prepare(
        `SELECT next_message_sequence AS nextMessageSequence
         FROM collaboration_project_sequences
         WHERE project_id = ? AND thread_id = ?`,
      )
      .get(PROJECT_ID, threadId) as { nextMessageSequence: number };
    return {
      ...run,
      ...mission,
      ...sequence,
      attempts: (
        database
          .prepare("SELECT COUNT(*) AS count FROM collaboration_attempts WHERE run_id = ?")
          .get(RUN_ID) as { count: number }
      ).count,
      events: (
        database
          .prepare(
            `SELECT sequence, type, payload_json AS payload
             FROM collaboration_events WHERE run_id = ? ORDER BY sequence`,
          )
          .all(RUN_ID) as Array<{ payload: string; sequence: number; type: string }>
      ).map((event) => ({ ...event, payload: JSON.parse(event.payload) })),
      messages: (
        database
          .prepare("SELECT COUNT(*) AS count FROM collaboration_messages WHERE run_id = ?")
          .get(RUN_ID) as { count: number }
      ).count,
      tasks: database
        .prepare(
          `SELECT assignee_agent_id AS assigneeAgentId, status, version
           FROM work_items
           WHERE mission_id = (SELECT id FROM missions WHERE project_id = ?)
           ORDER BY created_at, id`,
        )
        .all(PROJECT_ID) as Array<{
        assigneeAgentId: string | null;
        status: string;
        version: number;
      }>,
      turns: (
        database
          .prepare("SELECT COUNT(*) AS count FROM collaboration_turns WHERE run_id = ?")
          .get(RUN_ID) as { count: number }
      ).count,
    };
  } finally {
    database.close();
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "handoff-plan-ready-"));
  databasePath = join(directory, "cockpit.sqlite");
  operationSequence = 0;
  uuidSequence = 0;
  threadId = seedV7AdvanceFixture(databasePath, {
    agentId: AGENT_A,
    agentPrompt: "private-a",
    missionId: MISSION_ID,
    now: NOW,
    ownerMessage: null,
    projectId: PROJECT_ID,
    projectName: "Handoff project",
    providerId: "provider-handoff",
    runId: RUN_ID,
    secondAgentId: AGENT_B,
    secondAgentPrompt: "private-b",
    threadCreateOperationId: "14000000-0000-4000-8000-000000000000",
  });
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("handoff action commit", () => {
  it("atomically persists message, turn, snapshots, events, round/version, and the next current Agent", () => {
    const response = advance(handoff(AGENT_A, AGENT_B));

    expect(response).toMatchObject({
      affectedRows: 1,
      body: {
        attemptStatus: "committed",
        run: {
          currentAgentId: AGENT_B,
          roundCount: 1,
          status: "running",
          version: 2,
        },
      },
      status: 200,
    });
    const state = snapshot();
    expect(state).toMatchObject({
      currentAgentId: AGENT_B,
      messages: 1,
      nextMessageSequence: 2,
      roundCount: 1,
      runStatus: "running",
      runVersion: 2,
      turns: 1,
    });
    expect(state.events.slice(-2)).toEqual([
      {
        payload: expect.objectContaining({
          agentDisplayName: "Alpha",
          agentId: AGENT_A,
          turnId: expect.any(String),
        }),
        sequence: state.nextEventSequence - 2,
        type: "agent_message",
      },
      {
        payload: expect.objectContaining({
          fromAgentId: AGENT_A,
          reason: `The next contribution belongs to ${AGENT_B}`,
          summary: `Continue the mission after ${AGENT_A}`,
          toAgentId: AGENT_B,
          turnId: expect.any(String),
        }),
        sequence: state.nextEventSequence - 1,
        type: "handoff",
      },
    ]);
    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT turns.agent_id AS agentId, turns.round_number AS roundNumber,
                    turns.disposition, messages.author_display_name AS displayName,
                    messages.content
             FROM collaboration_turns AS turns
             JOIN collaboration_messages AS messages ON messages.id = turns.message_id
             WHERE turns.run_id = ?`,
          )
          .get(RUN_ID),
      ).toEqual({
        agentId: AGENT_A,
        content: `Committed conclusion from ${AGENT_A}`,
        displayName: "Alpha",
        disposition: "handoff",
        roundNumber: 1,
      });
    } finally {
      database.close();
    }
  });

  it.each([
    ["the same Agent", AGENT_A, "summary", "reason"],
    ["a non-member", "agent-outside", "summary", "reason"],
    ["an empty summary", AGENT_B, "", "reason"],
    ["an overlong summary", AGENT_B, "总".repeat(5_001), "reason"],
    ["an empty reason", AGENT_B, "summary", ""],
    ["an overlong reason", AGENT_B, "summary", "因".repeat(5_001)],
  ])("rejects %s and rolls back every handoff fact", (_case, target, summary, reason) => {
    expect(() =>
      withCommit({
        ...handoff(AGENT_A, target),
        disposition: {
          reason,
          summary,
          targetAgentId: target,
          type: "handoff",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "ACTION_INVALID" }));
    expect(snapshot()).toMatchObject({
      currentAgentId: AGENT_A,
      events: [],
      messages: 0,
      nextEventSequence: 1,
      nextMessageSequence: 1,
      roundCount: 0,
      runVersion: 1,
      turns: 0,
    });
  });

  it("enforces maxHandoffs immediately before commit without implementing token budgets", () => {
    const database = openDatabase(databasePath);
    database
      .prepare("UPDATE agents SET max_handoffs = 0 WHERE id = ?")
      .run(AGENT_A);
    database.close();

    expect(() => withCommit(handoff(AGENT_A, AGENT_B))).toThrowError(
      expect.objectContaining({ code: "BOUNDARY_REACHED" }),
    );
    expect(snapshot()).toMatchObject({
      currentAgentId: AGENT_A,
      events: [],
      messages: 0,
      nextEventSequence: 1,
      nextMessageSequence: 1,
      turns: 0,
    });
  });
});

describe("plan-ready action commit", () => {
  it("plans only after two distinct committed Agents and a claimed mission task, without completing either", () => {
    expect(advance(handoff(AGENT_A, AGENT_B)).status).toBe(200);
    const response = advance(
      planReady({
        claim: { clientKey: "implementation", source: "proposed" },
        tasks: [
          {
            clientKey: "implementation",
            dependsOnKeys: [],
            description: "Execute the accepted plan",
            title: "Implement plan",
          },
        ],
      }),
    );

    expect(response).toMatchObject({
      affectedRows: 1,
      body: {
        attemptStatus: "committed",
        run: {
          currentAgentId: AGENT_B,
          roundCount: 2,
          status: "planned",
          version: 3,
        },
      },
      status: 200,
    });
    const state = snapshot();
    expect(state.tasks).toEqual([
      { assigneeAgentId: AGENT_B, status: "in_progress", version: 2 },
    ]);
    expect(state).toMatchObject({
      messages: 2,
      missionVersion: 2,
      roundCount: 2,
      runStatus: "planned",
      runVersion: 3,
      turns: 2,
    });
    expect(state.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "agent_message",
        "tasks_created",
        "task_claimed",
        "handoff",
        "run_planned",
      ]),
    );
  });

  it("rolls back the whole invalid turn and reports only the allowlisted missing preconditions", () => {
    const response = advance(planReady());

    expect(response).toMatchObject({
      affectedRows: 1,
      body: {
        error: {
          category: "action_invalid",
          code: "ACTION_INVALID",
        },
      },
      status: 400,
    });
    const state = snapshot();
    expect(state).toMatchObject({
      currentAgentId: AGENT_A,
      messages: 0,
      missionVersion: 1,
      nextMessageSequence: 1,
      roundCount: 0,
      runStatus: "paused",
      runVersion: 2,
      tasks: [],
      turns: 0,
    });
    expect(state.events.at(-1)).toEqual({
      payload: {
        attemptId: expect.any(String),
        category: "action_invalid",
        missing: ["participants", "tasks", "claim"],
      },
      sequence: state.nextEventSequence - 1,
      type: "action_rejected",
    });
    expect(JSON.stringify(response.body)).not.toContain("participants,tasks,claim");
  });

  it("rolls back message, turn, baton, run revision, and event sequences when a late write fails", () => {
    const database = openDatabase(databasePath);
    database.exec(`
      CREATE TRIGGER reject_handoff_event
      BEFORE INSERT ON collaboration_events
      WHEN NEW.type = 'handoff'
      BEGIN
        SELECT RAISE(ABORT, 'injected handoff event failure');
      END;
    `);
    try {
      expect(() => withCommit(handoff(AGENT_A, AGENT_B), database)).toThrow(
        "injected handoff event failure",
      );
      database.exec("DROP TRIGGER reject_handoff_event");
    } finally {
      database.close();
    }
    expect(snapshot()).toMatchObject({
      currentAgentId: AGENT_A,
      events: [],
      messages: 0,
      missionVersion: 1,
      nextEventSequence: 1,
      nextMessageSequence: 1,
      roundCount: 0,
      runStatus: "running",
      runVersion: 1,
      tasks: [],
      turns: 0,
    });
  });
});
