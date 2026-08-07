import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentTurn } from "@/src/server/collaboration/agent-turn-schema";
import { appendProjectMessage } from "@/src/server/collaboration/run-service";
import type { StructuredTurnResult } from "@/src/server/collaboration/structured-repair";
import {
  acquireAdvance,
  finalizeAdvance,
} from "@/src/server/collaboration/turn-orchestrator";
import { openDatabase } from "@/src/server/db";
import { createMission } from "@/src/server/mission-service";

const NOW = "2026-07-30T05:00:00.000Z";
const PROJECT_ID = "project-owner-races";
const RUN_ID = "run-owner-races";
const AGENT_A = "agent-owner-a";
const AGENT_B = "agent-owner-b";
const AGENT_C = "agent-owner-c";

let databasePath: string;
let directory: string;
let operationSequence: number;
let uuidSequence: number;

function operationId(): string {
  operationSequence += 1;
  return `00000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function dependencies() {
  return {
    clock: () => new Date(NOW),
    randomUUID: () => {
      uuidSequence += 1;
      return `17000000-0000-4000-8000-${uuidSequence.toString().padStart(12, "0")}`;
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

function handoff(targetAgentId = AGENT_B, overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    claim: null,
    disposition: {
      reason: "Continue with the selected current member",
      summary: "Owner-safe handoff",
      targetAgentId,
      type: "handoff",
    },
    message: "The model contribution remains visible.",
    tasks: [],
    ...overrides,
  };
}

function planReady(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    claim: null,
    disposition: { type: "plan_ready" },
    message: "The model says the plan is ready.",
    tasks: [],
    ...overrides,
  };
}

function acquire() {
  const acquired = acquireAdvance(
    databasePath,
    RUN_ID,
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
    RUN_ID,
    {
      attemptId: acquired.attempt.id,
      leaseToken: acquired.attempt.leaseToken,
      result: result(turn),
    },
    dependencies(),
  );
}

function ownerMessage(content: string, mentionAgentId?: string) {
  return appendProjectMessage(databasePath, PROJECT_ID, {
    content,
    mentionAgentId,
    operationId: operationId(),
  }).body.message;
}

function messageConsumption(): Array<{
  authorType: string;
  consumedAt: string | null;
  content: string;
  mentionAgentId: string | null;
  sequence: number;
}> {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT author_type AS authorType, consumed_at AS consumedAt, content,
                mention_agent_id AS mentionAgentId, sequence
         FROM collaboration_messages
         WHERE project_id = ?
         ORDER BY sequence`,
      )
      .all(PROJECT_ID) as ReturnType<typeof messageConsumption>;
  } finally {
    database.close();
  }
}

function runState(): {
  currentAgentId: string;
  roundCount: number;
  status: string;
} {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT current_agent_id AS currentAgentId, round_count AS roundCount, status
         FROM collaboration_runs WHERE id = ?`,
      )
      .get(RUN_ID) as ReturnType<typeof runState>;
  } finally {
    database.close();
  }
}

function preparePlanReadyFromAgentB(): void {
  const first = acquire();
  expect(finalize(first, handoff(AGENT_B)).status).toBe(200);
  expect(runState().currentAgentId).toBe(AGENT_B);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  directory = mkdtempSync(join(tmpdir(), "owner-handoff-plan-races-"));
  databasePath = join(directory, "cockpit.sqlite");
  operationSequence = 1_700;
  uuidSequence = 0;

  const database = openDatabase(databasePath);
  database
    .prepare(
      `INSERT INTO projects (
         id, name, created_at, workspace_path, workspace_key, version
       ) VALUES (?, 'Owner race project', ?, 'D:\\workspace', 'd:/workspace', 1)`,
    )
    .run(PROJECT_ID, NOW);
  database.exec(`
    INSERT INTO providers (
      id, name, base_url, default_model, api_key_cipher, api_key_iv,
      api_key_tag, credential_version, credential_generation, key_id,
      api_key_mask, verified_at, version, created_at, updated_at
    ) VALUES (
      'provider-owner-races', 'Local', 'http://127.0.0.1:4000/v1', 'model',
      'cipher', 'iv', 'tag', 1, 1, 'key', '***', '${NOW}', 1, '${NOW}', '${NOW}'
    );
    INSERT INTO agents (
      id, name, role, system_prompt, provider_id, model, avatar_text,
      accent_token, can_read, can_write, can_execute, max_tokens,
      max_handoffs, version, created_at, updated_at
    ) VALUES
      (
        '${AGENT_A}', 'Alpha', 'Planner', 'private-a', 'provider-owner-races',
        'model', 'A', 'sage', 1, 1, 0, 10000, 10, 1, '${NOW}', '${NOW}'
      ),
      (
        '${AGENT_B}', 'Beta', 'Reviewer', 'private-b', 'provider-owner-races',
        'model', 'B', 'gold', 1, 1, 0, 10000, 10, 1, '${NOW}', '${NOW}'
      ),
      (
        '${AGENT_C}', 'Gamma', 'Builder', 'private-c', 'provider-owner-races',
        'model', 'C', 'sky', 1, 1, 0, 10000, 10, 1, '${NOW}', '${NOW}'
      );
    INSERT INTO project_memberships (project_id, agent_id, joined_at) VALUES
      ('${PROJECT_ID}', '${AGENT_A}', 'a'),
      ('${PROJECT_ID}', '${AGENT_B}', 'b'),
      ('${PROJECT_ID}', '${AGENT_C}', 'c');
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
    ) VALUES ('${PROJECT_ID}', 1);
  `);
  database.close();
  createMission(databasePath, PROJECT_ID, {
    goal: "Resolve owner messages without losing atomic model actions",
    title: "Owner race mission",
  });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { force: true, recursive: true });
});

describe("calling owner messages and handoff", () => {
  it("persists stable sequence, keeps the model target for ordinary pending chat, and consumes only the acquired prompt window", () => {
    const included = ownerMessage("Included before acquire");
    const acquired = acquire();
    const pending = ownerMessage("Ordinary pending after acquire");

    const response = finalize(
      acquired,
      handoff(AGENT_B, {
        claim: { clientKey: "owner_race_task", source: "proposed" },
        tasks: [
          {
            clientKey: "owner_race_task",
            dependsOnKeys: [],
            description: "Keep task and claim atomic with the handoff",
            title: "Preserve model action",
          },
        ],
      }),
    );

    expect([included.sequence, pending.sequence]).toEqual([1, 2]);
    expect(response).toMatchObject({
      body: {
        attemptStatus: "committed",
        run: { currentAgentId: AGENT_B, roundCount: 1, status: "running" },
      },
      status: 200,
    });
    const messages = messageConsumption();
    expect(messages.find(({ sequence }) => sequence === included.sequence)?.consumedAt).toBe(NOW);
    expect(messages.find(({ sequence }) => sequence === pending.sequence)?.consumedAt).toBeNull();

    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS tasks,
                    SUM(CASE WHEN assignee_agent_id = ? THEN 1 ELSE 0 END) AS claimed
             FROM work_items
             WHERE mission_id = (SELECT id FROM missions WHERE project_id = ?)`,
          )
          .get(AGENT_A, PROJECT_ID),
      ).toEqual({ claimed: 1, tasks: 1 });
    } finally {
      database.close();
    }

    const next = acquire();
    expect(JSON.stringify(next.prompt.messages)).toContain("Ordinary pending after acquire");
  });

  it("uses the latest pending mention by stable sequence even when ordinary chat follows it", () => {
    const acquired = acquire();
    const firstMention = ownerMessage("First override", AGENT_B);
    ownerMessage("Ordinary message does not cancel a mention");
    const latestMention = ownerMessage("Latest override", AGENT_C);
    ownerMessage("Later ordinary message");

    const response = finalize(acquired, handoff(AGENT_B));

    expect(firstMention.sequence).toBeLessThan(latestMention.sequence);
    expect(response).toMatchObject({
      body: { run: { currentAgentId: AGENT_C, status: "running" } },
      status: 200,
    });
    const database = openDatabase(databasePath);
    try {
      const event = database
        .prepare(
          `SELECT payload_json AS payload
           FROM collaboration_events WHERE run_id = ? AND type = 'handoff'
           ORDER BY sequence DESC LIMIT 1`,
        )
        .get(RUN_ID) as { payload: string };
      expect(JSON.parse(event.payload)).toMatchObject({
        fromAgentId: AGENT_A,
        overriddenByMention: true,
        toAgentId: AGENT_C,
      });
    } finally {
      database.close();
    }
  });
});

describe("calling owner messages and plan_ready", () => {
  it("delays planned for ordinary pending chat, keeps the current Agent, and preserves task/message actions", () => {
    preparePlanReadyFromAgentB();
    const acquired = acquire();
    const pending = ownerMessage("Please refine before planning");

    const response = finalize(
      acquired,
      planReady({
        claim: { clientKey: "implementation", source: "proposed" },
        tasks: [
          {
            clientKey: "implementation",
            dependsOnKeys: [],
            description: "Task remains committed while planning is delayed",
            title: "Implement accepted direction",
          },
        ],
      }),
    );

    expect(response).toMatchObject({
      body: {
        attemptStatus: "committed",
        run: { currentAgentId: AGENT_B, roundCount: 2, status: "running" },
      },
      status: 200,
    });
    expect(
      messageConsumption().find(({ sequence }) => sequence === pending.sequence)?.consumedAt,
    ).toBeNull();
    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM collaboration_turns
             WHERE run_id = ? AND disposition = 'plan_ready'`,
          )
          .get(RUN_ID),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM work_items
             WHERE mission_id = (SELECT id FROM missions WHERE project_id = ?)`,
          )
          .get(PROJECT_ID),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM collaboration_events
             WHERE run_id = ? AND type = 'run_planned'`,
          )
          .get(RUN_ID),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("keeps running and selects the latest mentioned current member", () => {
    preparePlanReadyFromAgentB();
    const acquired = acquire();
    ownerMessage("Let Alpha continue", AGENT_A);
    ownerMessage("Actually Gamma should continue", AGENT_C);

    const response = finalize(
      acquired,
      planReady({
        claim: { clientKey: "follow_up", source: "proposed" },
        tasks: [
          {
            clientKey: "follow_up",
            dependsOnKeys: [],
            description: "",
            title: "Follow up",
          },
        ],
      }),
    );

    expect(response).toMatchObject({
      body: { run: { currentAgentId: AGENT_C, status: "running" } },
      status: 200,
    });
  });
});

describe("owner prompt-window consumption", () => {
  it(
    "consumes exactly the 30 acquired owner message IDs and leaves excluded and post-acquire messages pending",
    () => {
      for (let index = 1; index <= 32; index += 1) {
        ownerMessage(`history-${index}`);
      }
      const acquired = acquire();
      const postAcquire = ownerMessage("post-acquire");

      expect(acquired.prompt.publicMessages.map(({ sequence }) => sequence)).toEqual(
        Array.from({ length: 30 }, (_, index) => index + 3),
      );
      expect(finalize(acquired, handoff(AGENT_B)).status).toBe(200);

      const ownerMessages = messageConsumption().filter(({ authorType }) => authorType === "owner");
      expect(ownerMessages.filter(({ consumedAt }) => consumedAt !== null)).toHaveLength(30);
      expect(ownerMessages.slice(0, 2).every(({ consumedAt }) => consumedAt === null)).toBe(true);
      expect(
        ownerMessages.find(({ sequence }) => sequence === postAcquire.sequence)?.consumedAt,
      ).toBeNull();
    },
    15_000,
  );

  it("respects the 60000-character whole-message window when marking acquired owner IDs consumed", () => {
    const messages = Array.from({ length: 7 }, (_, index) =>
      ownerMessage(`${index}`.repeat(9_000)),
    );
    const acquired = acquire();

    expect(acquired.prompt.publicMessages.map(({ sequence }) => sequence)).toEqual(
      messages.slice(1).map(({ sequence }) => sequence),
    );
    expect(finalize(acquired, handoff(AGENT_B)).status).toBe(200);

    const consumption = messageConsumption();
    expect(
      consumption.find(({ sequence }) => sequence === messages[0].sequence)?.consumedAt,
    ).toBeNull();
    for (const included of messages.slice(1)) {
      expect(
        consumption.find(({ sequence }) => sequence === included.sequence)?.consumedAt,
      ).toBe(NOW);
    }
  });

  it("consumes none when an invalid business commit fails", () => {
    const included = ownerMessage("Retry me after failure");
    const acquired = acquire();

    const response = finalize(acquired, handoff(AGENT_A));

    expect(response).toMatchObject({
      body: { error: { code: "ACTION_INVALID" } },
      status: 400,
    });
    expect(
      messageConsumption().find(({ sequence }) => sequence === included.sequence)?.consumedAt,
    ).toBeNull();
  });

  it("consumes none when execution changes and the provider result is discarded", () => {
    const included = ownerMessage("Retry me after discard");
    const acquired = acquire();
    const database = openDatabase(databasePath);
    database
      .prepare(
        `UPDATE collaboration_runs
         SET status = 'paused', execution_epoch = execution_epoch + 1
         WHERE id = ?`,
      )
      .run(RUN_ID);
    database.close();

    const response = finalize(acquired, handoff(AGENT_B));

    expect(response).toMatchObject({
      body: { attemptStatus: "discarded" },
      status: 200,
    });
    expect(
      messageConsumption().find(({ sequence }) => sequence === included.sequence)?.consumedAt,
    ).toBeNull();
  });
});
