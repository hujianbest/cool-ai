import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import { createSkill } from "@/src/server/skill-service";

type CollectionRoute = {
  GET(): Promise<Response>;
  POST(request: Request): Promise<Response>;
};

type ItemRoute = {
  PATCH(
    request: Request,
    context: { params: Promise<{ agentId: string }> },
  ): Promise<Response>;
};

type TemplateRoute = { GET(): Promise<Response> };

const collectionRoutes =
  import.meta.glob<CollectionRoute>("../app/api/agents/route.ts");
const itemRoutes =
  import.meta.glob<ItemRoute>("../app/api/agents/[agentId]/route.ts");
const templateRoutes =
  import.meta.glob<TemplateRoute>("../app/api/agent-templates/route.ts");
const MASTER_KEY = Buffer.alloc(32, 22).toString("base64url");
let directory: string;
let databasePath: string;

async function routes() {
  const loadCollection = collectionRoutes["../app/api/agents/route.ts"];
  const loadItem = itemRoutes["../app/api/agents/[agentId]/route.ts"];
  const loadTemplates = templateRoutes["../app/api/agent-templates/route.ts"];
  expect(loadCollection, "the Agent collection route must exist").toBeTypeOf("function");
  expect(loadItem, "the Agent PATCH route must exist").toBeTypeOf("function");
  expect(loadTemplates, "the Agent template route must exist").toBeTypeOf("function");
  return {
    collection: await loadCollection(),
    item: await loadItem(),
    templates: await loadTemplates(),
  };
}

function request(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
}

function seedReferences(): { providerId: string; skillIds: string[] } {
  const providerId = "provider-api";
  const database = openDatabase(databasePath);
  const vault = createCredentialVault();
  const envelope = vault.encrypt(providerId, "api-provider-key");
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
      "API provider",
      "https://provider.example/v1",
      "model-api",
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
  const skillIds = ["Plan", "Review"].map(
    (name) =>
      createSkill(
        { description: "", instructions: `Use ${name}`, name },
        databasePath,
      ).id,
  );
  return { providerId, skillIds };
}

function validInput(providerId: string, skillIds: string[]) {
  return {
    accentToken: "gold",
    avatarText: "🛠️",
    maxHandoffs: 5,
    maxTokens: 8_000,
    model: "model-api",
    name: "Builder",
    permissions: {
      readFiles: true,
      runCommands: true,
      writeFiles: true,
    },
    providerId,
    role: "Implementation",
    skillIds,
    systemPrompt: "Implement approved tasks.",
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-agents-api-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("Agent API", () => {
  it("returns detached immutable template DTOs", async () => {
    const { templates } = await routes();
    const first = await (await templates.GET()).json();
    first.templates[0].name = "Polluted";
    const second = await (await templates.GET()).json();

    expect(second.templates.map(({ id }: { id: string }) => id)).toEqual([
      "planner",
      "builder",
      "reviewer",
    ]);
    expect(second.templates[0].name).not.toBe("Polluted");
  });

  it("creates, lists and fully replaces an Agent", async () => {
    const { collection, item } = await routes();
    const references = seedReferences();
    const input = validInput(references.providerId, references.skillIds);
    const createdResponse = await collection.POST(
      request("http://localhost/api/agents", input),
    );
    expect(createdResponse.status).toBe(201);
    const { agent: created } = await createdResponse.json();
    expect(created).toMatchObject({ ...input, version: 1 });

    const replacement = {
      ...input,
      expectedVersion: 1,
      name: "Reviewer",
      skillIds: [references.skillIds[1]],
    };
    const updatedResponse = await item.PATCH(
      request(
        `http://localhost/api/agents/${created.id}`,
        replacement,
        "PATCH",
      ),
      { params: Promise.resolve({ agentId: created.id }) },
    );
    expect(updatedResponse.status).toBe(200);
    const { agent: updated } = await updatedResponse.json();
    expect(updated).toMatchObject({
      name: "Reviewer",
      skillIds: [references.skillIds[1]],
      version: 2,
    });
    await expect((await collection.GET()).json()).resolves.toEqual({
      agents: [updated],
    });
  });

  it("maps validation, references, not-found and version conflicts stably", async () => {
    const { collection, item } = await routes();
    const references = seedReferences();
    const input = validInput(references.providerId, references.skillIds);
    const invalid = await collection.POST(
      request("http://localhost/api/agents", {
        ...input,
        avatarText: "一二三四五",
        maxTokens: 1.5,
        role: "r".repeat(161),
      }),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_INPUT",
        fields: expect.arrayContaining([
          { code: "too_long", field: "role" },
          { code: "not_integer", field: "maxTokens" },
          { code: "out_of_range", field: "avatarText" },
        ]),
      },
    });

    const badSkill = await collection.POST(
      request("http://localhost/api/agents", {
        ...input,
        skillIds: ["missing"],
      }),
    );
    expect(badSkill.status).toBe(409);
    await expect(badSkill.json()).resolves.toMatchObject({
      error: { code: "INVALID_SKILL_REFERENCE" },
    });

    const created = await (
      await collection.POST(request("http://localhost/api/agents", input))
    ).json();
    const missingField = await item.PATCH(
      request(
        `http://localhost/api/agents/${created.agent.id}`,
        { ...input, systemPrompt: undefined, expectedVersion: 1 },
        "PATCH",
      ),
      { params: Promise.resolve({ agentId: created.agent.id }) },
    );
    expect(missingField.status).toBe(400);
    await expect(missingField.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });

    const update = { ...input, expectedVersion: 1 };
    expect(
      (
        await item.PATCH(
          request(`http://localhost/api/agents/${created.agent.id}`, update, "PATCH"),
          { params: Promise.resolve({ agentId: created.agent.id }) },
        )
      ).status,
    ).toBe(200);
    const stale = await item.PATCH(
      request(`http://localhost/api/agents/${created.agent.id}`, update, "PATCH"),
      { params: Promise.resolve({ agentId: created.agent.id }) },
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "RESOURCE_CONFLICT" },
    });

    const missing = await item.PATCH(
      request("http://localhost/api/agents/missing", update, "PATCH"),
      { params: Promise.resolve({ agentId: "missing" }) },
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "AGENT_NOT_FOUND" },
    });
  });
});
