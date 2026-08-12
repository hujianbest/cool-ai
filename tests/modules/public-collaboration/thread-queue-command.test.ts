import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  cancelQueuedMessage,
  createThread,
  enqueueThreadMessage,
  listThreadQueue,
  reorderQueuedMessage,
  steerQueuedMessage,
  startThreadRun,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createMission } from "@/src/composition/mission-commands";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { CollaborationError } from "@/src/modules/public-collaboration";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-12T05:00:00.000Z";
const THREAD_OPERATION = "00000000-0000-4000-8000-000000003421";
const MASTER_KEY = Buffer.alloc(32, 41).toString("base64url");

let databasePath: string;

function seedProject(projectId: string): void {
  const database = openDatabase(databasePath);
  try {
    const encrypted = createCredentialVault().encrypt(`provider-${projectId}`, "provider-key");
    database.prepare(
      `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
       VALUES (?, ?, ?, NULL, NULL, 1)`,
    ).run(projectId, projectId, NOW);
    const providerId = `provider-${projectId}`;
    database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES (?, 'Provider', 'http://localhost/v1', 'model', ?, ?, ?,
         ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      providerId,
      encrypted.apiKeyCipher,
      encrypted.apiKeyIv,
      encrypted.apiKeyTag,
      encrypted.credentialVersion,
      1,
      encrypted.keyId,
      encrypted.apiKeyMask,
      NOW,
      NOW,
      NOW,
    );
    const insertAgent = database.prepare(
      `INSERT INTO agents(
         id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
         can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
         updated_at,review_capable
       ) VALUES (?, ?, 'Peer', 'Prompt', ?, 'model', 'A', 'sage',
         1, 1, 0, 1000, 3, 1, ?, ?, 0)`,
    );
    const insertMember = database.prepare(
      `INSERT INTO project_memberships(project_id,agent_id,joined_at)
       VALUES (?, ?, ?)`,
    );
    insertAgent.run("agent-a", "Agent A", providerId, NOW, NOW);
    insertAgent.run("agent-b", "Agent B", providerId, NOW, NOW);
    insertMember.run(projectId, "agent-a", NOW);
    insertMember.run(projectId, "agent-b", NOW);
  } finally {
    database.close();
  }
}

function threadVersion(projectId: string, threadId: string): number {
  const database = openDatabase(databasePath);
  try {
    const row = database.prepare(
      `SELECT version
       FROM collaboration_threads
       WHERE project_id=? AND id=?`,
    ).get(projectId, threadId) as { version: number };
    return row.version;
  } finally {
    database.close();
  }
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
});

afterEach(() => {
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("thread queue command seam", () => {
  it("enqueues once per operation id and conflicts on changed hash", () => {
    seedProject("project-a");
    const threadId = createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: THREAD_OPERATION,
      title: "Queue thread",
    }).body.thread.id;

    const first = enqueueThreadMessage(databasePath, "project-a", threadId, {
      content: " First queued input ",
      expectedVersion: 1,
      operationId: "00000000-0000-4000-8000-000000003422",
    });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(first.body.item.status).toBe("pending");
    expect(first.body.item.content).toBe("First queued input");
    expect(first.body.threadVersion).toBe(2);

    const replay = enqueueThreadMessage(databasePath, "project-a", threadId, {
      content: " First queued input ",
      expectedVersion: 1,
      operationId: "00000000-0000-4000-8000-000000003422",
    });
    expect(replay).toEqual(first);
    expect(listThreadQueue(databasePath, "project-a", threadId).body.items).toHaveLength(1);

    expect(() => enqueueThreadMessage(databasePath, "project-a", threadId, {
      content: "Changed body",
      expectedVersion: 1,
      operationId: "00000000-0000-4000-8000-000000003422",
    })).toThrowError(
      expect.objectContaining<Partial<CollaborationError>>({
        code: "OPERATION_CONFLICT",
      }),
    );
  });

  it("cancels pending, is idempotent on cancelled, and conflicts on consumed", () => {
    seedProject("project-a");
    const threadId = createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: THREAD_OPERATION,
      title: "Queue thread",
    }).body.thread.id;

    const queued = enqueueThreadMessage(databasePath, "project-a", threadId, {
      content: "cancel me",
      expectedVersion: 1,
      operationId: "00000000-0000-4000-8000-000000003423",
    }).body.item;
    expect(threadVersion("project-a", threadId)).toBe(2);

    const cancelFirst = cancelQueuedMessage(databasePath, "project-a", threadId, queued.id, {
      expectedVersion: 2,
      operationId: "00000000-0000-4000-8000-000000003424",
    });
    expect(cancelFirst.status).toBe(200);
    expect(cancelFirst.body.cancelled).toBe(true);
    expect(cancelFirst.body.item.status).toBe("cancelled");
    expect(cancelFirst.body.threadVersion).toBe(3);

    const cancelAgain = cancelQueuedMessage(databasePath, "project-a", threadId, queued.id, {
      expectedVersion: 3,
      operationId: "00000000-0000-4000-8000-000000003425",
    });
    expect(cancelAgain.status).toBe(200);
    expect(cancelAgain.body.cancelled).toBe(false);
    expect(cancelAgain.body.item.status).toBe("cancelled");
    expect(cancelAgain.body.threadVersion).toBe(3);

    const database = openDatabase(databasePath);
    try {
      database.prepare(
        `UPDATE thread_message_queue
         SET status='consumed'
         WHERE project_id=? AND thread_id=? AND id=?`,
      ).run("project-a", threadId, queued.id);
    } finally {
      database.close();
    }
    expect(() => cancelQueuedMessage(databasePath, "project-a", threadId, queued.id, {
      expectedVersion: 3,
      operationId: "00000000-0000-4000-8000-000000003426",
    })).toThrowError(
      expect.objectContaining<Partial<CollaborationError>>({
        code: "ACTION_CONFLICT",
      }),
    );
  });

  it("reorders only pending item with version conflict guard", () => {
    seedProject("project-a");
    const threadId = createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: THREAD_OPERATION,
      title: "Queue thread",
    }).body.thread.id;

    const first = enqueueThreadMessage(databasePath, "project-a", threadId, {
      content: "first pending",
      expectedVersion: 1,
      operationId: "00000000-0000-4000-8000-000000003427",
    }).body.item;
    const second = enqueueThreadMessage(databasePath, "project-a", threadId, {
      content: "second pending",
      expectedVersion: 2,
      operationId: "00000000-0000-4000-8000-000000003428",
    }).body.item;
    cancelQueuedMessage(databasePath, "project-a", threadId, first.id, {
      expectedVersion: 3,
      operationId: "00000000-0000-4000-8000-000000003429",
    });
    const third = enqueueThreadMessage(databasePath, "project-a", threadId, {
      content: "third pending",
      expectedVersion: 4,
      operationId: "00000000-0000-4000-8000-000000003430",
    }).body.item;

    expect(() => reorderQueuedMessage(databasePath, "project-a", threadId, second.id, {
      expectedVersion: 2,
      operationId: "00000000-0000-4000-8000-000000003431",
      position: 2,
    })).toThrowError(
      expect.objectContaining<Partial<CollaborationError>>({
        code: "VERSION_CONFLICT",
      }),
    );

    const reordered = reorderQueuedMessage(databasePath, "project-a", threadId, third.id, {
      expectedVersion: 5,
      operationId: "00000000-0000-4000-8000-000000003432",
      position: 1,
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.reordered).toBe(true);
    expect(reordered.body.threadVersion).toBe(6);
    expect(reordered.body.item.id).toBe(third.id);
    expect(reordered.body.item.position).toBe(2);

    const items = listThreadQueue(databasePath, "project-a", threadId).body.items;
    expect(items.map((item) => [item.id, item.position, item.status])).toEqual([
      [first.id, 1, "cancelled"],
      [third.id, 2, "pending"],
      [second.id, 3, "pending"],
    ]);
  });

  it("steers pending item to queue head with governance guard", () => {
    seedProject("project-a");
    const threadId = createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: THREAD_OPERATION,
      title: "Queue thread",
    }).body.thread.id;

    const first = enqueueThreadMessage(databasePath, "project-a", threadId, {
      content: "first pending",
      expectedVersion: 1,
      operationId: "00000000-0000-4000-8000-000000003435",
    }).body.item;
    const second = enqueueThreadMessage(databasePath, "project-a", threadId, {
      content: "second pending",
      expectedVersion: 2,
      operationId: "00000000-0000-4000-8000-000000003436",
    }).body.item;
    const bootstrap = openDatabase(databasePath);
    try {
      bootstrap.prepare(
        `UPDATE projects
         SET workspace_path=?,workspace_key=?
         WHERE id=?`,
      ).run("D:\\workspace", "workspace-project-a", "project-a");
    } finally {
      bootstrap.close();
    }
    createMission(databasePath, "project-a", {
      expectedVersion: 0,
      goal: "Queue steer mission",
      operationId: "00000000-0000-4000-8000-000000003498",
      title: "Queue steer mission",
    });

    const steered = steerQueuedMessage(databasePath, "project-a", threadId, second.id, {
      expectedVersion: 3,
      operationId: "00000000-0000-4000-8000-000000003437",
    });
    expect(steered.status).toBe(200);
    expect(steered.body.steered).toBe(true);
    expect(steered.body.item.id).toBe(second.id);
    expect(steered.body.item.position).toBe(1);
    expect(steered.body.threadVersion).toBe(4);

    const queueAfterSteer = listThreadQueue(databasePath, "project-a", threadId).body.items;
    expect(queueAfterSteer.map((item) => item.id)).toEqual([second.id, first.id]);
    const guardThreadId = createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: "00000000-0000-4000-8000-000000003497",
      title: "Guard thread",
    }).body.thread.id;

    startThreadRun(databasePath, "project-a", guardThreadId, {
      message: "guard run",
      operationId: "00000000-0000-4000-8000-000000003496",
    });

    expect(() => steerQueuedMessage(databasePath, "project-a", threadId, first.id, {
      expectedVersion: 4,
      operationId: "00000000-0000-4000-8000-000000003438",
    })).toThrowError(
      expect.objectContaining<Partial<CollaborationError>>({
        code: "ACTION_CONFLICT",
      }),
    );
  });

  it("consumes queue head once when starting run and replays idempotently", () => {
    seedProject("project-a");
    const threadId = createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: THREAD_OPERATION,
      title: "Queue thread",
    }).body.thread.id;
    enqueueThreadMessage(databasePath, "project-a", threadId, {
      content: "queued head",
      expectedVersion: 1,
      operationId: "00000000-0000-4000-8000-000000003433",
    });
    const database = openDatabase(databasePath);
    try {
      database.prepare(
        `UPDATE projects
         SET workspace_path=?,workspace_key=?
         WHERE id=?`,
      ).run("D:\\workspace", "workspace-project-a", "project-a");
    } finally {
      database.close();
    }
    createMission(databasePath, "project-a", {
      expectedVersion: 0,
      goal: "Queue start mission",
      operationId: "00000000-0000-4000-8000-000000003499",
      title: "Queue mission",
    });

    const firstStart = startThreadRun(databasePath, "project-a", threadId, {
      message: "manual fallback",
      operationId: "00000000-0000-4000-8000-000000003434",
    });
    expect(firstStart.status).toBe(201);
    expect(firstStart.body.message.content).toBe("queued head");
    expect(firstStart.body.message.mentionAgentId).toBeNull();

    const replay = startThreadRun(databasePath, "project-a", threadId, {
      message: "manual fallback",
      operationId: "00000000-0000-4000-8000-000000003434",
    });
    expect(replay).toEqual(firstStart);

    const queue = listThreadQueue(databasePath, "project-a", threadId).body.items;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ content: "queued head", position: 1, status: "consumed" });

    const verifyDatabase = openDatabase(databasePath);
    try {
      const count = verifyDatabase
        .prepare(
          `SELECT COUNT(*) AS total
           FROM collaboration_messages
           WHERE project_id=? AND thread_id=? AND content='queued head'`,
        )
        .get("project-a", threadId) as { total: number };
      expect(count.total).toBe(1);
    } finally {
      verifyDatabase.close();
    }
  });
});
