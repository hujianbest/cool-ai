import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createV6FixtureDatabaseOpener } from "@/tests/v6-fixture-db";

const openDatabase = createV6FixtureDatabaseOpener({
  missingDeliveryHeadMissionIds: ["mission-execution"],
  missingReviewHeadResultIds: [],
});

type RouteContext = { params: Promise<{ projectId: string }> };
type ExecutionRoute = {
  GET: (request: Request, context: RouteContext) => Promise<Response>;
  POST: (request: Request, context: RouteContext) => Promise<Response>;
};
type SandboxModule = {
  setSandboxExecutorForTests: (
    executor: (() => Promise<never>) | null,
  ) => void;
};

const PROJECT_ID = "project-execution-slice";
const RUN_ID = "run-execution-slice";
const WORK_ITEM_ID = "work-item-execution-slice";
const OPERATION_ID = "00000000-0000-4000-8000-000000005002";
const NOW = "2026-07-30T02:00:00.000Z";

let directory: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-execution-slice-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_EXECUTION_ROOT = join(directory, "executions");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  try {
    const moduleId = "@/src/server/execution/sandbox-executor";
    const sandbox = (await import(/* @vite-ignore */ moduleId)) as SandboxModule;
    sandbox.setSandboxExecutorForTests(null);
  } catch {
    // RED can run before the execution module exists.
  }
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_EXECUTION_ROOT;
  rmSync(directory, { force: true, recursive: true });
});

async function executionRoute(): Promise<ExecutionRoute> {
  const routeId = "@/app/api/projects/[projectId]/executions/route";
  try {
    return (await import(/* @vite-ignore */ routeId)) as ExecutionRoute;
  } catch {
    expect.fail("The project execution route is unavailable.");
  }
}

async function executionPanel(): Promise<ComponentType<{ projectId: string }>> {
  const componentId = "@/components/execution/execution-panel";
  try {
    const module = (await import(/* @vite-ignore */ componentId)) as {
      ExecutionPanel: ComponentType<{ projectId: string }>;
    };
    return module.ExecutionPanel;
  } catch {
    expect.fail("The execution panel is unavailable.");
  }
}

async function sandboxModule(): Promise<SandboxModule> {
  const moduleId = "@/src/server/execution/sandbox-executor";
  try {
    return (await import(/* @vite-ignore */ moduleId)) as SandboxModule;
  } catch {
    expect.fail("The injectable sandbox executor is unavailable.");
  }
}

function seedEligibleTask(): void {
  const database = openDatabase(databasePath);
  const emptyPolicyHash =
    "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
  try {
    database.exec(`
      INSERT INTO projects (
        id, name, created_at, workspace_path, workspace_key, version
      ) VALUES (
        '${PROJECT_ID}', 'Execution project', '${NOW}',
        'D:\\workspace', 'd:/workspace', 1
      );
      INSERT INTO providers (
        id, name, base_url, default_model, api_key_cipher, api_key_iv,
        api_key_tag, credential_version, credential_generation, key_id,
        api_key_mask, verified_at, version, created_at, updated_at
      ) VALUES (
        'provider-execution', 'Local', 'http://127.0.0.1:4000/v1', 'model',
        'cipher', 'iv', 'tag', 1, 1, 'key', '***', '${NOW}', 1, '${NOW}', '${NOW}'
      );
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text,
        accent_token, can_read, can_write, can_execute, max_tokens,
        max_handoffs, version, created_at, updated_at
      ) VALUES (
        'agent-execution', 'Alpha', 'Builder', 'private',
        'provider-execution', 'model', 'A', 'sage', 1, 1, 0,
        1000, 5, 1, '${NOW}', '${NOW}'
      );
      INSERT INTO project_memberships (project_id, agent_id, joined_at)
      VALUES ('${PROJECT_ID}', 'agent-execution', '${NOW}');
      INSERT INTO missions (
        id, project_id, title, goal, version, created_at, updated_at
      ) VALUES (
        'mission-execution', '${PROJECT_ID}', 'Build', 'Build safely',
        1, '${NOW}', '${NOW}'
      );
      INSERT INTO work_items (
        id, mission_id, title, description, status, assignee_agent_id,
        version, created_at, updated_at
      ) VALUES (
        '${WORK_ITEM_ID}', 'mission-execution', 'Implement the slice', '',
        'in_progress', 'agent-execution', 2, '${NOW}', '${NOW}'
      );
      INSERT INTO collaboration_runs (
        id, project_id, status, current_agent_id, round_count,
        next_event_sequence, version, execution_epoch, pause_reason,
        pause_category, created_at, updated_at
      ) VALUES (
        '${RUN_ID}', '${PROJECT_ID}', 'planned', 'agent-execution', 1,
        3, 2, 1, NULL, NULL, '${NOW}', '${NOW}'
      );
      INSERT INTO collaboration_project_sequences (
        project_id, next_message_sequence
      ) VALUES ('${PROJECT_ID}', 2);
      INSERT INTO collaboration_operations (
        id, project_id, run_id, kind, request_hash, status,
        http_status, response_json, created_at, updated_at
      ) VALUES (
        'plan-operation', '${PROJECT_ID}', '${RUN_ID}', 'advance',
        'plan-request-hash', 'completed', 200, '{}', '${NOW}', '${NOW}'
      );
      INSERT INTO collaboration_messages (
        id, project_id, run_id, author_type, author_agent_id,
        author_display_name, content, mention_agent_id, mention_display_name,
        sequence, consumed_at, created_at
      ) VALUES (
        'plan-message', '${PROJECT_ID}', '${RUN_ID}', 'agent',
        'agent-execution', 'Alpha', 'Plan ready', NULL, NULL, 1, NULL, '${NOW}'
      );
      INSERT INTO collaboration_attempts (
        id, project_id, run_id, agent_id, operation_id, status,
        lease_token, lease_expires_at, prompt_hash, acquire_execution_epoch,
        acquire_context_hash, included_message_sequence, error_category,
        started_at, finished_at
      ) VALUES (
        'plan-attempt', '${PROJECT_ID}', '${RUN_ID}', 'agent-execution',
        'plan-operation', 'committed', 'plan-lease', '${NOW}', 'prompt',
        1, 'context', 1, NULL, '${NOW}', '${NOW}'
      );
      INSERT INTO collaboration_turns (
        id, attempt_id, run_id, agent_id, round_number, message_id,
        disposition, created_at
      ) VALUES (
        'plan-turn', 'plan-attempt', '${RUN_ID}', 'agent-execution', 1,
        'plan-message', 'plan_ready', '${NOW}'
      );
      INSERT INTO collaboration_events (
        id, run_id, sequence, type, actor_type, actor_id, payload_json, created_at
      ) VALUES (
        'claim-event', '${RUN_ID}', 1, 'task_claimed', 'agent',
        'agent-execution',
        '{"turnId":"plan-turn","workItemId":"${WORK_ITEM_ID}","agentId":"agent-execution"}',
        '${NOW}'
      );
      INSERT INTO project_validation_policy_revisions (
        id, project_id, created_operation_id, created_actor_type, revision_no,
        policy_hash, classifier_version, warning_accepted, canonical_bytes,
        entry_count, created_at
      ) VALUES (
        'policy-execution', '${PROJECT_ID}', NULL, 'system', 1,
        '${emptyPolicyHash}', 1, 0, 2, 0, '${NOW}'
      );
      INSERT INTO project_validation_policies (
        project_id, active_revision_id, version, updated_at
      ) VALUES ('${PROJECT_ID}', 'policy-execution', 1, '${NOW}');
    `);
  } finally {
    database.close();
  }
}

function deferredSandbox() {
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const executor = vi.fn(() => {
    entered();
    return new Promise<never>(() => undefined);
  });
  return { enteredPromise, executor };
}

async function startPendingExecution(): Promise<{ responsePromise: Promise<Response> }> {
  const deferred = deferredSandbox();
  (await sandboxModule()).setSandboxExecutorForTests(deferred.executor);
  const route = await executionRoute();
  const responsePromise = route.POST(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/executions`, {
      body: JSON.stringify({
        operationId: OPERATION_ID,
        sourceCollaborationRunId: RUN_ID,
        workItemId: WORK_ITEM_ID,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ projectId: PROJECT_ID }) },
  );
  const first = await Promise.race([
    deferred.enteredPromise.then(() => null),
    responsePromise,
  ]);
  if (first instanceof Response) {
    expect.fail(`Start returned before sandbox execution: ${await first.text()}`);
  }
  expect(deferred.executor).toHaveBeenCalledTimes(1);
  return { responsePromise };
}

async function getExecutions(): Promise<Response> {
  const route = await executionRoute();
  return route.GET(
    new Request(`http://localhost/api/projects/${PROJECT_ID}/executions`),
    { params: Promise.resolve({ projectId: PROJECT_ID }) },
  );
}

function installExecutionFetch(
  get: () => Promise<Response> = getExecutions,
) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === `/api/projects/${PROJECT_ID}/executions`) return get();
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("execution T-2 vertical slice", () => {
  it("persists queued execution, preparing attempt, pending receipt, and running sandbox action before start returns", async () => {
    seedEligibleTask();
    const { responsePromise } = await startPendingExecution();
    let settled = false;
    void responsePromise.finally(() => {
      settled = true;
    });

    const read = await getExecutions();
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      executions: [
        expect.objectContaining({
          agent: {
            accentToken: "sage",
            avatarText: "A",
            id: "agent-execution",
            name: "Alpha",
          },
          businessDeadlineAt: null,
          currentAction: expect.objectContaining({
            actionIndex: 0,
            kind: "sandbox_build",
            startedAt: expect.any(String),
          }),
          firstRunningAt: null,
          status: "queued",
          workItem: { id: WORK_ITEM_ID, title: "Implement the slice" },
        }),
      ],
    });

    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(
        `SELECT status, http_status AS httpStatus, response_json AS responseJson
         FROM execution_operations WHERE project_id=? AND id=?`,
      ).get(PROJECT_ID, OPERATION_ID)).toEqual({
        httpStatus: null,
        responseJson: null,
        status: "pending",
      });
      expect(database.prepare(
        `SELECT status FROM execution_attempts WHERE project_id=?`,
      ).get(PROJECT_ID)).toEqual({ status: "preparing" });
      expect(database.prepare(
        `SELECT kind, status FROM execution_actions WHERE project_id=?`,
      ).get(PROJECT_ID)).toEqual({ kind: "sandbox_build", status: "running" });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM execution_events
         WHERE project_id=? AND type='sandbox_ready'`,
      ).get(PROJECT_ID)).toEqual({ count: 0 });
    } finally {
      database.close();
    }
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("renders route-backed loading, empty, error recovery, queued preparation, and refresh rehydration", async () => {
    seedEligibleTask();
    const Panel = await executionPanel();
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    installExecutionFetch(async () => {
      await loadGate;
      return Response.json({ executions: [] });
    });

    const loadingView = render(createElement(Panel, { projectId: PROJECT_ID }));
    expect(screen.getByText("正在加载执行…")).toBeInTheDocument();
    expect(screen.queryByText("尚无执行。")).not.toBeInTheDocument();
    releaseLoad();
    expect(await screen.findByText("尚无执行。")).toBeInTheDocument();
    loadingView.unmount();

    const user = userEvent.setup();
    let failOnce = true;
    installExecutionFetch(async () => {
      if (failOnce) {
        failOnce = false;
        return Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "Storage unavailable." } },
          { status: 503 },
        );
      }
      return Response.json({ executions: [] });
    });
    const errorView = render(createElement(Panel, { projectId: PROJECT_ID }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "服务暂时不可用，请稍后重试。",
    );
    await user.click(screen.getByRole("button", { name: "重试加载执行" }));
    expect(await screen.findByText("尚无执行。")).toBeInTheDocument();
    errorView.unmount();

    await startPendingExecution();
    installExecutionFetch();
    const firstQueuedView = render(createElement(Panel, { projectId: PROJECT_ID }));
    const heading = await screen.findByRole("heading", {
      name: "Implement the slice",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText("排队中")).toBeInTheDocument();
    expect(screen.getByText("正在准备隔离区")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "刷新执行" });
    expect(retryButton).toHaveStyle({ minHeight: "var(--control-min)" });
    firstQueuedView.unmount();

    render(createElement(Panel, { projectId: PROJECT_ID }));
    expect(await screen.findByRole("heading", {
      name: "Implement the slice",
    })).toBeInTheDocument();
    expect(screen.getByText("正在准备隔离区")).toBeInTheDocument();
  });
});
