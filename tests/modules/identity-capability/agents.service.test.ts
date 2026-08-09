

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createSkill } from "@/src/adapters/outbound/sqlite/identity-capability/skill-service";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type AgentInput = {
  accentToken: "sage" | "terracotta" | "gold" | "slate" | "rose" | "olive";
  avatarText: string;
  maxHandoffs: number;
  maxTokens: number;
  model: string;
  name: string;
  permissions: {
    readFiles: boolean;
    runCommands: boolean;
    writeFiles: boolean;
  };
  providerId: string;
  role: string;
  skillIds: string[];
  systemPrompt: string;
};

type Agent = AgentInput & {
  createdAt: string;
  id: string;
  updatedAt: string;
  version: number;
};

type AgentTemplate = Pick<
  AgentInput,
  "accentToken" | "avatarText" | "name" | "role" | "systemPrompt"
> & { id: "planner" | "builder" | "reviewer" };

type AgentServiceModule = {
  createAgent(input: AgentInput, databasePath: string): Agent;
  getAgentTemplates(): readonly AgentTemplate[];
  listAgents(databasePath: string): Agent[];
  updateAgent(
    agentId: string,
    input: AgentInput & { expectedVersion: number },
    databasePath: string,
  ): Agent;
};

const serviceModules =
  import.meta.glob<AgentServiceModule>("../../../src/adapters/outbound/sqlite/identity-capability/agent-service.ts");
const MASTER_KEY = Buffer.alloc(32, 21).toString("base64url");
let databasePath: string;

async function loadService(): Promise<AgentServiceModule> {
  const load = serviceModules["../../../src/adapters/outbound/sqlite/identity-capability/agent-service.ts"];
  expect(load, "the Agent domain service must exist").toBeTypeOf("function");
  return load();
}

function insertProvider(
  providerId = "provider-1",
  options: { model?: string; verified?: boolean } = {},
): string {
  const database = openDatabase(databasePath);
  const vault = createCredentialVault();
  const envelope = vault.encrypt(providerId, "test-provider-key");
  const timestamp = "2026-07-29T00:00:00.000Z";
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
      "Local provider",
      "https://provider.example/v1",
      options.model ?? "model-a",
      envelope.apiKeyCipher,
      envelope.apiKeyIv,
      envelope.apiKeyTag,
      envelope.credentialVersion,
      1,
      envelope.keyId,
      envelope.apiKeyMask,
      options.verified === false ? "" : timestamp,
      1,
      timestamp,
      timestamp,
    );
  database.close();
  return providerId;
}

function insertSkill(name: string): string {
  return createSkill(
    { description: `${name} notes`, instructions: `Use ${name}`, name },
    databasePath,
  ).id;
}

function validInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    accentToken: "sage",
    avatarText: "🧑🏽‍💻",
    maxHandoffs: 8,
    maxTokens: 16_000,
    model: "model-a",
    name: "Builder",
    permissions: {
      readFiles: true,
      runCommands: true,
      writeFiles: true,
    },
    providerId: "provider-1",
    role: "Implement approved work",
    skillIds: [],
    systemPrompt: "Build and test the requested change.",
    ...overrides,
  };
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
});

afterEach(() => {
  delete process.env.COCKPIT_MASTER_KEY;
  vi.useRealTimers();
});

describe("Agent templates", () => {
  it("returns fresh immutable planner, builder and reviewer defaults", async () => {
    const service = await loadService();
    const first = service.getAgentTemplates();
    const second = service.getAgentTemplates();

    expect(first.map(({ id }) => id)).toEqual(["planner", "builder", "reviewer"]);
    expect(first.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    expect(first.every((template) =>
      Boolean(
        template.name &&
          template.role &&
          template.systemPrompt &&
          template.avatarText &&
          template.accentToken,
      ),
    )).toBe(true);
  });
});

describe("Agent service", () => {
  it("creates and lists agents with grapheme avatars and ordered skill references", async () => {
    const service = await loadService();
    insertProvider();
    const secondSkill = insertSkill("Review");
    const firstSkill = insertSkill("Plan");
    const created = service.createAgent(
      validInput({ avatarText: "🧑🏽‍💻好", skillIds: [firstSkill, secondSkill] }),
      databasePath,
    );

    expect(created).toMatchObject({
      avatarText: "🧑🏽‍💻好",
      skillIds: [firstSkill, secondSkill],
      version: 1,
    });
    expect(service.listAgents(databasePath)).toEqual([created]);
    const database = openDatabase(databasePath);
    expect(
      database
        .prepare(
          "SELECT skill_id AS skillId, position FROM agent_skills WHERE agent_id = ? ORDER BY position",
        )
        .all(created.id),
    ).toEqual([
      { position: 0, skillId: firstSkill },
      { position: 1, skillId: secondSkill },
    ]);
    database.close();
  });

  it.each([
    [{ name: "" }, "name", "required"],
    [{ name: "n".repeat(81) }, "name", "too_long"],
    [{ role: "r".repeat(161) }, "role", "too_long"],
    [{ systemPrompt: "s".repeat(20_001) }, "systemPrompt", "too_long"],
    [{ model: "m".repeat(121) }, "model", "too_long"],
    [{ avatarText: "" }, "avatarText", "required"],
    [{ avatarText: "一二三四五" }, "avatarText", "out_of_range"],
    [{ maxTokens: 0 }, "maxTokens", "out_of_range"],
    [{ maxTokens: 1_000_001 }, "maxTokens", "out_of_range"],
    [{ maxTokens: 1.5 }, "maxTokens", "not_integer"],
    [{ maxHandoffs: 0 }, "maxHandoffs", "out_of_range"],
    [{ maxHandoffs: 101 }, "maxHandoffs", "out_of_range"],
    [{ maxHandoffs: 1.5 }, "maxHandoffs", "not_integer"],
    [{ accentToken: "violet" as never }, "accentToken", "invalid_format"],
    [{ permissions: { readFiles: true } as never }, "permissions.writeFiles", "invalid_format"],
  ])("rejects exact input bounds without persistence", async (override, field, code) => {
    const service = await loadService();
    insertProvider();

    expect(() => service.createAgent(validInput(override), databasePath)).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        fields: expect.arrayContaining([{ code, field }]),
      }),
    );
    expect(service.listAgents(databasePath)).toEqual([]);
  });

  it("requires a currently verified provider and its exact default model", async () => {
    const service = await loadService();
    insertProvider("unverified", { verified: false });

    expectCode(
      () =>
        service.createAgent(
          validInput({ providerId: "unverified" }),
          databasePath,
        ),
      "PROVIDER_NOT_VERIFIED",
    );
    expect(() =>
      service.createAgent(
        validInput({ model: "model-b", providerId: "unverified" }),
        databasePath,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        fields: expect.arrayContaining([
          { code: "invalid_reference", field: "model" },
        ]),
      }),
    );
    expectCode(
      () =>
        service.createAgent(
          validInput({ providerId: "missing" }),
          databasePath,
        ),
      "PROVIDER_NOT_VERIFIED",
    );
  });

  it("rejects missing and duplicate skill references before writing", async () => {
    const service = await loadService();
    insertProvider();
    const existing = insertSkill("Existing");

    expectCode(
      () =>
        service.createAgent(
          validInput({ skillIds: [existing, "missing"] }),
          databasePath,
        ),
      "INVALID_SKILL_REFERENCE",
    );
    expect(() =>
      service.createAgent(validInput({ skillIds: [existing, existing] }), databasePath),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_INPUT",
        fields: expect.arrayContaining([
          { code: "invalid_reference", field: "skillIds" },
        ]),
      }),
    );
    expect(service.listAgents(databasePath)).toEqual([]);
  });

  it("fully replaces an agent and its ordered skills in one transaction", async () => {
    const service = await loadService();
    insertProvider();
    const first = insertSkill("First");
    const second = insertSkill("Second");
    const created = service.createAgent(
      validInput({ skillIds: [first, second] }),
      databasePath,
    );
    const updated = service.updateAgent(
      created.id,
      {
        ...validInput({
          name: "Reviewer",
          permissions: {
            readFiles: true,
            runCommands: false,
            writeFiles: false,
          },
          skillIds: [second],
        }),
        expectedVersion: 1,
      },
      databasePath,
    );

    expect(updated).toMatchObject({
      name: "Reviewer",
      permissions: {
        readFiles: true,
        runCommands: false,
        writeFiles: false,
      },
      skillIds: [second],
      version: 2,
    });
    expect(service.listAgents(databasePath)).toEqual([updated]);
  });

  it("rolls back invalid updates and reports stale and missing agents", async () => {
    const service = await loadService();
    insertProvider();
    const skillId = insertSkill("Stable");
    const created = service.createAgent(
      validInput({ skillIds: [skillId] }),
      databasePath,
    );

    expectCode(
      () =>
        service.updateAgent(
          created.id,
          {
            ...validInput({ name: "Must not persist", skillIds: ["missing"] }),
            expectedVersion: 1,
          },
          databasePath,
        ),
      "INVALID_SKILL_REFERENCE",
    );
    expect(service.listAgents(databasePath)).toEqual([created]);
    expectCode(
      () =>
        service.updateAgent(
          created.id,
          { ...validInput(), expectedVersion: 2 },
          databasePath,
        ),
      "RESOURCE_CONFLICT",
    );
    expectCode(
      () =>
        service.updateAgent(
          "missing",
          { ...validInput(), expectedVersion: 1 },
          databasePath,
        ),
      "AGENT_NOT_FOUND",
    );
  });

  it("lists deterministically by creation time and id", async () => {
    const service = await loadService();
    insertProvider();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const first = service.createAgent(validInput({ name: "First" }), databasePath);
    const second = service.createAgent(validInput({ name: "Second" }), databasePath);

    expect(service.listAgents(databasePath)).toEqual(
      [first, second].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      ),
    );
  });
});
