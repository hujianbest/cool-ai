import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createAgent } from "@/src/adapters/outbound/sqlite/identity-capability/agent-service";
import { createSkill } from "@/src/adapters/outbound/sqlite/identity-capability/skill-service";
import { createWorkItem } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { replaceMembers } from "@/src/adapters/outbound/sqlite/project-workspace/membership-service";
import { createMission } from "@/src/composition/mission-commands";
import { capabilityInsightSchema } from "@/src/shared/capability-insight-contracts";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type InsightRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<InsightRoute>(
  "../../../app/api/projects/[projectId]/capability-insight/route.ts",
);

const MASTER_KEY = Buffer.alloc(32, 46).toString("base64url");
const SECRET_KEY = "capability-insight-api-key-DO-NOT-LEAK";
const SECRET_PROMPT = "capability-insight-system-prompt-DO-NOT-LEAK";

let databasePath: string;
let missionOperationSequence = 0;

async function loadRoute(): Promise<InsightRoute> {
  const load =
    routeModules["../../../app/api/projects/[projectId]/capability-insight/route.ts"];
  expect(load, "the capability insight route must exist").toBeTypeOf("function");
  return load();
}

function seedProvider(): string {
  const providerId = "provider-insight";
  const database = openDatabase(databasePath);
  const envelope = createCredentialVault().encrypt(providerId, SECRET_KEY);
  const timestamp = "2026-08-15T00:00:00.000Z";
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
      "Insight provider",
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
    name: "Planner",
    permissions: {
      readFiles: true,
      runCommands: false,
      writeFiles: false,
    },
    providerId,
    reviewCapable: false,
    role: "规划",
    skillIds: [] as string[],
    systemPrompt: SECRET_PROMPT,
    ...overrides,
  };
}

beforeEach(() => {
  missionOperationSequence = 0;
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("capability insight API", () => {
  it("returns member portraits and unassigned todo suggestions without secrets", async () => {
    const route = await loadRoute();
    const providerId = seedProvider();
    const planSkill = createSkill(
      { description: "Plan notes", instructions: "Use Plan", name: "Plan" },
      databasePath,
    );
    const planner = createAgent(
      agentInput(providerId, {
        name: "Planner",
        reviewCapable: true,
        skillIds: [planSkill.id],
      }),
      databasePath,
    );
    const builder = createAgent(
      agentInput(providerId, {
        accentToken: "terracotta",
        avatarText: "B",
        name: "Builder",
        permissions: {
          readFiles: true,
          runCommands: true,
          writeFiles: true,
        },
        role: "实现",
      }),
      databasePath,
    );
    createAgent(
      agentInput(providerId, {
        accentToken: "slate",
        avatarText: "O",
        name: "Outsider",
        role: "旁观",
      }),
      databasePath,
    );
    const project = createProject("Insight project", databasePath);
    replaceMembers(databasePath, project.id, {
      agentIds: [planner.id, builder.id],
      expectedProjectVersion: 1,
    });
    const mission = createMission(databasePath, project.id, {
      expectedVersion: 0,
      goal: "Prove capability insight",
      operationId: `16000000-0000-4000-8000-${(++missionOperationSequence)
        .toString(16)
        .padStart(12, "0")}`,
      title: "Insight mission",
    });
    const openItem = createWorkItem(databasePath, mission.id, {
      assigneeAgentId: null,
      dependencyIds: [],
      description: "需要检查并写入文件后运行测试",
      title: "Plan the Café review",
    });
    createWorkItem(databasePath, mission.id, {
      assigneeAgentId: planner.id,
      dependencyIds: [],
      description: "",
      title: "Plan assigned work",
    });
    const busy = createWorkItem(databasePath, mission.id, {
      assigneeAgentId: null,
      dependencyIds: [],
      description: "",
      title: "Plan in progress",
    });
    const database = openDatabase(databasePath);
    database
      .prepare("UPDATE work_items SET status = 'in_progress' WHERE id = ?")
      .run(busy.id);
    database.close();

    const response = await route.GET(
      new Request(`http://localhost/api/projects/${project.id}/capability-insight`),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(capabilityInsightSchema.parse(payload)).toEqual(payload);
    expect(payload.portraits.map((row: { name: string }) => row.name)).toEqual([
      "Planner",
      "Builder",
    ].sort((left, right) => {
      const leftId = payload.portraits.find((row: { name: string }) => row.name === left)
        ?.agentId;
      const rightId = payload.portraits.find((row: { name: string }) => row.name === right)
        ?.agentId;
      return String(leftId) < String(rightId) ? -1 : 1;
    }));
    expect(payload.portraits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: planner.id,
          evidence: expect.arrayContaining(["skill:Plan", "review", "model"]),
          name: "Planner",
          reviewCapable: true,
          skillNames: ["Plan"],
        }),
        expect.objectContaining({
          agentId: builder.id,
          name: "Builder",
          reviewCapable: false,
          tools: {
            readFiles: true,
            runCommands: true,
            writeFiles: true,
          },
        }),
      ]),
    );
    expect(payload.portraits).toHaveLength(2);
    expect(payload.suggestions).toEqual([
      {
        agentId: planner.id,
        reasons: [
          "技能 Plan 匹配任务标题",
          "具备复核能力且任务涉及复核",
        ],
        score: 5,
        workItemId: openItem.id,
      },
      {
        agentId: builder.id,
        reasons: [
          "具备写入文件能力且任务涉及文件",
          "具备运行命令能力且任务涉及命令或测试",
        ],
        score: 4,
        workItemId: openItem.id,
      },
    ]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/systemPrompt|apiKey|api_key/i);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(SECRET_PROMPT);
  });

  it("returns 404 for a missing project and rejects unknown query parameters", async () => {
    const route = await loadRoute();
    const missing = await route.GET(
      new Request("http://localhost/api/projects/missing-project/capability-insight"),
      { params: Promise.resolve({ projectId: "missing-project" }) },
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "PROJECT_NOT_FOUND",
        message: "Project was not found.",
      },
    });
    expect(missing.headers.get("cache-control")).toBe("no-store");

    const project = createProject("Query project", databasePath);
    const rejected = await route.GET(
      new Request(
        `http://localhost/api/projects/${project.id}/capability-insight?extra=1`,
      ),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [{ code: "unknown", field: "extra" }],
        message: "Capability insight query is invalid.",
      },
    });
  });
});
