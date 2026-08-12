import { beforeEach, describe, expect, it } from "vitest";

import { CollaborationError } from "@/src/modules/public-collaboration";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { deleteThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-lifecycle-service";
import {
  createThread,
  listThreadQueue,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-12T01:00:00.000Z";
const THREAD_CREATE_OPERATION = "00000000-0000-4000-8000-000000003401";

let databasePath: string;

function seedProject(projectId: string): void {
  const database = openDatabase(databasePath);
  try {
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
       ) VALUES (?, 'Provider', 'http://localhost/v1', 'model', 'cipher', 'iv', 'tag',
         1, 1, 'key', '***', ?, 1, ?, ?)`,
    ).run(providerId, NOW, NOW, NOW);
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

beforeEach(() => {
  databasePath = memoryDatabasePath();
});

describe("thread queue query seam", () => {
  it("lists queue rows in deterministic position order with status", () => {
    seedProject("project-a");
    const threadId = createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: THREAD_CREATE_OPERATION,
      title: "Queue thread",
    }).body.thread.id;
    const database = openDatabase(databasePath);
    try {
      database.prepare(
        `INSERT INTO thread_message_queue(
           id,project_id,thread_id,content,position,status,operation_id,created_at,updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "queue-2",
        "project-a",
        threadId,
        "Second",
        2,
        "pending",
        "00000000-0000-4000-8000-000000003402",
        NOW,
        NOW,
      );
      database.prepare(
        `INSERT INTO thread_message_queue(
           id,project_id,thread_id,content,position,status,operation_id,created_at,updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "queue-1",
        "project-a",
        threadId,
        "First",
        1,
        "consumed",
        "00000000-0000-4000-8000-000000003403",
        NOW,
        NOW,
      );
      database.prepare(
        `INSERT INTO thread_message_queue(
           id,project_id,thread_id,content,position,status,operation_id,created_at,updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "queue-3",
        "project-a",
        threadId,
        "Third",
        3,
        "cancelled",
        "00000000-0000-4000-8000-000000003404",
        NOW,
        NOW,
      );
    } finally {
      database.close();
    }

    const result = listThreadQueue(databasePath, "project-a", threadId);
    expect(result.status).toBe(200);
    expect(result.body.items.map((item) => [item.id, item.position, item.status])).toEqual([
      ["queue-1", 1, "consumed"],
      ["queue-2", 2, "pending"],
      ["queue-3", 3, "cancelled"],
    ]);
  });

  it("returns thread_deleted not-found semantics for deleted threads", () => {
    seedProject("project-a");
    const threadId = createThread(databasePath, "project-a", {
      memberAgentIds: ["agent-a", "agent-b"],
      operationId: THREAD_CREATE_OPERATION,
      title: "Queue thread",
    }).body.thread.id;
    deleteThread(databasePath, "project-a", threadId);

    expect(() => listThreadQueue(databasePath, "project-a", threadId)).toThrowError(
      expect.objectContaining<Partial<CollaborationError>>({
        code: "RESOURCE_NOT_FOUND",
        details: { reason: "thread_deleted" },
      }),
    );
  });
});
