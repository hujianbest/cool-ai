import { describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-21T05:00:00.000Z";
const HASH = "a".repeat(64);

type UsageTotals = {
  completionTokens: number;
  invalidCalls: number;
  promptTokens: number;
  totalTokens: number;
  unreportedCalls: number;
};

type UsageQuotaDto = {
  budgets: Array<{
    agentId: string;
    maxHandoffs: number;
    maxTokens: number;
    name: string;
    usedTokens: number;
  }>;
  disclaimer: "not_invoice";
  project: {
    detail: string | null;
    projectId: string | null;
    totals: UsageTotals;
  };
  providers: Array<{
    id: string;
    name: string;
    totals: UsageTotals;
  }>;
  runs: Array<{
    id: string;
    roundCount: number;
    roundLimit: number;
    totals: UsageTotals;
  }>;
};

type UsageModule = {
  getUsageQuota(databasePath: string, projectId?: string): UsageQuotaDto;
};

const usageModules = import.meta.glob<UsageModule>(
  "../../../src/adapters/outbound/sqlite/operations-projection/usage-quota.ts",
);

const EMPTY_TOTALS: UsageTotals = {
  completionTokens: 0,
  invalidCalls: 0,
  promptTokens: 0,
  totalTokens: 0,
  unreportedCalls: 0,
};

async function usageService(): Promise<UsageModule> {
  const load = usageModules[
    "../../../src/adapters/outbound/sqlite/operations-projection/usage-quota.ts"
  ];
  expect(load, "the usage quota query must exist").toBeTypeOf("function");
  return load();
}

function seedProjectGraph(
  databasePath: string,
  input: {
    agentId: string;
    projectId: string;
    providerId: string;
    runId: string;
    threadId: string;
  },
): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      BEGIN;
      PRAGMA defer_foreign_keys=ON;
      INSERT INTO projects (
        id, name, created_at, workspace_path, workspace_key, version
      ) VALUES (
        '${input.projectId}', 'Usage ${input.projectId}', '${NOW}',
        'D:\\workspace\\${input.projectId}', 'd:/workspace/${input.projectId}', 1
      );
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv,
        api_key_tag, credential_version, credential_generation, key_id,
        api_key_mask, verified_at, version, created_at, updated_at
      ) VALUES (
        '${input.providerId}', 'Local ${input.providerId}', 'http://127.0.0.1:4000/v1',
        'model', 'cipher', 'iv', 'tag', 1, 1, 'key', '***', '${NOW}', 1, '${NOW}', '${NOW}'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
        can_read, can_write, can_execute, max_tokens, max_handoffs, version, created_at, updated_at
      ) VALUES (
        '${input.agentId}', 'Agent ${input.agentId}', 'Builder', 'private',
        '${input.providerId}', 'model', 'A', 'sage', 1, 1, 1, 1000, 5, 1, '${NOW}', '${NOW}'
      );
      INSERT INTO project_memberships (project_id, agent_id, joined_at)
      VALUES ('${input.projectId}', '${input.agentId}', '${NOW}');
      INSERT INTO collaboration_operations (
        id, project_id, thread_id, run_id, kind, request_hash, status, http_status,
        response_json, response_schema_version, created_at, updated_at
      ) VALUES (
        'thread-op-${input.threadId}', '${input.projectId}', '${input.threadId}', NULL,
        'thread_create', 'thread-hash-${input.threadId}', 'completed', 201, '{}', 7, '${NOW}', '${NOW}'
      );
      INSERT INTO collaboration_thread_policy_revisions (
        id, project_id, thread_id, version, created_operation_id, created_at
      ) VALUES (
        'policy-${input.threadId}', '${input.projectId}', '${input.threadId}', 1,
        'thread-op-${input.threadId}', '${NOW}'
      );
      INSERT INTO collaboration_threads (
        id, project_id, title, active_policy_revision_id, policy_version,
        next_fact_sequence, last_activity_sequence, version, created_at, updated_at
      ) VALUES (
        '${input.threadId}', '${input.projectId}', 'Thread', 'policy-${input.threadId}',
        1, 4, 3, 1, '${NOW}', '${NOW}'
      );
      INSERT INTO collaboration_thread_policy_members (
        project_id, thread_id, revision_id, position, agent_id, agent_display_name
      ) VALUES (
        '${input.projectId}', '${input.threadId}', 'policy-${input.threadId}', 0,
        '${input.agentId}', 'Agent'
      );
      INSERT INTO collaboration_project_thread_sequences (project_id, next_activity_sequence)
      VALUES ('${input.projectId}', 4);
      INSERT INTO collaboration_runs (
        id, project_id, thread_id, status, current_agent_id, round_count,
        next_event_sequence, version, execution_epoch, pause_reason, pause_category,
        created_at, updated_at
      ) VALUES (
        '${input.runId}', '${input.projectId}', '${input.threadId}', 'planned',
        '${input.agentId}', 3, 1, 1, 1, NULL, NULL, '${NOW}', '${NOW}'
      );
      INSERT INTO collaboration_thread_facts (
        id, project_id, thread_id, sequence, activity_sequence, type, actor_type, actor_id,
        run_id, message_id, run_event_id, policy_revision_id, payload_json, created_at
      ) VALUES
        ('created-${input.threadId}', '${input.projectId}', '${input.threadId}', 1, 1,
         'thread_created', 'system', NULL, NULL, NULL, NULL, NULL, '{"title":"Thread"}', '${NOW}'),
        ('policy-${input.threadId}-fact', '${input.projectId}', '${input.threadId}', 2, 2,
         'policy_changed', 'system', NULL, NULL, NULL, NULL, 'policy-${input.threadId}',
         '{"policyVersion":1}', '${NOW}'),
        ('run-${input.runId}-fact', '${input.projectId}', '${input.threadId}', 3, 3,
         'run_linked', 'system', NULL, '${input.runId}', NULL, NULL, NULL,
         '{"runId":"${input.runId}"}', '${NOW}');
      INSERT INTO collaboration_operations (
        id, project_id, thread_id, run_id, kind, request_hash, status, http_status,
        response_json, response_schema_version, created_at, updated_at
      ) VALUES (
        'advance-${input.runId}', '${input.projectId}', '${input.threadId}', '${input.runId}',
        'advance', 'advance-hash-${input.runId}', 'completed', 200, '{}', 7, '${NOW}', '${NOW}'
      );
      INSERT INTO collaboration_attempts (
        id, project_id, thread_id, run_id, agent_id, operation_id, status, lease_token,
        lease_expires_at, prompt_hash, acquire_execution_epoch, acquire_context_hash,
        included_message_sequence, error_category, started_at, finished_at
      ) VALUES (
        'attempt-${input.runId}', '${input.projectId}', '${input.threadId}', '${input.runId}',
        '${input.agentId}', 'advance-${input.runId}', 'committed', 'lease', '${NOW}',
        '${HASH}', 1, '${HASH}', 1, NULL, '${NOW}', '${NOW}'
      );
      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // A failed BEGIN leaves nothing to roll back.
    }
    throw error;
  } finally {
    database.close();
  }
}

function insertCall(
  databasePath: string,
  input: {
    callIndex: 1 | 2;
    completionTokens: number | null;
    id: string;
    kind: "primary" | "repair";
    promptTokens: number | null;
    runId: string;
    status: "succeeded" | "usage_invalid";
    totalTokens: number | null;
  },
): void {
  const database = openDatabase(databasePath);
  try {
    database.prepare(`
      INSERT INTO collaboration_model_calls (
        id, attempt_id, kind, call_index, status, prompt_tokens, completion_tokens,
        total_tokens, error_category, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      `attempt-${input.runId}`,
      input.kind,
      input.callIndex,
      input.status,
      input.promptTokens,
      input.completionTokens,
      input.totalTokens,
      input.status === "usage_invalid" ? "usage_invalid" : null,
      NOW,
    );
  } finally {
    database.close();
  }
}

describe("usage quota", () => {
  it("keeps project usage unknown without a project and never looks like an invoice", async () => {
    const databasePath = memoryDatabasePath();
    const service = await usageService();
    const usage = service.getUsageQuota(databasePath);

    expect(usage).toEqual({
      budgets: [],
      disclaimer: "not_invoice",
      project: {
        detail: "需要打开项目",
        projectId: null,
        totals: EMPTY_TOTALS,
      },
      providers: [],
      runs: [],
    });
  });

  it("scopes reported tokens to one project and does not invent missing usage", async () => {
    const service = await usageService();
    const databasePath = memoryDatabasePath();
    seedProjectGraph(databasePath, {
      agentId: "agent-a",
      projectId: "project-a",
      providerId: "provider-a",
      runId: "run-a",
      threadId: "thread-a",
    });
    seedProjectGraph(databasePath, {
      agentId: "agent-b",
      projectId: "project-b",
      providerId: "provider-b",
      runId: "run-b",
      threadId: "thread-b",
    });
    insertCall(databasePath, {
      callIndex: 1,
      completionTokens: 20,
      id: "call-a-ok",
      kind: "primary",
      promptTokens: 10,
      runId: "run-a",
      status: "succeeded",
      totalTokens: 30,
    });
    insertCall(databasePath, {
      callIndex: 2,
      completionTokens: null,
      id: "call-a-empty",
      kind: "repair",
      promptTokens: null,
      runId: "run-a",
      status: "succeeded",
      totalTokens: null,
    });
    const database = openDatabase(databasePath);
    try {
      database.prepare(`
        INSERT INTO collaboration_operations (
          id, project_id, thread_id, run_id, kind, request_hash, status, http_status,
          response_json, response_schema_version, created_at, updated_at
        ) VALUES (
          'advance-a-invalid', 'project-a', 'thread-a', 'run-a', 'advance',
          'advance-hash-a-invalid', 'completed', 200, '{}', 7, ?, ?
        )
      `).run(NOW, NOW);
      database.prepare(`
        INSERT INTO collaboration_attempts (
          id, project_id, thread_id, run_id, agent_id, operation_id, status, lease_token,
          lease_expires_at, prompt_hash, acquire_execution_epoch, acquire_context_hash,
          included_message_sequence, error_category, started_at, finished_at
        ) VALUES (
          'attempt-a-invalid', 'project-a', 'thread-a', 'run-a', 'agent-a',
          'advance-a-invalid', 'committed', 'lease', ?, ?, 1, ?, 1, NULL, ?, ?
        )
      `).run(NOW, HASH, HASH, NOW, NOW);
      database.prepare(`
        INSERT INTO collaboration_model_calls (
          id, attempt_id, kind, call_index, status, prompt_tokens, completion_tokens,
          total_tokens, error_category, created_at
        ) VALUES (
          'call-a-invalid', 'attempt-a-invalid', 'primary', 1, 'usage_invalid',
          NULL, NULL, NULL, 'usage_invalid', ?
        )
      `).run(NOW);
    } finally {
      database.close();
    }
    insertCall(databasePath, {
      callIndex: 1,
      completionTokens: 5,
      id: "call-b-ok",
      kind: "primary",
      promptTokens: 5,
      runId: "run-b",
      status: "succeeded",
      totalTokens: 10,
    });

    const emptyProject = createProject("Empty usage project", databasePath);
    const empty = service.getUsageQuota(databasePath, emptyProject.id);
    expect(empty.project).toEqual({
      detail: "尚无已报告用量",
      projectId: emptyProject.id,
      totals: EMPTY_TOTALS,
    });
    expect(empty.runs).toEqual([]);
    expect(empty.disclaimer).toBe("not_invoice");

    const usage = service.getUsageQuota(databasePath, "project-a");
    expect(usage.disclaimer).toBe("not_invoice");
    expect(usage.project).toEqual({
      detail: null,
      projectId: "project-a",
      totals: {
        completionTokens: 20,
        invalidCalls: 1,
        promptTokens: 10,
        totalTokens: 30,
        unreportedCalls: 1,
      },
    });
    expect(usage.runs).toEqual([
      {
        id: "run-a",
        roundCount: 3,
        roundLimit: 50,
        totals: {
          completionTokens: 20,
          invalidCalls: 1,
          promptTokens: 10,
          totalTokens: 30,
          unreportedCalls: 1,
        },
      },
    ]);
    expect(usage.providers).toEqual([
      {
        id: "provider-a",
        name: "Local provider-a",
        totals: {
          completionTokens: 20,
          invalidCalls: 1,
          promptTokens: 10,
          totalTokens: 30,
          unreportedCalls: 1,
        },
      },
    ]);
    expect(usage.budgets).toEqual([
      {
        agentId: "agent-a",
        maxHandoffs: 5,
        maxTokens: 1000,
        name: "Agent agent-a",
        usedTokens: 30,
      },
    ]);
    expect(() => service.getUsageQuota(databasePath, "missing-project")).toThrowError(
      /Project was not found/u,
    );
  });
});
