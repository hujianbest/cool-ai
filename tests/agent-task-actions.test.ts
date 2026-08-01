import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StructuredTurnResult } from "@/src/server/collaboration/structured-repair";
import { createV6FixtureDatabaseOpener } from "@/tests/v6-fixture-db";

const openDatabase = createV6FixtureDatabaseOpener({
  missingDeliveryHeadMissionIds: [],
  missingReviewHeadResultIds: [],
});
import { createMission, createWorkItem } from "@/src/server/mission-service";

type ProposedTask = {
  clientKey: string;
  title: string;
  description: string;
  dependsOnKeys: string[];
};
type Turn = {
  message: string;
  tasks: ProposedTask[];
  claim:
    | null
    | { source: "existing"; workItemId: string }
    | { source: "proposed"; clientKey: string };
  disposition: {
    type: "handoff";
    targetAgentId: string;
    summary: string;
    reason: string;
  };
};
type CommitInput = {
  agentId: string;
  attemptId: string;
  runId: string;
  timestamp: string;
  turn: Turn;
};
type CommitResult = {
  claimedWorkItemId: string | null;
  messageId: string;
  messageSequence: number;
  taskIdsByClientKey: Record<string, string>;
};
type CommitterModule = {
  commitAgentTaskActionsTx?: (
    database: DatabaseSync,
    input: CommitInput,
  ) => CommitResult;
};
type OrchestratorModule = {
  acquireAdvance?: (
    databasePath: string,
    runId: string,
    input: { operationId: string },
    dependencies: Dependencies,
  ) => { kind: "acquired"; attempt: { id: string; leaseToken: string } };
  finalizeAdvance?: (
    databasePath: string,
    runId: string,
    input: {
      attemptId: string;
      leaseToken: string;
      result: StructuredTurnResult;
    },
    dependencies: Dependencies,
  ) => { affectedRows: 0 | 1; body: unknown; status: number };
};
type Dependencies = {
  clock: () => Date;
  randomUUID: () => string;
};

const committers = import.meta.glob<CommitterModule>(
  "../src/server/collaboration/action-committer.ts",
);
const orchestrators = import.meta.glob<OrchestratorModule>(
  "../src/server/collaboration/turn-orchestrator.ts",
);

const NOW = "2026-07-30T03:00:00.000Z";
const PROJECT_ID = "project-actions";
const RUN_ID = "run-actions";
const AGENT_A = "agent-actions-a";
const AGENT_B = "agent-actions-b";
const OPERATION_ID = "00000000-0000-4000-8000-000000001300";

let directory: string;
let databasePath: string;
let missionId: string;
let uuidSequence: number;

function seed(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv,
        api_key_tag, credential_version, credential_generation, key_id,
        api_key_mask, verified_at, version, created_at, updated_at
      ) VALUES (
        'provider-actions', 'Local', 'http://127.0.0.1:4000/v1', 'model',
        'cipher', 'iv', 'tag', 1, 1, 'key', '***', '${NOW}', 1, '${NOW}', '${NOW}'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text,
        accent_token, can_read, can_write, can_execute, max_tokens,
        max_handoffs, version, created_at, updated_at
      ) VALUES
        (
          '${AGENT_A}', 'Alpha', 'Planner', 'private-a', 'provider-actions',
          'model', 'A', 'sage', 1, 1, 0, 1000, 5, 1, '${NOW}', '${NOW}'
        ),
        (
          '${AGENT_B}', 'Beta', 'Reviewer', 'private-b', 'provider-actions',
          'model', 'B', 'gold', 1, 1, 0, 1000, 5, 1, '${NOW}', '${NOW}'
        );
      INSERT INTO project_memberships (project_id, agent_id, joined_at) VALUES
        ('${PROJECT_ID}', '${AGENT_A}', 'a'),
        ('${PROJECT_ID}', '${AGENT_B}', 'b');
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
  } finally {
    database.close();
  }
}

async function committer(): Promise<Required<CommitterModule>> {
  const load = committers["../src/server/collaboration/action-committer.ts"];
  expect(load, "T-13 action committer module must exist").toBeTypeOf("function");
  const implementation = await load!();
  expect(implementation.commitAgentTaskActionsTx).toBeTypeOf("function");
  return implementation as Required<CommitterModule>;
}

async function orchestrator(): Promise<Required<OrchestratorModule>> {
  const load = orchestrators["../src/server/collaboration/turn-orchestrator.ts"];
  expect(load).toBeTypeOf("function");
  const implementation = await load!();
  expect(implementation.acquireAdvance).toBeTypeOf("function");
  expect(implementation.finalizeAdvance).toBeTypeOf("function");
  return implementation as Required<OrchestratorModule>;
}

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    claim: null,
    disposition: {
      reason: "T-14 will commit this later",
      summary: "Continue",
      targetAgentId: AGENT_B,
      type: "handoff",
    },
    message: "Visible Agent conclusion",
    tasks: [],
    ...overrides,
  };
}

function dependencies(): Dependencies {
  return {
    clock: () => new Date(NOW),
    randomUUID: () => {
      uuidSequence += 1;
      return `13000000-0000-4000-8000-${uuidSequence.toString().padStart(12, "0")}`;
    },
  };
}

async function commit(input: Partial<CommitInput> = {}): Promise<CommitResult> {
  const implementation = await committer();
  const database = openDatabase(databasePath);
  database
    .prepare(
      `INSERT OR IGNORE INTO collaboration_operations (
         id, project_id, run_id, kind, request_hash, status,
         http_status, response_json, created_at, updated_at
       ) VALUES (
         'operation-actions-direct', ?, ?, 'advance', 'hash', 'pending',
         NULL, NULL, ?, ?
       )`,
    )
    .run(PROJECT_ID, RUN_ID, NOW, NOW);
  database
    .prepare(
      `INSERT OR IGNORE INTO collaboration_attempts (
         id, project_id, run_id, agent_id, operation_id, status,
         lease_token, lease_expires_at, prompt_hash, acquire_execution_epoch,
         acquire_context_hash, included_message_sequence, error_category,
         started_at, finished_at
       ) VALUES (
         'attempt-actions', ?, ?, ?, 'operation-actions-direct', 'calling',
         'lease', '2099-01-01T00:00:00.000Z', 'prompt', 1,
         'context', 0, NULL, ?, NULL
       )`,
    )
    .run(PROJECT_ID, RUN_ID, AGENT_A, NOW);
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = implementation.commitAgentTaskActionsTx(database, {
      agentId: AGENT_A,
      attemptId: "attempt-actions",
      runId: RUN_ID,
      timestamp: NOW,
      turn: turn(),
      ...input,
    });
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function counts(): {
  messages: number;
  tasks: number;
  dependencies: number;
  assigned: number;
  missionVersion: number;
  nextMessageSequence: number;
} {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM collaboration_messages WHERE run_id = ?) AS messages,
           (SELECT COUNT(*) FROM work_items WHERE mission_id = ?) AS tasks,
           (SELECT COUNT(*) FROM work_item_dependencies AS dependencies
             JOIN work_items AS items ON items.id = dependencies.work_item_id
             WHERE items.mission_id = ?) AS dependencies,
           (SELECT COUNT(*) FROM work_items
             WHERE mission_id = ? AND assignee_agent_id IS NOT NULL) AS assigned,
           (SELECT version FROM missions WHERE id = ?) AS missionVersion,
           (SELECT next_message_sequence FROM collaboration_project_sequences
             WHERE project_id = ?) AS nextMessageSequence`,
      )
      .get(RUN_ID, missionId, missionId, missionId, missionId, PROJECT_ID) as ReturnType<
      typeof counts
    >;
  } finally {
    database.close();
  }
}

function item(id: string): {
  assigneeAgentId: string | null;
  status: string;
  version: number;
} {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT assignee_agent_id AS assigneeAgentId, status, version
         FROM work_items WHERE id = ?`,
      )
      .get(id) as ReturnType<typeof item>;
  } finally {
    database.close();
  }
}

function validResult(value: Turn): StructuredTurnResult {
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
    turn: value,
    usage: [{ kind: "primary", usage, usageReported: true }],
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-task-actions-"));
  databasePath = join(directory, "cockpit.sqlite");
  uuidSequence = 0;
  const database = openDatabase(databasePath);
  database
    .prepare(
      `INSERT INTO projects (
         id, name, created_at, workspace_path, workspace_key, version
       ) VALUES (?, 'Agent actions', ?, 'D:\\workspace', 'd:/workspace', 1)`,
    )
    .run(PROJECT_ID, NOW);
  database.close();
  seed();
  missionId = createMission(databasePath, PROJECT_ID, {
    goal: "Commit one complete Agent action transaction",
    title: "Atomic task actions",
  }).id;
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("Agent task action committer", () => {
  it("creates a complete batch-only DAG, resolves proposed ids, and claims only the current Agent", async () => {
    const result = await commit({
      turn: turn({
        claim: { clientKey: "research", source: "proposed" },
        tasks: [
          {
            clientKey: "research",
            dependsOnKeys: [],
            description: " Gather facts ",
            title: " Research ",
          },
          {
            clientKey: "draft",
            dependsOnKeys: ["research"],
            description: " Produce draft ",
            title: "Draft",
          },
          {
            clientKey: "review",
            dependsOnKeys: ["draft"],
            description: "",
            title: "Review",
          },
        ],
      }),
    });

    expect(Object.keys(result.taskIdsByClientKey)).toEqual(["research", "draft", "review"]);
    expect(result.claimedWorkItemId).toBe(result.taskIdsByClientKey.research);
    expect(result.messageSequence).toBe(1);
    expect(item(result.taskIdsByClientKey.research)).toEqual({
      assigneeAgentId: AGENT_A,
      status: "in_progress",
      version: 2,
    });
    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT child.id, dependency.depends_on_id AS dependsOnId
             FROM work_item_dependencies AS dependency
             JOIN work_items AS child ON child.id = dependency.work_item_id
             WHERE child.id IN (?, ?)
             ORDER BY child.title`,
          )
          .all(result.taskIdsByClientKey.draft, result.taskIdsByClientKey.review),
      ).toEqual([
        {
          dependsOnId: result.taskIdsByClientKey.research,
          id: result.taskIdsByClientKey.draft,
        },
        {
          dependsOnId: result.taskIdsByClientKey.draft,
          id: result.taskIdsByClientKey.review,
        },
      ]);
      expect(
        database
          .prepare(
            `SELECT author_agent_id AS agentId, author_display_name AS displayName,
                    content, sequence
             FROM collaboration_messages WHERE id = ?`,
          )
          .get(result.messageId),
      ).toEqual({
        agentId: AGENT_A,
        content: "Visible Agent conclusion",
        displayName: "Alpha",
        sequence: 1,
      });
    } finally {
      database.close();
    }
    expect(counts()).toEqual({
      assigned: 1,
      dependencies: 2,
      messages: 1,
      missionVersion: 2,
      nextMessageSequence: 2,
      tasks: 3,
    });
  });

  it("claims an existing todo only when unassigned, dependencies are done, and its current version wins", async () => {
    const prerequisite = createWorkItem(databasePath, missionId, {
      assigneeAgentId: null,
      dependencyIds: [],
      description: "",
      title: "Prerequisite",
    });
    const existing = createWorkItem(databasePath, missionId, {
      assigneeAgentId: null,
      dependencyIds: [prerequisite.id],
      description: "",
      title: "Existing",
    });
    const database = openDatabase(databasePath);
    database
      .prepare("DELETE FROM work_item_dependencies WHERE work_item_id = ?")
      .run(existing.id);
    database
      .prepare("UPDATE work_items SET version = version + 1 WHERE id = ?")
      .run(prerequisite.id);
    database.close();

    const result = await commit({
      turn: turn({
        claim: { source: "existing", workItemId: existing.id },
      }),
    });

    expect(result.claimedWorkItemId).toBe(existing.id);
    expect(item(existing.id)).toEqual({
      assigneeAgentId: AGENT_A,
      status: "in_progress",
      version: 2,
    });

    await expect(
      commit({
        turn: turn({
          claim: { source: "existing", workItemId: existing.id },
        }),
      }),
    ).rejects.toMatchObject({ code: "ACTION_CONFLICT" });
    expect(item(existing.id)).toEqual({
      assigneeAgentId: AGENT_A,
      status: "in_progress",
      version: 2,
    });
    expect(counts().messages).toBe(1);
  });

  it("commits pure visible text with zero tasks and no claim without changing mission facts", async () => {
    const result = await commit();

    expect(result.taskIdsByClientKey).toEqual({});
    expect(result.claimedWorkItemId).toBeNull();
    expect(counts()).toEqual({
      assigned: 0,
      dependencies: 0,
      messages: 1,
      missionVersion: 1,
      nextMessageSequence: 2,
      tasks: 0,
    });
  });

  it.each([
    [
      "duplicate client keys",
      [
        { clientKey: "same", title: "One", description: "", dependsOnKeys: [] },
        { clientKey: "same", title: "Two", description: "", dependsOnKeys: [] },
      ],
    ],
    [
      "client key bounds",
      [{ clientKey: "x".repeat(65), title: "One", description: "", dependsOnKeys: [] }],
    ],
    [
      "client key characters",
      [{ clientKey: "not valid", title: "One", description: "", dependsOnKeys: [] }],
    ],
    [
      "dependencies outside the batch",
      [{ clientKey: "one", title: "One", description: "", dependsOnKeys: ["existing"] }],
    ],
    [
      "a dependency cycle",
      [
        { clientKey: "one", title: "One", description: "", dependsOnKeys: ["two"] },
        { clientKey: "two", title: "Two", description: "", dependsOnKeys: ["one"] },
      ],
    ],
    [
      "S-3 title and description bounds",
      [
        {
          clientKey: "one",
          title: "题".repeat(161),
          description: "述".repeat(5001),
          dependsOnKeys: [],
        },
      ],
    ],
  ])("rejects %s and rolls back the whole turn", async (_case, tasks) => {
    await expect(commit({ turn: turn({ tasks: [...tasks] }) })).rejects.toMatchObject({
      code: "ACTION_INVALID",
    });
    expect(counts()).toEqual({
      assigned: 0,
      dependencies: 0,
      messages: 0,
      missionVersion: 1,
      nextMessageSequence: 1,
      tasks: 0,
    });
  });

  it.each(["blocked", "assigned", "dependency", "missing"] as const)(
    "rejects an existing claim that is %s and rolls back its Agent message",
    async (conflict) => {
      const prerequisite = createWorkItem(databasePath, missionId, {
        assigneeAgentId: null,
        dependencyIds: [],
        description: "",
        title: "Prerequisite",
      });
      const existing = createWorkItem(databasePath, missionId, {
        assigneeAgentId: null,
        dependencyIds: conflict === "dependency" ? [prerequisite.id] : [],
        description: "",
        title: "Existing",
      });
      if (conflict === "blocked" || conflict === "assigned") {
        const database = openDatabase(databasePath);
        database
          .prepare(
            conflict === "blocked"
              ? "UPDATE work_items SET status = 'blocked' WHERE id = ?"
              : "UPDATE work_items SET assignee_agent_id = ? WHERE id = ?",
          )
          .run(...(conflict === "blocked" ? [existing.id] : [AGENT_B, existing.id]));
        database.close();
      }

      await expect(
        commit({
          turn: turn({
            claim: {
              source: "existing",
              workItemId: conflict === "missing" ? "missing-item" : existing.id,
            },
          }),
        }),
      ).rejects.toMatchObject({ code: "ACTION_CONFLICT" });
      expect(counts().messages).toBe(0);
      expect(item(existing.id).version).toBe(1);
      expect(item(existing.id).assigneeAgentId).toBe(
        conflict === "assigned" ? AGENT_B : null,
      );
    },
  );

  it("rejects an unresolved proposed claim and a non-current committing Agent atomically", async () => {
    await expect(
      commit({
        turn: turn({
          claim: { clientKey: "absent", source: "proposed" },
          tasks: [
            { clientKey: "present", title: "Present", description: "", dependsOnKeys: [] },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: "ACTION_INVALID" });
    await expect(commit({ agentId: AGENT_B })).rejects.toMatchObject({
      code: "ACTION_CONFLICT",
    });
    expect(counts()).toEqual({
      assigned: 0,
      dependencies: 0,
      messages: 0,
      missionVersion: 1,
      nextMessageSequence: 1,
      tasks: 0,
    });
  });

  it("uses the T-10 finalize transaction so a late invalid claim rolls back message, tasks, and claim", async () => {
    const existing = createWorkItem(databasePath, missionId, {
      assigneeAgentId: AGENT_B,
      dependencyIds: [],
      description: "",
      title: "Already assigned",
    });
    const implementation = await orchestrator();
    const acquired = implementation.acquireAdvance(
      databasePath,
      RUN_ID,
      { operationId: OPERATION_ID },
      dependencies(),
    );
    expect(acquired.kind).toBe("acquired");
    const response = implementation.finalizeAdvance(
      databasePath,
      RUN_ID,
      {
        attemptId: acquired.attempt.id,
        leaseToken: acquired.attempt.leaseToken,
        result: validResult(
          turn({
            claim: { source: "existing", workItemId: existing.id },
            tasks: [
              {
                clientKey: "must_rollback",
                dependsOnKeys: [],
                description: "",
                title: "Must rollback",
              },
            ],
          }),
        ),
      },
      dependencies(),
    );

    expect(response).toMatchObject({
      affectedRows: 1,
      body: { error: { category: "action_invalid", code: "ACTION_CONFLICT" } },
      status: 409,
    });
    expect(counts()).toEqual({
      assigned: 1,
      dependencies: 0,
      messages: 0,
      missionVersion: 1,
      nextMessageSequence: 1,
      tasks: 1,
    });
    expect(item(existing.id)).toEqual({
      assigneeAgentId: AGENT_B,
      status: "todo",
      version: 1,
    });
    const database = openDatabase(databasePath);
    try {
      expect(
        database
          .prepare(
            `SELECT attempts.status AS attemptStatus, runs.status AS runStatus,
                    runs.round_count AS roundCount
             FROM collaboration_attempts AS attempts
             JOIN collaboration_runs AS runs ON runs.id = attempts.run_id
             WHERE attempts.id = ?`,
          )
          .get(acquired.attempt.id),
      ).toEqual({
        attemptStatus: "failed",
        roundCount: 0,
        runStatus: "paused",
      });
    } finally {
      database.close();
    }
  });
});
