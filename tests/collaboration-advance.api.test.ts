import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";

type AdvanceRoute = {
  POST(
    request: Request,
    context: {
      params: Promise<{ projectId: string; threadId: string; runId: string }>;
    },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<AdvanceRoute>(
  "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/advance/route.ts",
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
let threadId: string;

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
  threadId = seedV7AdvanceFixture(databasePath, {
    agentId: AGENT_ID,
    agentPrompt: PRIVATE_PROMPT,
    missionId: "mission-advance-api",
    now: NOW,
    ownerMessage: "Prepare the release plan",
    projectId: PROJECT_ID,
    projectName: "Advance API",
    providerId: "provider-advance-api",
    runId: RUN_ID,
    secondAgentId: TARGET_ID,
    secondAgentPrompt: "BETA_PRIVATE",
    threadCreateOperationId: "00000000-0000-4000-8000-000000002099",
  });
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `UPDATE providers
         SET base_url=?,default_model='provider-default',api_key_cipher=?,
             api_key_iv=?,api_key_tag=?,credential_version=?,key_id=?,
             api_key_mask=?
         WHERE id='provider-advance-api'`,
      )
      .run(
        providerBaseUrl,
        credential.apiKeyCipher,
        credential.apiKeyIv,
        credential.apiKeyTag,
        credential.credentialVersion,
        credential.keyId,
        credential.apiKeyMask,
      );
    database
      .prepare(
        `UPDATE agents
         SET model=CASE id WHEN ? THEN 'agent-specific-model' ELSE 'beta-model' END
         WHERE id IN (?,?)`,
      )
      .run(AGENT_ID, AGENT_ID, TARGET_ID);
  } finally {
    database.close();
  }
}

async function route(): Promise<AdvanceRoute> {
  const load = routeModules[
    "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/advance/route.ts"
  ];
  expect(load, "the real advance route must exist").toBeTypeOf("function");
  return load!();
}

async function postAdvance(
  body: string = JSON.stringify({ operationId: OPERATION_ID }),
): Promise<Response> {
  const implementation = await route();
  return implementation.POST(
    new Request(
      `http://localhost/api/projects/${PROJECT_ID}/threads/${threadId}/runs/${RUN_ID}/advance`,
      {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
      },
    ),
    { params: Promise.resolve({ projectId: PROJECT_ID, runId: RUN_ID, threadId }) },
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
