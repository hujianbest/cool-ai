

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollaborationError } from "@/src/modules/public-collaboration";
import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { initializeMissingMissionHeads } from "@/tests/fixtures/execution/current-graph";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-08T08:00:00.000Z";
const OPERATION = "00000000-0000-4000-8000-000000000901";
const MASTER_KEY = Buffer.alloc(32, 9).toString("base64url");
let databasePath: string;

type Selection =
  | { kind: "start"; mentionAgentId?: string | null }
  | { kind: "advance"; currentAgentId: string }
  | {
      kind: "handoff";
      mentionAgentId?: string | null;
      targetAgentId: string;
    };

type DispatchResult = {
  dispatch:
    | "ready"
    | "project_context_not_ready"
    | "policy_repair_required"
    | "selected_member_provider_unavailable"
    | "project_run_active";
  missingProjectFacts: string[];
  policy: {
    availability: "ready" | "repair_required";
    members: Array<{
      agentId: string;
      displayNameSnapshot: string;
      live: "current" | "removed";
      position: number;
    }>;
    unavailableMemberIds: string[];
  };
  selectedMemberId: string | null;
};

type ReadinessService = {
  readThreadPolicy: (
    databasePath: string,
    projectId: string,
    threadId: string,
  ) => DispatchResult["policy"];
  resolveThreadDispatch: (
    databasePath: string,
    projectId: string,
    threadId: string,
    selection: Selection,
    options?: { missingProjectFacts?: string[]; projectRunActive?: boolean },
  ) => DispatchResult;
  selectAdvanceAgent: (
    databasePath: string,
    projectId: string,
    threadId: string,
    currentAgentId: string,
  ) => string;
  selectHandoffAgent: (
    databasePath: string,
    projectId: string,
    threadId: string,
    targetAgentId: string,
    mentionAgentId?: string | null,
  ) => string;
  selectStartAgent: (
    databasePath: string,
    projectId: string,
    threadId: string,
    mentionAgentId?: string | null,
  ) => string;
};

async function readinessService(): Promise<ReadinessService> {
  const service = await import("@/src/adapters/outbound/sqlite/public-collaboration/thread-service");
  expect(typeof (service as Record<string, unknown>).resolveThreadDispatch).toBe("function");
  return service as unknown as ReadinessService;
}

function seedProject(): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
         VALUES ('project-a','Project A',?,'D:/workspace','workspace-key',1)`,
      )
      .run(NOW);
    database
      .prepare(
        `INSERT INTO missions(
           id,project_id,title,goal,version,created_at,updated_at
         ) VALUES ('mission-a','project-a','Mission','Goal',1,?,?)`,
      )
      .run(NOW, NOW);
    const insertProvider = database.prepare(
      `INSERT INTO providers(
         id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
         credential_version,credential_generation,key_id,api_key_mask,verified_at,
         version,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertAgent = database.prepare(
      `INSERT INTO agents(
         id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
         can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
         updated_at,review_capable
       ) VALUES (?,?,'Peer','Prompt',?,'model','A','sage',
         1,1,0,1000,3,1,?,?,0)`,
    );
    const insertMember = database.prepare(
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES ('project-a',?,?)",
    );
    const vault = createCredentialVault();
    ["agent-a", "agent-b", "agent-c"].forEach((agentId, position) => {
      const providerId = `provider-${agentId}`;
      const encrypted = vault.encrypt(providerId, `key-${agentId}`);
      insertProvider.run(
        providerId,
        `Provider ${agentId}`,
        "http://localhost/v1",
        "model",
        encrypted.apiKeyCipher,
        encrypted.apiKeyIv,
        encrypted.apiKeyTag,
        encrypted.credentialVersion,
        1,
        encrypted.keyId,
        encrypted.apiKeyMask,
        NOW,
        1,
        NOW,
        NOW,
      );
      insertAgent.run(agentId, `Agent ${agentId}`, providerId, NOW, NOW);
      insertMember.run(agentId, `2026-08-08T08:00:0${position}.000Z`);
    });
    initializeMissingMissionHeads(database);
  } finally {
    database.close();
  }
}

function createPolicyThread(): string {
  return createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-b", "agent-a"],
    operationId: OPERATION,
    title: "Readiness",
  }).body.thread.id;
}

function setProviderAvailable(agentId: string, available: boolean): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `UPDATE providers SET verified_at=?
         WHERE id=(SELECT provider_id FROM agents WHERE id=?)`,
      )
      .run(available ? NOW : "", agentId);
  } finally {
    database.close();
  }
}

function removeMembership(agentId: string): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare("DELETE FROM project_memberships WHERE project_id='project-a' AND agent_id=?")
      .run(agentId);
  } finally {
    database.close();
  }
}

function expectCode(operation: () => unknown, code: string): CollaborationError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
    return error as CollaborationError;
  }
  throw new Error(`Expected ${code}`);
}

function durableCounts(): Record<string, number> {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT
           (SELECT count(*) FROM collaboration_operations) AS operations,
           (SELECT count(*) FROM collaboration_thread_facts) AS facts,
           (SELECT count(*) FROM collaboration_runs) AS runs,
           (SELECT count(*) FROM collaboration_messages) AS messages`,
      )
      .get() as Record<string, number>;
  } finally {
    database.close();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  databasePath = memoryDatabasePath();
  seedProject();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("thread policy availability and deterministic dispatch", () => {
  it("keeps a removed policy member readable and requires repair before dispatch", async () => {
    const service = await readinessService();
    const threadId = createPolicyThread();
    removeMembership("agent-a");
    const before = durableCounts();

    const result = service.resolveThreadDispatch(
      databasePath,
      "project-a",
      threadId,
      { kind: "start" },
    );

    expect(result).toMatchObject({
      dispatch: "policy_repair_required",
      selectedMemberId: null,
      policy: {
        availability: "repair_required",
        unavailableMemberIds: ["agent-a"],
      },
    });
    expect(result.policy.members.map(({ agentId, live }) => ({ agentId, live }))).toEqual([
      { agentId: "agent-b", live: "current" },
      { agentId: "agent-a", live: "removed" },
    ]);
    const error = expectCode(
      () => service.selectStartAgent(databasePath, "project-a", threadId),
      "THREAD_POLICY_REPAIR_REQUIRED",
    );
    expect(error.message).toBe("Thread policy requires repair.");
    expect(durableCounts()).toEqual(before);
  });

  it("ignores new project members and their unavailable Providers", async () => {
    const service = await readinessService();
    const threadId = createPolicyThread();
    setProviderAvailable("agent-c", false);

    const result = service.resolveThreadDispatch(
      databasePath,
      "project-a",
      threadId,
      { kind: "start" },
    );

    expect(result.dispatch).toBe("ready");
    expect(result.selectedMemberId).toBe("agent-b");
    expect(result.policy.members.map(({ agentId }) => agentId)).toEqual([
      "agent-b",
      "agent-a",
    ]);
  });

  it("shows a live rename in the current policy without mutating its stored snapshot", async () => {
    const service = await readinessService();
    const threadId = createPolicyThread();
    const database = openDatabase(databasePath);
    try {
      database.prepare("UPDATE agents SET name='Renamed B' WHERE id='agent-b'").run();
    } finally {
      database.close();
    }

    const policy = service.readThreadPolicy(databasePath, "project-a", threadId);

    expect(policy.members[0]?.displayNameSnapshot).toBe("Renamed B");
    const verify = openDatabase(databasePath);
    try {
      expect(
        verify
          .prepare(
            `SELECT agent_display_name AS name
             FROM collaboration_thread_policy_members
             WHERE project_id='project-a' AND thread_id=? AND position=0`,
          )
          .get(threadId),
      ).toEqual({ name: "Agent agent-b" });
    } finally {
      verify.close();
    }
  });

  it("selects a valid mention and rejects non-policy mention targets without writes", async () => {
    const service = await readinessService();
    const threadId = createPolicyThread();
    const before = durableCounts();

    expect(
      service.selectStartAgent(databasePath, "project-a", threadId, "agent-a"),
    ).toBe("agent-a");
    expectCode(
      () => service.selectStartAgent(databasePath, "project-a", threadId, "agent-c"),
      "AGENT_NOT_MEMBER",
    );
    expect(durableCounts()).toEqual(before);
  });

  it("uses an unconsumed owner mention before the structured handoff target", async () => {
    const service = await readinessService();
    const threadId = createPolicyThread();

    expect(
      service.selectHandoffAgent(
        databasePath,
        "project-a",
        threadId,
        "agent-a",
        "agent-b",
      ),
    ).toBe("agent-b");
    expect(
      service.selectHandoffAgent(databasePath, "project-a", threadId, "agent-a"),
    ).toBe("agent-a");
    expectCode(
      () =>
        service.selectHandoffAgent(
          databasePath,
          "project-a",
          threadId,
          "agent-c",
        ),
      "AGENT_NOT_MEMBER",
    );
  });

  it("validates the current advance Agent through the same live policy rule", async () => {
    const service = await readinessService();
    const threadId = createPolicyThread();

    expect(
      service.selectAdvanceAgent(databasePath, "project-a", threadId, "agent-a"),
    ).toBe("agent-a");
    expectCode(
      () => service.selectAdvanceAgent(databasePath, "project-a", threadId, "agent-c"),
      "AGENT_NOT_MEMBER",
    );
  });

  it("checks Provider readiness only for the selected policy member", async () => {
    const service = await readinessService();
    const threadId = createPolicyThread();
    setProviderAvailable("agent-a", false);

    expect(
      service.resolveThreadDispatch(
        databasePath,
        "project-a",
        threadId,
        { kind: "start" },
      ),
    ).toMatchObject({ dispatch: "ready", selectedMemberId: "agent-b" });
    expect(
      service.resolveThreadDispatch(
        databasePath,
        "project-a",
        threadId,
        { kind: "start", mentionAgentId: "agent-a" },
      ),
    ).toMatchObject({
      dispatch: "selected_member_provider_unavailable",
      selectedMemberId: "agent-a",
    });
    const error = expectCode(
      () =>
        service.selectStartAgent(databasePath, "project-a", threadId, "agent-a"),
      "CREDENTIAL_UNAVAILABLE",
    );
    expect(error.message).toBe("Provider credential is unavailable.");
    expect(error.details).toEqual({ category: "credential_unavailable" });
  });

  it("uses policy position zero by default and returns exact readiness precedence", async () => {
    const service = await readinessService();
    const threadId = createPolicyThread();

    expect(service.selectStartAgent(databasePath, "project-a", threadId)).toBe("agent-b");
    expect(
      service.resolveThreadDispatch(
        databasePath,
        "project-a",
        threadId,
        { kind: "start" },
        { missingProjectFacts: ["mission"], projectRunActive: true },
      ),
    ).toMatchObject({
      dispatch: "project_context_not_ready",
      missingProjectFacts: ["mission"],
      selectedMemberId: "agent-b",
    });
    expect(
      service.resolveThreadDispatch(
        databasePath,
        "project-a",
        threadId,
        { kind: "start" },
        { projectRunActive: true },
      ),
    ).toMatchObject({
      dispatch: "project_run_active",
      selectedMemberId: "agent-b",
    });
  });
});
