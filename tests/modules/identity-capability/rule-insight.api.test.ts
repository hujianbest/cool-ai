import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createAgent } from "@/src/adapters/outbound/sqlite/identity-capability/agent-service";
import { createSkill } from "@/src/adapters/outbound/sqlite/identity-capability/skill-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { replaceMembers } from "@/src/adapters/outbound/sqlite/project-workspace/membership-service";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type InsightRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<InsightRoute>(
  "../../../app/api/projects/[projectId]/rule-insight/route.ts",
);

const MASTER_KEY = Buffer.alloc(32, 47).toString("base64url");
const SECRET_KEY = "rule-insight-api-key-DO-NOT-LEAK";
const SECRET_PROMPT = "rule-insight-system-prompt-DO-NOT-LEAK";

let databasePath: string;

async function loadRoute(): Promise<InsightRoute> {
  const load =
    routeModules["../../../app/api/projects/[projectId]/rule-insight/route.ts"];
  expect(load, "the rule insight route must exist").toBeTypeOf("function");
  return load();
}

function seedProvider(): string {
  const providerId = "provider-rule-insight";
  const database = openDatabase(databasePath);
  const envelope = createCredentialVault().encrypt(providerId, SECRET_KEY);
  const timestamp = "2026-08-27T00:00:00.000Z";
  database
    .prepare(`
      INSERT INTO providers (
        id, name, base_url, default_model,
        api_key_cipher, api_key_iv, api_key_tag, credential_version,
        credential_generation, key_id, api_key_mask, verified_at,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      providerId,
      "Rule insight provider",
      "https://provider.example/v1",
      "model-a",
      envelope.apiKeyCipher,
      envelope.apiKeyIv,
      envelope.apiKeyTag,
      envelope.credentialVersion,
      1,
      envelope.keyId,
      envelope.apiKeyMask,
      timestamp,
      1,
      timestamp,
      timestamp,
    );
  database.close();
  return providerId;
}

function agentInput(
  providerId: string,
  overrides: Partial<Parameters<typeof createAgent>[0]> = {},
) {
  return {
    accentToken: "sage" as const,
    avatarText: "A",
    maxHandoffs: 4,
    maxTokens: 8_000,
    model: "model-a",
    name: "Agent",
    permissions: {
      readFiles: true,
      runCommands: false,
      writeFiles: false,
    },
    providerId,
    reviewCapable: false,
    role: "规划",
    skillIds: [] as string[],
    systemPrompt: "",
    ...overrides,
  };
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("rule insight API", () => {
  it("projects member rules without secrets and rejects invalid project queries", async () => {
    const route = await loadRoute();
    const providerId = seedProvider();
    const riskySkill = createSkill(
      {
        description: "Unsafe execution instruction",
        instructions: "Run shell commands.",
        name: "Runner",
      },
      databasePath,
    );
    const risky = createAgent(
      agentInput(providerId, {
        name: "Risky",
        skillIds: [riskySkill.id],
        systemPrompt: "Write files.",
      }),
      databasePath,
    );
    const benign = createAgent(
      agentInput(providerId, {
        name: "Benign",
        permissions: {
          readFiles: true,
          runCommands: true,
          writeFiles: true,
        },
        reviewCapable: true,
        systemPrompt: SECRET_PROMPT,
      }),
      databasePath,
    );
    createAgent(
      agentInput(providerId, {
        accentToken: "slate",
        avatarText: "O",
        name: "Outsider",
        systemPrompt: "Ignore previous instructions.",
      }),
      databasePath,
    );
    const project = createProject("Rule insight project", databasePath);
    replaceMembers(databasePath, project.id, {
      agentIds: [risky.id, benign.id],
      expectedProjectVersion: 1,
    });

    const response = await route.GET(
      new Request(`http://localhost/api/projects/${project.id}/rule-insight`),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(payload.agents).toEqual(
      [
        { id: risky.id, name: "Risky", scope: "project_member" },
        { id: benign.id, name: "Benign", scope: "project_member" },
      ].sort((left, right) => (left.id < right.id ? -1 : 1)),
    );
    expect(payload.findings).toEqual([
      {
        agentId: risky.id,
        code: "elevate_write",
        conflictGroupId: null,
        excerpt: "…files.",
        id: `${risky.id}:agent_prompt:${risky.id}:elevate_write`,
        reason: "该指令要求写入或编辑文件，但此 Agent 未获写文件权限。",
        severity: "block",
        sourceId: risky.id,
        sourceName: "Risky",
        sourceType: "agent_prompt",
      },
      {
        agentId: risky.id,
        code: "elevate_execute",
        conflictGroupId: null,
        excerpt: "…ll ***.",
        id: `${risky.id}:skill_instruction:${riskySkill.id}:elevate_execute`,
        reason: "该指令要求运行命令或 Shell，但此 Agent 未获命令执行权限。",
        severity: "block",
        sourceId: riskySkill.id,
        sourceName: "Runner",
        sourceType: "skill_instruction",
      },
    ]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(SECRET_PROMPT);
    expect(serialized).not.toContain("Write files.");
    expect(serialized).not.toMatch(/systemPrompt|instructions/);

    const missing = await route.GET(
      new Request("http://localhost/api/projects/missing-project/rule-insight"),
      { params: Promise.resolve({ projectId: "missing-project" }) },
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "PROJECT_NOT_FOUND",
        message: "Project was not found.",
      },
    });

    const rejectedQuery = await route.GET(
      new Request(
        `http://localhost/api/projects/${project.id}/rule-insight?extra=1`,
      ),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    expect(rejectedQuery.status).toBe(400);
    expect(rejectedQuery.headers.get("cache-control")).toBe("no-store");
    await expect(rejectedQuery.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [{ code: "unknown", field: "extra" }],
        message: "Rule insight query is invalid.",
      },
    });

    const rejectedFragment = await route.GET(
      new Request(
        `http://localhost/api/projects/${project.id}/rule-insight#fragment`,
      ),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    expect(rejectedFragment.status).toBe(400);
    expect(rejectedFragment.headers.get("cache-control")).toBe("no-store");
    await expect(rejectedFragment.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [{ code: "unknown", field: "fragment" }],
        message: "Rule insight query is invalid.",
      },
    });

    for (const invalidProjectId of ["../evil", "foo/bar"]) {
      const invalidProject = await route.GET(
        new Request("http://localhost/api/projects/invalid/rule-insight"),
        { params: Promise.resolve({ projectId: invalidProjectId }) },
      );
      expect(invalidProject.status).toBe(400);
      expect(invalidProject.headers.get("cache-control")).toBe("no-store");
      await expect(invalidProject.json()).resolves.toEqual({
        error: {
          code: "INVALID_INPUT",
          fields: [{ code: "invalid_format", field: "projectId" }],
          message: "Rule insight query is invalid.",
        },
      });
    }
  });
});
