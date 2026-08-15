import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ZodIssue } from "zod";

import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import type { CredentialEnvelope } from "@/src/modules/identity-capability";
import { AgentServiceError } from "@/src/modules/identity-capability";
import { isAgentInActiveCollaboration } from "@/src/adapters/outbound/sqlite/public-collaboration/active-run-guards";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import type {
  AgentInput,
  AgentProfile,
  AgentTemplate,
  UpdateAgentInput,
} from "@/src/shared/team-contracts";
import {
  agentInputSchema,
  updateAgentInputSchema,
} from "@/src/shared/team-schemas";

type AgentRow = {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  avatarText: string;
  accentToken: AgentProfile["accentToken"];
  canRead: number;
  canWrite: number;
  canExecute: number;
  reviewCapable: number;
  maxTokens: number;
  maxHandoffs: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type ProviderReferenceRow = {
  id: string;
  defaultModel: string;
  apiKeyCipher: string;
  apiKeyIv: string;
  apiKeyTag: string;
  credentialVersion: number;
  keyId: string;
  apiKeyMask: string;
  verifiedAt: string;
};

const TEMPLATE_DEFAULTS: readonly AgentTemplate[] = Object.freeze([
  Object.freeze({
    accentToken: "sage",
    avatarText: "规",
    id: "planner",
    name: "规划",
    role: "拆解目标并制定可验证计划",
    reviewCapable: false,
    systemPrompt: "澄清目标、识别风险，并把工作拆成可验证步骤。",
  }),
  Object.freeze({
    accentToken: "terracotta",
    avatarText: "实",
    id: "builder",
    name: "实施",
    role: "按批准计划实现并验证",
    reviewCapable: false,
    systemPrompt: "按批准的计划实施变更，并用自动化验证结果。",
  }),
  Object.freeze({
    accentToken: "slate",
    avatarText: "复",
    id: "reviewer",
    name: "复核",
    role: "独立检查正确性与风险",
    reviewCapable: true,
    systemPrompt: "独立检查实现、测试证据和未覆盖风险。",
  }),
]);

function fieldCode(issue: ZodIssue): string {
  if (
    issue.code === "custom" &&
    (issue.message === "not_integer" ||
      issue.message === "out_of_range" ||
      issue.message === "invalid_reference")
  ) {
    return issue.message;
  }
  if (issue.code === "too_big") {
    return issue.origin === "number" ? "out_of_range" : "too_long";
  }
  if (issue.code === "too_small") {
    return issue.origin === "number" ? "out_of_range" : "required";
  }
  return "invalid_format";
}

function invalidInput(issues: ZodIssue[]): AgentServiceError {
  return new AgentServiceError(
    "INVALID_INPUT",
    400,
    "Agent input is invalid.",
    issues.map((issue) => ({
      code: fieldCode(issue),
      field: issue.path.join(".") || "input",
    })),
  );
}

function parseInput(input: unknown): AgentInput {
  const parsed = agentInputSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error.issues);
  return parsed.data;
}

function parseUpdateInput(input: unknown): UpdateAgentInput {
  const parsed = updateAgentInputSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error.issues);
  return parsed.data;
}

function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the domain failure.
    }
    throw error;
  }
}

function providerReference(
  database: DatabaseSync,
  providerId: string,
): ProviderReferenceRow | undefined {
  return database
    .prepare(`
      SELECT
        id,
        default_model AS defaultModel,
        api_key_cipher AS apiKeyCipher,
        api_key_iv AS apiKeyIv,
        api_key_tag AS apiKeyTag,
        credential_version AS credentialVersion,
        key_id AS keyId,
        api_key_mask AS apiKeyMask,
        verified_at AS verifiedAt
      FROM providers
      WHERE id = ?
    `)
    .get(providerId) as ProviderReferenceRow | undefined;
}

function ensureProvider(
  database: DatabaseSync,
  providerId: string,
  model: string,
): void {
  const provider = providerReference(database, providerId);
  if (provider && provider.defaultModel !== model) {
    throw new AgentServiceError(
      "INVALID_INPUT",
      400,
      "Agent model must match the provider default model.",
      [{ code: "invalid_reference", field: "model" }],
    );
  }
  if (!provider || !provider.verifiedAt) {
    throw new AgentServiceError(
      "PROVIDER_NOT_VERIFIED",
      409,
      "Provider is not verified.",
    );
  }

  try {
    const envelope: CredentialEnvelope = {
      apiKeyCipher: provider.apiKeyCipher,
      apiKeyIv: provider.apiKeyIv,
      apiKeyMask: provider.apiKeyMask,
      apiKeyTag: provider.apiKeyTag,
      credentialVersion: provider.credentialVersion as 1,
      keyId: provider.keyId,
    };
    createCredentialVault().decrypt(provider.id, envelope);
  } catch {
    throw new AgentServiceError(
      "PROVIDER_NOT_VERIFIED",
      409,
      "Provider is not verified.",
    );
  }
}

function ensureSkills(database: DatabaseSync, skillIds: string[]): void {
  if (skillIds.length === 0) return;
  const placeholders = skillIds.map(() => "?").join(", ");
  const rows = database
    .prepare(`SELECT id FROM skills WHERE id IN (${placeholders})`)
    .all(...skillIds) as Array<{ id: string }>;
  if (rows.length !== skillIds.length) {
    throw new AgentServiceError(
      "INVALID_SKILL_REFERENCE",
      409,
      "One or more skills do not exist.",
    );
  }
}

function selectAgent(
  database: DatabaseSync,
  agentId: string,
): AgentRow | undefined {
  return database
    .prepare(`
      SELECT
        id,
        name,
        role,
        system_prompt AS systemPrompt,
        provider_id AS providerId,
        model,
        avatar_text AS avatarText,
        accent_token AS accentToken,
        can_read AS canRead,
        can_write AS canWrite,
        can_execute AS canExecute,
        review_capable AS reviewCapable,
        max_tokens AS maxTokens,
        max_handoffs AS maxHandoffs,
        version,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM agents
      WHERE id = ?
    `)
    .get(agentId) as AgentRow | undefined;
}

function skillIdsFor(database: DatabaseSync, agentId: string): string[] {
  const rows = database
    .prepare(`
      SELECT skill_id AS skillId
      FROM agent_skills
      WHERE agent_id = ?
      ORDER BY position ASC
    `)
    .all(agentId) as Array<{ skillId: string }>;
  return rows.map(({ skillId }) => skillId);
}

function toAgent(database: DatabaseSync, row: AgentRow): AgentProfile {
  return {
    accentToken: row.accentToken,
    avatarText: row.avatarText,
    createdAt: row.createdAt,
    id: row.id,
    maxHandoffs: row.maxHandoffs,
    maxTokens: row.maxTokens,
    model: row.model,
    name: row.name,
    permissions: {
      readFiles: row.canRead === 1,
      runCommands: row.canExecute === 1,
      writeFiles: row.canWrite === 1,
    },
    providerId: row.providerId,
    reviewCapable: row.reviewCapable === 1,
    role: row.role,
    skillIds: skillIdsFor(database, row.id),
    systemPrompt: row.systemPrompt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

const STARTER_PREFIX = "starter-";
const STARTER_MAX_TOKENS = 16_000;
const STARTER_MAX_HANDOFFS = 8;

type StarterPermissions = AgentProfile["permissions"];

function starterId(templateId: AgentTemplate["id"]): string {
  return `${STARTER_PREFIX}${templateId}`;
}

function starterPermissions(templateId: AgentTemplate["id"]): StarterPermissions {
  if (templateId === "builder") {
    return {
      readFiles: true,
      runCommands: true,
      writeFiles: true,
    };
  }
  return {
    readFiles: true,
    runCommands: false,
    writeFiles: false,
  };
}

function firstVerifiedProvider(
  database: DatabaseSync,
): { defaultModel: string; id: string } | undefined {
  return database
    .prepare(`
      SELECT
        id,
        default_model AS defaultModel
      FROM providers
      WHERE verified_at IS NOT NULL AND trim(verified_at) != ''
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `)
    .get() as { defaultModel: string; id: string } | undefined;
}

function insertStarterAgent(
  database: DatabaseSync,
  template: AgentTemplate,
  provider: { defaultModel: string; id: string },
  timestamp: string,
): void {
  const id = starterId(template.id);
  const permissions = starterPermissions(template.id);
  database
    .prepare(`
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model,
        avatar_text, accent_token, can_read, can_write, can_execute,
        review_capable, max_tokens, max_handoffs, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `)
    .run(
      id,
      template.name,
      template.role,
      template.systemPrompt,
      provider.id,
      provider.defaultModel,
      template.avatarText,
      template.accentToken,
      Number(permissions.readFiles),
      Number(permissions.writeFiles),
      Number(permissions.runCommands),
      Number(template.reviewCapable),
      STARTER_MAX_TOKENS,
      STARTER_MAX_HANDOFFS,
      timestamp,
      timestamp,
    );
}

function requireAgent(database: DatabaseSync, agentId: string): AgentRow {
  const row = selectAgent(database, agentId);
  if (!row) {
    throw new AgentServiceError("AGENT_NOT_FOUND", 404, "Agent was not found.");
  }
  return row;
}

function insertAgentSkills(
  database: DatabaseSync,
  agentId: string,
  skillIds: string[],
): void {
  const insert = database.prepare(
    "INSERT INTO agent_skills (agent_id, skill_id, position) VALUES (?, ?, ?)",
  );
  skillIds.forEach((skillId, position) => {
    insert.run(agentId, skillId, position);
  });
}

export function getAgentTemplates(): readonly AgentTemplate[] {
  return Object.freeze(
    TEMPLATE_DEFAULTS.map((template) => Object.freeze({ ...template })),
  );
}

export function createAgent(
  input: AgentInput,
  databasePath: string,
): AgentProfile {
  const parsed = parseInput(input);
  const database = openDatabase(databasePath);

  try {
    return withTransaction(database, () => {
      ensureProvider(database, parsed.providerId, parsed.model);
      ensureSkills(database, parsed.skillIds);
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      database
        .prepare(`
          INSERT INTO agents (
            id, name, role, system_prompt, provider_id, model,
            avatar_text, accent_token, can_read, can_write, can_execute,
            review_capable, max_tokens, max_handoffs, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `)
        .run(
          id,
          parsed.name,
          parsed.role,
          parsed.systemPrompt,
          parsed.providerId,
          parsed.model,
          parsed.avatarText,
          parsed.accentToken,
          Number(parsed.permissions.readFiles),
          Number(parsed.permissions.writeFiles),
          Number(parsed.permissions.runCommands),
          Number(parsed.reviewCapable),
          parsed.maxTokens,
          parsed.maxHandoffs,
          timestamp,
          timestamp,
        );
      insertAgentSkills(database, id, parsed.skillIds);
      return toAgent(database, requireAgent(database, id));
    });
  } finally {
    database.close();
  }
}

export function listAgents(databasePath: string): AgentProfile[] {
  const database = openDatabase(databasePath);
  try {
    const rows = database
      .prepare(`
        SELECT
          id,
          name,
          role,
          system_prompt AS systemPrompt,
          provider_id AS providerId,
          model,
          avatar_text AS avatarText,
          accent_token AS accentToken,
          can_read AS canRead,
          can_write AS canWrite,
          can_execute AS canExecute,
          review_capable AS reviewCapable,
          max_tokens AS maxTokens,
          max_handoffs AS maxHandoffs,
          version,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM agents
        ORDER BY created_at ASC, id ASC
      `)
      .all() as AgentRow[];
    return rows.map((row) => toAgent(database, row));
  } finally {
    database.close();
  }
}

export function updateAgent(
  agentId: string,
  input: UpdateAgentInput,
  databasePath: string,
): AgentProfile {
  const parsed = parseUpdateInput(input);
  const database = openDatabase(databasePath);

  try {
    return withTransaction(database, () => {
      const current = selectAgent(database, agentId);
      if (!current) {
        throw new AgentServiceError("AGENT_NOT_FOUND", 404, "Agent was not found.");
      }
      if (current.version !== parsed.expectedVersion) {
        throw new AgentServiceError(
          "RESOURCE_CONFLICT",
          409,
          "Agent version is stale.",
        );
      }
      ensureProvider(database, parsed.providerId, parsed.model);
      ensureSkills(database, parsed.skillIds);
      const updatedAt = new Date().toISOString();
      database
        .prepare(`
          UPDATE agents
          SET name = ?,
              role = ?,
              system_prompt = ?,
              provider_id = ?,
              model = ?,
              avatar_text = ?,
              accent_token = ?,
              can_read = ?,
              can_write = ?,
              can_execute = ?,
              review_capable = ?,
              max_tokens = ?,
              max_handoffs = ?,
              version = version + 1,
              updated_at = ?
          WHERE id = ? AND version = ?
        `)
        .run(
          parsed.name,
          parsed.role,
          parsed.systemPrompt,
          parsed.providerId,
          parsed.model,
          parsed.avatarText,
          parsed.accentToken,
          Number(parsed.permissions.readFiles),
          Number(parsed.permissions.writeFiles),
          Number(parsed.permissions.runCommands),
          Number(parsed.reviewCapable),
          parsed.maxTokens,
          parsed.maxHandoffs,
          updatedAt,
          agentId,
          parsed.expectedVersion,
        );
      database
        .prepare("DELETE FROM agent_skills WHERE agent_id = ?")
        .run(agentId);
      insertAgentSkills(database, agentId, parsed.skillIds);
      return toAgent(database, requireAgent(database, agentId));
    });
  } finally {
    database.close();
  }
}

export function ensureStarterAgents(databasePath: string): AgentProfile[] {
  const database = openDatabase(databasePath);
  try {
    return withTransaction(database, () => {
      const provider = firstVerifiedProvider(database);
      if (!provider) return [];
      const timestamp = new Date().toISOString();
      const starters: AgentProfile[] = [];
      for (const template of TEMPLATE_DEFAULTS) {
        const id = starterId(template.id);
        if (!selectAgent(database, id)) {
          insertStarterAgent(database, template, provider, timestamp);
        }
        starters.push(toAgent(database, requireAgent(database, id)));
      }
      return starters;
    });
  } finally {
    database.close();
  }
}

export function deleteAgent(agentId: string, databasePath: string): void {
  const database = openDatabase(databasePath);
  try {
    withTransaction(database, () => {
      if (!selectAgent(database, agentId)) {
        throw new AgentServiceError("AGENT_NOT_FOUND", 404, "Agent was not found.");
      }
      if (agentId.startsWith(STARTER_PREFIX)) {
        throw new AgentServiceError(
          "STARTER_AGENT_PROTECTED",
          409,
          "系统自带 Agent 不能删除。",
        );
      }
      if (isAgentInActiveCollaboration(database, agentId)) {
        throw new AgentServiceError(
          "COLLABORATION_ACTIVE",
          409,
          "An Agent in an active collaboration cannot be deleted.",
        );
      }
      database.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    });
  } finally {
    database.close();
  }
}
