import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { controlThreadRun } from "@/src/adapters/outbound/sqlite/public-collaboration/run-service";
import {
  createThread,
  readThreadDetail,
  startThreadRun,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import {
  acquireAdvance,
  reconcileExpiredAttempt,
} from "@/src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createMission } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";

const NOW = "2026-08-08T08:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 23).toString("base64url");

let directory: string;
let databasePath: string;
let operationSequence: number;

function operationId(): string {
  operationSequence += 1;
  return `23000000-0000-4000-8000-${operationSequence.toString().padStart(12, "0")}`;
}

function seedProject(projectId: string, agentIds: [string, string]): void {
  const database = openDatabase(databasePath);
  const vault = createCredentialVault();
  try {
    database.prepare(
      `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
       VALUES (?,?,?,'D:\\workspace',?,1)`,
    ).run(projectId, projectId, NOW, `workspace-${projectId}`);
    const insertProvider = database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES (?,?,'http://127.0.0.1:1/v1','model',?,?,?,?,1,?,?,?,1,?,?)`,
    );
    const insertAgent = database.prepare(
      `INSERT INTO agents(
         id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
         can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
         updated_at,review_capable
       ) VALUES (?,?,'Peer','Prompt',?,'model','A','sage',
                 1,1,0,1000,3,1,?,?,0)`,
    );
    const insertMember = database.prepare(
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
    );
    agentIds.forEach((agentId, position) => {
      const providerId = `provider-${agentId}`;
      const encrypted = vault.encrypt(providerId, `key-${agentId}`);
      insertProvider.run(
        providerId,
        `Provider ${agentId}`,
        encrypted.apiKeyCipher,
        encrypted.apiKeyIv,
        encrypted.apiKeyTag,
        encrypted.credentialVersion,
        encrypted.keyId,
        encrypted.apiKeyMask,
        NOW,
        NOW,
        NOW,
      );
      insertAgent.run(agentId, `Agent ${agentId}`, providerId, NOW, NOW);
      insertMember.run(projectId, agentId, `2026-08-08T08:00:0${position}.000Z`);
    });
  } finally {
    database.close();
  }
  createMission(databasePath, projectId, {
    expectedVersion: 0,
    goal: `Goal ${projectId}`,
    operationId: operationId(),
    title: `Mission ${projectId}`,
  });
}

function newThread(projectId: string, title: string, agents: [string, string]): string {
  return createThread(databasePath, projectId, {
    memberAgentIds: agents,
    operationId: operationId(),
    title,
  }).body.thread.id;
}

function lifecycleState(projectId: string): unknown {
  const database = openDatabase(databasePath);
  try {
    return {
      attempts: database.prepare(
        `SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,status
         FROM collaboration_attempts WHERE project_id=? ORDER BY id`,
      ).all(projectId),
      facts: database.prepare(
        `SELECT id,thread_id AS threadId,run_id AS runId,message_id AS messageId,
                run_event_id AS runEventId,type,payload_json AS payload
         FROM collaboration_thread_facts WHERE project_id=? ORDER BY activity_sequence,id`,
      ).all(projectId),
      messages: database.prepare(
        `SELECT id,thread_id AS threadId,run_id AS runId,content
         FROM collaboration_messages WHERE project_id=? ORDER BY thread_id,sequence,id`,
      ).all(projectId),
      operations: database.prepare(
        `SELECT id,thread_id AS threadId,run_id AS runId,kind,status,
                http_status AS httpStatus,response_json AS response
         FROM collaboration_operations WHERE project_id=? ORDER BY id`,
      ).all(projectId),
      runs: database.prepare(
        `SELECT id,thread_id AS threadId,status,current_agent_id AS currentAgentId,
                version,execution_epoch AS executionEpoch
         FROM collaboration_runs WHERE project_id=? ORDER BY created_at,id`,
      ).all(projectId),
      threads: database.prepare(
        `SELECT id,next_fact_sequence AS nextFactSequence,
                last_activity_sequence AS lastActivitySequence,version
         FROM collaboration_threads WHERE project_id=? ORDER BY id`,
      ).all(projectId),
    };
  } finally {
    database.close();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  directory = mkdtempSync(join(tmpdir(), "multi-thread-run-lifecycle-"));
  databasePath = join(directory, "cockpit.sqlite");
  operationSequence = 2300;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("approved multi-thread CollaborationRun lifecycle", () => {
  it("keeps B writable but blocks its start and Agent dispatch with A's exact active tuple", () => {
    seedProject("project-a", ["agent-a", "agent-b"]);
    const threadA = newThread("project-a", "Thread A", ["agent-a", "agent-b"]);
    const threadB = newThread("project-a", "Thread B", ["agent-a", "agent-b"]);

    const oldB = startThreadRun(databasePath, "project-a", threadB, {
      message: "Historical B round",
      operationId: operationId(),
    }).body.run;
    controlThreadRun(databasePath, "project-a", threadB, oldB.id, {
      action: "stop",
      expectedVersion: oldB.version,
      operationId: operationId(),
    });
    const activeA = startThreadRun(databasePath, "project-a", threadA, {
      message: "A owns the active run",
      operationId: operationId(),
    }).body.run;

    const message = writeOwnerThreadMessage(databasePath, "project-a", threadB, {
      content: "B remains independently writable",
      operationId: operationId(),
    }).body;
    expect(message.run).toBeNull();
    expect(message.message).toMatchObject({ runId: null, threadId: threadB });
    expect(message.fact).toMatchObject({ runId: null, threadId: threadB });

    const detail = readThreadDetail(databasePath, "project-a", threadB, oldB.id).body;
    expect(detail.activeRun).toEqual({ runId: activeA.id, threadId: threadA });
    expect(detail.selectedRun?.id).toBe(oldB.id);
    expect(detail.readiness.dispatch).toBe("project_run_active");

    const beforeBlocked = lifecycleState("project-a");
    expect(() =>
      startThreadRun(databasePath, "project-a", threadB, {
        message: "Must not start",
        operationId: operationId(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "PROJECT_RUN_ACTIVE",
        details: { activeRunId: activeA.id, activeThreadId: threadA },
      }),
    );
    expect(() =>
      acquireAdvance(
        databasePath,
        { projectId: "project-a", runId: oldB.id, threadId: threadB },
        { operationId: operationId() },
        { clock: () => new Date(NOW), randomUUID },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "PROJECT_RUN_ACTIVE",
        details: { activeRunId: activeA.id, activeThreadId: threadA },
      }),
    );
    expect(lifecycleState("project-a")).toEqual(beforeBlocked);

    const activeAfterSwitch = readThreadDetail(
      databasePath,
      "project-a",
      threadA,
      activeA.id,
    ).body;
    expect(activeAfterSwitch.activeRun).toEqual({ runId: activeA.id, threadId: threadA });
    expect(activeAfterSwitch.selectedRun?.id).toBe(activeA.id);
    expect(lifecycleState("project-a")).toEqual(beforeBlocked);
  });

  it("continues and retries only the selected identity, then creates immutable new rounds", () => {
    seedProject("project-a", ["agent-a", "agent-b"]);
    const threadA = newThread("project-a", "Thread A", ["agent-a", "agent-b"]);
    const first = startThreadRun(databasePath, "project-a", threadA, {
      message: "First round source",
      operationId: operationId(),
    }).body;
    const sourceMessageId = first.message.id;
    const sourceFactIds = first.facts.map(({ id }) => id);

    const paused = controlThreadRun(databasePath, "project-a", threadA, first.run.id, {
      action: "pause",
      expectedVersion: 1,
      operationId: operationId(),
    }).body;
    const continued = controlThreadRun(databasePath, "project-a", threadA, first.run.id, {
      action: "continue",
      expectedVersion: paused.run.version,
      operationId: operationId(),
    }).body;
    expect(continued.run).toMatchObject({
      id: first.run.id,
      projectId: "project-a",
      status: "running",
      threadId: threadA,
    });

    const database = openDatabase(databasePath);
    try {
      database.prepare(
        `UPDATE collaboration_runs
         SET status='failed',pause_category='internal_failure'
         WHERE project_id=? AND thread_id=? AND id=?`,
      ).run("project-a", threadA, first.run.id);
    } finally {
      database.close();
    }
    const retryOperationId = operationId();
    const retryInput = {
      action: "retry" as const,
      expectedVersion: continued.run.version,
      operationId: retryOperationId,
    };
    const retried = controlThreadRun(
      databasePath,
      "project-a",
      threadA,
      first.run.id,
      retryInput,
    );
    expect(retried.body.run).toMatchObject({
      id: first.run.id,
      status: "running",
      threadId: threadA,
    });
    expect(
      controlThreadRun(databasePath, "project-a", threadA, first.run.id, retryInput),
    ).toEqual(retried);
    expect(() =>
      controlThreadRun(databasePath, "project-a", threadA, first.run.id, {
        ...retryInput,
        action: "pause",
      }),
    ).toThrowError(expect.objectContaining({ code: "OPERATION_CONFLICT" }));

    const stopped = controlThreadRun(databasePath, "project-a", threadA, first.run.id, {
      action: "stop",
      expectedVersion: retried.body.run.version,
      operationId: operationId(),
    }).body.run;
    expect(stopped).toMatchObject({ id: first.run.id, status: "stopped" });

    const second = startThreadRun(databasePath, "project-a", threadA, {
      message: "Second round source",
      operationId: operationId(),
    }).body;
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.run.threadId).toBe(threadA);
    controlThreadRun(databasePath, "project-a", threadA, second.run.id, {
      action: "stop",
      expectedVersion: second.run.version,
      operationId: operationId(),
    });
    const third = startThreadRun(databasePath, "project-a", threadA, {
      message: "Third round source",
      operationId: operationId(),
    }).body;
    expect(new Set([first.run.id, second.run.id, third.run.id]).size).toBe(3);

    const detail = readThreadDetail(databasePath, "project-a", threadA, first.run.id).body;
    expect(detail.runs).toHaveLength(3);
    expect(detail.selectedRun?.id).toBe(first.run.id);
    expect(detail.activeRun).toEqual({ runId: third.run.id, threadId: threadA });

    const persisted = openDatabase(databasePath);
    try {
      expect(persisted.prepare(
        `SELECT id,thread_id AS threadId,run_id AS runId
         FROM collaboration_messages WHERE id=?`,
      ).get(sourceMessageId)).toEqual({
        id: sourceMessageId,
        runId: first.run.id,
        threadId: threadA,
      });
      expect(persisted.prepare(
        `SELECT id,thread_id AS threadId,run_id AS runId
         FROM collaboration_thread_facts
         WHERE id IN (${sourceFactIds.map(() => "?").join(",")})
         ORDER BY sequence`,
      ).all(...sourceFactIds)).toEqual(
        sourceFactIds.map((id) => ({ id, runId: first.run.id, threadId: threadA })),
      );
    } finally {
      persisted.close();
    }
  });

  it("reconciles the exact run after restart and keeps active/current returns deterministic", () => {
    seedProject("project-a", ["agent-a", "agent-b"]);
    const threadA = newThread("project-a", "Thread A", ["agent-a", "agent-b"]);
    const threadB = newThread("project-a", "Thread B", ["agent-a", "agent-b"]);
    const active = startThreadRun(databasePath, "project-a", threadA, {
      message: "Pending dispatch",
      operationId: operationId(),
    }).body.run;
    const advanceOperationId = operationId();
    const acquired = acquireAdvance(
      databasePath,
      { projectId: "project-a", runId: active.id, threadId: threadA },
      { operationId: advanceOperationId },
      { clock: () => new Date(NOW), randomUUID },
    );
    expect(acquired.kind).toBe("acquired");

    const reconciled = reconcileExpiredAttempt(
      databasePath,
      { projectId: "project-a", runId: active.id, threadId: threadA },
      {
        clock: () => new Date("2026-08-08T08:03:00.000Z"),
        randomUUID,
      },
    );
    expect(reconciled).toMatchObject({
      affectedRows: 1,
      attempt: { status: "interrupted" },
      run: {
        id: active.id,
        pauseCategory: "interrupted",
        status: "paused",
        threadId: threadA,
      },
    });

    const afterReconcile = lifecycleState("project-a");
    const selected = readThreadDetail(databasePath, "project-a", threadA, active.id).body;
    const other = readThreadDetail(databasePath, "project-a", threadB, null).body;
    expect(selected.activeRun).toEqual({ runId: active.id, threadId: threadA });
    expect(selected.selectedRun?.id).toBe(active.id);
    expect(selected.readiness.dispatch).not.toBe("project_run_active");
    expect(other.activeRun).toEqual({ runId: active.id, threadId: threadA });
    expect(other.selectedRun).toBeNull();
    expect(other.readiness.dispatch).toBe("project_run_active");
    expect(lifecycleState("project-a")).toEqual(afterReconcile);

    const replay = acquireAdvance(
      databasePath,
      { projectId: "project-a", runId: active.id, threadId: threadA },
      { operationId: advanceOperationId },
      { clock: () => new Date("2026-08-08T08:04:00.000Z"), randomUUID },
    );
    expect(replay).toMatchObject({
      body: { attemptStatus: "interrupted", run: { id: active.id, threadId: threadA } },
      kind: "replayed",
      status: 200,
    });
    expect(lifecycleState("project-a")).toEqual(afterReconcile);
  });

  it("isolates active ownership and identities across projects", () => {
    seedProject("project-a", ["agent-a", "agent-b"]);
    seedProject("project-b", ["agent-c", "agent-d"]);
    const threadA = newThread("project-a", "Thread A", ["agent-a", "agent-b"]);
    const threadB = newThread("project-b", "Thread B", ["agent-c", "agent-d"]);
    const runA = startThreadRun(databasePath, "project-a", threadA, {
      message: "A active",
      operationId: operationId(),
    }).body.run;
    const beforeA = lifecycleState("project-a");
    const runB = startThreadRun(databasePath, "project-b", threadB, {
      message: "B independently active",
      operationId: operationId(),
    }).body.run;
    expect(runA.projectId).toBe("project-a");
    expect(runB.projectId).toBe("project-b");
    expect(runB.id).not.toBe(runA.id);
    expect(lifecycleState("project-a")).toEqual(beforeA);
    expect(readThreadDetail(databasePath, "project-a", threadA, runA.id).body.activeRun)
      .toEqual({ runId: runA.id, threadId: threadA });
    expect(readThreadDetail(databasePath, "project-b", threadB, runB.id).body.activeRun)
      .toEqual({ runId: runB.id, threadId: threadB });

    expect(() =>
      readThreadDetail(databasePath, "project-a", threadA, runB.id),
    ).toThrowError(expect.objectContaining({ code: "RESOURCE_NOT_FOUND" }));
    expect(() =>
      controlThreadRun(databasePath, "project-a", threadA, runB.id, {
        action: "pause",
        expectedVersion: 1,
        operationId: operationId(),
      }),
    ).toThrowError(expect.objectContaining({ code: "RESOURCE_NOT_FOUND" }));
  });
});
