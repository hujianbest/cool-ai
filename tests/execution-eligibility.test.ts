// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExecutionPanel } from "@/components/execution/execution-panel";
import { openDatabase } from "@/src/server/db";
import { startExecution } from "@/src/server/execution/execution-service";

const PROJECT_ID = "eligibility-project";
const RUN_ID = "eligibility-run";
const NOW = "2026-07-30T03:00:00.000Z";
const EMPTY_POLICY_HASH =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

let directory: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-execution-eligibility-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_EXECUTION_ROOT = join(directory, "executions");
  seedProject();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_EXECUTION_ROOT;
  rmSync(directory, { force: true, recursive: true });
});

function seedProject(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec(`
      INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
      VALUES ('${PROJECT_ID}','Eligibility','${NOW}','D:\\workspace','d:/workspace',1);
      INSERT INTO providers (
        id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
        credential_version,credential_generation,key_id,api_key_mask,verified_at,
        version,created_at,updated_at
      ) VALUES
        ('provider-a','A','http://127.0.0.1:4000/v1','model','c','i','t',1,1,'k','***','${NOW}',1,'${NOW}','${NOW}'),
        ('provider-b','B','http://127.0.0.1:4001/v1','model','c','i','t',1,1,'k','***','${NOW}',1,'${NOW}','${NOW}'),
        ('provider-c','C','http://127.0.0.1:4002/v1','model','c','i','t',1,1,'k','***','${NOW}',1,'${NOW}','${NOW}');
      INSERT INTO agents (
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
      ) VALUES
        ('agent-a','Alpha','Builder','private','provider-a','model','A','sage',1,1,0,1000,5,1,'${NOW}','${NOW}'),
        ('agent-b','Beta','Builder','private','provider-b','model','B','amber',1,1,0,1000,5,1,'${NOW}','${NOW}'),
        ('agent-c','Gamma','Builder','private','provider-c','model','C','ocean',1,1,0,1000,5,1,'${NOW}','${NOW}');
      INSERT INTO project_memberships (project_id,agent_id,joined_at) VALUES
        ('${PROJECT_ID}','agent-a','${NOW}'),('${PROJECT_ID}','agent-b','${NOW}'),
        ('${PROJECT_ID}','agent-c','${NOW}');
      INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
      VALUES ('mission','${PROJECT_ID}','Mission','Ship',1,'${NOW}','${NOW}');
      INSERT INTO collaboration_runs (
        id,project_id,status,current_agent_id,round_count,next_event_sequence,
        version,execution_epoch,pause_reason,pause_category,created_at,updated_at
      ) VALUES ('${RUN_ID}','${PROJECT_ID}','planned','agent-a',1,20,2,1,NULL,NULL,'${NOW}','${NOW}');
      INSERT INTO collaboration_project_sequences (project_id,next_message_sequence)
      VALUES ('${PROJECT_ID}',2);
      INSERT INTO collaboration_operations (
        id,project_id,run_id,kind,request_hash,status,http_status,response_json,created_at,updated_at
      ) VALUES
        ('plan-op','${PROJECT_ID}','${RUN_ID}','advance','hash-a','completed',200,'{}','${NOW}','${NOW}'),
        ('plan-op-b','${PROJECT_ID}','${RUN_ID}','advance','hash-b','completed',200,'{}','${NOW}','${NOW}'),
        ('plan-op-c','${PROJECT_ID}','${RUN_ID}','advance','hash-c','completed',200,'{}','${NOW}','${NOW}');
      INSERT INTO collaboration_messages (
        id,project_id,run_id,author_type,author_agent_id,author_display_name,
        content,mention_agent_id,mention_display_name,sequence,consumed_at,created_at
      ) VALUES
        ('plan-message','${PROJECT_ID}','${RUN_ID}','agent','agent-a','Alpha','ready',NULL,NULL,1,NULL,'${NOW}'),
        ('plan-message-b','${PROJECT_ID}','${RUN_ID}','agent','agent-b','Beta','ready',NULL,NULL,2,NULL,'${NOW}'),
        ('plan-message-c','${PROJECT_ID}','${RUN_ID}','agent','agent-c','Gamma','ready',NULL,NULL,3,NULL,'${NOW}');
      INSERT INTO collaboration_attempts (
        id,project_id,run_id,agent_id,operation_id,status,lease_token,lease_expires_at,
        prompt_hash,acquire_execution_epoch,acquire_context_hash,included_message_sequence,
        error_category,started_at,finished_at
      ) VALUES
        ('plan-attempt','${PROJECT_ID}','${RUN_ID}','agent-a','plan-op','committed',
          'lease-a','${NOW}','prompt-a',1,'context-a',1,NULL,'${NOW}','${NOW}'),
        ('plan-attempt-b','${PROJECT_ID}','${RUN_ID}','agent-b','plan-op-b','committed',
          'lease-b','${NOW}','prompt-b',1,'context-b',2,NULL,'${NOW}','${NOW}'),
        ('plan-attempt-c','${PROJECT_ID}','${RUN_ID}','agent-c','plan-op-c','committed',
          'lease-c','${NOW}','prompt-c',1,'context-c',3,NULL,'${NOW}','${NOW}');
      INSERT INTO collaboration_turns (
        id,attempt_id,run_id,agent_id,round_number,message_id,disposition,created_at
      ) VALUES
        ('plan-turn','plan-attempt','${RUN_ID}','agent-a',1,'plan-message','plan_ready','${NOW}'),
        ('plan-turn-b','plan-attempt-b','${RUN_ID}','agent-b',2,'plan-message-b','plan_ready','${NOW}'),
        ('plan-turn-c','plan-attempt-c','${RUN_ID}','agent-c',3,'plan-message-c','plan_ready','${NOW}');
      INSERT INTO project_validation_policy_revisions (
        id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
        classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
      ) VALUES ('policy','${PROJECT_ID}',NULL,'system',1,'${EMPTY_POLICY_HASH}',1,0,2,0,'${NOW}');
      INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
      VALUES ('${PROJECT_ID}','policy',1,'${NOW}');
    `);
  } finally {
    database.close();
  }
}

function addTask(
  id: string,
  agentId: string | null,
  status = "in_progress",
  dependencies: string[] = [],
): void {
  const database = openDatabase(databasePath);
  try {
    database.prepare(
      `INSERT INTO work_items (
         id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,1,?,?)`,
    ).run(id, "mission", id, "", status, agentId, NOW, NOW);
    for (const dependencyId of dependencies) {
      database.prepare(
        "INSERT INTO work_item_dependencies (work_item_id,depends_on_id) VALUES (?,?)",
      ).run(id, dependencyId);
    }
    if (agentId) {
      database.prepare(
        `INSERT INTO collaboration_events (
           id,run_id,sequence,type,actor_type,actor_id,payload_json,created_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        `claim-${id}`,
        RUN_ID,
        2 + Number(database.prepare(
          "SELECT COUNT(*) AS count FROM collaboration_events WHERE run_id=?",
        ).get(RUN_ID)!.count),
        "task_claimed",
        "agent",
        agentId,
        JSON.stringify({
          turnId: agentId === "agent-b"
            ? "plan-turn-b"
            : agentId === "agent-c"
              ? "plan-turn-c"
              : "plan-turn",
          workItemId: id,
          agentId,
        }),
        NOW,
      );
    }
  } finally {
    database.close();
  }
}

function operationId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function start(id: string, operation: string) {
  return startExecution(
    databasePath,
    PROJECT_ID,
    { operationId: operation, sourceCollaborationRunId: RUN_ID, workItemId: id },
    async () => {
      throw new Error("sandbox held by eligibility test");
    },
    join(directory, "executions"),
  );
}

function executionCount(): number {
  const database = openDatabase(databasePath);
  try {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM executions").get()!.count);
  } finally {
    database.close();
  }
}

describe("execution start eligibility", () => {
  it("strictly rejects task arrays without creating work", async () => {
    const route = await import("@/app/api/projects/[projectId]/executions/route");
    const response = await route.POST(
      new Request(`http://localhost/api/projects/${PROJECT_ID}/executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: operationId(1),
          sourceCollaborationRunId: RUN_ID,
          workItemId: ["one", "two"],
        }),
      }),
      { params: Promise.resolve({ projectId: PROJECT_ID }) },
    );
    expect(response.status).toBe(400);
    expect(executionCount()).toBe(0);
  });

  it.each([
    ["missing", null, "in_progress", "NOT_FOUND"],
    ["todo", "agent-a", "todo", "NOT_IN_PROGRESS"],
    ["unassigned", null, "in_progress", "UNASSIGNED"],
  ])("persists and exactly replays the %s rejection", async (id, agentId, status, code) => {
    if (id !== "missing") addTask(id, agentId, status);
    const first = await start(id, operationId(10));
    const replay = await start(id, operationId(10));
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: 409,
      body: { rejection: { code, workItemId: id } },
    });
    expect(executionCount()).toBe(0);
  });

  it("requires current membership, done dependencies, latest planned run, and project readiness", async () => {
    addTask("dependency", "agent-b", "in_progress");
    addTask("blocked", "agent-a", "in_progress", ["dependency"]);
    await expect(start("blocked", operationId(20))).resolves.toMatchObject({
      body: { rejection: { code: "DEPENDENCY_NOT_DONE" } },
    });

    const database = openDatabase(databasePath);
    try {
      database.prepare("UPDATE work_items SET status='done' WHERE id='dependency'").run();
      database.prepare(
        "DELETE FROM project_memberships WHERE project_id=? AND agent_id='agent-a'",
      ).run(PROJECT_ID);
    } finally {
      database.close();
    }
    await expect(start("blocked", operationId(21))).resolves.toMatchObject({
      body: { rejection: { code: "ASSIGNEE_NOT_MEMBER" } },
    });
  });

  it("atomically enforces project two, task one, Agent one, and DAG-unrelated selections", async () => {
    addTask("a1", "agent-a");
    addTask("a2", "agent-a");
    addTask("b1", "agent-b");
    addTask("b2", "agent-b");
    addTask("c1", "agent-c");

    await Promise.allSettled([
      start("a1", operationId(30)),
      start("a1", operationId(31)),
      start("a2", operationId(32)),
      start("b1", operationId(33)),
      start("b2", operationId(34)),
      start("c1", operationId(35)),
    ]);

    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM executions
         WHERE status IN ('queued','running','waiting_approval','paused','staged')`,
      ).get()).toEqual({ count: 2 });
      expect(database.prepare(
        `SELECT work_item_id AS workItemId,agent_id AS agentId FROM executions ORDER BY agent_id`,
      ).all()).toEqual([
        { agentId: "agent-a", workItemId: "a1" },
        { agentId: "agent-b", workItemId: "b1" },
      ]);
      const rejected = database.prepare(
        `SELECT id,response_json AS responseJson FROM execution_operations
         WHERE status='completed' ORDER BY id`,
      ).all() as Array<{ id: string; responseJson: string }>;
      expect(rejected.map(({ id, responseJson }) => [
        id,
        JSON.parse(responseJson).rejection.code,
      ])).toEqual(expect.arrayContaining([
        [operationId(31), "TASK_ACTIVE"],
        [operationId(32), "AGENT_ACTIVE"],
        [operationId(34), "AGENT_ACTIVE"],
        [operationId(35), "PROJECT_LIMIT"],
      ]));
    } finally {
      database.close();
    }
  });

  it("rejects a dependency relationship introduced beside an active execution", async () => {
    addTask("active", "agent-a");
    await expect(start("active", operationId(40))).rejects.toThrow(
      "sandbox held by eligibility test",
    );
    addTask("related", "agent-b");
    const database = openDatabase(databasePath);
    try {
      database.prepare("UPDATE work_items SET status='done' WHERE id='active'").run();
      database.prepare(
        "INSERT INTO work_item_dependencies (work_item_id,depends_on_id) VALUES ('related','active')",
      ).run();
    } finally {
      database.close();
    }
    await expect(start("related", operationId(41))).resolves.toMatchObject({
      body: { rejection: { code: "RELATED_SELECTION" } },
    });
  });
});

describe("execution selection UI", () => {
  it("starts two selections concurrently with independent operation ids and retries only the failed operation", async () => {
    const user = userEvent.setup();
    const pending: Array<() => void> = [];
    const postBodies: Array<{ operationId: string; workItemId: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/executions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { operationId: string; workItemId: string };
        postBodies.push(body);
        if (postBodies.length <= 2) {
          await new Promise<void>((resolve) => pending.push(resolve));
          return body.workItemId === "task-a"
            ? Response.json({ execution: { id: "execution-a" } }, { status: 201 })
            : Response.json(
                { rejection: { workItemId: "task-b", code: "PROJECT_LIMIT", messageKey: "project_limit" } },
                { status: 409 },
              );
        }
        return Response.json({ execution: { id: "execution-b" } }, { status: 201 });
      }
      if (url.endsWith("/mission")) {
        return Response.json({
          mission: { id: "mission" },
          workItems: [
            { id: "task-a", title: "Task A", status: "in_progress", assigneeAgentId: "agent-a", dependencyIds: [] },
            { id: "task-b", title: "Task B", status: "in_progress", assigneeAgentId: "agent-b", dependencyIds: [] },
            { id: "task-c", title: "Task C", status: "in_progress", assigneeAgentId: "agent-c", dependencyIds: [] },
          ],
        });
      }
      if (url.endsWith("/collaboration")) {
        return Response.json({ run: { id: RUN_ID, status: "planned" } });
      }
      if (url.endsWith("/executions")) return Response.json({ executions: [] });
      throw new Error(`Unexpected request ${url}`);
    }));

    render(createElement(ExecutionPanel, { projectId: PROJECT_ID }));
    await user.click(await screen.findByRole("checkbox", { name: "Task A" }));
    await user.click(screen.getByRole("checkbox", { name: "Task B" }));
    expect(screen.getByRole("checkbox", { name: "Task C" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "开始执行所选任务" }));
    await waitFor(() => expect(postBodies).toHaveLength(2));
    expect(new Set(postBodies.map(({ operationId }) => operationId)).size).toBe(2);
    expect(screen.getAllByText("正在启动…")).toHaveLength(2);

    pending.splice(0).forEach((release) => release());
    expect(await screen.findByText("Task A 已启动")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Task B");
    await user.click(screen.getByRole("button", { name: "重试 Task B" }));
    await waitFor(() => expect(postBodies).toHaveLength(3));
    expect(postBodies[2].operationId).toBe(postBodies[1].operationId);
    expect(postBodies[2].operationId).not.toBe(postBodies[0].operationId);
  });
});
