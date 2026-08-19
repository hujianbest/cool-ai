import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  answerThreadDecision,
  controlThreadRun,
} from "@/src/adapters/outbound/sqlite/public-collaboration/run-service";
import {
  createThread,
  startThreadRun,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import {
  acquireAdvance,
  finalizeAdvance,
} from "@/src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator";
import { executeAdvance } from "@/src/adapters/outbound/sqlite/public-collaboration/advance-executor";
import type { StructuredTurnResult } from "@/src/modules/public-collaboration";
import { seedCurrentAdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { updateMission } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { seedMissionInitialization } from "@/tests/fixtures/review/mission-initialization";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-10T03:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 13).toString("base64url");
const PROJECT_ID = "coll-audit-project";
const AGENT_A = "coll-audit-agent-a";
const AGENT_B = "coll-audit-agent-b";

let operationSequence = 0;

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

let databasePath: string;
let database: DatabaseSync;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  databasePath = memoryDatabasePath();
  database = openDatabase(databasePath);
});

afterEach(() => {
  try {
    database.close();
  } catch {
    // The connection may already be closed by reopen exercises.
  }
  delete process.env.COCKPIT_MASTER_KEY;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function seedProjectOnly(): void {
  database.prepare(
    "INSERT INTO projects(id,name,created_at,version) VALUES (?,?,?,1)",
  ).run(PROJECT_ID, "CollAudit", NOW);
}

function seedCollaborationGraph(): void {
  database.prepare(
    `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
     VALUES (?,?,?,'D:\\workspace',?,1)`,
  ).run(PROJECT_ID, "CollAudit", NOW, `d:/workspace/${PROJECT_ID}`);
  const encrypted = createCredentialVault().encrypt("coll-audit-provider", "provider-key");
  database.prepare(
    `INSERT INTO providers(
       id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
       credential_version,credential_generation,key_id,api_key_mask,verified_at,
       version,created_at,updated_at
     ) VALUES ('coll-audit-provider','Provider','http://localhost/v1','model',
       ?,?,?,1,1,?,'***',?,1,?,?)`,
  ).run(
    encrypted.apiKeyCipher,
    encrypted.apiKeyIv,
    encrypted.apiKeyTag,
    encrypted.keyId,
    NOW,
    NOW,
    NOW,
  );
  const insertAgent = database.prepare(
    `INSERT INTO agents(
       id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
       can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
       updated_at,review_capable
     ) VALUES (?,?,'Peer','Prompt','coll-audit-provider','model','A','sage',
       1,1,0,1000,3,1,?,?,0)`,
  );
  insertAgent.run(AGENT_A, "Agent A", NOW, NOW);
  insertAgent.run(AGENT_B, "Agent B", NOW, NOW);
  const insertMember = database.prepare(
    "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
  );
  insertMember.run(PROJECT_ID, AGENT_A, NOW);
  insertMember.run(PROJECT_ID, AGENT_B, NOW);
  database.prepare(
    `INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
     VALUES ('coll-audit-mission',?,'Mission','Goal',1,?,?)`,
  ).run(PROJECT_ID, NOW, NOW);
  seedMissionInitialization(database, {
    missionId: "coll-audit-mission",
    occurredAt: NOW,
    projectId: PROJECT_ID,
  });
}

function seedThread(): string {
  return createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [AGENT_A, AGENT_B],
    operationId: operationId(),
    title: "Audit thread",
  }).body.thread.id;
}

type OutboxRow = {
  eventType: string;
  id: string;
  occurredAt: string;
  payloadJson: string;
  projectId: string;
  seq: number;
  source: string;
};

// This suite's subject is the collaboration writer seam; since feature 035 the
// shared outbox also carries mission_work rows (written earlier in the same
// turn-finalize transaction), so the reader scopes to this source.
function outboxRows(path: string = databasePath): OutboxRow[] {
  const reader = openDatabase(path);
  try {
    return reader.prepare(`
      SELECT id,project_id AS projectId,source,event_type AS eventType,
             payload_json AS payloadJson,occurred_at AS occurredAt,outbox_seq AS seq
      FROM audit_event_outbox WHERE source='public_collaboration' ORDER BY outbox_seq
    `).all() as OutboxRow[];
  } finally {
    reader.close();
  }
}

function runtimeOutboxRows(): OutboxRow[] {
  return database.prepare(`
    SELECT id,project_id AS projectId,source,event_type AS eventType,
           payload_json AS payloadJson,occurred_at AS occurredAt,outbox_seq AS seq
    FROM audit_event_outbox WHERE source='runtime' ORDER BY outbox_seq
  `).all() as OutboxRow[];
}

describe("collaboration audit outbox schema", () => {
  it("bootstraps identity 17 and accepts the public_collaboration outbox source", () => {
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
    seedProjectOnly();
    database.prepare(`
      INSERT INTO audit_event_outbox (
        id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
      ) VALUES ('coll-event-1',?,'public_collaboration','run_started','{}',?,1)
    `).run(PROJECT_ID, NOW);
    expect(database.prepare(
      "SELECT source FROM audit_event_outbox WHERE id='coll-event-1'",
    ).get()).toEqual({ source: "public_collaboration" });
    expect(() => database.prepare(`
      INSERT INTO audit_event_outbox (
        id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
      ) VALUES ('coll-event-2',?,'collaboration','run_started','{}',?,2)
    `).run(PROJECT_ID, NOW)).toThrow();
  });
});

describe("collaboration audit outbox write seam", () => {
  it("mirrors run_started into the outbox in the same transaction as the thread run start", () => {
    seedCollaborationGraph();
    const threadId = seedThread();
    const started = startThreadRun(databasePath, PROJECT_ID, threadId, {
      message: "Start the audit run",
      operationId: operationId(),
    });
    const runId = started.body.run.id;

    const events = database.prepare(`
      SELECT id,type,actor_type AS actorType,actor_id AS actorId,payload_json AS payloadJson
      FROM collaboration_events ORDER BY sequence
    `).all() as Array<{
      actorId: string | null;
      actorType: string;
      id: string;
      payloadJson: string;
      type: string;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: "owner", type: "run_started" });

    const rows = outboxRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      eventType: "run_started",
      id: events[0]!.id,
      occurredAt: NOW,
      projectId: PROJECT_ID,
      seq: 1,
      source: "public_collaboration",
    });
    const sourcePayload = JSON.parse(events[0]!.payloadJson) as Record<string, unknown>;
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      currentAgentId: sourcePayload.currentAgentId,
      messageId: sourcePayload.messageId,
      messageSequence: sourcePayload.messageSequence,
      occurredAt: NOW,
      runId,
      threadId,
      type: "run_started",
    });
    expect(JSON.parse(rows[1]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      messageExcerpt: "Start the audit run",
      messageId: sourcePayload.messageId,
      occurredAt: NOW,
      runId,
      threadId,
      type: "owner_message",
    });
  });

  it("mirrors run_stopped into the outbox with a monotonic sequence when the owner stops the run", () => {
    seedCollaborationGraph();
    const threadId = seedThread();
    const started = startThreadRun(databasePath, PROJECT_ID, threadId, {
      message: "Start then stop",
      operationId: operationId(),
    });
    const runId = started.body.run.id;

    controlThreadRun(databasePath, PROJECT_ID, threadId, runId, {
      action: "stop",
      expectedVersion: started.body.run.version,
      operationId: operationId(),
    });

    const stoppedEvent = database.prepare(`
      SELECT id,type FROM collaboration_events WHERE type='run_stopped'
    `).get() as { id: string; type: string };
    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "run_started",
      "owner_message",
      "run_stopped",
    ]);
    expect(rows[2]).toMatchObject({
      eventType: "run_stopped",
      id: stoppedEvent.id,
      projectId: PROJECT_ID,
      seq: 3,
      source: "public_collaboration",
    });
    expect(JSON.parse(rows[2]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      occurredAt: NOW,
      runId,
      threadId,
      type: "run_stopped",
    });
  });

  it("mirrors run_paused and run_resumed owner controls into the outbox", () => {
    seedCollaborationGraph();
    const threadId = seedThread();
    const started = startThreadRun(databasePath, PROJECT_ID, threadId, {
      message: "Pause then resume",
      operationId: operationId(),
    });
    const runId = started.body.run.id;

    const paused = controlThreadRun(databasePath, PROJECT_ID, threadId, runId, {
      action: "pause",
      expectedVersion: started.body.run.version,
      operationId: operationId(),
    });
    expect(paused.status).toBe(200);
    const resumed = controlThreadRun(databasePath, PROJECT_ID, threadId, runId, {
      action: "continue",
      expectedVersion: paused.body.run.version,
      operationId: operationId(),
    });
    expect(resumed.status).toBe(200);

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "run_started",
      "owner_message",
      "run_paused",
      "run_resumed",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(JSON.parse(rows[2]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      category: "manual",
      occurredAt: NOW,
      runId,
      threadId,
      type: "run_paused",
    });
    expect(JSON.parse(rows[3]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      currentAgentId: started.body.run.currentAgentId,
      occurredAt: NOW,
      runId,
      threadId,
      type: "run_resumed",
    });
  });

  it("keeps collaboration outbox rows intact across an idempotent reopen", () => {
    seedCollaborationGraph();
    const threadId = seedThread();
    startThreadRun(databasePath, PROJECT_ID, threadId, {
      message: "Reopen keeps the audit trail",
      operationId: operationId(),
    });
    const before = outboxRows();
    expect(before).toHaveLength(2);

    database.close();
    database = openDatabase(databasePath);

    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
    expect(outboxRows()).toEqual(before);
  });

  it("mirrors owner thread messages into the outbox with a public excerpt and null runId", () => {
    seedCollaborationGraph();
    const threadId = seedThread();
    const written = writeOwnerThreadMessage(databasePath, PROJECT_ID, threadId, {
      content: "Owner audit question for the thread",
      operationId: operationId(),
    });
    expect(written.status).toBe(201);

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "owner_message",
      id: written.body.fact.id,
      occurredAt: NOW,
      projectId: PROJECT_ID,
      seq: 1,
      source: "public_collaboration",
    });
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      messageExcerpt: "Owner audit question for the thread",
      messageId: written.body.message.id,
      occurredAt: NOW,
      runId: null,
      threadId,
      type: "owner_message",
    });
  });
});

const ADVANCE_PROJECT = "coll-audit-advance-project";
const ADVANCE_RUN = "coll-audit-advance-run";
const ADVANCE_MISSION = "coll-audit-advance-mission";
const ADVANCE_PROVIDER = "coll-audit-advance-provider";

let advanceUuidSequence = 0;

function advanceDependencies(): { clock: () => Date; randomUUID: () => string } {
  return {
    clock: () => new Date(NOW),
    randomUUID: () => {
      advanceUuidSequence += 1;
      return `33000000-0000-4000-8000-${advanceUuidSequence.toString().padStart(12, "0")}`;
    },
  };
}

function seedAdvanceThread(): string {
  advanceUuidSequence = 0;
  const threadId = seedCurrentAdvanceFixture(databasePath, {
    agentId: AGENT_A,
    agentPrompt: "private-prompt-a",
    missionId: ADVANCE_MISSION,
    now: NOW,
    ownerMessage: null,
    projectId: ADVANCE_PROJECT,
    projectName: "CollAuditAdvance",
    providerId: ADVANCE_PROVIDER,
    runId: ADVANCE_RUN,
    secondAgentId: AGENT_B,
    secondAgentPrompt: "private-prompt-b",
    threadCreateOperationId: operationId(),
  });
  // The shared fixture stores an undecryptable provider credential; replace it
  // with a real envelope so the public-text classifier can verify excerpts.
  const encrypted = createCredentialVault().encrypt(ADVANCE_PROVIDER, "advance-provider-key");
  database.prepare(
    `UPDATE providers
     SET api_key_cipher=?,api_key_iv=?,api_key_tag=?,key_id=?,api_key_mask=?
     WHERE id=?`,
  ).run(
    encrypted.apiKeyCipher,
    encrypted.apiKeyIv,
    encrypted.apiKeyTag,
    encrypted.keyId,
    encrypted.apiKeyMask,
    ADVANCE_PROVIDER,
  );
  return threadId;
}

function succeededTurn(
  turn: NonNullable<StructuredTurnResult["turn"]>,
): StructuredTurnResult {
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

function handoffTurn(): NonNullable<StructuredTurnResult["turn"]> {
  return {
    claim: null,
    disposition: {
      reason: "Beta owns the next step",
      summary: "Handing off after the audit start",
      targetAgentId: AGENT_B,
      type: "handoff",
    },
    message: "Audit start committed",
    tasks: [],
  };
}

describe("collaboration audit outbox event selection", () => {
  function driveTurn(turn: NonNullable<StructuredTurnResult["turn"]>): void {
    const thread = database
      .prepare("SELECT id FROM collaboration_threads WHERE project_id=?")
      .get(ADVANCE_PROJECT) as { id: string };
    const tuple = { projectId: ADVANCE_PROJECT, runId: ADVANCE_RUN, threadId: thread.id };
    const acquired = acquireAdvance(
      databasePath,
      tuple,
      { operationId: operationId() },
      advanceDependencies(),
    );
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    const response = finalizeAdvance(
      databasePath,
      tuple,
      {
        attemptId: acquired.attempt.id,
        leaseToken: acquired.attempt.leaseToken,
        result: succeededTurn(turn),
      },
      advanceDependencies(),
    );
    expect(response.status).toBe(200);
  }

  it("audits the model frozen into the HTTP request even if the Agent changes", async () => {
    const threadId = seedAdvanceThread();
    let requestedModel = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requestedModel = (JSON.parse(String(init.body)) as { model: string }).model;
      database.prepare("UPDATE agents SET model='changed-after-request' WHERE id=?").run(AGENT_A);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(handoffTurn()) } }],
        usage: { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 },
      }), { headers: { "content-type": "application/json" }, status: 200 });
    }));

    const response = await executeAdvance(
      databasePath,
      { projectId: ADVANCE_PROJECT, runId: ADVANCE_RUN, threadId },
      { operationId: operationId() },
    );

    expect(response.status).toBe(200);
    expect(requestedModel).toBe("model");
    const runtimePayload = JSON.parse(runtimeOutboxRows()[0]!.payloadJson) as {
      model: string;
    };
    expect(runtimePayload.model).toBe(requestedModel);
  });

  it("audits successful HTTP calls as succeeded when structured validation fails", async () => {
    const threadId = seedAdvanceThread();
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"unexpected":true}' } }],
      usage: { completion_tokens: 3, prompt_tokens: 7, total_tokens: 10 },
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await executeAdvance(
      databasePath,
      { projectId: ADVANCE_PROJECT, runId: ADVANCE_RUN, threadId },
      { operationId: operationId() },
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(runtimeOutboxRows().map((row) => row.eventType)).toEqual([
      "runtime_call_succeeded",
      "runtime_call_succeeded",
    ]);
    expect(database.prepare(`
      SELECT status FROM collaboration_model_calls ORDER BY call_index
    `).all()).toEqual([
      { status: "response_invalid" },
      { status: "response_invalid" },
    ]);
  });

  it("mirrors every selected turn event type with a monotonic outbox_seq", () => {
    const threadId = seedAdvanceThread();
    driveTurn({
      claim: { clientKey: "audit", source: "proposed" },
      disposition: {
        reason: "Beta continues",
        summary: "Audit context handed over",
        targetAgentId: AGENT_B,
        type: "handoff",
      },
      message: "Created the audit tasks",
      tasks: [
        { clientKey: "audit", dependsOnKeys: [], description: "", title: "Audit" },
        { clientKey: "report", dependsOnKeys: ["audit"], description: "", title: "Report" },
      ],
    });
    driveTurn({
      claim: null,
      disposition: {
        options: ["Option A", "Option B"],
        question: "Which option should the audit take?",
        type: "decision_request",
      },
      message: "Need the owner to decide",
      tasks: [],
    });
    const decision = database.prepare(
      `SELECT id,version FROM decision_requests
       WHERE project_id=? AND thread_id=? AND run_id=?`,
    ).get(ADVANCE_PROJECT, threadId, ADVANCE_RUN) as { id: string; version: number };
    const answered = answerThreadDecision(
      databasePath,
      ADVANCE_PROJECT,
      threadId,
      ADVANCE_RUN,
      decision.id,
      {
        answer: "Take option A",
        expectedVersion: decision.version,
        mentionAgentId: AGENT_A,
        operationId: operationId(),
      },
    );
    expect(answered.status).toBe(200);
    driveTurn({
      claim: null,
      disposition: { type: "plan_ready" },
      message: "Plan is ready",
      tasks: [],
    });

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "agent_message",
      "tasks_created",
      "task_claimed",
      "handoff",
      "agent_message",
      "decision_requested",
      "decision_answered",
      "owner_message",
      "agent_message",
      "run_planned",
    ]);
    // The global outbox_seq space is shared with the mission_work source since
    // feature 035, so collaboration rows keep strict monotonic order but are
    // no longer guaranteed contiguous numbering.
    const seqs = rows.map((row) => row.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(rows.map((row) => row.source))).toEqual(new Set(["public_collaboration"]));

    const tasksCreated = JSON.parse(rows[1]!.payloadJson) as Record<string, unknown>;
    expect(tasksCreated).toEqual({
      actorId: AGENT_A,
      actorType: "agent",
      occurredAt: NOW,
      runId: ADVANCE_RUN,
      taskCount: 2,
      threadId,
      turnId: expect.any(String),
      type: "tasks_created",
    });
    expect(tasksCreated).not.toHaveProperty("items");

    const taskClaimed = JSON.parse(rows[2]!.payloadJson) as Record<string, unknown>;
    expect(taskClaimed).toMatchObject({
      actorId: AGENT_A,
      agentId: AGENT_A,
      type: "task_claimed",
      workItemId: expect.any(String),
    });

    const decisionRequested = JSON.parse(rows[5]!.payloadJson) as Record<string, unknown>;
    expect(decisionRequested).toEqual({
      actorId: AGENT_B,
      actorType: "agent",
      agentId: AGENT_B,
      decisionId: decision.id,
      occurredAt: NOW,
      options: ["Option A", "Option B"],
      question: "Which option should the audit take?",
      runId: ADVANCE_RUN,
      threadId,
      turnId: expect.any(String),
      type: "decision_requested",
    });

    const decisionAnswered = JSON.parse(rows[6]!.payloadJson) as Record<string, unknown>;
    expect(decisionAnswered).toMatchObject({
      actorId: null,
      actorType: "owner",
      answer: "Take option A",
      decisionId: decision.id,
      nextAgentId: AGENT_A,
      type: "decision_answered",
    });

    expect(JSON.parse(rows[7]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      messageExcerpt: "Take option A",
      messageId: decisionAnswered.messageId,
      occurredAt: NOW,
      runId: ADVANCE_RUN,
      threadId,
      type: "owner_message",
    });

    expect(JSON.parse(rows[9]!.payloadJson)).toEqual({
      actorId: AGENT_A,
      actorType: "agent",
      occurredAt: NOW,
      runId: ADVANCE_RUN,
      threadId,
      turnId: expect.any(String),
      type: "run_planned",
    });
  });

  it("truncates agent message excerpts to 200 graphemes in the outbox payload", () => {
    seedAdvanceThread();
    const longMessage = "审".repeat(250);
    driveTurn({
      claim: null,
      disposition: {
        reason: "Done",
        summary: "Handoff",
        targetAgentId: AGENT_B,
        type: "handoff",
      },
      message: longMessage,
      tasks: [],
    });

    const rows = outboxRows();
    const agentMessage = rows.find((row) => row.eventType === "agent_message");
    expect(agentMessage).toBeDefined();
    const payload = JSON.parse(agentMessage!.payloadJson) as Record<string, unknown>;
    const excerpt = payload.messageExcerpt as string;
    expect([...excerpt]).toHaveLength(201);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.startsWith("审".repeat(200))).toBe(true);
  });

  it("withholds excerpts that contain credential-like content without blocking the turn", () => {
    seedAdvanceThread();
    driveTurn({
      claim: null,
      disposition: {
        reason: "key is advance-provider-key here",
        summary: "Handoff",
        targetAgentId: AGENT_B,
        type: "handoff",
      },
      message: "The provider key advance-provider-key must never leak",
      tasks: [],
    });

    const message = database.prepare(
      "SELECT content FROM collaboration_messages WHERE run_id=?",
    ).get(ADVANCE_RUN) as { content: string };
    expect(message.content).toContain("advance-provider-key");

    const rows = outboxRows();
    const agentMessage = JSON.parse(
      rows.find((row) => row.eventType === "agent_message")!.payloadJson,
    ) as Record<string, unknown>;
    expect(agentMessage.messageExcerpt).toBe("[redacted]");
    const handoff = JSON.parse(
      rows.find((row) => row.eventType === "handoff")!.payloadJson,
    ) as Record<string, unknown>;
    expect(handoff.reason).toBe("[redacted]");
    expect(handoff.summary).toBe("Handoff");
  });

  it("rolls the outbox row back when the business transaction fails after the event insert", () => {
    seedCollaborationGraph();
    const threadId = seedThread();
    expect(() => startThreadRun(databasePath, PROJECT_ID, threadId, {
      message: "Fault after the event",
      operationId: operationId(),
    }, {
      fault: (point) => {
        if (point === "after_event") throw new Error("injected after_event fault");
      },
    })).toThrow("injected after_event fault");

    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_events",
    ).get()).toEqual({ count: 0 });
    expect(outboxRows()).toEqual([]);
  });

  it("mirrors committed turn events but keeps model_call and usage noise out of the outbox", () => {
    const threadId = seedAdvanceThread();
    const tuple = { projectId: ADVANCE_PROJECT, runId: ADVANCE_RUN, threadId };
    const acquired = acquireAdvance(
      databasePath,
      tuple,
      { operationId: operationId() },
      advanceDependencies(),
    );
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;

    const response = finalizeAdvance(
      databasePath,
      tuple,
      {
        attemptId: acquired.attempt.id,
        leaseToken: acquired.attempt.leaseToken,
        result: succeededTurn(handoffTurn()),
      },
      advanceDependencies(),
    );
    expect(response.status).toBe(200);

    const eventTypes = (
      database.prepare(
        "SELECT type FROM collaboration_events ORDER BY sequence",
      ).all() as Array<{ type: string }>
    ).map((row) => row.type);
    expect(eventTypes).toEqual([
      "model_call_started",
      "model_call_succeeded",
      "usage_recorded",
      "agent_message",
      "handoff",
    ]);

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual(["agent_message", "handoff"]);
    const handoffPayload = JSON.parse(rows[1]!.payloadJson) as Record<string, unknown>;
    expect(handoffPayload).toEqual({
      actorId: AGENT_A,
      actorType: "agent",
      fromAgentId: AGENT_A,
      occurredAt: NOW,
      overriddenByMention: false,
      reason: "Beta owns the next step",
      runId: ADVANCE_RUN,
      summary: "Handing off after the audit start",
      threadId,
      toAgentId: AGENT_B,
      turnId: expect.any(String),
      type: "handoff",
    });
  });

  it("mirrors action_rejected and run_retried when an invalid turn is rejected then retried", () => {
    const threadId = seedAdvanceThread();
    const tuple = { projectId: ADVANCE_PROJECT, runId: ADVANCE_RUN, threadId };
    const acquired = acquireAdvance(
      databasePath,
      tuple,
      { operationId: operationId() },
      advanceDependencies(),
    );
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;

    const rejected = finalizeAdvance(
      databasePath,
      tuple,
      {
        attemptId: acquired.attempt.id,
        leaseToken: acquired.attempt.leaseToken,
        result: succeededTurn({
          claim: { clientKey: "ghost", source: "proposed" },
          disposition: {
            reason: "Beta continues",
            summary: "Invalid claim turn",
            targetAgentId: AGENT_B,
            type: "handoff",
          },
          message: "Claim without a matching task",
          tasks: [],
        }),
      },
      advanceDependencies(),
    );
    expect(rejected.status).toBe(400);

    let rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual(["action_rejected"]);
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "system",
      attemptId: acquired.attempt.id,
      category: "action_invalid",
      missing: [],
      occurredAt: NOW,
      runId: ADVANCE_RUN,
      threadId,
      type: "action_rejected",
    });

    const run = database
      .prepare("SELECT version FROM collaboration_runs WHERE id=?")
      .get(ADVANCE_RUN) as { version: number };
    const retried = controlThreadRun(databasePath, ADVANCE_PROJECT, threadId, ADVANCE_RUN, {
      action: "retry",
      expectedVersion: run.version,
      operationId: operationId(),
    });
    expect(retried.status).toBe(200);

    rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual(["action_rejected", "run_retried"]);
    expect(JSON.parse(rows[1]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      currentAgentId: AGENT_A,
      occurredAt: NOW,
      runId: ADVANCE_RUN,
      threadId,
      type: "run_retried",
    });
  });

  it("mirrors boundary_paused when the token boundary discards the attempt", () => {
    const threadId = seedAdvanceThread();
    database.prepare("UPDATE agents SET max_tokens=5 WHERE id=?").run(AGENT_A);
    const tuple = { projectId: ADVANCE_PROJECT, runId: ADVANCE_RUN, threadId };
    const acquired = acquireAdvance(
      databasePath,
      tuple,
      { operationId: operationId() },
      advanceDependencies(),
    );
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;

    const response = finalizeAdvance(
      databasePath,
      tuple,
      {
        attemptId: acquired.attempt.id,
        leaseToken: acquired.attempt.leaseToken,
        result: succeededTurn(handoffTurn()),
      },
      advanceDependencies(),
    );
    expect(response).toMatchObject({ body: { attemptStatus: "discarded" }, status: 200 });

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual(["boundary_paused"]);
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "system",
      agentId: AGENT_A,
      boundary: "tokens",
      limit: 5,
      occurredAt: NOW,
      runId: ADVANCE_RUN,
      threadId,
      type: "boundary_paused",
      value: 10,
    });
  });

  it("mirrors context_changed when the acquired context turns stale before finalize", () => {
    const threadId = seedAdvanceThread();
    const tuple = { projectId: ADVANCE_PROJECT, runId: ADVANCE_RUN, threadId };
    const acquired = acquireAdvance(
      databasePath,
      tuple,
      { operationId: operationId() },
      advanceDependencies(),
    );
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;

    updateMission(databasePath, ADVANCE_MISSION, {
      expectedVersion: 1,
      goal: "Changed goal",
      title: "Mission",
    });

    const response = finalizeAdvance(
      databasePath,
      tuple,
      {
        attemptId: acquired.attempt.id,
        leaseToken: acquired.attempt.leaseToken,
        result: succeededTurn(handoffTurn()),
      },
      advanceDependencies(),
    );
    expect(response).toMatchObject({ body: { attemptStatus: "discarded" }, status: 200 });

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual(["context_changed"]);
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "system",
      attemptId: acquired.attempt.id,
      occurredAt: NOW,
      runId: ADVANCE_RUN,
      threadId,
      type: "context_changed",
    });
  });
});
