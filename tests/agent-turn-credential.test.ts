import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callOpenAiChat } from "@/src/server/collaboration/openai-chat-client";
import { finalizeAdvance } from "@/src/server/collaboration/turn-orchestrator";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import type { ModelCallResult } from "@/src/shared/collaboration-contracts";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";

vi.mock("@/src/server/collaboration/openai-chat-client", () => ({
  callOpenAiChat: vi.fn(),
}));

const mockedCall = vi.mocked(callOpenAiChat);
const API_KEY = "configured-provider-key-T21";
const PROJECT_ID = "project-agent-turn-credential";
const RUN_ID = "run-agent-turn-credential";
const AGENT_ID = "agent-turn-alpha";
const SECOND_AGENT_ID = "agent-turn-beta";
const PROVIDER_ID = "provider-agent-turn-credential";
const NOW = "2026-08-08T10:00:00.000Z";
const OPERATION_ID = "21000000-0000-4000-8000-000000000021";

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
    usage: { completionTokens: 5, promptTokens: 11, totalTokens: 16 },
    usageReported: true,
  };
}

type TextField =
  | "message"
  | "task_title"
  | "task_description"
  | "handoff_summary"
  | "handoff_reason"
  | "decision_question"
  | "decision_option"
  | "proposal_body";

function turnWith(field: TextField, value: string): string {
  const handoff = {
    reason: field === "handoff_reason" ? value : "A second Agent should continue.",
    summary: field === "handoff_summary" ? value : "The first pass is complete.",
    targetAgentId: SECOND_AGENT_ID,
    type: "handoff",
  };
  if (field === "decision_question" || field === "decision_option") {
    return JSON.stringify({
      claim: null,
      disposition: {
        options: field === "decision_option" ? ["Continue", value] : ["Continue", "Stop"],
        question: field === "decision_question" ? value : "How should we proceed?",
        type: "decision_request",
      },
      message: "Please choose the next step.",
      tasks: [],
    });
  }
  return JSON.stringify({
    blocks: field === "proposal_body"
      ? [{
          actions: ["accept", "reject"],
          blockRevision: 1,
          blockSchemaVersion: 1,
          blockType: "proposal",
          body: value,
          logicalBlockId: "proposal-credential",
          title: "Safe title",
        }]
      : [],
    claim: null,
    disposition: handoff,
    message: field === "message" ? value : "Clean Agent message.",
    tasks: field === "task_title" || field === "task_description"
      ? [{
          clientKey: "task-one",
          dependsOnKeys: [],
          description: field === "task_description" ? value : "Clean task description.",
          title: field === "task_title" ? value : "Clean task title",
        }]
      : [],
  });
}

describe("AgentTurn public-text credential rejection", () => {
  let directory: string;
  let databasePath: string;
  let threadId: string;
  let consoleError: ReturnType<typeof vi.spyOn>;

  async function postAdvance(operationId = OPERATION_ID): Promise<Response> {
    const load = routeModules[
      "../app/api/projects/[projectId]/threads/[threadId]/runs/[runId]/advance/route.ts"
    ];
    expect(load).toBeTypeOf("function");
    const route = await load!();
    return route.POST(
      new Request(
        `http://localhost/api/projects/${PROJECT_ID}/threads/${threadId}/runs/${RUN_ID}/advance`,
        {
          body: JSON.stringify({ operationId }),
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
        businessEvents: (
          database.prepare(
            `SELECT COUNT(*) AS count FROM collaboration_events
             WHERE type IN (
               'agent_message','tasks_created','task_claimed','handoff','decision_requested'
             )`,
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
    mockedCall.mockReset();
    directory = mkdtempSync(join(tmpdir(), "agent-turn-credential-"));
    databasePath = join(directory, "cockpit.sqlite");
    process.env.COCKPIT_DB_PATH = databasePath;
    process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 21).toString("base64url");
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    threadId = seedV7AdvanceFixture(databasePath, {
      agentId: AGENT_ID,
      agentPrompt: "Private alpha prompt",
      missionId: "mission-agent-turn-credential",
      now: NOW,
      ownerMessage: "Please produce the next action.",
      projectId: PROJECT_ID,
      projectName: "Agent turn credential project",
      providerId: PROVIDER_ID,
      runId: RUN_ID,
      secondAgentId: SECOND_AGENT_ID,
      secondAgentPrompt: "Private beta prompt",
      threadCreateOperationId: "21000000-0000-4000-8000-000000000020",
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
    consoleError.mockRestore();
    delete process.env.COCKPIT_DB_PATH;
    delete process.env.COCKPIT_MASTER_KEY;
    rmSync(directory, { force: true, recursive: true });
  });

  const fields: TextField[] = [
    "message",
    "task_title",
    "task_description",
    "proposal_body",
    "handoff_summary",
    "handoff_reason",
    "decision_question",
    "decision_option",
  ];
  const credentials = [
    ["configured_provider_key", API_KEY],
    [
      "private_key",
      "-----BEGIN PRIVATE KEY-----\nYWJjZA==\n-----END PRIVATE KEY-----",
    ],
    ["authorization_header", "Before\nAuthorization: Bearer parsed-secret\nAfter"],
    ["credential_field", "password: parsed-secret"],
  ] as const;
  const rejectedCases = fields.flatMap((field) =>
    credentials.map(([category, value]) => ({ category, field, value }))
  );

  it.each(rejectedCases)(
    "rejects $category in parsed $field and rolls back the whole turn",
    async ({ field, value }) => {
      mockedCall.mockResolvedValueOnce(success(turnWith(field, value)));

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
      expect(businessCounts()).toEqual({
        agentMessages: 0,
        businessEvents: 0,
        decisions: 0,
        turns: 0,
        workItems: 0,
      });
      expect(JSON.stringify({ body, durable, logs: consoleError.mock.calls })).not.toContain(value);
      expect(durable.collaboration_model_calls).toEqual([
        expect.objectContaining({
          completion_tokens: 5,
          error_category: "credential_content_rejected",
          prompt_tokens: 11,
          status: "response_invalid",
          total_tokens: 16,
        }),
      ]);
      expect(durable.collaboration_attempts).toEqual([
        expect.objectContaining({
          error_category: "credential_content_rejected",
          status: "failed",
        }),
      ]);
    },
  );

  it("permits placeholders and ordinary code-like text", async () => {
    const safe = [
      "api_key: ***",
      "Authorization: Bearer <redacted>",
      "token=${ENV_NAME}",
      "password",
      "const tokenCount = tokens.length;",
    ].join("\n");
    mockedCall.mockResolvedValueOnce(success(turnWith("handoff_summary", safe)));
    const response = await postAdvance();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ attemptStatus: "committed" });
  });

  it("rolls back a valid task and claim when a sibling field is rejected", async () => {
    const raw = "password: whole-turn-secret";
    mockedCall.mockResolvedValueOnce(success(JSON.stringify({
      claim: { clientKey: "valid-task", source: "proposed" },
      disposition: {
        reason: "A clean reason.",
        summary: "A clean summary.",
        targetAgentId: SECOND_AGENT_ID,
        type: "handoff",
      },
      message: raw,
      tasks: [{
        clientKey: "valid-task",
        dependsOnKeys: [],
        description: "A valid sibling task.",
        title: "Valid sibling",
      }],
    })));

    const response = await postAdvance();
    expect(response.status).toBe(422);
    expect(businessCounts()).toEqual({
      agentMessages: 0,
      businessEvents: 0,
      decisions: 0,
      turns: 0,
      workItems: 0,
    });
    expect(JSON.stringify(durableSurface())).not.toContain(raw);
  });

  it.each(["message", "task", "handoff", "decision"] as const)(
    "preserves clean %s commits",
    async (kind) => {
      const operationId = `21000000-0000-4000-8000-${String(
        ["message", "task", "handoff", "decision"].indexOf(kind) + 30,
      ).padStart(12, "0")}`;
      const content = kind === "decision"
        ? turnWith("decision_question", "Choose the preferred clean option?")
        : kind === "task"
          ? turnWith("task_title", "Implement the clean task")
          : kind === "handoff"
            ? turnWith("handoff_reason", "A clean specialist review is needed.")
            : turnWith("message", "A clean public Agent message.");
      mockedCall.mockResolvedValueOnce(success(content));
      const response = await postAdvance(operationId);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ attemptStatus: "committed" });
    },
  );

  it("replays a rejected finalize without another Provider call or duplicate audit", async () => {
    const raw = "Authorization: Bearer late-finalize-secret";
    mockedCall.mockResolvedValueOnce(success(turnWith("task_description", raw)));
    const first = await postAdvance();
    const firstBody = await first.json();
    const beforeReplay = durableSurface();

    const replay = await postAdvance();
    expect(replay.status).toBe(422);
    expect(await replay.json()).toEqual(firstBody);
    expect(mockedCall).toHaveBeenCalledTimes(1);
    expect(durableSurface()).toEqual(beforeReplay);
    expect(JSON.stringify(beforeReplay)).not.toContain(raw);

    const attempt = beforeReplay.collaboration_attempts[0] as {
      id: string;
      lease_token: string;
    };
    const late = finalizeAdvance(
      databasePath,
      { projectId: PROJECT_ID, runId: RUN_ID, threadId },
      {
        attemptId: attempt.id,
        leaseToken: attempt.lease_token,
        result: {
          calls: [],
          pauseCategory: null,
          status: "provider_failed",
          turn: null,
          usage: [],
        },
      },
      {
        clock: () => new Date(NOW),
        randomUUID: () => "21000000-0000-4000-8000-000000000099",
      },
    );
    expect(late).toEqual({ affectedRows: 0, body: firstBody, status: 422 });
    expect(durableSurface()).toEqual(beforeReplay);
  });
});
