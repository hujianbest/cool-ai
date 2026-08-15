import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type AgentProfile = {
  accentToken: string;
  avatarText: string;
  createdAt: string;
  id: string;
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
  reviewCapable: boolean;
  role: string;
  skillIds: string[];
  systemPrompt: string;
  updatedAt: string;
  version: number;
};

type AgentServiceModule = {
  deleteAgent(agentId: string, databasePath: string): void;
  ensureStarterAgents(databasePath: string): AgentProfile[];
  listAgents(databasePath: string): AgentProfile[];
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

beforeEach(() => {
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
});

afterEach(() => {
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("starter agents", () => {
  it("inserts nothing and returns an empty list when no verified provider exists", async () => {
    const service = await loadService();
    insertProvider("unverified", { verified: false });

    expect(service.ensureStarterAgents(databasePath)).toEqual([]);
    expect(service.listAgents(databasePath)).toEqual([]);
  });

  it("creates the three template starters bound to the first verified provider", async () => {
    const service = await loadService();
    insertProvider("provider-b", { model: "model-b" });
    insertProvider("provider-a", { model: "model-a" });

    const starters = service.ensureStarterAgents(databasePath);

    expect(starters.map(({ id }) => id)).toEqual([
      "starter-planner",
      "starter-builder",
      "starter-reviewer",
    ]);
    expect(starters).toEqual([
      expect.objectContaining({
        id: "starter-planner",
        maxHandoffs: 8,
        maxTokens: 16_000,
        model: "model-a",
        name: "规划",
        permissions: {
          readFiles: true,
          runCommands: false,
          writeFiles: false,
        },
        providerId: "provider-a",
        reviewCapable: false,
        skillIds: [],
      }),
      expect.objectContaining({
        id: "starter-builder",
        maxHandoffs: 8,
        maxTokens: 16_000,
        model: "model-a",
        name: "实施",
        permissions: {
          readFiles: true,
          runCommands: true,
          writeFiles: true,
        },
        providerId: "provider-a",
        reviewCapable: false,
        skillIds: [],
      }),
      expect.objectContaining({
        id: "starter-reviewer",
        maxHandoffs: 8,
        maxTokens: 16_000,
        model: "model-a",
        name: "复核",
        permissions: {
          readFiles: true,
          runCommands: false,
          writeFiles: false,
        },
        providerId: "provider-a",
        reviewCapable: true,
        skillIds: [],
      }),
    ]);
  });

  it("returns the same starter ids on a second ensure without duplicating rows", async () => {
    const service = await loadService();
    insertProvider();

    const first = service.ensureStarterAgents(databasePath);
    const second = service.ensureStarterAgents(databasePath);

    expect(second.map(({ id }) => id)).toEqual(first.map(({ id }) => id));
    expect(service.listAgents(databasePath).map(({ id }) => id).sort()).toEqual([
      "starter-builder",
      "starter-planner",
      "starter-reviewer",
    ]);
  });

  it("rejects deleting a starter agent with STARTER_AGENT_PROTECTED", async () => {
    const service = await loadService();
    insertProvider();
    service.ensureStarterAgents(databasePath);

    expect(() => service.deleteAgent("starter-planner", databasePath)).toThrowError(
      expect.objectContaining({
        code: "STARTER_AGENT_PROTECTED",
        httpStatus: 409,
        message: "系统自带 Agent 不能删除。",
      }),
    );
    expect(service.listAgents(databasePath).map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "starter-planner",
        "starter-builder",
        "starter-reviewer",
      ]),
    );
  });

  it("returns AGENT_NOT_FOUND for a missing starter-prefixed id", async () => {
    const service = await loadService();

    expect(() => service.deleteAgent("starter-missing", databasePath)).toThrowError(
      expect.objectContaining({
        code: "AGENT_NOT_FOUND",
        httpStatus: 404,
        message: "Agent was not found.",
      }),
    );
  });
});
