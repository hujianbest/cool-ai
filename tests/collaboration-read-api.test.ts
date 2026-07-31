import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";

type GetRoute = {
  GET(
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<GetRoute>([
  "../app/api/projects/[projectId]/collaboration/route.ts",
  "../app/api/runs/[runId]/timeline/route.ts",
]);

const NOW = "2026-07-30T07:00:00.000Z";
const PROJECT_ID = "project-read-api";
const RUN_ID = "run-read-api";
const AGENT_A = "agent-read-a";
const AGENT_B = "agent-read-b";

let directory: string;
let databasePath: string;

const eventFixtures = [
  ["run_started", { messageId: "message-1", messageSequence: 1, currentAgentId: AGENT_A }],
  ["owner_message", { messageId: "message-1", messageSequence: 1, mentionAgentId: AGENT_B, mentionDisplayName: "Beta Snapshot" }],
  ["agent_message", { messageId: "message-2", messageSequence: 2, agentId: AGENT_A, agentDisplayName: "Alpha Snapshot", turnId: "turn-1" }],
  ["model_call_started", { attemptId: "attempt-1", agentId: AGENT_A, kind: "primary" }],
  ["model_call_succeeded", { attemptId: "attempt-1", kind: "primary" }],
  ["model_call_failed", { attemptId: "attempt-2", kind: "repair", category: "provider_timeout" }],
  ["usage_recorded", { attemptId: "attempt-1", kind: "primary", promptTokens: 8, completionTokens: 5, totalTokens: 13, reported: true }],
  ["tasks_created", { turnId: "turn-1", items: [{ id: "task-1", title: "Draft", dependsOnIds: [] }] }],
  ["task_claimed", { turnId: "turn-1", workItemId: "task-1", agentId: AGENT_A }],
  ["handoff", { turnId: "turn-1", fromAgentId: AGENT_A, toAgentId: AGENT_B, summary: "Ready", reason: "Review", overriddenByMention: false }],
  ["decision_requested", { decisionId: "decision-1", turnId: "turn-1", agentId: AGENT_A, question: "Ship?", options: ["Yes", "No"] }],
  ["decision_answered", { decisionId: "decision-1", messageId: "message-3", messageSequence: 3, answer: "Yes", nextAgentId: AGENT_B }],
  ["boundary_paused", { boundary: "tokens", agentId: AGENT_A, value: 101, limit: 100 }],
  ["run_paused", { category: "provider_timeout" }],
  ["run_resumed", { currentAgentId: AGENT_A }],
  ["run_retried", { currentAgentId: AGENT_A }],
  ["run_planned", { turnId: "turn-1" }],
  ["run_stopped", {}],
  ["attempt_interrupted", { attemptId: "attempt-2" }],
  ["action_rejected", { attemptId: "attempt-2", category: "action_invalid", missing: ["participants", "tasks", "claim"] }],
  ["context_changed", { attemptId: "attempt-2" }],
] as const;

function seed(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO projects (
        id, name, created_at, workspace_path, workspace_key, version
      ) VALUES (
        '${PROJECT_ID}', 'Read API', '${NOW}', 'D:\\workspace', 'd:/workspace', 1
      );
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv,
        api_key_tag, credential_version, credential_generation, key_id,
        api_key_mask, verified_at, version, created_at, updated_at
      ) VALUES (
        'provider-read', 'Local', 'http://127.0.0.1:4000/v1', 'model',
        'cipher-secret', 'iv-secret', 'tag-secret', 1, 1, 'key-secret',
        '***', '${NOW}', 1, '${NOW}', '${NOW}'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text,
        accent_token, can_read, can_write, can_execute, max_tokens,
        max_handoffs, version, created_at, updated_at
      ) VALUES
        (
          '${AGENT_A}', 'Alpha Current', 'Planner', 'private-alpha', 'provider-read',
          'model', 'A', 'sage', 1, 1, 0, 1000, 3, 1, '${NOW}', '${NOW}'
        ),
        (
          '${AGENT_B}', 'Beta Current', 'Reviewer', 'private-beta', 'provider-read',
          'model', 'B', 'gold', 1, 1, 0, 1000, 3, 1, '${NOW}', '${NOW}'
        );
      INSERT INTO project_memberships (project_id, agent_id, joined_at) VALUES
        ('${PROJECT_ID}', '${AGENT_A}', 'a'),
        ('${PROJECT_ID}', '${AGENT_B}', 'b');
      INSERT INTO missions (
        id, project_id, title, goal, version, created_at, updated_at
      ) VALUES (
        'mission-read', '${PROJECT_ID}', 'Mission', 'Read safely', 1, '${NOW}', '${NOW}'
      );
      INSERT INTO collaboration_runs (
        id, project_id, status, current_agent_id, round_count,
        next_event_sequence, version, execution_epoch, pause_reason,
        pause_category, created_at, updated_at
      ) VALUES (
        '${RUN_ID}', '${PROJECT_ID}', 'waiting_owner', '${AGENT_A}', 2,
        ${eventFixtures.length + 1}, 3, 1, NULL, NULL, '${NOW}', '${NOW}'
      );
      INSERT INTO collaboration_project_sequences (
        project_id, next_message_sequence
      ) VALUES ('${PROJECT_ID}', 4);
      INSERT INTO collaboration_messages (
        id, project_id, run_id, author_type, author_agent_id,
        author_display_name, content, mention_agent_id, mention_display_name,
        sequence, consumed_at, created_at
      ) VALUES
        (
          'message-1', '${PROJECT_ID}', '${RUN_ID}', 'owner', NULL,
          'Owner Snapshot', 'Start', '${AGENT_B}', 'Beta Snapshot', 1, NULL, '${NOW}'
        ),
        (
          'message-2', '${PROJECT_ID}', '${RUN_ID}', 'agent', '${AGENT_A}',
          'Alpha Snapshot', 'Drafted', NULL, NULL, 2, NULL, '${NOW}'
        ),
        (
          'message-3', '${PROJECT_ID}', '${RUN_ID}', 'owner', NULL,
          'Owner Snapshot', 'Yes', '${AGENT_B}', 'Beta Snapshot', 3, NULL, '${NOW}'
        );
      INSERT INTO collaboration_operations (
        id, project_id, run_id, kind, request_hash, status,
        http_status, response_json, created_at, updated_at
      ) VALUES
        ('00000000-0000-4000-8000-000000001901', '${PROJECT_ID}', '${RUN_ID}',
         'advance', 'hash-1', 'completed', 200, '{}', '${NOW}', '${NOW}'),
        ('00000000-0000-4000-8000-000000001902', '${PROJECT_ID}', '${RUN_ID}',
         'advance', 'hash-2', 'completed', 200, '{}', '${NOW}', '${NOW}');
      INSERT INTO collaboration_attempts (
        id, project_id, run_id, agent_id, operation_id, status,
        lease_token, lease_expires_at, prompt_hash, acquire_execution_epoch,
        acquire_context_hash, included_message_sequence, error_category,
        started_at, finished_at
      ) VALUES
        ('attempt-1', '${PROJECT_ID}', '${RUN_ID}', '${AGENT_A}',
         '00000000-0000-4000-8000-000000001901', 'committed', 'lease-1', '${NOW}',
         'prompt-1', 1, 'context-1', 1, NULL, '${NOW}', '${NOW}'),
        ('attempt-2', '${PROJECT_ID}', '${RUN_ID}', '${AGENT_B}',
         '00000000-0000-4000-8000-000000001902', 'failed', 'lease-2', '${NOW}',
         'prompt-2', 1, 'context-2', 2, 'provider_timeout', '${NOW}', '${NOW}');
      INSERT INTO collaboration_model_calls (
        id, attempt_id, kind, call_index, status, prompt_tokens,
        completion_tokens, total_tokens, error_category, created_at
      ) VALUES
        ('call-1', 'attempt-1', 'primary', 1, 'succeeded', 8, 5, 13, NULL, '${NOW}'),
        ('call-2', 'attempt-1', 'repair', 2, 'succeeded', 3, 2, 5, NULL, '${NOW}'),
        ('call-3', 'attempt-2', 'primary', 1, 'provider_failed', NULL, NULL, NULL,
         'provider_timeout', '${NOW}');
      INSERT INTO collaboration_turns (
        id, attempt_id, run_id, agent_id, round_number, message_id,
        disposition, created_at
      ) VALUES (
        'turn-1', 'attempt-1', '${RUN_ID}', '${AGENT_A}', 1, 'message-2',
        'handoff', '${NOW}'
      );
      INSERT INTO decision_requests (
        id, run_id, turn_id, requesting_agent_id, question, options_json,
        status, answer, answer_message_id, version, created_at, answered_at
      ) VALUES (
        'decision-open', '${RUN_ID}', 'turn-1', '${AGENT_A}', 'Approve?',
        '["Approve","Revise"]', 'open', NULL, NULL, 1, '${NOW}', NULL
      );
    `);
    const insertEvent = database.prepare(
      `INSERT INTO collaboration_events (
         id, run_id, sequence, type, actor_type, actor_id, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    eventFixtures.forEach(([type, payload], index) => {
      insertEvent.run(
        `event-${index + 1}`,
        RUN_ID,
        index + 1,
        type,
        type.startsWith("run_") || type === "owner_message" ? "owner" : "system",
        null,
        JSON.stringify(payload),
        NOW,
      );
    });
  } finally {
    database.close();
  }
}

async function loadRoute(path: string): Promise<GetRoute> {
  const load = routeModules[path];
  expect(load, `${path} must exist`).toBeTypeOf("function");
  return load!();
}

async function collaboration(query = ""): Promise<Response> {
  const route = await loadRoute("../app/api/projects/[projectId]/collaboration/route.ts");
  return route.GET(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/collaboration${query}`),
    { params: Promise.resolve({ projectId: PROJECT_ID }) },
  );
}

async function timeline(query = ""): Promise<Response> {
  const route = await loadRoute("../app/api/runs/[runId]/timeline/route.ts");
  return route.GET(
    new Request(`http://localhost/api/runs/${RUN_ID}/timeline${query}`),
    { params: Promise.resolve({ runId: RUN_ID }) },
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-read-api-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  seed();
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("typed collaboration read API", () => {
  it("pages project messages and run events independently while restoring current facts and snapshots after reopen", async () => {
    const first = await collaboration("?messageAfter=0&messageLimit=1&eventAfter=4&eventLimit=2");
    expect(first.status).toBe(200);
    const body = await first.json();

    expect(body).toMatchObject({
      run: { id: RUN_ID, currentAgentId: AGENT_A, status: "waiting_owner", roundCount: 2 },
      pendingDecision: {
        id: "decision-open",
        requestingAgentId: AGENT_A,
        options: ["Approve", "Revise"],
        status: "open",
      },
      readiness: { ready: true, missing: [] },
      projectMessagesPage: {
        items: [{
          sequence: 1,
          authorDisplayName: "Owner Snapshot",
          mentionDisplayName: "Beta Snapshot",
          mentionMemberStatus: "current",
        }],
        nextAfter: 1,
      },
      timelinePage: {
        items: [{ sequence: 5, type: "model_call_succeeded" }, { sequence: 6, type: "model_call_failed" }],
        nextAfter: 6,
      },
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
        repairCalls: 1,
        unreportedCalls: 1,
        byAgent: [
          { agentId: AGENT_A, promptTokens: 11, completionTokens: 7, totalTokens: 18, handoffs: 1 },
          { agentId: AGENT_B, promptTokens: 0, completionTokens: 0, totalTokens: 0, handoffs: 0 },
        ],
      },
    });

    const database = openDatabase(databasePath);
    database.prepare("UPDATE agents SET name = 'Beta Renamed' WHERE id = ?").run(AGENT_B);
    database.prepare("DELETE FROM project_memberships WHERE project_id = ? AND agent_id = ?").run(PROJECT_ID, AGENT_B);
    database.close();

    const reopened = await collaboration("?messageAfter=2&messageLimit=1&eventAfter=999&eventLimit=1");
    expect(reopened.status).toBe(200);
    await expect(reopened.json()).resolves.toMatchObject({
      projectMessagesPage: {
        items: [{ sequence: 3, mentionDisplayName: "Beta Snapshot", mentionMemberStatus: "left" }],
        nextAfter: null,
      },
      timelinePage: { items: [], nextAfter: null },
      pendingDecision: { id: "decision-open" },
      usage: { totalTokens: 18 },
    });
  });

  it("returns every designed event as an exact strict payload and supports a missing after sequence", async () => {
    const response = await timeline("?after=3&limit=200");
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.items.map((item: { type: string }) => item.type)).toEqual(
      eventFixtures.slice(3).map(([type]) => type),
    );
    expect(body.items.map((item: { payload: unknown }) => item.payload)).toEqual(
      eventFixtures.slice(3).map(([, payload]) => payload),
    );
    expect(body.nextAfter).toBeNull();

    const missingCursor = await timeline("?after=11&limit=1");
    await expect(missingCursor.json()).resolves.toMatchObject({
      items: [{ sequence: 12, type: "decision_answered" }],
      nextAfter: 12,
    });
  });

  it.each([
    ["unknown payload key", { attemptId: "attempt-1", kind: "primary", rawProviderBody: "Bearer secret-value" }],
    ["wrong payload type", { attemptId: "attempt-1", kind: "primary", reported: "yes", promptTokens: 1, completionTokens: 1, totalTokens: 2 }],
  ])("rejects %s with only a sanitized public error", async (_label, payload) => {
    const database = openDatabase(databasePath);
    database
      .prepare("UPDATE collaboration_events SET type = 'usage_recorded', payload_json = ? WHERE id = 'event-1'")
      .run(JSON.stringify(payload));
    database.close();

    const response = await timeline("?after=0&limit=1");
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
        correlationId: expect.any(String),
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/rawProviderBody|Bearer|secret-value|provider-read|private-alpha/i);
  });

  it.each([
    "?messageAfter=-1",
    "?messageLimit=0",
    "?eventAfter=1.5",
    "?eventLimit=201",
  ])("rejects invalid independent pagination input: %s", async (query) => {
    const response = await collaboration(query);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });
});
