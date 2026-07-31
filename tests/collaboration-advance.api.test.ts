import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";

type AdvanceRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ runId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<AdvanceRoute>(
  "../app/api/runs/[runId]/advance/route.ts",
);
const PROJECT_ID = "project-advance-api";
const RUN_ID = "run-advance-api";
const AGENT_ID = "agent-alpha-api";
const TARGET_ID = "agent-beta-api";
const NOW = "2026-07-30T02:00:00.000Z";
const OPERATION_ID = "00000000-0000-4000-8000-000000002100";
const API_KEY = "provider-secret-route";
const PRIVATE_PROMPT = "PRIVATE_AGENT_PROMPT_ROUTE";

let directory: string;
let databasePath: string;
let provider: Server;
let providerBaseUrl: string;
let providerRequests: Array<{ authorization: string | undefined; body: string }>;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider did not listen.");
  return `http://127.0.0.1:${address.port}/v1`;
}

function providerReply(content: string): Record<string, unknown> {
  return {
    choices: [{ message: { content } }],
    usage: { completion_tokens: 10, prompt_tokens: 20, total_tokens: 30 },
  };
}

function validTurn(): string {
  return JSON.stringify({
    claim: null,
    disposition: {
      reason: "Beta should review the release plan.",
      summary: "Draft complete; review the risks.",
      targetAgentId: TARGET_ID,
      type: "handoff",
    },
    message: "I drafted the release plan and handed it to Beta.",
    tasks: [],
  });
}

function seed(): void {
  const vault = createCredentialVault();
  const credential = vault.encrypt("provider-advance-api", API_KEY);
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO projects (
           id, name, created_at, workspace_path, workspace_key, version
         ) VALUES (?, 'Advance API', ?, 'D:\\workspace', 'd:/workspace', 1)`,
      )
      .run(PROJECT_ID, NOW);
    database
      .prepare(
        `INSERT INTO providers (
           id, name, base_url, default_model, api_key_cipher, api_key_iv,
           api_key_tag, credential_version, credential_generation, key_id,
           api_key_mask, verified_at, version, created_at, updated_at
         ) VALUES (?, 'Local', ?, 'provider-default', ?, ?, ?, 1, 1, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        "provider-advance-api",
        providerBaseUrl,
        credential.apiKeyCipher,
        credential.apiKeyIv,
        credential.apiKeyTag,
        credential.keyId,
        credential.apiKeyMask,
        NOW,
        NOW,
        NOW,
      );
    const insertAgent = database.prepare(
      `INSERT INTO agents (
         id, name, role, system_prompt, provider_id, model, avatar_text,
         accent_token, can_read, can_write, can_execute, max_tokens,
         max_handoffs, version, created_at, updated_at
       ) VALUES (?, ?, 'Peer', ?, 'provider-advance-api', ?, ?, ?, 1, 0, 0, 1000, 5, 1, ?, ?)`,
    );
    insertAgent.run(AGENT_ID, "Alpha", PRIVATE_PROMPT, "agent-specific-model", "A", "sage", NOW, NOW);
    insertAgent.run(TARGET_ID, "Beta", "BETA_PRIVATE", "beta-model", "B", "gold", NOW, NOW);
    const insertMembership = database.prepare(
      `INSERT INTO project_memberships (project_id, agent_id, joined_at) VALUES (?, ?, ?)`,
    );
    insertMembership.run(PROJECT_ID, AGENT_ID, NOW);
    insertMembership.run(PROJECT_ID, TARGET_ID, NOW);
    database
      .prepare(
        `INSERT INTO missions (
           id, project_id, title, goal, version, created_at, updated_at
         ) VALUES ('mission-advance-api', ?, 'Release plan', 'Plan a safe release', 1, ?, ?)`,
      )
      .run(PROJECT_ID, NOW, NOW);
    database
      .prepare(
        `INSERT INTO collaboration_runs (
           id, project_id, status, current_agent_id, round_count,
           next_event_sequence, version, execution_epoch, pause_reason,
           pause_category, created_at, updated_at
         ) VALUES (?, ?, 'running', ?, 0, 1, 1, 1, NULL, NULL, ?, ?)`,
      )
      .run(RUN_ID, PROJECT_ID, AGENT_ID, NOW, NOW);
    database
      .prepare(
        `INSERT INTO collaboration_project_sequences (project_id, next_message_sequence)
         VALUES (?, 2)`,
      )
      .run(PROJECT_ID);
    database
      .prepare(
        `INSERT INTO collaboration_messages (
           id, project_id, run_id, author_type, author_agent_id,
           author_display_name, content, mention_agent_id, mention_display_name,
           sequence, consumed_at, created_at
         ) VALUES (
           'owner-advance-api', ?, ?, 'owner', NULL, 'Owner',
           'Prepare the release plan', NULL, NULL, 1, NULL, ?
         )`,
      )
      .run(PROJECT_ID, RUN_ID, NOW);
  } finally {
    database.close();
  }
}

async function route(): Promise<AdvanceRoute> {
  const load = routeModules["../app/api/runs/[runId]/advance/route.ts"];
  expect(load, "the real advance route must exist").toBeTypeOf("function");
  return load!();
}

async function postAdvance(
  body: string = JSON.stringify({ operationId: OPERATION_ID }),
): Promise<Response> {
  const implementation = await route();
  return implementation.POST(
    new Request(`http://localhost/api/runs/${RUN_ID}/advance`, {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ runId: RUN_ID }) },
  );
}

function collaborationPersistence(): string {
  const database = openDatabase(databasePath);
  try {
    const tables = [
      "collaboration_attempts",
      "collaboration_events",
      "collaboration_messages",
      "collaboration_model_calls",
      "collaboration_operations",
      "collaboration_turns",
    ];
    return JSON.stringify(
      Object.fromEntries(
        tables.map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]),
      ),
    );
  } finally {
    database.close();
  }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-advance-api-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 21).toString("base64url");
  providerRequests = [];
  provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      providerRequests.push({
        authorization: request.headers.authorization,
        body,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(providerReply(validTurn())));
    });
  });
  providerBaseUrl = await listen(provider);
  seed();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  );
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("collaboration advance route", () => {
  it("executes the acquired immutable prompt through the configured provider and replays exactly", async () => {
    const first = await postAdvance();
    const firstBody = await first.json();
    const replay = await postAdvance();
    const replayBody = await replay.json();

    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({
      attempt: { status: "committed" },
      attemptStatus: "committed",
      events: expect.arrayContaining([
        expect.objectContaining({ type: "model_call_started" }),
        expect.objectContaining({ type: "model_call_succeeded" }),
        expect.objectContaining({ type: "agent_message" }),
        expect.objectContaining({ type: "handoff" }),
      ]),
      run: { currentAgentId: TARGET_ID, roundCount: 1, status: "running" },
    });
    expect(replay.status).toBe(first.status);
    expect(replayBody).toEqual(firstBody);
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0].authorization).toBe(`Bearer ${API_KEY}`);
    const outbound = JSON.parse(providerRequests[0].body) as {
      messages: Array<{ content: string }>;
      model: string;
    };
    expect(outbound.model).toBe("agent-specific-model");
    expect(JSON.stringify(outbound.messages)).toContain(PRIVATE_PROMPT);
    expect(JSON.stringify(firstBody)).not.toContain(API_KEY);
    expect(JSON.stringify(firstBody)).not.toContain(PRIVATE_PROMPT);
    expect(collaborationPersistence()).not.toContain(API_KEY);
    expect(collaborationPersistence()).not.toContain(PRIVATE_PROMPT);
  });

  it("uses exactly one repair call and persists only the repaired public turn", async () => {
    let call = 0;
    provider.removeAllListeners("request");
    provider.on("request", (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        providerRequests.push({ authorization: request.headers.authorization, body });
        call += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            providerReply(
              call === 1 ? '{"message":"invalid raw response marker"}' : validTurn(),
            ),
          ),
        );
      });
    });

    const result = await postAdvance();
    expect(result.status).toBe(200);
    expect(providerRequests).toHaveLength(2);
    expect(await result.json()).toMatchObject({ attemptStatus: "committed" });
    const persisted = collaborationPersistence();
    expect(persisted).not.toContain("invalid raw response marker");
    expect(persisted).toContain("I drafted the release plan");
  });

  it("maps provider failures, sanitizes every surface, and durably replays the error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    provider.removeAllListeners("request");
    provider.on("request", (request, response) => {
      request.resume();
      request.on("end", () => {
        providerRequests.push({
          authorization: request.headers.authorization,
          body: "",
        });
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: `RAW_PROVIDER_FAILURE ${API_KEY} ${PRIVATE_PROMPT}`,
          }),
        );
      });
    });

    const first = await postAdvance();
    const firstBody = await first.json();
    const replay = await postAdvance();

    expect(first.status).toBe(401);
    expect(firstBody).toEqual({
      error: {
        category: "provider_auth",
        code: "PROVIDER_AUTH",
        message: "Provider call failed.",
      },
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual(firstBody);
    expect(providerRequests).toHaveLength(1);
    const surfaces = JSON.stringify({
      body: firstBody,
      logs: consoleError.mock.calls,
      persistence: collaborationPersistence(),
    });
    expect(surfaces).not.toContain("RAW_PROVIDER_FAILURE");
    expect(surfaces).not.toContain(API_KEY);
    expect(surfaces).not.toContain(PRIVATE_PROMPT);
  });

  it("durably maps an unavailable server-side vault without calling the provider", async () => {
    delete process.env.COCKPIT_MASTER_KEY;
    const first = await postAdvance();
    const firstBody = await first.json();
    process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 21).toString("base64url");
    const replay = await postAdvance();

    expect(first.status).toBe(503);
    expect(firstBody).toEqual({
      error: {
        category: "credential_unavailable",
        code: "CREDENTIAL_UNAVAILABLE",
        message: "Provider credential is unavailable.",
      },
    });
    expect(replay.status).toBe(503);
    expect(await replay.json()).toEqual(firstBody);
    expect(providerRequests).toHaveLength(0);
  });

  it("validates JSON and operation ids through stable collaboration error envelopes", async () => {
    const invalidJson = await postAdvance("{");
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({
      error: { code: "INVALID_JSON", message: "Request body must be valid JSON." },
    });

    const invalidOperation = await postAdvance(JSON.stringify({ operationId: "not-a-uuid" }));
    expect(invalidOperation.status).toBe(400);
    expect(await invalidOperation.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: { operationId: "invalid_format" },
        message: "Advance input is invalid.",
      },
    });
    expect(providerRequests).toHaveLength(0);
  });
});
