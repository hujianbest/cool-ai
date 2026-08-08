import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentTurn } from "@/src/server/collaboration/agent-turn-schema";
import { CollaborationError } from "@/src/server/collaboration/collaboration-errors";
import * as runService from "@/src/server/collaboration/run-service";
import {
  createThread,
  writeOwnerThreadMessage,
} from "@/src/server/collaboration/thread-service";
import type { StructuredTurnResult } from "@/src/server/collaboration/structured-repair";
import {
  acquireAdvance,
  finalizeAdvance,
} from "@/src/server/collaboration/turn-orchestrator";
import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import { createMission } from "@/src/server/mission-service";

const PROJECT_ID = "project-decisions";
const RUN_ID = "run-decisions";
const REQUESTER_ID = "agent-requester";
const REVIEWER_ID = "agent-reviewer";
const NOW = "2026-07-30T06:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 57).toString("base64url");
let threadId: string;

type AnswerInput = {
  answer: string;
  expectedVersion: number;
  mentionAgentId?: string;
  operationId: string;
};
type AnswerResult = {
  body: {
    decision: {
      answer: string;
      answerMessageId: string;
      id: string;
      status: string;
      version: number;
    };
    run: {
      currentAgentId: string;
      status: string;
      version: number;
    };
  };
  status: number;
};
type AnswerDecision = (
  databasePath: string,
  projectId: string,
  threadId: string,
  runId: string,
  decisionId: string,
  input: AnswerInput,
) => AnswerResult;
type DecisionRoute = {
  POST(
    request: Request,
    context: {
      params: Promise<{
        decisionId: string;
        projectId: string;
        runId: string;
        threadId: string;
      }>;
    },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<DecisionRoute>(
  "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/decisions/[decisionId]/answer/route.ts",
);

let databasePath: string;
let directory: string;
let operationSequence: number;
let uuidSequence: number;

function operationId(): string {
  operationSequence += 1;
  return `16000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function dependencies() {
  return {
    clock: () => new Date(NOW),
    randomUUID: () => {
      uuidSequence += 1;
      return `16100000-0000-4000-8000-${uuidSequence.toString().padStart(12, "0")}`;
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

function requestDecision(): string {
  const acquired = acquireAdvance(
    databasePath,
    { projectId: PROJECT_ID, runId: RUN_ID, threadId },
    { operationId: operationId() },
    dependencies(),
  );
  expect(acquired.kind).toBe("acquired");
  if (acquired.kind !== "acquired") throw new Error("Expected acquired decision turn.");
  const finalized = finalizeAdvance(
    databasePath,
    { projectId: PROJECT_ID, runId: RUN_ID, threadId },
    {
      attemptId: acquired.attempt.id,
      leaseToken: acquired.attempt.leaseToken,
      result: result({
        claim: null,
        disposition: {
          options: ["Ship now", "Run another review"],
          question: "How should the team proceed?",
          type: "decision_request",
        },
        message: "The team needs the owner's choice.",
        tasks: [],
      }),
    },
    dependencies(),
  );
  expect(finalized).toMatchObject({
    body: {
      attemptStatus: "committed",
      run: { status: "waiting_owner", version: 2 },
    },
    status: 200,
  });
  const database = openDatabase(databasePath);
  try {
    return (
      database
        .prepare("SELECT id FROM decision_requests WHERE run_id = ? AND status = 'open'")
        .get(RUN_ID) as { id: string }
    ).id;
  } finally {
    database.close();
  }
}

function answerDecision(decisionId: string, input: AnswerInput): AnswerResult {
  const implementation = (
    runService as unknown as { answerThreadDecision?: AnswerDecision }
  ).answerThreadDecision;
  expect(implementation, "T-16 answerDecision service must exist").toBeTypeOf("function");
  return implementation!(databasePath, PROJECT_ID, threadId, RUN_ID, decisionId, input);
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

function snapshot() {
  const database = openDatabase(databasePath);
  try {
    const run = database
      .prepare(
        `SELECT status, current_agent_id AS currentAgentId, round_count AS roundCount,
                version, next_event_sequence AS nextEventSequence
         FROM collaboration_runs WHERE id = ?`,
      )
      .get(RUN_ID);
    const decision = database
      .prepare(
        `SELECT id, status, answer, answer_message_id AS answerMessageId, version,
                requesting_agent_id AS requestingAgentId
         FROM decision_requests WHERE run_id = ? ORDER BY created_at, id LIMIT 1`,
      )
      .get(RUN_ID);
    const messages = database
      .prepare(
        `SELECT id, sequence, author_type AS authorType,
                author_display_name AS authorDisplayName, content,
                mention_agent_id AS mentionAgentId,
                mention_display_name AS mentionDisplayName
         FROM collaboration_messages
         WHERE project_id=? AND thread_id=? ORDER BY sequence`,
      )
      .all(PROJECT_ID, threadId);
    const events = (
      database
        .prepare(
          `SELECT sequence, type, actor_type AS actorType, payload_json AS payload
           FROM collaboration_events WHERE run_id = ? ORDER BY sequence`,
        )
        .all(RUN_ID) as Array<{
        actorType: string;
        payload: string;
        sequence: number;
        type: string;
      }>
    ).map((event) => ({ ...event, payload: JSON.parse(event.payload) }));
    const facts = database
      .prepare(
        `SELECT type,message_id AS messageId
         FROM collaboration_thread_facts
         WHERE project_id=? AND thread_id=? ORDER BY sequence`,
      )
      .all(PROJECT_ID, threadId);
    return { decision, events, facts, messages, run };
  } finally {
    database.close();
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-decisions-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  operationSequence = 0;
  uuidSequence = 0;
  const credential = createCredentialVault().encrypt(
    "provider-decisions",
    "decision-fixture-provider-key",
  );
  const database = openDatabase(databasePath);
  database.exec(`
    INSERT INTO projects (
      id, name, created_at, workspace_path, workspace_key, version
    ) VALUES (
      '${PROJECT_ID}', 'Decision project', '${NOW}', 'D:\\workspace', 'd:/workspace', 1
    );
  `);
  database.prepare(`
    INSERT INTO providers (
      id, name, base_url, default_model, api_key_cipher, api_key_iv,
      api_key_tag, credential_version, credential_generation, key_id,
      api_key_mask, verified_at, version, created_at, updated_at
    ) VALUES (
      'provider-decisions', 'Local', 'http://127.0.0.1:4000/v1', 'model',
      ?, ?, ?, 1, 1, ?, ?, ?, 1, ?, ?
    );
  `).run(
    credential.apiKeyCipher,
    credential.apiKeyIv,
    credential.apiKeyTag,
    credential.keyId,
    credential.apiKeyMask,
    NOW,
    NOW,
    NOW,
  );
  database.exec(`
    INSERT INTO agents (
      id, name, role, system_prompt, provider_id, model, avatar_text,
      accent_token, can_read, can_write, can_execute, max_tokens,
      max_handoffs, version, created_at, updated_at
    ) VALUES
      (
        '${REQUESTER_ID}', 'Requester', 'Planner', 'private', 'provider-decisions',
        'model', 'R', 'sage', 1, 1, 0, 1000, 5, 1, '${NOW}', '${NOW}'
      ),
      (
        '${REVIEWER_ID}', 'Reviewer', 'Reviewer', 'private', 'provider-decisions',
        'model', 'V', 'gold', 1, 1, 0, 1000, 5, 1, '${NOW}', '${NOW}'
      );
    INSERT INTO project_memberships (project_id, agent_id, joined_at) VALUES
      ('${PROJECT_ID}', '${REQUESTER_ID}', 'a'),
      ('${PROJECT_ID}', '${REVIEWER_ID}', 'b');
  `);
  database.close();
  threadId = createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [REQUESTER_ID, REVIEWER_ID],
    operationId: operationId(),
    title: "Decision thread",
  }).body.thread.id;
  const runDatabase = openDatabase(databasePath);
  runDatabase.exec("BEGIN IMMEDIATE");
  try {
    const thread = runDatabase.prepare(
      `SELECT next_fact_sequence AS sequence
       FROM collaboration_threads WHERE project_id=? AND id=?`,
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
       ) VALUES ('fact-run-decisions',?,?,?,?,'run_linked','system',NULL,
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
    goal: "Resolve a collaboration decision",
    title: "Decision mission",
  });
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("decision request commit", () => {
  it("atomically writes the Agent message, turn, sole open decision and events while waiting", () => {
    const decisionId = requestDecision();
    const state = snapshot();

    expect(state.run).toEqual({
      currentAgentId: REQUESTER_ID,
      nextEventSequence: 6,
      roundCount: 1,
      status: "waiting_owner",
      version: 2,
    });
    expect(state.decision).toMatchObject({
      answer: null,
      answerMessageId: null,
      id: decisionId,
      requestingAgentId: REQUESTER_ID,
      status: "open",
      version: 1,
    });
    expect(state.messages).toEqual([
      expect.objectContaining({
        authorDisplayName: "Requester",
        authorType: "agent",
        content: "The team needs the owner's choice.",
        sequence: 1,
      }),
    ]);
    expect(
      state.events.filter(({ type }) =>
        ["agent_message", "decision_requested"].includes(type),
      ),
    ).toEqual([
      expect.objectContaining({
        actorType: "agent",
        sequence: 4,
        type: "agent_message",
      }),
      expect.objectContaining({
        actorType: "agent",
        payload: {
          agentId: REQUESTER_ID,
          decisionId,
          options: ["Ship now", "Run another review"],
          question: "How should the team proceed?",
          turnId: expect.any(String),
        },
        sequence: 5,
        type: "decision_requested",
      }),
    ]);

    const database = openDatabase(databasePath);
    try {
      expect(() =>
        database
          .prepare(
            `INSERT INTO decision_requests (
               id, run_id, turn_id, requesting_agent_id, question, options_json,
               status, answer, answer_message_id, version, created_at, answered_at
             ) VALUES (
               'other-decision', ?, 'other-turn', ?, 'Other?', '["Yes","No"]',
               'open', NULL, NULL, 1, ?, NULL
             )`,
          )
          .run(RUN_ID, REQUESTER_ID, NOW),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("keeps ordinary waiting chat queued and does not treat it as an answer", () => {
    const decisionId = requestDecision();
    const chat = writeOwnerThreadMessage(databasePath, PROJECT_ID, threadId, {
      content: "This is context, not my answer.",
      operationId: operationId(),
    });

    expect(snapshot().run).toMatchObject({ status: "waiting_owner", version: 2 });
    const state = snapshot();
    expect(state.decision).toMatchObject({
      answer: null,
      id: decisionId,
      status: "open",
      version: 1,
    });
    expect(state.messages.at(-1)).toMatchObject({
      authorType: "owner",
      content: "This is context, not my answer.",
    });
    expect(state.facts.at(-1)).toMatchObject({ type: "owner_message" });
  });
});

describe("owner decision answer", () => {
  it("atomically saves an owner message snapshot, answers/version-bumps, emits an event and resumes requester", () => {
    const decisionId = requestDecision();
    const response = answerDecision(decisionId, {
      answer: "Ship now",
      expectedVersion: 1,
      operationId: operationId(),
    });

    expect(response).toMatchObject({
      body: {
        decision: {
          answer: "Ship now",
          answerMessageId: expect.any(String),
          id: decisionId,
          status: "answered",
          version: 2,
        },
        run: {
          currentAgentId: REQUESTER_ID,
          status: "running",
          version: 3,
        },
      },
      status: 200,
    });
    const state = snapshot();
    expect(state.messages.at(-1)).toMatchObject({
      authorDisplayName: "Owner",
      authorType: "owner",
      content: "Ship now",
      mentionAgentId: null,
      mentionDisplayName: null,
      sequence: 2,
    });
    expect(state.events.at(-1)).toEqual({
      actorType: "owner",
      payload: {
        answer: "Ship now",
        decisionId,
        messageId: response.body.decision.answerMessageId,
        messageSequence: 2,
        nextAgentId: REQUESTER_ID,
      },
      sequence: (state.run as { nextEventSequence: number }).nextEventSequence - 1,
      type: "decision_answered",
    });
  });

  it("uses an optional current member mention as the next Agent and snapshots its name", () => {
    const decisionId = requestDecision();
    answerDecision(decisionId, {
      answer: "Ask the reviewer to continue.",
      expectedVersion: 1,
      mentionAgentId: REVIEWER_ID,
      operationId: operationId(),
    });

    const state = snapshot();
    expect(state.run).toMatchObject({
      currentAgentId: REVIEWER_ID,
      status: "running",
      version: 3,
    });
    expect(state.messages.at(-1)).toMatchObject({
      mentionAgentId: REVIEWER_ID,
      mentionDisplayName: "Reviewer",
    });
    expect(state.events.at(-1)).toMatchObject({
      payload: { nextAgentId: REVIEWER_ID },
      type: "decision_answered",
    });
  });

  it("requires waiting/open/exact version, a 1..5000 answer, and a current member mention", () => {
    const decisionId = requestDecision();
    for (const answer of ["", "答".repeat(5_001)]) {
      expectCode(
        () =>
          answerDecision(decisionId, {
            answer,
            expectedVersion: 1,
            operationId: operationId(),
          }),
        "INVALID_INPUT",
      );
    }
    expectCode(
      () =>
        answerDecision(decisionId, {
          answer: "Answer",
          expectedVersion: 2,
          operationId: operationId(),
        }),
      "RUN_STATE_CONFLICT",
      1,
    );
    expectCode(
      () =>
        answerDecision(decisionId, {
          answer: "Answer",
          expectedVersion: 1,
          mentionAgentId: "not-a-member",
          operationId: operationId(),
        }),
      "AGENT_NOT_MEMBER",
    );

    const database = openDatabase(databasePath);
    database.prepare("UPDATE collaboration_runs SET status = 'paused' WHERE id = ?").run(RUN_ID);
    database.close();
    expectCode(
      () =>
        answerDecision(decisionId, {
          answer: "Answer",
          expectedVersion: 1,
          operationId: operationId(),
        }),
      "RUN_STATE_CONFLICT",
    );
  });

  it("accepts an answer at the 5000-grapheme boundary", () => {
    const decisionId = requestDecision();

    const result = answerDecision(decisionId, {
      answer: "答".repeat(5_000),
      expectedVersion: 1,
      operationId: operationId(),
    });

    expect(result.body.decision.answer).toHaveLength(5_000);
  });

  it("exactly replays across reopen, rejects operation conflicts and rejects an answered decision", async () => {
    const decisionId = requestDecision();
    const input = {
      answer: "Ship now",
      expectedVersion: 1,
      operationId: operationId(),
    };
    const first = answerDecision(decisionId, input);
    expect(answerDecision(decisionId, input)).toEqual(first);
    expectCode(
      () => answerDecision(decisionId, { ...input, answer: "Different answer" }),
      "OPERATION_CONFLICT",
    );
    expectCode(
      () =>
        answerDecision(decisionId, {
          answer: "Another answer",
          expectedVersion: 2,
          operationId: operationId(),
        }),
      "DECISION_ALREADY_ANSWERED",
      2,
    );
    expect(snapshot().messages).toHaveLength(2);

    const load = routeModules[
      "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/decisions/[decisionId]/answer/route.ts"
    ];
    expect(load, "T-16 decision answer route must exist").toBeTypeOf("function");
    const route = await load!();
    const response = await route.POST(
      new Request(
        `http://localhost/api/projects/${PROJECT_ID}/threads/${threadId}/runs/${RUN_ID}/decisions/${decisionId}/answer`,
        {
          body: JSON.stringify(input),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
      {
        params: Promise.resolve({
          decisionId,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          threadId,
        }),
      },
    );
    expect({ body: await response.json(), status: response.status }).toEqual(first);
    expect(snapshot().messages).toHaveLength(2);
  });
});
