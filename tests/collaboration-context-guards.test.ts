import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as agentService from "@/src/adapters/outbound/sqlite/identity-capability/agent-service";
import * as contextSnapshotService from "@/src/server/context-snapshot-service";
import * as providerService from "@/src/adapters/outbound/sqlite/identity-capability/provider-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { replaceMembers } from "@/src/server/membership-service";
import {
  updateMission,
  updateWorkItem,
} from "@/src/server/mission-service";
import {
  createThread,
  startThreadRun,
} from "@/src/server/collaboration/thread-service";
import { seedMissionInitializationForMission as initializeMissionDeliveryTx } from "@/tests/fixtures/review/mission-initialization";

type ContextFingerprint = {
  hash: string;
  facts: {
    roster: Array<{ agentId: string }>;
  };
};

const MASTER_KEY = Buffer.alloc(32, 35).toString("base64url");
let directory: string;
let databasePath: string;
let runId: string;

function fingerprint(): ContextFingerprint {
  const implementation = (
    contextSnapshotService as unknown as {
      collaborationContextFingerprint?: (
        databasePath: string,
        projectId: string,
      ) => ContextFingerprint;
    }
  ).collaborationContextFingerprint;
  expect(implementation, "T-5 context fingerprint primitive must exist").toBeTypeOf(
    "function",
  );
  return implementation!(databasePath, "project-1");
}

function disposition(acquiredHash: string): {
  category: "context_changed" | null;
  disposition: "current" | "discarded";
} {
  const implementation = (
    contextSnapshotService as unknown as {
      evaluateAcquiredContext?: (
        databasePath: string,
        projectId: string,
        acquiredHash: string,
      ) => {
        category: "context_changed" | null;
        disposition: "current" | "discarded";
      };
    }
  ).evaluateAcquiredContext;
  expect(implementation, "T-5 stale acquired-context contract must exist").toBeTypeOf(
    "function",
  );
  return implementation!(databasePath, "project-1", acquiredHash);
}

function seedReadyRun(): void {
  const database = openDatabase(databasePath);
  const vault = createCredentialVault();
  const credential = vault.encrypt("provider-1", "context-guard-key");
  const timestamp = "2026-07-30T00:00:00.000Z";
  try {
    database
      .prepare(
        `INSERT INTO projects (
           id, name, created_at, workspace_path, workspace_key, version
         ) VALUES (?, ?, ?, ?, ?, 1)`,
      )
      .run("project-1", "Project", timestamp, directory, directory.toLowerCase());
    database
      .prepare(
        `INSERT INTO providers (
           id, name, base_url, default_model, api_key_cipher, api_key_iv,
           api_key_tag, credential_version, credential_generation, key_id,
           api_key_mask, verified_at, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        "provider-1",
        "Local",
        "http://127.0.0.1:4000/v1",
        "model",
        credential.apiKeyCipher,
        credential.apiKeyIv,
        credential.apiKeyTag,
        credential.credentialVersion,
        credential.keyId,
        credential.apiKeyMask,
        timestamp,
        timestamp,
        timestamp,
      );
    const insertAgent = database.prepare(
      `INSERT INTO agents (
         id, name, role, system_prompt, provider_id, model, avatar_text,
         accent_token, can_read, can_write, can_execute, max_tokens,
         max_handoffs, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'provider-1', 'model', ?, 'sage', 1, 0, 0,
                 1000, 5, 1, ?, ?)`,
    );
    insertAgent.run("agent-a", "Alpha", "Peer", "Prompt A", "A", timestamp, timestamp);
    insertAgent.run("agent-b", "Beta", "Peer", "Prompt B", "B", timestamp, timestamp);
    insertAgent.run("agent-c", "Gamma", "Peer", "Prompt C", "C", timestamp, timestamp);
    database.exec(`
      INSERT INTO project_memberships (project_id, agent_id, joined_at)
      VALUES
        ('project-1', 'agent-a', '2026-07-30T00:00:00.000Z'),
        ('project-1', 'agent-b', '2026-07-30T00:00:01.000Z');
      INSERT INTO missions (
        id, project_id, title, goal, version, created_at, updated_at
      ) VALUES (
        'mission-1', 'project-1', 'Mission', 'Goal', 1, '${timestamp}', '${timestamp}'
      );
      INSERT INTO work_items (
        id, mission_id, title, description, status, assignee_agent_id,
        version, created_at, updated_at
      ) VALUES (
        'work-1', 'mission-1', 'Task', 'Description', 'todo', NULL,
        1, '${timestamp}', '${timestamp}'
      );
    `);
    initializeMissionDeliveryTx(database, {
      id: "mission-1",
      projectId: "project-1",
      updatedAt: timestamp,
    });
  } finally {
    database.close();
  }
  const threadId = createThread(databasePath, "project-1", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000000500",
    title: "Context guard",
  }).body.thread.id;
  runId = startThreadRun(databasePath, "project-1", threadId, {
    message: "Start",
    operationId: "00000000-0000-4000-8000-000000000501",
  }).body.run.id;
}

function setRunStatus(
  status: "running" | "waiting_owner" | "paused" | "failed" | "stopped",
): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare("UPDATE collaboration_runs SET status = ? WHERE id = ?")
      .run(status, runId);
  } finally {
    database.close();
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaboration-context-guards-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  seedReadyRun();
});

afterEach(() => {
  delete process.env.COCKPIT_MASTER_KEY;
  rmSync(directory, { force: true, recursive: true });
});

describe("collaboration context fingerprint", () => {
  it("marks acquired context discarded after mission and task fact changes", () => {
    const acquiredMission = fingerprint().hash;
    expect(disposition(acquiredMission)).toEqual({
      category: null,
      disposition: "current",
    });

    updateMission(databasePath, "mission-1", {
      expectedVersion: 1,
      goal: "Changed goal",
      title: "Mission",
    });
    expect(disposition(acquiredMission)).toEqual({
      category: "context_changed",
      disposition: "discarded",
    });

    const acquiredTask = fingerprint().hash;
    updateWorkItem(databasePath, "work-1", {
      assigneeAgentId: null,
      dependencyIds: [],
      description: "Changed description",
      expectedVersion: 1,
      title: "Task",
    });
    expect(disposition(acquiredTask)).toEqual({
      category: "context_changed",
      disposition: "discarded",
    });
  });

  it("changes the roster fingerprint when a member is added", () => {
    const acquired = fingerprint();
    const state = replaceMembers(databasePath, "project-1", {
      agentIds: ["agent-a", "agent-b", "agent-c"],
      expectedProjectVersion: 1,
    });
    const current = fingerprint();

    expect(state.members.map(({ agentId }) => agentId).sort()).toEqual([
      "agent-a",
      "agent-b",
      "agent-c",
    ]);
    expect(current.facts.roster.map(({ agentId }) => agentId).sort()).toEqual([
      "agent-a",
      "agent-b",
      "agent-c",
    ]);
    expect(current.hash).not.toBe(acquired.hash);
    expect(disposition(acquired.hash)).toEqual({
      category: "context_changed",
      disposition: "discarded",
    });
  });
});

describe("active collaboration mutation guards", () => {
  it.each(["running", "waiting_owner", "paused", "failed"] as const)(
    "rejects member removal or replacement while the run is %s",
    (status) => {
      setRunStatus(status);
      expect(() =>
        replaceMembers(databasePath, "project-1", {
          agentIds: ["agent-a", "agent-c"],
          expectedProjectVersion: 1,
        }),
      ).toThrowError(expect.objectContaining({ code: "COLLABORATION_ACTIVE" }));
      expect(fingerprint().facts.roster.map(({ agentId }) => agentId)).toEqual([
        "agent-a",
        "agent-b",
      ]);
    },
  );

  it("rejects deleting an active member or the provider used by any active member", () => {
    const deleteAgent = (
      agentService as unknown as {
        deleteAgent?: (agentId: string, databasePath: string) => void;
      }
    ).deleteAgent;
    const deleteProvider = (
      providerService as unknown as {
        deleteProvider?: (providerId: string, databasePath: string) => void;
      }
    ).deleteProvider;
    expect(deleteAgent, "T-5 Agent deletion service must exist").toBeTypeOf("function");
    expect(deleteProvider, "T-5 provider deletion service must exist").toBeTypeOf(
      "function",
    );

    expect(() => deleteAgent!("agent-a", databasePath)).toThrowError(
      expect.objectContaining({ code: "COLLABORATION_ACTIVE" }),
    );
    expect(() => deleteProvider!("provider-1", databasePath)).toThrowError(
      expect.objectContaining({ code: "COLLABORATION_ACTIVE" }),
    );
  });

  it("allows Agent and provider configuration updates for the next attempt", () => {
    const acquired = fingerprint().hash;
    const updatedAgent = agentService.updateAgent(
      "agent-a",
      {
        accentToken: "gold",
        avatarText: "AA",
        expectedVersion: 1,
        maxHandoffs: 8,
        maxTokens: 2000,
        model: "model",
        name: "Alpha next",
        permissions: {
          readFiles: true,
          runCommands: true,
          writeFiles: true,
        },
        providerId: "provider-1",
        role: "Next attempt role",
        skillIds: [],
        systemPrompt: "Next attempt prompt",
      },
      databasePath,
    );
    const updatedProvider = providerService.updateProvider(
      "provider-1",
      {
        allowInsecureHttp: true,
        baseUrl: "http://127.0.0.1:4000/v1",
        defaultModel: "model",
        expectedVersion: 1,
        mode: "retain",
        name: "Local next",
        providerId: "provider-1",
      },
      undefined,
      databasePath,
    );

    expect(updatedAgent.version).toBe(2);
    expect(updatedProvider.version).toBe(2);
    expect(disposition(acquired)).toEqual({
      category: null,
      disposition: "current",
    });
  });

  it("preserves roster replacement behavior when no nonterminal run exists", () => {
    setRunStatus("stopped");
    expect(
      replaceMembers(databasePath, "project-1", {
        agentIds: ["agent-a", "agent-c"],
        expectedProjectVersion: 1,
      }).members.map(({ agentId }) => agentId).sort(),
    ).toEqual(["agent-a", "agent-c"]);
  });
});
