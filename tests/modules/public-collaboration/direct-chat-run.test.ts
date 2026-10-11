import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  createThread,
  startThreadRun,
  writeOwnerThreadMessage,
} from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { getCollaboration } from "@/src/adapters/outbound/sqlite/public-collaboration/run-service";
import {
  acquireAdvance,
  finalizeAdvance,
} from "@/src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator";
import type { StructuredTurnResult } from "@/src/modules/public-collaboration";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { createMission } from "@/src/composition/mission-commands";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-08T08:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 29).toString("base64url");
const PROJECT_ID = "project-direct-chat";
const AGENT_ID = "agent-direct-assistant";

let databasePath: string;

function operationId(): string {
  return randomUUID();
}

function seedDirectProject(): void {
  const database = openDatabase(databasePath);
  const vault = createCredentialVault();
  try {
    // 个人对话项目：workspace_path IS NULL 且名称固定（既有 direct 判定口径）。
    database
      .prepare(
        `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
         VALUES (?,?,?,NULL,NULL,1)`,
      )
      .run(PROJECT_ID, "个人对话", NOW);
    const encrypted = vault.encrypt("provider-direct", "direct-chat-key");
    database
      .prepare(
        `INSERT INTO providers(
           id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
           credential_version,credential_generation,key_id,api_key_mask,verified_at,
           version,created_at,updated_at
         ) VALUES (?,?,'http://127.0.0.1:1/v1','model',?,?,?,?,1,?,?,?,1,?,?)`,
      )
      .run(
        "provider-direct",
        "Direct Provider",
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
    database
      .prepare(
        `INSERT INTO agents(
           id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
           can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
           updated_at,review_capable
         ) VALUES (?,?,'Assistant','Prompt','provider-direct','model','A','sage',
                 1,0,0,1000,3,1,?,?,0)`,
      )
      .run(AGENT_ID, "Direct Assistant", NOW, NOW);
    database
      .prepare(
        "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES (?,?,?)",
      )
      .run(PROJECT_ID, AGENT_ID, NOW);
  } finally {
    database.close();
  }
}

function directThread(): string {
  return createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [AGENT_ID],
    operationId: operationId(),
    title: "首页直聊",
  }).body.thread.id;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  databasePath = memoryDatabasePath();
  seedDirectProject();
});

describe("direct chat run path", () => {
  it("starts a run for a single-member direct-chat thread", () => {
    const threadId = directThread();

    const started = startThreadRun(databasePath, PROJECT_ID, threadId, {
      message: "帮我拟一份发布清单",
      operationId: operationId(),
    });

    expect(started.status).toBe(201);
    expect(started.body.run.threadId).toBe(threadId);
    expect(started.body.run.status).toBe("running");
    expect(started.body.run.currentAgentId).toBe(AGENT_ID);

    const database = openDatabase(databasePath);
    try {
      const messages = database
        .prepare(
          `SELECT content FROM collaboration_messages
           WHERE project_id=? AND thread_id=? ORDER BY sequence ASC`,
        )
        .all(PROJECT_ID, threadId) as Array<{ content: string }>;
      expect(messages.map(({ content }) => content)).toContain("帮我拟一份发布清单");
    } finally {
      database.close();
    }
  });

  it("reports the direct-chat collaboration projection as ready", () => {
    directThread();

    const collaboration = getCollaboration(databasePath, PROJECT_ID);

    expect(collaboration.readiness.ready).toBe(true);
    expect(collaboration.readiness.missing).toEqual([]);
  });

  it("advances a direct-chat run into a real assistant reply", () => {
    const threadId = directThread();
    const started = startThreadRun(databasePath, PROJECT_ID, threadId, {
      message: "帮我拟一份发布清单",
      operationId: operationId(),
    });
    const dependencies = { clock: () => new Date(), randomUUID };

    const acquired = acquireAdvance(
      databasePath,
      { projectId: PROJECT_ID, runId: started.body.run.id, threadId },
      { operationId: operationId() },
      dependencies,
    );
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") throw new Error("Expected acquired advance.");

    const usage = { completionTokens: 3, promptTokens: 7, totalTokens: 10 };
    const turn = JSON.parse(
      JSON.stringify({
        claim: null,
        disposition: { summary: "直聊回复完成。", type: "reply" },
        message: "这是你的发布清单草稿。",
        tasks: [],
      }),
    ) as StructuredTurnResult["turn"];
    const result: StructuredTurnResult = {
      calls: [{
        kind: "primary",
        result: {
          content: JSON.stringify({
            claim: null,
            disposition: { summary: "直聊回复完成。", type: "reply" },
            message: "这是你的发布清单草稿。",
            tasks: [],
          }),
          error: null,
          httpStatus: 200,
          status: "succeeded",
          usage,
          usageReported: true,
        },
      }],
      pauseCategory: null,
      status: "completed",
      turn,
      usage: [{ kind: "primary", usage, usageReported: true }],
    };
    const finalized = finalizeAdvance(
      databasePath,
      { projectId: PROJECT_ID, runId: started.body.run.id, threadId },
      {
        attemptId: acquired.attempt.id,
        leaseToken: acquired.attempt.leaseToken,
        result,
      },
      dependencies,
    );
    expect(finalized).toMatchObject({ status: 200 });

    const database = openDatabase(databasePath);
    try {
      const contents = database
        .prepare(
          `SELECT content FROM collaboration_messages
           WHERE project_id=? AND thread_id=? ORDER BY sequence ASC`,
        )
        .all(PROJECT_ID, threadId) as Array<{ content: string }>;
      expect(contents.map(({ content }) => content)).toContain("这是你的发布清单草稿。");
    } finally {
      database.close();
    }
  });

  it("resumes a rested direct-chat run when the owner sends the next message", () => {
    const threadId = directThread();
    const started = startThreadRun(databasePath, PROJECT_ID, threadId, {
      message: "帮我拟一份发布清单",
      operationId: operationId(),
    });
    const database = openDatabase(databasePath);
    try {
      // reply 回合把运行休息在 waiting_owner（直聊的沉思态）。
      database
        .prepare(
          `UPDATE collaboration_runs SET status='waiting_owner'
           WHERE project_id=? AND thread_id=?`,
        )
        .run(PROJECT_ID, threadId);
    } finally {
      database.close();
    }

    writeOwnerThreadMessage(databasePath, PROJECT_ID, threadId, {
      content: "再加一节回滚步骤。",
      operationId: operationId(),
    });

    const reopened = openDatabase(databasePath);
    try {
      const row = reopened
        .prepare(
          `SELECT status FROM collaboration_runs WHERE id=?`,
        )
        .get(started.body.run.id) as { status: string };
      expect(row.status).toBe("running");
    } finally {
      reopened.close();
    }
  });

  it("rejects a reply turn inside a collaboration project run", () => {
    const database = openDatabase(databasePath);
    try {
      database
        .prepare(
          `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
           VALUES ('project-workspace','Workspace Project',?,'/tmp/ws','/tmp/ws',1)`,
        )
        .run(NOW);
      const encrypted = createCredentialVault().encrypt("provider-ws", "ws-key");
      database
        .prepare(
          `INSERT INTO providers(
             id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
             credential_version,credential_generation,key_id,api_key_mask,verified_at,
             version,created_at,updated_at
           ) VALUES ('provider-ws','Workspace Provider','http://127.0.0.1:1/v1','model',?,?,?,?,1,?,?,?,1,?,?)`,
        )
        .run(
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
      database
        .prepare(
          `INSERT INTO agents(
             id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
             can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
             updated_at,review_capable
           ) VALUES ('agent-ws-b','Workspace Beta','Peer','Prompt','provider-ws','model','B','clay',
                   1,0,0,1000,3,1,?,?,0)`,
        )
        .run(NOW, NOW);
      database
        .prepare(
          "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES ('project-workspace',?,?)",
        )
        .run(AGENT_ID, NOW);
      database
        .prepare(
          "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES ('project-workspace','agent-ws-b',?)",
        )
        .run(NOW);
    } finally {
      database.close();
    }
    createMission(databasePath, "project-workspace", {
      expectedVersion: 0,
      goal: "Goal",
      operationId: operationId(),
      title: "Mission",
    });
    const threadId = createThread(databasePath, "project-workspace", {
      memberAgentIds: [AGENT_ID, "agent-ws-b"],
      operationId: operationId(),
      title: "项目对话",
    }).body.thread.id;
    const started = startThreadRun(databasePath, "project-workspace", threadId, {
      message: "开始协作",
      operationId: operationId(),
    });
    const dependencies = { clock: () => new Date(), randomUUID };
    const acquired = acquireAdvance(
      databasePath,
      { projectId: "project-workspace", runId: started.body.run.id, threadId },
      { operationId: operationId() },
      dependencies,
    );
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") throw new Error("Expected acquired advance.");

    const usage = { completionTokens: 1, promptTokens: 1, totalTokens: 2 };
    const turnJson = JSON.stringify({
      claim: null,
      disposition: { summary: "直聊收束", type: "reply" },
      message: "不应被协作运行接受。",
      tasks: [],
    });
    const finalized = finalizeAdvance(
      databasePath,
      { projectId: "project-workspace", runId: started.body.run.id, threadId },
      {
        attemptId: acquired.attempt.id,
        leaseToken: acquired.attempt.leaseToken,
        result: {
          calls: [{
            kind: "primary",
            result: {
              content: turnJson,
              error: null,
              httpStatus: 200,
              status: "succeeded",
              usage,
              usageReported: true,
            },
          }],
          pauseCategory: null,
          status: "completed",
          turn: JSON.parse(turnJson) as never,
          usage: [{ kind: "primary", usage, usageReported: true }],
        },
      },
      dependencies,
    );
    expect(finalized.status).toBe(400);
    expect(finalized.body).toMatchObject({
      error: { code: "ACTION_INVALID" },
    });
  });

  it("keeps project threads without a mission failing closed", () => {
    const database = openDatabase(databasePath);
    try {
      database
        .prepare(
          `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
           VALUES ('project-workspace','Workspace Project',?,'/tmp/ws','/tmp/ws',1)`,
        )
        .run(NOW);
      const encrypted = createCredentialVault().encrypt("provider-ws", "ws-key");
      database
        .prepare(
          `INSERT INTO providers(
             id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
             credential_version,credential_generation,key_id,api_key_mask,verified_at,
             version,created_at,updated_at
           ) VALUES ('provider-ws','Workspace Provider','http://127.0.0.1:1/v1','model',?,?,?,?,1,?,?,?,1,?,?)`,
        )
        .run(
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
      database
        .prepare(
          `INSERT INTO agents(
             id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
             can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
             updated_at,review_capable
           ) VALUES ('agent-ws-b','Workspace Beta','Peer','Prompt','provider-ws','model','B','clay',
                   1,0,0,1000,3,1,?,?,0)`,
        )
        .run(NOW, NOW);
      database
        .prepare(
          "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES ('project-workspace',?,?)",
        )
        .run(AGENT_ID, NOW);
      database
        .prepare(
          "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES ('project-workspace','agent-ws-b',?)",
        )
        .run(NOW);
    } finally {
      database.close();
    }
    const threadId = createThread(databasePath, "project-workspace", {
      memberAgentIds: [AGENT_ID, "agent-ws-b"],
      operationId: operationId(),
      title: "项目对话",
    }).body.thread.id;

    expect(() =>
      startThreadRun(databasePath, "project-workspace", threadId, {
        message: "开始协作",
        operationId: operationId(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONTEXT_NOT_READY",
        details: expect.objectContaining({
          fields: expect.objectContaining({ mission: "required" }),
        }),
      }),
    );
  });
});
