import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callOpenAiChat } from "@/src/server/collaboration/openai-chat-client";
import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import type { ModelCallResult } from "@/src/shared/collaboration-contracts";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";

vi.mock("@/src/server/collaboration/openai-chat-client", () => ({
  callOpenAiChat: vi.fn(),
}));

const mockedCall = vi.mocked(callOpenAiChat);
const rawCredential = "Authorization: Bearer raw-primary-secret";
const API_KEY = "configured-provider-key-T20";
const PROJECT_ID = "project-structured-credential";
const RUN_ID = "run-structured-credential";
const AGENT_ID = "agent-structured-alpha";
const SECOND_AGENT_ID = "agent-structured-beta";
const PROVIDER_ID = "provider-structured-credential";
const NOW = "2026-08-08T09:00:00.000Z";
const OPERATION_ID = "20000000-0000-4000-8000-000000000020";

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

function success(content: string): ModelCallResult {
  return {
    content,
    error: null,
    httpStatus: 200,
    status: "succeeded",
    usage: { completionTokens: 3, promptTokens: 7, totalTokens: 10 },
    usageReported: true,
  };
}

beforeEach(() => {
  mockedCall.mockReset();
});

describe("structured repair credential scanning", () => {
  it("rejects raw primary credentials before parse or repair", async () => {
    mockedCall
      .mockResolvedValueOnce(success(`{"invalid":true,"raw":"${rawCredential}"}`))
      .mockResolvedValueOnce(success(JSON.stringify({
        claim: null,
        disposition: { type: "plan_ready" },
        message: "Repaired.",
        tasks: [],
      })));
    const { executeStructuredTurn } = await import(
      "@/src/server/collaboration/structured-repair"
    );
    const execute = executeStructuredTurn as unknown as (
      request: Parameters<typeof executeStructuredTurn>[0],
      context: Parameters<typeof executeStructuredTurn>[1],
      scan: (text: string) => "authorization_header" | null,
    ) => ReturnType<typeof executeStructuredTurn>;

    const result = await execute(
      {
        apiKey: "provider-key",
        baseUrl: "https://provider.example/v1",
        messages: [{ role: "user", content: "plan" }],
        model: "model",
      },
      { attemptId: "attempt", correlationId: "correlation", runId: "run" },
      () => "authorization_header",
    );

    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockedCall.mock.calls)).not.toContain(rawCredential);
    expect(JSON.stringify(result)).not.toContain(rawCredential);
    expect(result).toMatchObject({
      calls: [{
        kind: "primary",
        result: {
          content: null,
          error: {
            category: "credential_content_rejected",
            code: "CREDENTIAL_CONTENT_REJECTED",
          },
          status: "response_invalid",
        },
      }],
      status: "provider_failed",
      turn: null,
    });
  });
});

describe("structured repair credential durability", () => {
  let directory: string;
  let databasePath: string;
  let threadId: string;
  let consoleError: ReturnType<typeof vi.spyOn>;

  function validTurn(message = "Clean provider result."): string {
    return JSON.stringify({
      claim: null,
      disposition: {
        reason: "Beta should review.",
        summary: "Primary work is ready.",
        targetAgentId: SECOND_AGENT_ID,
        type: "handoff",
      },
      message,
      tasks: [],
    });
  }

  async function postAdvance(): Promise<Response> {
    const load = routeModules[
      "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/advance/route.ts"
    ];
    expect(load).toBeTypeOf("function");
    const route = await load!();
    return route.POST(
      new Request(
        `http://localhost/api/projects/${PROJECT_ID}/threads/${threadId}/runs/${RUN_ID}/advance`,
        {
          body: JSON.stringify({ operationId: OPERATION_ID }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
      { params: Promise.resolve({ projectId: PROJECT_ID, runId: RUN_ID, threadId }) },
    );
  }

  function durableSurface(): Record<string, unknown[]> {
    const database = openDatabase(databasePath);
    try {
      const tables = [
        "collaboration_attempts",
        "collaboration_events",
        "collaboration_messages",
        "collaboration_model_calls",
        "collaboration_operations",
        "collaboration_thread_facts",
        "collaboration_turns",
        "decision_requests",
        "work_items",
      ];
      return Object.fromEntries(
        tables.map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]),
      );
    } finally {
      database.close();
    }
  }

  function businessCounts(): Record<string, number> {
    const database = openDatabase(databasePath);
    try {
      return {
        agentMessages: (
          database.prepare(
            "SELECT COUNT(*) AS count FROM collaboration_messages WHERE author_type='agent'",
          ).get() as { count: number }
        ).count,
        decisions: (
          database.prepare("SELECT COUNT(*) AS count FROM decision_requests").get() as {
            count: number;
          }
        ).count,
        turns: (
          database.prepare("SELECT COUNT(*) AS count FROM collaboration_turns").get() as {
            count: number;
          }
        ).count,
        workItems: (
          database.prepare("SELECT COUNT(*) AS count FROM work_items").get() as {
            count: number;
          }
        ).count,
      };
    } finally {
      database.close();
    }
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "structured-repair-credential-"));
    databasePath = join(directory, "cockpit.sqlite");
    process.env.COCKPIT_DB_PATH = databasePath;
    process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 25).toString("base64url");
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    threadId = seedV7AdvanceFixture(databasePath, {
      agentId: AGENT_ID,
      agentPrompt: "Private alpha prompt",
      missionId: "mission-structured-credential",
      now: NOW,
      ownerMessage: "Please produce a plan.",
      projectId: PROJECT_ID,
      projectName: "Structured credential project",
      providerId: PROVIDER_ID,
      runId: RUN_ID,
      secondAgentId: SECOND_AGENT_ID,
      secondAgentPrompt: "Private beta prompt",
      threadCreateOperationId: "20000000-0000-4000-8000-000000000019",
    });
    const encrypted = createCredentialVault().encrypt(PROVIDER_ID, API_KEY);
    const database = openDatabase(databasePath);
    try {
      database.prepare(
        `UPDATE providers
         SET api_key_cipher=?,api_key_iv=?,api_key_tag=?,credential_version=?,
             key_id=?,api_key_mask=?,base_url='https://provider.example/v1'
         WHERE id=?`,
      ).run(
        encrypted.apiKeyCipher,
        encrypted.apiKeyIv,
        encrypted.apiKeyTag,
        encrypted.credentialVersion,
        encrypted.keyId,
        encrypted.apiKeyMask,
        PROVIDER_ID,
      );
    } finally {
      database.close();
    }
  });

  afterEach(() => {
    delete process.env.COCKPIT_DB_PATH;
    delete process.env.COCKPIT_MASTER_KEY;
    rmSync(directory, { force: true, recursive: true });
  });

  const credentialCases = [
    ["configured_provider_key", `{"invalid":true,"raw":"${API_KEY}"}`],
    [
      "private_key",
      "-----BEGIN PRIVATE KEY-----\nYWJjZA==\n-----END PRIVATE KEY-----",
    ],
    ["authorization_header", "before\nAuthorization: Bearer raw-primary-token\nafter"],
    ["credential_field", "config = { password: 'raw-primary-password' }"],
  ] as const;

  it.each(credentialCases)(
    "rejects invalid primary %s content with one call and no raw persistence",
    async (_category, raw) => {
      mockedCall
        .mockResolvedValueOnce(success(raw))
        .mockResolvedValueOnce(success(validTurn("Repair must not run.")));

      const response = await postAdvance();
      const body = await response.json();
      const durable = durableSurface();

      expect(response.status).toBe(422);
      expect(body).toEqual({
        error: {
          category: "credential_content_rejected",
          code: "CREDENTIAL_CONTENT_REJECTED",
          message: "Provider call failed.",
        },
      });
      expect(mockedCall).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mockedCall.mock.calls)).not.toContain(raw);
      expect(businessCounts()).toEqual({
        agentMessages: 0,
        decisions: 0,
        turns: 0,
        workItems: 0,
      });
      const surfaces = JSON.stringify({
        api: body,
        durable,
        logs: consoleError.mock.calls,
      });
      expect(surfaces).not.toContain(raw);
      expect(durable.collaboration_model_calls).toEqual([
        expect.objectContaining({
          completion_tokens: 3,
          error_category: "credential_content_rejected",
          kind: "primary",
          prompt_tokens: 7,
          status: "response_invalid",
          total_tokens: 10,
        }),
      ]);
      expect(durable.collaboration_attempts).toEqual([
        expect.objectContaining({
          error_category: "credential_content_rejected",
          status: "failed",
        }),
      ]);
      expect(JSON.stringify(durable.collaboration_events)).toContain(
        "credential_content_rejected",
      );
    },
  );

  it("rejects credential-bearing repair before parse without a third call", async () => {
    const repairRaw = "password: raw-repair-secret";
    mockedCall
      .mockResolvedValueOnce(success('{"message":"clean but invalid"}'))
      .mockResolvedValueOnce(success(validTurn(`before ${repairRaw}`)))
      .mockResolvedValueOnce(success(validTurn("Third call must not run.")));

    const response = await postAdvance();
    const body = await response.json();
    const durable = durableSurface();

    expect(response.status).toBe(422);
    expect(mockedCall).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mockedCall.mock.calls)).not.toContain(repairRaw);
    expect(JSON.stringify({ body, durable, logs: consoleError.mock.calls })).not.toContain(
      repairRaw,
    );
    expect(durable.collaboration_model_calls).toEqual([
      expect.objectContaining({ kind: "primary", status: "succeeded", total_tokens: 10 }),
      expect.objectContaining({
        error_category: "credential_content_rejected",
        kind: "repair",
        status: "response_invalid",
        total_tokens: 10,
      }),
    ]);
    expect(businessCounts()).toEqual({
      agentMessages: 0,
      decisions: 0,
      turns: 0,
      workItems: 0,
    });
  });

  it("preserves clean repair success", async () => {
    mockedCall
      .mockResolvedValueOnce(success('{"message":"clean but invalid"}'))
      .mockResolvedValueOnce(success(validTurn("Clean repaired result.")));

    const response = await postAdvance();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ attemptStatus: "committed" });
    expect(mockedCall).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(durableSurface())).toContain("Clean repaired result.");
  });

  it("preserves valid primary success without repair", async () => {
    mockedCall.mockResolvedValueOnce(success(validTurn("Clean primary result.")));

    const response = await postAdvance();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ attemptStatus: "committed" });
    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(durableSurface())).toContain("Clean primary result.");
  });

  it("fails closed before parse or repair when any configured key cannot decrypt", async () => {
    const database = openDatabase(databasePath);
    try {
      const source = database.prepare("SELECT * FROM providers WHERE id=?").get(
        PROVIDER_ID,
      ) as {
        api_key_cipher: string;
        api_key_iv: string;
        api_key_mask: string;
        api_key_tag: string;
        base_url: string;
        credential_version: number;
        created_at: string;
        default_model: string;
        updated_at: string;
        verified_at: string;
      };
      database.prepare(
        `INSERT INTO providers(
           id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
           credential_version,credential_generation,key_id,api_key_mask,verified_at,
           version,created_at,updated_at
         ) VALUES (
           'provider-unavailable','Unavailable',?,?,?,?,?,?,1,
           'unavailable-key-id',?,?,1,?,?
         )`,
      ).run(
        source.base_url,
        source.default_model,
        source.api_key_cipher,
        source.api_key_iv,
        source.api_key_tag,
        source.credential_version,
        source.api_key_mask,
        source.verified_at,
        source.created_at,
        source.updated_at,
      );
    } finally {
      database.close();
    }
    const raw = "password: raw-never-parse";
    mockedCall
      .mockResolvedValueOnce(success(raw))
      .mockResolvedValueOnce(success(validTurn("Repair must not run.")));

    const response = await postAdvance();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        category: "credential_unavailable",
        code: "CREDENTIAL_UNAVAILABLE",
        message: "Provider credentials are unavailable.",
      },
    });
    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({
      body,
      durable: durableSurface(),
      logs: consoleError.mock.calls,
    })).not.toContain(raw);
    expect(businessCounts()).toEqual({
      agentMessages: 0,
      decisions: 0,
      turns: 0,
      workItems: 0,
    });
  });
});
