import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollaborationError } from "@/src/server/collaboration/collaboration-errors";
import {
  createThread,
  updateThreadPolicy,
} from "@/src/server/collaboration/thread-service";
import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import { seedMissionInitializationForMission as initializeMissionDeliveryTx } from "@/tests/fixtures/review/mission-initialization";

type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type PromptSnapshot = {
  schemaVersion: 1;
  agentId: string;
  threadId: string;
  policyVersion: number;
  currentAgent: {
    id: string;
    name: string;
    role: string;
    systemPrompt: string;
    skills: Array<{ id: string; name: string; instructions: string }>;
    permissionSummary: {
      configured: {
        readFiles: boolean;
        writeFiles: boolean;
        runCommands: boolean;
      };
      collaborationTools: {
        fileRead: "unavailable";
        fileWrite: "unavailable";
        commandExecution: "unavailable";
        network: "unavailable";
      };
    };
  };
  sharedContext: {
    project: { id: string; name: string; workspaceBound: true };
    roster: Array<{
      agentId: string;
      name: string;
      role: string;
      skillNames: string[];
    }>;
  };
  publicMessages: Array<{
    sequence: number;
    authorType: "owner" | "agent";
    authorAgentId: string | null;
    authorDisplayName: string;
    content: string;
    mentionAgentId: string | null;
    mentionDisplayName: string | null;
  }>;
  includedMessageSequence: number;
  contextHash: string;
  promptHash: string;
  messages: PromptMessage[];
};

type PromptBuilderModule = {
  acquireCollaborationPrompt(
    databasePath: string,
    projectId: string,
    threadId: string,
    agentId: string,
  ): PromptSnapshot;
};

const promptBuilderModules =
  import.meta.glob<PromptBuilderModule>("../src/server/collaboration/prompt-builder.ts");

const MASTER_KEY = Buffer.alloc(32, 61).toString("base64url");
const PROJECT_ID = "project-prompt";
const ALPHA_ID = "agent-alpha";
const BETA_ID = "agent-beta";
const GAMMA_ID = "agent-gamma";
const WORKSPACE_PATH = "D:\\private\\workspace\\absolute-path-marker";
const SECRET_MARKERS = [
  "provider-api-key-marker",
  "cipher-marker",
  "iv-marker",
  "tag-marker",
  "validation-token-marker",
  MASTER_KEY,
];

let directory: string;
let databasePath: string;
let primaryThreadId: string;
let secondaryThreadId: string;

async function promptBuilder(): Promise<PromptBuilderModule> {
  const load =
    promptBuilderModules["../src/server/collaboration/prompt-builder.ts"];
  expect(load, "T-6 prompt builder service must exist").toBeTypeOf("function");
  return load();
}

function seedReadyProject(): void {
  const database = openDatabase(databasePath);
  const credential = createCredentialVault().encrypt(
    "provider-prompt",
    "provider-api-key-marker",
  );
  const gammaCredential = createCredentialVault().encrypt(
    "provider-gamma",
    "gamma-provider-api-key-marker",
  );
  const timestamp = "2026-07-30T00:00:00.000Z";
  try {
    database
      .prepare(
        `INSERT INTO projects (
           id, name, created_at, workspace_path, workspace_key, version
         ) VALUES (?, ?, ?, ?, ?, 1)`,
      )
      .run(
        PROJECT_ID,
        "Prompt Project",
        timestamp,
        WORKSPACE_PATH,
        WORKSPACE_PATH.toLowerCase(),
      );
    database
      .prepare(
        `INSERT INTO providers (
           id, name, base_url, default_model, api_key_cipher, api_key_iv,
           api_key_tag, credential_version, credential_generation, key_id,
           api_key_mask, verified_at, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        "provider-gamma",
        "Gamma Provider",
        "https://gamma-provider.invalid/v1",
        "gamma-model",
        gammaCredential.apiKeyCipher,
        gammaCredential.apiKeyIv,
        gammaCredential.apiKeyTag,
        gammaCredential.credentialVersion,
        gammaCredential.keyId,
        gammaCredential.apiKeyMask,
        timestamp,
        timestamp,
        timestamp,
      );
    database
      .prepare(
        `INSERT INTO providers (
           id, name, base_url, default_model, api_key_cipher, api_key_iv,
           api_key_tag, credential_version, credential_generation, key_id,
           api_key_mask, verified_at, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        "provider-prompt",
        "Private Provider",
        "https://provider.invalid/v1",
        "private-model",
        `${credential.apiKeyCipher}-cipher-marker`,
        `${credential.apiKeyIv}-iv-marker`,
        `${credential.apiKeyTag}-tag-marker`,
        credential.credentialVersion,
        credential.keyId,
        "validation-token-marker",
        timestamp,
        timestamp,
        timestamp,
      );
    database.exec(`
      INSERT INTO skills (
        id, name, description, instructions, version, created_at, updated_at
      ) VALUES
        ('skill-alpha-first', 'Alpha First', '', 'alpha-first-instruction-marker', 1, '${timestamp}', '${timestamp}'),
        ('skill-alpha-second', 'Alpha Second', '', 'alpha-second-instruction-marker', 1, '${timestamp}', '${timestamp}'),
        ('skill-beta-only', 'Beta Only', '', 'beta-only-instruction-marker', 1, '${timestamp}', '${timestamp}');
      INSERT INTO agents (
        id, name, role, system_prompt, provider_id, model, avatar_text,
        accent_token, can_read, can_write, can_execute, max_tokens,
        max_handoffs, version, created_at, updated_at
      ) VALUES
        (
          '${ALPHA_ID}', 'Alpha', 'alpha-private-role-marker',
          'alpha-private-system-marker', 'provider-prompt', 'private-model',
          'A', 'sage', 1, 0, 1, 1000, 5, 1, '${timestamp}', '${timestamp}'
        ),
        (
          '${BETA_ID}', 'Beta', 'beta-private-role-marker',
          'beta-private-system-marker', 'provider-prompt', 'private-model',
          'B', 'gold', 0, 1, 0, 1000, 5, 1, '${timestamp}', '${timestamp}'
        ),
        (
          '${GAMMA_ID}', 'Gamma', 'gamma-non-policy-role-marker',
          'gamma-non-policy-system-marker', 'provider-gamma', 'gamma-model',
          'G', 'sage', 1, 1, 1, 1000, 5, 1, '${timestamp}', '${timestamp}'
        );
      INSERT INTO agent_skills (agent_id, skill_id, position) VALUES
        ('${ALPHA_ID}', 'skill-alpha-second', 1),
        ('${ALPHA_ID}', 'skill-alpha-first', 0),
        ('${BETA_ID}', 'skill-beta-only', 0);
      INSERT INTO project_memberships (project_id, agent_id, joined_at) VALUES
        ('${PROJECT_ID}', '${ALPHA_ID}', '2026-07-30T00:00:00.000Z'),
        ('${PROJECT_ID}', '${BETA_ID}', '2026-07-30T00:00:01.000Z'),
        ('${PROJECT_ID}', '${GAMMA_ID}', '2026-07-30T00:00:02.000Z');
      INSERT INTO missions (
        id, project_id, title, goal, version, created_at, updated_at
      ) VALUES (
        'mission-prompt', '${PROJECT_ID}', 'Stable Mission', 'Build safely',
        1, '${timestamp}', '${timestamp}'
      );
      INSERT INTO work_items (
        id, mission_id, title, description, status, assignee_agent_id,
        version, created_at, updated_at
      ) VALUES (
        'work-prompt', 'mission-prompt', 'First task', 'Public description',
        'todo', NULL, 1, '${timestamp}', '${timestamp}'
      );
      INSERT INTO memory_entries (
        id, project_id, chain_id, version, type, content, dedupe_hash,
        source_type, source_id, source_version, proposer_actor_type,
        proposer_actor_id, confirming_review_attempt_id, persistence_actor,
        supersedes_id, created_at
      ) VALUES (
        'memory-prompt', '${PROJECT_ID}', 'memory-prompt', 1, 'fact',
        'Public active memory', '${"a".repeat(64)}', 'owner_input', 'Owner',
        NULL, 'owner', NULL, NULL, 'platform', NULL, '${timestamp}'
      );
    `);
    initializeMissionDeliveryTx(database, {
      id: "mission-prompt",
      projectId: PROJECT_ID,
      updatedAt: timestamp,
    });
  } finally {
    database.close();
  }
  primaryThreadId = createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [BETA_ID, ALPHA_ID],
    operationId: "22000000-0000-4000-8000-000000000001",
    title: "Primary prompt",
  }).body.thread.id;
  secondaryThreadId = createThread(databasePath, PROJECT_ID, {
    memberAgentIds: [ALPHA_ID, BETA_ID],
    operationId: "22000000-0000-4000-8000-000000000002",
    title: "Secondary prompt",
  }).body.thread.id;
}

function insertMessage(input: {
  sequence: number;
  content: string;
  threadId?: string;
  authorType?: "owner" | "agent";
  authorAgentId?: string | null;
  authorDisplayName?: string;
  mentionAgentId?: string | null;
  mentionDisplayName?: string | null;
}): void {
  const threadId = input.threadId ?? primaryThreadId;
  const database = openDatabase(databasePath);
  try {
    const thread = database
      .prepare(
        `SELECT next_fact_sequence AS factSequence
         FROM collaboration_threads WHERE project_id=? AND id=?`,
      )
      .get(PROJECT_ID, threadId) as { factSequence: number };
    const project = database
      .prepare(
        `SELECT next_activity_sequence AS activitySequence
         FROM collaboration_project_thread_sequences WHERE project_id=?`,
      )
      .get(PROJECT_ID) as { activitySequence: number };
    const messageId = `message-${threadId}-${input.sequence}`;
    const factId = `fact-${threadId}-${input.sequence}`;
    const timestamp = `2026-07-30T00:01:${String(input.sequence).padStart(2, "0")}.000Z`;
    database
      .prepare(
        `INSERT INTO collaboration_messages (
           id, project_id, thread_id, run_id, author_type, author_agent_id,
           author_display_name, content, mention_agent_id, mention_display_name,
           sequence, consumed_at, created_at
         ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        messageId,
        PROJECT_ID,
        threadId,
        input.authorType ?? "owner",
        input.authorAgentId ?? null,
        input.authorDisplayName ?? "Owner",
        input.content,
        input.mentionAgentId ?? null,
        input.mentionDisplayName ?? null,
        input.sequence,
        timestamp,
      );
    database
      .prepare(
        `INSERT INTO collaboration_thread_facts(
           id,project_id,thread_id,sequence,activity_sequence,type,actor_type,
           actor_id,run_id,message_id,run_event_id,policy_revision_id,payload_json,
           created_at
         ) VALUES (?,?,?,?,?,?,?,?,NULL,?,NULL,NULL,json_object('messageId',?),?)`,
      )
      .run(
        factId,
        PROJECT_ID,
        threadId,
        thread.factSequence,
        project.activitySequence,
        input.authorType === "agent" ? "agent_message" : "owner_message",
        input.authorType === "agent" ? "agent" : "owner",
        input.authorAgentId ?? null,
        messageId,
        messageId,
        timestamp,
      );
    database
      .prepare(
        `UPDATE collaboration_threads
         SET next_fact_sequence=next_fact_sequence+1,last_activity_sequence=?,
             updated_at=?
         WHERE project_id=? AND id=?`,
      )
      .run(project.activitySequence, timestamp, PROJECT_ID, threadId);
    database
      .prepare(
        `UPDATE collaboration_project_thread_sequences
         SET next_activity_sequence=next_activity_sequence+1 WHERE project_id=?`,
      )
      .run(PROJECT_ID);
    database
      .prepare(
        `UPDATE collaboration_project_sequences
         SET next_message_sequence=? WHERE project_id=? AND thread_id=?`,
      )
      .run(input.sequence + 1, PROJECT_ID, threadId);
  } finally {
    database.close();
  }
}

function isDeeplyFrozen(value: unknown): boolean {
  if (!value || typeof value !== "object" || !Object.isFrozen(value)) return false;
  return Object.values(value).every(
    (child) =>
      !child ||
      typeof child !== "object" ||
      isDeeplyFrozen(child),
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-prompt-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  seedReadyProject();
});

afterEach(() => {
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("collaboration prompt allowlist", () => {
  it("gives both Agents identical shared context and only the current private configuration", async () => {
    const builder = await promptBuilder();
    insertMessage({
      sequence: 1,
      content: "Please coordinate",
      mentionAgentId: BETA_ID,
      mentionDisplayName: "Historical Beta",
    });

    const alpha = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );
    const beta = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      BETA_ID,
    );

    expect(beta.sharedContext).toEqual(alpha.sharedContext);
    expect(beta.publicMessages).toEqual(alpha.publicMessages);
    expect(alpha.threadId).toBe(primaryThreadId);
    expect(alpha.policyVersion).toBe(1);
    expect(alpha.sharedContext.roster.map(({ agentId }) => agentId)).toEqual([
      BETA_ID,
      ALPHA_ID,
    ]);
    expect(alpha.sharedContext).toMatchObject({
      mission: { goal: "Build safely", title: "Stable Mission" },
      workItems: [{ description: "Public description", title: "First task" }],
      memories: [{ content: "Public active memory" }],
    });
    expect(alpha.currentAgent).toMatchObject({
      id: ALPHA_ID,
      role: "alpha-private-role-marker",
      systemPrompt: "alpha-private-system-marker",
      skills: [
        {
          id: "skill-alpha-first",
          instructions: "alpha-first-instruction-marker",
        },
        {
          id: "skill-alpha-second",
          instructions: "alpha-second-instruction-marker",
        },
      ],
      permissionSummary: {
        configured: {
          readFiles: true,
          writeFiles: false,
          runCommands: true,
        },
        collaborationTools: {
          fileRead: "unavailable",
          fileWrite: "unavailable",
          commandExecution: "unavailable",
          network: "unavailable",
        },
      },
    });
    expect(beta.currentAgent).toMatchObject({
      id: BETA_ID,
      role: "beta-private-role-marker",
      systemPrompt: "beta-private-system-marker",
      skills: [
        {
          id: "skill-beta-only",
          instructions: "beta-only-instruction-marker",
        },
      ],
    });

    const alphaSerialized = JSON.stringify(alpha);
    const betaSerialized = JSON.stringify(beta);
    expect(alphaSerialized).not.toContain("beta-private-system-marker");
    expect(alphaSerialized).not.toContain("beta-only-instruction-marker");
    expect(betaSerialized).not.toContain("alpha-private-system-marker");
    expect(betaSerialized).not.toContain("alpha-first-instruction-marker");
    expect(betaSerialized).not.toContain("alpha-second-instruction-marker");
    expect(alphaSerialized).not.toContain(WORKSPACE_PATH);
    expect(betaSerialized).not.toContain(WORKSPACE_PATH);
    for (const marker of SECRET_MARKERS) {
      expect(alphaSerialized).not.toContain(marker);
      expect(betaSerialized).not.toContain(marker);
    }
  });

  it("isolates each thread's messages and immutable policy order", async () => {
    const builder = await promptBuilder();
    insertMessage({ sequence: 1, content: "primary-thread-only" });
    insertMessage({
      sequence: 1,
      content: "secondary-thread-only",
      threadId: secondaryThreadId,
    });

    const primary = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );
    const secondary = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      secondaryThreadId,
      ALPHA_ID,
    );

    expect(primary.publicMessages.map(({ content }) => content)).toEqual([
      "primary-thread-only",
    ]);
    expect(secondary.publicMessages.map(({ content }) => content)).toEqual([
      "secondary-thread-only",
    ]);
    expect(JSON.stringify(primary)).not.toContain("secondary-thread-only");
    expect(JSON.stringify(secondary)).not.toContain("primary-thread-only");
    expect(primary.sharedContext.roster.map(({ agentId }) => agentId)).toEqual([
      BETA_ID,
      ALPHA_ID,
    ]);
    expect(secondary.sharedContext.roster.map(({ agentId }) => agentId)).toEqual([
      ALPHA_ID,
      BETA_ID,
    ]);
  });

  it("selects the newest 30 public messages in stable order with stored name snapshots", async () => {
    const builder = await promptBuilder();
    for (let sequence = 1; sequence <= 35; sequence += 1) {
      insertMessage({
        sequence,
        content: `public-message-${sequence}`,
        authorType: sequence === 35 ? "agent" : "owner",
        authorAgentId: sequence === 35 ? ALPHA_ID : null,
        authorDisplayName:
          sequence === 35 ? "Historical Alpha" : "Historical Owner",
        mentionAgentId: sequence === 34 ? BETA_ID : null,
        mentionDisplayName: sequence === 34 ? "Historical Beta" : null,
      });
    }
    const database = openDatabase(databasePath);
    database
      .prepare("UPDATE agents SET name = 'Renamed Alpha' WHERE id = ?")
      .run(ALPHA_ID);
    database
      .prepare("UPDATE agents SET name = 'Renamed Beta' WHERE id = ?")
      .run(BETA_ID);
    database.close();

    const snapshot = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );

    expect(snapshot.publicMessages).toHaveLength(30);
    expect(snapshot.publicMessages.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 6),
    );
    expect(snapshot.publicMessages.at(-1)).toMatchObject({
      authorDisplayName: "Historical Alpha",
      sequence: 35,
    });
    expect(snapshot.publicMessages.at(-2)).toMatchObject({
      mentionAgentId: BETA_ID,
      mentionDisplayName: "Historical Beta",
      sequence: 34,
    });
    expect(snapshot.includedMessageSequence).toBe(35);
  });

  it("keeps whole messages at the 60000 character boundary without skipping older entries", async () => {
    const builder = await promptBuilder();
    insertMessage({ sequence: 1, content: "older-must-not-be-skipped" });
    insertMessage({ sequence: 2, content: "a".repeat(29_999) });
    insertMessage({ sequence: 3, content: "b".repeat(30_001) });

    const snapshot = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );

    expect(snapshot.publicMessages.map(({ sequence }) => sequence)).toEqual([2, 3]);
    expect(snapshot.publicMessages[0].content).toHaveLength(29_999);
    expect(snapshot.publicMessages[1].content).toHaveLength(30_001);
    expect(
      snapshot.publicMessages.reduce(
        (total, message) => total + message.content.length,
        0,
      ),
    ).toBe(60_000);
  });

  it("returns an immutable acquire snapshot with deterministic canonical hashes", async () => {
    const builder = await promptBuilder();
    insertMessage({ sequence: 1, content: "Hash this public message" });

    const first = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );
    const repeated = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );
    expect(repeated).toEqual(first);
    expect(first.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.contextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(repeated.promptHash).toBe(first.promptHash);
    expect(repeated.contextHash).toBe(first.contextHash);
    expect(isDeeplyFrozen(first)).toBe(true);

    const database = openDatabase(databasePath);
    database
      .prepare("UPDATE agents SET system_prompt = ? WHERE id = ?")
      .run("changed-after-acquire", ALPHA_ID);
    database
      .prepare(
        "UPDATE collaboration_messages SET content = ? WHERE project_id=? AND thread_id=? AND sequence = 1",
      )
      .run("changed-public-message", PROJECT_ID, primaryThreadId);
    database.close();

    expect(JSON.stringify(first)).not.toContain("changed-after-acquire");
    expect(JSON.stringify(first)).not.toContain("changed-public-message");
    const next = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );
    expect(next.promptHash).not.toBe(first.promptHash);
    expect(next.contextHash).not.toBe(first.contextHash);
  });

  it("changes hash only for current thread policy, messages, and shared project facts", async () => {
    const builder = await promptBuilder();
    insertMessage({ sequence: 1, content: "primary hash input" });
    const baseline = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );

    insertMessage({
      sequence: 1,
      content: "unrelated thread hash input",
      threadId: secondaryThreadId,
    });
    updateThreadPolicy(databasePath, PROJECT_ID, secondaryThreadId, {
      expectedVersion: 1,
      memberAgentIds: [BETA_ID, ALPHA_ID],
      operationId: "22000000-0000-4000-8000-000000000003",
    });
    const database = openDatabase(databasePath);
    database
      .prepare(
        `UPDATE agents
         SET system_prompt='changed non-policy private config',version=version+1
         WHERE id=?`,
      )
      .run(GAMMA_ID);
    database
      .prepare(
        `UPDATE providers
         SET api_key_cipher='nonpolicy-provider-failure',
             base_url='https://changed-gamma.invalid/v1',
             version=version+1
         WHERE id=(SELECT provider_id FROM agents WHERE id=?)`,
      )
      .run(GAMMA_ID);
    database.close();

    const unrelated = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );
    expect(unrelated.contextHash).toBe(baseline.contextHash);
    expect(unrelated.promptHash).toBe(baseline.promptHash);

    insertMessage({ sequence: 2, content: "current thread changed" });
    const messageChanged = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );
    expect(messageChanged.contextHash).not.toBe(unrelated.contextHash);

    const policyDatabase = openDatabase(databasePath);
    policyDatabase
      .prepare("UPDATE agents SET role='changed policy role',version=version+1 WHERE id=?")
      .run(BETA_ID);
    policyDatabase.close();
    const memberChanged = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );
    expect(memberChanged.contextHash).not.toBe(messageChanged.contextHash);

    const providerDatabase = openDatabase(databasePath);
    providerDatabase
      .prepare(
        `UPDATE providers
         SET base_url='https://changed-policy-provider.invalid/v1',
             version=version+1
         WHERE id=(SELECT provider_id FROM agents WHERE id=?)`,
      )
      .run(BETA_ID);
    providerDatabase.close();
    const providerChanged = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );
    expect(providerChanged.contextHash).not.toBe(memberChanged.contextHash);

    updateThreadPolicy(databasePath, PROJECT_ID, primaryThreadId, {
      expectedVersion: 1,
      memberAgentIds: [ALPHA_ID, BETA_ID],
      operationId: "22000000-0000-4000-8000-000000000004",
    });
    const policyChanged = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );
    expect(policyChanged.policyVersion).toBe(2);
    expect(policyChanged.contextHash).not.toBe(providerChanged.contextHash);

    const sharedDatabase = openDatabase(databasePath);
    sharedDatabase
      .prepare("UPDATE missions SET goal='Changed shared goal',version=version+1 WHERE id=?")
      .run("mission-prompt");
    sharedDatabase.close();
    const sharedChanged = builder.acquireCollaborationPrompt(
      databasePath,
      PROJECT_ID,
      primaryThreadId,
      ALPHA_ID,
    );
    expect(sharedChanged.contextHash).not.toBe(policyChanged.contextHash);
  });

  it("fails closed for a project and thread tuple mismatch", async () => {
    const builder = await promptBuilder();
    expect(() =>
      builder.acquireCollaborationPrompt(
        databasePath,
        PROJECT_ID,
        "thread-from-another-project",
        ALPHA_ID,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<CollaborationError>>({
        code: "RESOURCE_NOT_FOUND",
        httpStatus: 404,
      }),
    );
  });
});
