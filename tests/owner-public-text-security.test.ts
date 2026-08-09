import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThread } from "@/src/server/collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { seedMissionInitializationForMission as initializeMissionDeliveryTx } from "@/tests/fixtures/review/mission-initialization";

type MessageRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

type StartRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

type DecisionRoute = {
  POST(
    request: Request,
    context: {
      params: Promise<{
        decisionId: string;
        projectId: string;
        runId: string;
        threadId: string;
      }>;
    },
  ): Promise<Response>;
};

const messageRoutes = import.meta.glob<MessageRoute>(
  "../app/api/projects/[projectId]/threads/[threadId]/messages/route.ts",
);
const startRoutes = import.meta.glob<StartRoute>(
  "../app/api/projects/[projectId]/threads/[threadId]/runs/route.ts",
);
const decisionRoutes = import.meta.glob<DecisionRoute>(
  "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/decisions/[decisionId]/answer/route.ts",
);
const NOW = "2026-08-08T08:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 29).toString("base64url");
const CONFIGURED_KEY = "configured-provider-key-value";
const OPERATION = "19000000-0000-4000-8000-000000000001";
let directory: string;
let databasePath: string;
let threadId: string;
let decisionSeeded: boolean;

function seed(): void {
  const vault = createCredentialVault();
  const encrypted = vault.encrypt("provider-a", CONFIGURED_KEY);
  const database = openDatabase(databasePath);
  try {
    database.prepare(
      `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
       VALUES ('project-a','A',?,'D:/a','d:/a',1)`,
    ).run(NOW);
    database.prepare(
      `INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
       VALUES ('mission-a','project-a','Mission','Goal',1,?,?)`,
    ).run(NOW, NOW);
    database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES ('provider-a','P','http://localhost/v1','model',?,?,?,?,1,?,?,?,1,?,?)`,
    ).run(
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
    database.exec(`
      INSERT INTO agents(
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
        updated_at,review_capable
      ) VALUES
        ('agent-a','Agent A','Peer','Prompt','provider-a','model','A','sage',
         1,1,0,1000,3,1,'${NOW}','${NOW}',0),
        ('agent-b','Agent B','Peer','Prompt','provider-a','model','B','gold',
         1,1,0,1000,3,1,'${NOW}','${NOW}',0);
      INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES
        ('project-a','agent-a','${NOW}'),
        ('project-a','agent-b','2026-08-08T08:00:01.000Z');
    `);
    initializeMissionDeliveryTx(database, {
      id: "mission-a",
      projectId: "project-a",
      updatedAt: NOW,
    });
  } finally {
    database.close();
  }
  threadId = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "19000000-0000-4000-8000-000000000000",
    title: "Thread A",
  }).body.thread.id;
}

function seedDecision(): void {
  const database = openDatabase(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      `INSERT INTO collaboration_runs(
         id,project_id,thread_id,status,current_agent_id,round_count,next_event_sequence,
         version,execution_epoch,pause_reason,pause_category,created_at,updated_at
       ) VALUES ('run-a','project-a',?,'waiting_owner','agent-a',1,1,2,1,NULL,NULL,?,?)`,
    ).run(threadId, NOW, NOW);
    database.prepare(
      `INSERT INTO collaboration_operations(
         id,project_id,thread_id,run_id,kind,request_hash,status,http_status,
         response_json,response_schema_version,created_at,updated_at
       ) VALUES ('19000000-0000-4000-8000-000000000090','project-a',?,'run-a',
         'advance','hash','completed',200,'{}',7,?,?)`,
    ).run(threadId, NOW, NOW);
    database.prepare(
      `INSERT INTO collaboration_messages(
         id,project_id,thread_id,run_id,author_type,author_agent_id,
         author_display_name,content,mention_agent_id,mention_display_name,
         sequence,consumed_at,created_at
       ) VALUES ('agent-message','project-a',?,'run-a','agent','agent-a',
         'Agent A','Choose',NULL,NULL,1,NULL,?)`,
    ).run(threadId, NOW);
    database.prepare(
      `INSERT INTO collaboration_attempts(
         id,project_id,thread_id,run_id,agent_id,operation_id,status,lease_token,
         lease_expires_at,prompt_hash,acquire_execution_epoch,acquire_context_hash,
         included_message_sequence,error_category,started_at,finished_at
       ) VALUES ('attempt-a','project-a',?,'run-a','agent-a',
         '19000000-0000-4000-8000-000000000090','committed','lease',
         '2026-08-08T08:01:00.000Z','prompt',1,'context',0,NULL,?,?)`,
    ).run(threadId, NOW, NOW);
    database.prepare(
      `INSERT INTO collaboration_turns(
         id,project_id,thread_id,attempt_id,run_id,agent_id,round_number,
         message_id,disposition,created_at
       ) VALUES ('turn-a','project-a',?,'attempt-a','run-a','agent-a',1,
         'agent-message','decision_request',?)`,
    ).run(threadId, NOW);
    database.prepare(
      `INSERT INTO decision_requests(
         id,project_id,thread_id,run_id,turn_id,requesting_agent_id,question,
         options_json,status,answer,answer_message_id,version,created_at,answered_at
       ) VALUES ('decision-a','project-a',?,'run-a','turn-a','agent-a','Proceed?',
         json_array('Yes','No'),'open',NULL,NULL,1,?,NULL)`,
    ).run(threadId, NOW);
    database.prepare(
      `INSERT INTO collaboration_thread_facts(
         id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
         run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
       ) VALUES
         ('fact-run','project-a',?,3,3,'run_linked','system',NULL,
          'run-a',NULL,NULL,NULL,json_object('runId','run-a'),?),
         ('fact-agent-message','project-a',?,4,4,'agent_message','agent','agent-a',
          'run-a','agent-message',NULL,NULL,json_object('messageId','agent-message'),?)`,
    ).run(threadId, NOW, threadId, NOW);
    database.prepare(
      `UPDATE collaboration_threads
       SET next_fact_sequence=5,last_activity_sequence=4 WHERE project_id='project-a' AND id=?`,
    ).run(threadId);
    database.prepare(
      `UPDATE collaboration_project_thread_sequences
       SET next_activity_sequence=5 WHERE project_id='project-a'`,
    ).run();
    database.prepare(
      `INSERT INTO collaboration_project_sequences(project_id,thread_id,next_message_sequence)
       VALUES ('project-a',?,2)
       ON CONFLICT(project_id,thread_id) DO UPDATE SET next_message_sequence=2`,
    ).run(threadId);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

type Ingress = "start" | "message" | "decision";

function ensureIngressReady(ingress: Ingress): void {
  if (ingress === "decision" && !decisionSeeded) {
    seedDecision();
    decisionSeeded = true;
  }
}

async function postOwnerText(
  ingress: Ingress,
  text: string,
  operationId = OPERATION,
): Promise<Response> {
  if (ingress === "message") {
    return postMessage(text, operationId);
  }
  if (ingress === "start") {
    const load = startRoutes[
      "../app/api/projects/[projectId]/threads/[threadId]/runs/route.ts"
    ];
    expect(load).toBeTypeOf("function");
    return (await load!()).POST(
      new Request(`http://localhost/api/projects/project-a/threads/${threadId}/runs`, {
        body: JSON.stringify({ message: text, operationId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ projectId: "project-a", threadId }) },
    );
  }
  ensureIngressReady(ingress);
  const load = decisionRoutes[
    "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/decisions/[decisionId]/answer/route.ts"
  ];
  expect(load).toBeTypeOf("function");
  return (await load!()).POST(
    new Request(
      `http://localhost/api/projects/project-a/threads/${threadId}/runs/run-a/decisions/decision-a/answer`,
      {
        body: JSON.stringify({ answer: text, expectedVersion: 1, operationId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ),
    {
      params: Promise.resolve({
        decisionId: "decision-a",
        projectId: "project-a",
        runId: "run-a",
        threadId,
      }),
    },
  );
}

async function postMessage(content: string, operationId = OPERATION): Promise<Response> {
  const load = messageRoutes[
    "../app/api/projects/[projectId]/threads/[threadId]/messages/route.ts"
  ];
  expect(load).toBeTypeOf("function");
  return (await load!()).POST(
    new Request(`http://localhost/api/projects/project-a/threads/${threadId}/messages`, {
      body: JSON.stringify({ content, operationId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ projectId: "project-a", threadId }) },
  );
}

function durableState(): unknown {
  const database = openDatabase(databasePath);
  try {
    const tables = [
      "collaboration_runs",
      "collaboration_messages",
      "collaboration_events",
      "collaboration_thread_facts",
      "collaboration_operations",
      "decision_requests",
    ];
    return {
      rows: Object.fromEntries(tables.map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ])),
      thread: database.prepare(
        `SELECT next_fact_sequence,last_activity_sequence,version
         FROM collaboration_threads WHERE project_id='project-a' AND id=?`,
      ).get(threadId),
      messageSequence: database.prepare(
        `SELECT next_message_sequence FROM collaboration_project_sequences
         WHERE project_id='project-a' AND thread_id=?`,
      ).get(threadId),
      activitySequence: database.prepare(
        `SELECT next_activity_sequence FROM collaboration_project_thread_sequences
         WHERE project_id='project-a'`,
      ).get(),
    };
  } finally {
    database.close();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  directory = mkdtempSync(join(tmpdir(), "owner-public-text-security-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  decisionSeeded = false;
  seed();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("owner public-text credential rejection", () => {
  const rejectedCases = [
    ["configured_provider_key", CONFIGURED_KEY],
    [
      "private_key",
      "-----BEGIN PRIVATE KEY-----\nYWJjZA==\n-----END PRIVATE KEY-----",
    ],
    [
      "private_key",
      "-----BEGIN RSA PRIVATE KEY-----\nYWJjZA==\n-----END RSA PRIVATE KEY-----",
    ],
    ["authorization_header", "Before\n  AuThOrIzAtIoN: BeArEr abc.DEF-123  \nAfter"],
    ["authorization_header", "AUTHORIZATION: BASIC dXNlcjpwYXNz"],
    ["credential_field", "config = { PaSsWoRd: 'hunter2' }"],
    ["credential_field", "api-key = value-one"],
    ["credential_field", "api_key: value_two"],
    ["credential_field", "\"apikey\": \"value-three\""],
    ["credential_field", "TOKEN=value-four"],
    ["credential_field", "secret: value-five"],
  ] as const;

  it.each(["start", "message", "decision"] satisfies Ingress[])(
    "rejects every approved credential category at the %s ingress with zero writes",
    async (ingress) => {
      ensureIngressReady(ingress);
      for (const [index, [category, text]] of rejectedCases.entries()) {
        const before = durableState();
        const response = await postOwnerText(
          ingress,
          text,
          `19000000-0000-4000-8000-${(index + 10).toString().padStart(12, "0")}`,
        );
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({
          error: {
            category,
            code: "CREDENTIAL_CONTENT_REJECTED",
            message: "Public text contains credential-like content.",
          },
        });
        expect(durableState()).toEqual(before);
      }
    },
  );

  it("rejects an exact configured Provider key before an ordinary message write", async () => {
    const response = await postMessage(`prefix ${CONFIGURED_KEY} suffix`);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        category: "configured_provider_key",
        code: "CREDENTIAL_CONTENT_REJECTED",
        message: "Public text contains credential-like content.",
      },
    });
  });

  it.each(["start", "message", "decision"] satisfies Ingress[])(
    "permits placeholders, field-name-only examples, and ordinary text at the %s ingress",
    async (ingress) => {
      const safe = [
        "api_key: ***",
        "Authorization: Bearer <redacted>",
        "Authorization: Basic ${BASIC_AUTH}",
        "Authorization: Bearer \"***\"",
        "token=${ENV_NAME}",
        "secret = '<redacted>'",
        "password: \"***\"",
        "password",
        "secret:",
        "Explain how an authorization header works without including one.",
      ];
      const response = await postOwnerText(ingress, safe.join("\n"));
      expect(response.status).toBe(ingress === "decision" ? 200 : 201);
    },
  );

  it.each(["start", "message", "decision"] satisfies Ingress[])(
    "does not reserve an operation after a rejected %s attempt",
    async (ingress) => {
      ensureIngressReady(ingress);
      const before = durableState();
      const rejected = await postOwnerText(ingress, "api_key=live-value");
      expect(rejected.status).toBe(422);
      expect(durableState()).toEqual(before);
      const accepted = await postOwnerText(ingress, "Safe retry");
      expect(accepted.status).toBe(ingress === "decision" ? 200 : 201);
    },
  );

  it.each(["start", "message", "decision"] satisfies Ingress[])(
    "fails closed without disclosure when Provider keys cannot decrypt at the %s ingress",
    async (ingress) => {
      ensureIngressReady(ingress);
      const database = openDatabase(databasePath);
      database.prepare("UPDATE providers SET key_id='unavailable-key-id' WHERE id='provider-a'").run();
      database.close();
      const before = durableState();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const response = await postOwnerText(ingress, "Ordinary text");
      const responseText = await response.text();
      expect(response.status).toBe(503);
      expect(JSON.parse(responseText)).toEqual({
        error: {
          category: "credential_unavailable",
          code: "CREDENTIAL_UNAVAILABLE",
          message: "Provider credentials are unavailable.",
        },
      });
      expect(responseText).not.toContain(CONFIGURED_KEY);
      expect(JSON.stringify(durableState())).not.toContain(CONFIGURED_KEY);
      expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(CONFIGURED_KEY);
      expect(durableState()).toEqual(before);
      errorSpy.mockRestore();
    },
  );

  it.each(["start", "message", "decision"] satisfies Ingress[])(
    "never leaks rejected raw values through response, database, or logs at the %s ingress",
    async (ingress) => {
      ensureIngressReady(ingress);
      const raw = "Authorization: Basic leak-me-raw";
      const before = durableState();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const response = await postOwnerText(ingress, raw);
      const responseText = await response.text();
      expect(response.status).toBe(422);
      expect(responseText).not.toContain("leak-me-raw");
      expect(JSON.stringify(durableState())).not.toContain("leak-me-raw");
      expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("leak-me-raw");
      expect(durableState()).toEqual(before);
      errorSpy.mockRestore();
    },
  );
});
