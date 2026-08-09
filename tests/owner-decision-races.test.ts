import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentTurn } from "@/src/server/collaboration/agent-turn-schema";
import {
  answerThreadDecision,
  controlThreadRun,
} from "@/src/server/collaboration/run-service";
import {
  createThread,
  writeOwnerThreadMessage,
} from "@/src/server/collaboration/thread-service";
import type { StructuredTurnResult } from "@/src/server/collaboration/structured-repair";
import {
  acquireAdvance,
  finalizeAdvance,
} from "@/src/server/collaboration/turn-orchestrator";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createMission } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";

const NOW = "2026-07-30T06:30:00.000Z";
const PROJECT_ID = "project-owner-decision-races";
const RUN_ID = "run-owner-decision-races";
const REQUESTER_ID = "agent-decision-requester";
const REVIEWER_ID = "agent-decision-reviewer";
let threadId: string;

let databasePath: string;
let directory: string;
let operationSequence: number;
let uuidSequence: number;

function operationId(): string {
  operationSequence += 1;
  return `18000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function dependencies() {
  return {
    clock: () => new Date(NOW),
    randomUUID: () => {
      uuidSequence += 1;
      return `18100000-0000-4000-8000-${uuidSequence.toString().padStart(12, "0")}`;
    },
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

function decision(options = ["Approve", "Revise"]): AgentTurn {
  return {
    claim: null,
    disposition: {
      options,
      question: "Which direction should the team take?",
      type: "decision_request",
    },
    message: "The owner needs to decide.",
    tasks: [],
  };
}

function ownerMessage(content: string, mentionAgentId?: string) {
  return writeOwnerThreadMessage(databasePath, PROJECT_ID, threadId, {
    content,
    ...(mentionAgentId === undefined ? {} : { mentionAgentId }),
    operationId: operationId(),
  }).body.message;
}

function acquire() {
  const acquired = acquireAdvance(
    databasePath,
    { projectId: PROJECT_ID, runId: RUN_ID, threadId },
    { operationId: operationId() },
    dependencies(),
  );
  expect(acquired.kind).toBe("acquired");
  if (acquired.kind !== "acquired") throw new Error("Expected acquired advance.");
  return acquired;
}

function finalize(acquired: ReturnType<typeof acquire>, turn: AgentTurn) {
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

function persistedState() {
  const database = openDatabase(databasePath);
  try {
    const run = database
      .prepare(
        `SELECT status, current_agent_id AS currentAgentId, version
         FROM collaboration_runs WHERE id = ?`,
      )
      .get(RUN_ID) as { currentAgentId: string; status: string; version: number };
    const decisionRows = database
      .prepare(
        `SELECT id, requesting_agent_id AS requestingAgentId, status, answer
         FROM decision_requests WHERE run_id = ? ORDER BY created_at, id`,
      )
      .all(RUN_ID) as Array<{
      answer: string | null;
      id: string;
      requestingAgentId: string;
      status: string;
    }>;
    const ownerMessages = database
      .prepare(
        `SELECT content, consumed_at AS consumedAt,
                mention_agent_id AS mentionAgentId, sequence
         FROM collaboration_messages
         WHERE project_id = ? AND author_type = 'owner'
         ORDER BY sequence`,
      )
      .all(PROJECT_ID) as Array<{
      consumedAt: string | null;
      content: string;
      mentionAgentId: string | null;
      sequence: number;
    }>;
    return { decisionRows, ownerMessages, run };
  } finally {
    database.close();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  directory = mkdtempSync(join(tmpdir(), "owner-decision-races-"));
  databasePath = join(directory, "cockpit.sqlite");
  operationSequence = 1_800;
  uuidSequence = 0;

  const database = openDatabase(databasePath);
  database
    .prepare(
      `INSERT INTO projects (
         id, name, created_at, workspace_path, workspace_key, version
       ) VALUES (?, 'Decision race project', ?, 'D:\\workspace', 'd:/workspace', 1)`,
    )
    .run(PROJECT_ID, NOW);
  database.exec(`
    INSERT INTO providers (
      id, name, base_url, default_model, api_key_cipher, api_key_iv,
      api_key_tag, credential_version, credential_generation, key_id,
      api_key_mask, verified_at, version, created_at, updated_at
    ) VALUES (
      'provider-owner-decisions', 'Local', 'http://127.0.0.1:4000/v1', 'model',
      'cipher', 'iv', 'tag', 1, 1, 'key', '***', '${NOW}', 1, '${NOW}', '${NOW}'
    );
    INSERT INTO agents (
      id, name, role, system_prompt, provider_id, model, avatar_text,
      accent_token, can_read, can_write, can_execute, max_tokens,
      max_handoffs, version, created_at, updated_at
    ) VALUES
      (
        '${REQUESTER_ID}', 'Requester', 'Planner', 'private-requester',
        'provider-owner-decisions', 'model', 'R', 'sage',
        1, 1, 0, 10000, 10, 1, '${NOW}', '${NOW}'
      ),
      (
        '${REVIEWER_ID}', 'Reviewer', 'Reviewer', 'private-reviewer',
        'provider-owner-decisions', 'model', 'V', 'gold',
        1, 1, 0, 10000, 10, 1, '${NOW}', '${NOW}'
      );
    INSERT INTO project_memberships (project_id, agent_id, joined_at) VALUES
      ('${PROJECT_ID}', '${REQUESTER_ID}', 'a'),
      ('${PROJECT_ID}', '${REVIEWER_ID}', 'b');
  `);
  database.close();
  threadId = createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [REQUESTER_ID, REVIEWER_ID],
    operationId: operationId(),
    title: "Decision race thread",
  }).body.thread.id;
  const runDatabase = openDatabase(databasePath);
  runDatabase.exec("BEGIN IMMEDIATE");
  try {
    const thread = runDatabase.prepare(
      `SELECT next_fact_sequence AS sequence FROM collaboration_threads
       WHERE project_id=? AND id=?`,
    ).get(PROJECT_ID, threadId) as { sequence: number };
    const activity = runDatabase.prepare(
      `SELECT next_activity_sequence AS sequence
       FROM collaboration_project_thread_sequences WHERE project_id=?`,
    ).get(PROJECT_ID) as { sequence: number };
    runDatabase.prepare(
      `INSERT INTO collaboration_runs(
         id,project_id,thread_id,status,current_agent_id,round_count,
         next_event_sequence,version,execution_epoch,pause_reason,pause_category,
         created_at,updated_at
       ) VALUES (?,?,?,'running',?,0,1,1,1,NULL,NULL,?,?)`,
    ).run(RUN_ID, PROJECT_ID, threadId, REQUESTER_ID, NOW, NOW);
    runDatabase.prepare(
      `INSERT INTO collaboration_thread_facts(
         id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
         run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
       ) VALUES ('fact-run-owner-races',?,?,?,?,'run_linked','system',NULL,
                 ?,NULL,NULL,NULL,json_object('runId',?),?)`,
    ).run(PROJECT_ID, threadId, thread.sequence, activity.sequence, RUN_ID, RUN_ID, NOW);
    runDatabase.prepare(
      `UPDATE collaboration_threads
       SET next_fact_sequence=next_fact_sequence+1,last_activity_sequence=?
       WHERE project_id=? AND id=?`,
    ).run(activity.sequence, PROJECT_ID, threadId);
    runDatabase.prepare(
      `UPDATE collaboration_project_thread_sequences
       SET next_activity_sequence=next_activity_sequence+1 WHERE project_id=?`,
    ).run(PROJECT_ID);
    runDatabase.exec("COMMIT");
  } catch (error) {
    if (runDatabase.isTransaction) runDatabase.exec("ROLLBACK");
    throw error;
  } finally {
    runDatabase.close();
  }
  createMission(databasePath, PROJECT_ID, {
    expectedVersion: 0,
    goal: "Keep owner decision races durable and explicit",
    operationId: "16000000-0000-4000-8000-000000000122",
    title: "Decision race mission",
  });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { force: true, recursive: true });
});

describe("calling owner messages and decision requests", () => {
  it("keeps ordinary and mentioned post-acquire messages queued without answering or changing requester", () => {
    const included = ownerMessage("Context included before acquire");
    const acquired = acquire();
    const ordinary = ownerMessage("This is not the decision answer");
    const mentioned = ownerMessage("Reviewer should see this later", REVIEWER_ID);
    const last = ownerMessage("One more queued note");

    const response = finalize(acquired, decision());

    expect(response).toMatchObject({
      body: {
        attemptStatus: "committed",
        run: {
          currentAgentId: REQUESTER_ID,
          status: "waiting_owner",
        },
      },
      status: 200,
    });
    const state = persistedState();
    expect(state.decisionRows).toEqual([
      expect.objectContaining({
        answer: null,
        requestingAgentId: REQUESTER_ID,
        status: "open",
      }),
    ]);
    expect(state.ownerMessages.map(({ sequence }) => sequence)).toEqual([
      included.sequence,
      ordinary.sequence,
      mentioned.sequence,
      last.sequence,
    ]);
    expect(state.ownerMessages[0].consumedAt).toBe(NOW);
    expect(state.ownerMessages.slice(1).every(({ consumedAt }) => consumedAt === null)).toBe(
      true,
    );
  });

  it("preserves queued message and mention sequence across reopen for the next prompt after an explicit answer", () => {
    const acquired = acquire();
    const first = ownerMessage("First pending note", REVIEWER_ID);
    const second = ownerMessage("Second pending note");
    const third = ownerMessage("Third pending note", REQUESTER_ID);
    expect(finalize(acquired, decision()).status).toBe(200);

    const openDecision = persistedState().decisionRows[0];
    answerThreadDecision(databasePath, PROJECT_ID, threadId, RUN_ID, openDecision.id, {
      answer: "Explicit owner answer",
      expectedVersion: 1,
      operationId: operationId(),
    });

    const next = acquire();
    const queuedInPrompt = next.prompt.publicMessages.filter(
      ({ authorType, content }) =>
        authorType === "owner" &&
        ["First pending note", "Second pending note", "Third pending note"].includes(content),
    );
    expect(queuedInPrompt.map(({ sequence }) => sequence)).toEqual([
      first.sequence,
      second.sequence,
      third.sequence,
    ]);
    expect(queuedInPrompt.map(({ mentionAgentId }) => mentionAgentId)).toEqual([
      REVIEWER_ID,
      null,
      REQUESTER_ID,
    ]);
    expect(
      next.prompt.publicMessages.find(({ content }) => content === "Explicit owner answer")
        ?.sequence,
    ).toBeGreaterThan(third.sequence);
  });

  it("consumes no included or post-acquire owner messages when a decision commit fails, then replays them after retry", () => {
    const included = ownerMessage("Included before invalid decision");
    const acquired = acquire();
    const pending = ownerMessage("Pending after invalid decision", REVIEWER_ID);

    expect(finalize(acquired, decision(["Duplicate", "Duplicate"]))).toMatchObject({
      body: { error: { code: "ACTION_INVALID" } },
      status: 400,
    });
    expect(
      persistedState().ownerMessages.every(({ consumedAt }) => consumedAt === null),
    ).toBe(true);

    const failedRun = persistedState().run;
    controlThreadRun(databasePath, PROJECT_ID, threadId, RUN_ID, {
      action: "retry",
      expectedVersion: failedRun.version,
      operationId: operationId(),
    });
    const recovered = acquire();
    expect(
      recovered.prompt.publicMessages
        .filter(({ authorType }) => authorType === "owner")
        .map(({ sequence }) => sequence),
    ).toEqual([included.sequence, pending.sequence]);
  });

  it("consumes none on a discarded decision result and retains stable pending order after continue", () => {
    const included = ownerMessage("Included before discard");
    const acquired = acquire();
    const pending = ownerMessage("Pending during discarded call", REVIEWER_ID);
    const runningVersion = persistedState().run.version;
    controlThreadRun(databasePath, PROJECT_ID, threadId, RUN_ID, {
      action: "pause",
      expectedVersion: runningVersion,
      operationId: operationId(),
    });

    expect(finalize(acquired, decision())).toMatchObject({
      body: { attemptStatus: "discarded", run: { status: "paused" } },
      status: 200,
    });
    expect(persistedState().decisionRows).toEqual([]);
    expect(
      persistedState().ownerMessages.every(({ consumedAt }) => consumedAt === null),
    ).toBe(true);

    const pausedRun = persistedState().run;
    controlThreadRun(databasePath, PROJECT_ID, threadId, RUN_ID, {
      action: "continue",
      expectedVersion: pausedRun.version,
      operationId: operationId(),
    });
    const recovered = acquire();
    expect(
      recovered.prompt.publicMessages
        .filter(({ authorType }) => authorType === "owner")
        .map(({ sequence }) => sequence),
    ).toEqual([included.sequence, pending.sequence]);
  });
});
