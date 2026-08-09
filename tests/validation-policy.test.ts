import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { execV7Fixture } from "@/tests/fixtures/execution/current-graph";
import { createProject } from "@/src/server/projects";

type PolicyEntryInput = {
  args: string[];
  executable: string;
  required: boolean;
  workdir: string;
};
type Policy = {
  classifierVersion: number;
  entries: Array<PolicyEntryInput & {
    executableIdentity: string;
    id: string;
    position: number;
    tupleHash: string;
  }>;
  policyHash: string;
  projectId: string;
  revisionId: string;
  revisionNo: number;
  version: number;
  warningAccepted: boolean;
};
type PolicyModule = {
  getValidationPolicy(databasePath: string, projectId: string): Policy;
  listValidationPolicyAudits(databasePath: string, projectId: string): Array<{
    afterPolicyHash: string | null;
    beforePolicyHash: string;
    outcome: "rejected" | "saved";
    sequence: number;
    warningAccepted: boolean;
  }>;
  listValidationPolicyRevisions(databasePath: string, projectId: string): Policy[];
  saveValidationPolicy(
    databasePath: string,
    projectId: string,
    input: {
      entries: PolicyEntryInput[];
      expectedVersion: number;
      operationId: string;
      warningAccepted: boolean;
    },
    options: {
      resolveExecutable(executable: string): {
        executable: string;
        executableIdentity: string;
      };
    },
  ): { outcome: "rejected" | "saved"; policy: Policy; reasonCode: string | null };
};

const IDENTITY = "a".repeat(64);
const HASH = "b".repeat(64);
const NOW = "2026-07-30T04:30:00.000Z";
const temporaryDirectories: string[] = [];

let databasePath: string;
let policy: PolicyModule;

function operationId(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function entry(overrides: Partial<PolicyEntryInput> = {}): PolicyEntryInput {
  return {
    args: ["test", "--runInBand"],
    executable: "node",
    required: true,
    workdir: ".",
    ...overrides,
  };
}

const resolver = {
  resolveExecutable(executable: string) {
    return {
      executable: `C:/verified-tools/${executable}.exe`,
      executableIdentity: IDENTITY,
    };
  },
};

beforeEach(async () => {
  const directory = mkdtempSync(join(tmpdir(), "cool-ai-validation-policy-"));
  temporaryDirectories.push(directory);
  databasePath = join(directory, "cockpit.sqlite");
  try {
    policy = await import("@/src/server/execution/validation-policy-service") as PolicyModule;
  } catch {
    expect.fail("The T-11 validation policy service is unavailable.");
  }
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("append-only validation policy", () => {
  it("creates an immutable empty policy for every new project", () => {
    const project = createProject("Policy", databasePath);
    const active = policy.getValidationPolicy(databasePath, project.id);

    expect(active).toMatchObject({
      classifierVersion: 1,
      entries: [],
      policyHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      projectId: project.id,
      revisionNo: 1,
      version: 1,
      warningAccepted: false,
    });
  });

  it("saves exact ordered tuples with CAS and before/after audit hashes", () => {
    const project = createProject("Policy CAS", databasePath);
    const first = policy.saveValidationPolicy(databasePath, project.id, {
      entries: [
        entry({ args: ["test", "--runInBand"], workdir: "./packages/app" }),
        entry({ args: ["lint"], executable: "npm", required: false }),
      ],
      expectedVersion: 1,
      operationId: operationId(1),
      warningAccepted: true,
    }, resolver);

    expect(first.outcome).toBe("saved");
    expect(first.reasonCode).toBeNull();
    expect(first.policy).toMatchObject({
      revisionNo: 2,
      version: 2,
      warningAccepted: true,
    });
    expect(first.policy.entries).toEqual([
      expect.objectContaining({
        args: ["test", "--runInBand"],
        executable: "C:/verified-tools/node.exe",
        executableIdentity: IDENTITY,
        position: 0,
        required: true,
        workdir: "packages/app",
      }),
      expect.objectContaining({
        args: ["lint"],
        executable: "C:/verified-tools/npm.exe",
        position: 1,
        required: false,
        workdir: ".",
      }),
    ]);
    expect(first.policy.entries[0]?.tupleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.policy.entries[0]?.tupleHash).not.toBe(first.policy.entries[1]?.tupleHash);

    const audits = policy.listValidationPolicyAudits(databasePath, project.id);
    expect(audits).toEqual([
      expect.objectContaining({
        afterPolicyHash: first.policy.policyHash,
        beforePolicyHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        outcome: "saved",
        sequence: 1,
        warningAccepted: true,
      }),
    ]);

    expect(() => policy.saveValidationPolicy(databasePath, project.id, {
      entries: [entry()],
      expectedVersion: 1,
      operationId: operationId(2),
      warningAccepted: true,
    }, resolver)).toThrow(expect.objectContaining({
      code: "POLICY_VERSION_CONFLICT",
      currentVersion: 2,
    }));

    const replay = policy.saveValidationPolicy(databasePath, project.id, {
      entries: [
        entry({ args: ["test", "--runInBand"], workdir: "./packages/app" }),
        entry({ args: ["lint"], executable: "npm", required: false }),
      ],
      expectedVersion: 1,
      operationId: operationId(1),
      warningAccepted: true,
    }, resolver);
    expect(replay).toEqual(first);
  });

  it("rejects missing warning and known-deny entries without moving the active pointer", () => {
    const project = createProject("Policy warning", databasePath);
    const noWarning = policy.saveValidationPolicy(databasePath, project.id, {
      entries: [entry()],
      expectedVersion: 1,
      operationId: operationId(3),
      warningAccepted: false,
    }, {
      resolveExecutable() {
        throw new Error("warning rejection must not resolve or run an executable");
      },
    });
    const shell = policy.saveValidationPolicy(databasePath, project.id, {
      entries: [entry({ executable: "powershell", args: ["-Command", "npm test"] })],
      expectedVersion: 1,
      operationId: operationId(4),
      warningAccepted: true,
    }, resolver);

    expect(noWarning).toMatchObject({
      outcome: "rejected",
      reasonCode: "WARNING_REQUIRED",
      policy: { revisionNo: 1, version: 1 },
    });
    expect(shell).toMatchObject({
      outcome: "rejected",
      reasonCode: "SHELL_EXECUTABLE_DENIED",
      policy: { revisionNo: 1, version: 1 },
    });
    expect(policy.listValidationPolicyRevisions(databasePath, project.id)).toHaveLength(1);
    expect(policy.listValidationPolicyAudits(databasePath, project.id)).toEqual([
      expect.objectContaining({ outcome: "rejected", sequence: 1 }),
      expect.objectContaining({ outcome: "rejected", sequence: 2 }),
    ]);
  });

  it("enforces 50 entries and 64 KiB of canonical policy bytes", () => {
    const project = createProject("Policy limits", databasePath);
    const fifty = Array.from({ length: 50 }, (_, index) =>
      entry({ args: ["test", `case-${index}`] }));
    const saved = policy.saveValidationPolicy(databasePath, project.id, {
      entries: fifty,
      expectedVersion: 1,
      operationId: operationId(5),
      warningAccepted: true,
    }, resolver);
    expect(saved.policy.entries).toHaveLength(50);

    expect(() => policy.saveValidationPolicy(databasePath, project.id, {
      entries: [...fifty, entry()],
      expectedVersion: 2,
      operationId: operationId(6),
      warningAccepted: true,
    }, resolver)).toThrow(expect.objectContaining({ code: "POLICY_ENTRY_LIMIT_EXCEEDED" }));

    expect(() => policy.saveValidationPolicy(databasePath, project.id, {
      entries: Array.from({ length: 20 }, (_, index) =>
        entry({ args: ["test", `${index}-${"x".repeat(4090)}`] })),
      expectedVersion: 2,
      operationId: operationId(7),
      warningAccepted: true,
    }, resolver)).toThrow(expect.objectContaining({ code: "POLICY_SIZE_LIMIT_EXCEEDED" }));
  });

  it("retains history and frozen references across restart until project deletion", () => {
    const project = createProject("Policy retention", databasePath);
    const saved = policy.saveValidationPolicy(databasePath, project.id, {
      entries: [entry()],
      expectedVersion: 1,
      operationId: operationId(8),
      warningAccepted: true,
    }, resolver);

    const database = openDatabase(databasePath);
    seedFrozenExecution(databasePath, database, project.id, saved.policy);
    const oldRevisionId = policy.listValidationPolicyRevisions(databasePath, project.id)[0]!.revisionId;
    const entryId = saved.policy.entries[0]!.id;
    expect(() => database.prepare(
      "UPDATE project_validation_policy_revisions SET classifier_version=2 WHERE id=?",
    ).run(oldRevisionId)).toThrow(/IMMUTABLE_POLICY_REVISION/);
    expect(() => database.prepare(
      "UPDATE project_validation_policy_entries SET required=0 WHERE id=?",
    ).run(entryId)).toThrow(/IMMUTABLE_POLICY_ENTRY/);
    expect(() => database.prepare(
      "DELETE FROM project_validation_policy_entries WHERE id=?",
    ).run(entryId)).toThrow(/IMMUTABLE_POLICY_ENTRY/);
    database.close();

    const reopened = openDatabase(databasePath);
    expect(reopened.prepare(
      "SELECT COUNT(*) AS count FROM project_validation_policy_revisions WHERE project_id=?",
    ).get(project.id)).toEqual({ count: 2 });
    expect(reopened.prepare(
      `SELECT r.policy_revision_id AS revisionId,e.frozen_policy_revision_id AS frozenRevisionId
       FROM execution_validation_results r
       JOIN execution_attempts e ON e.id=r.attempt_id`,
    ).get()).toEqual({
      frozenRevisionId: saved.policy.revisionId,
      revisionId: saved.policy.revisionId,
    });
    reopened.prepare("DELETE FROM projects WHERE id=?").run(project.id);
    expect(reopened.prepare(
      "SELECT COUNT(*) AS count FROM project_validation_policy_revisions WHERE project_id=?",
    ).get(project.id)).toEqual({ count: 0 });
    reopened.close();
  });

  it("rejects validation facts that do not belong to the attempt's frozen revision", () => {
    const project = createProject("Frozen validation", databasePath);
    const frozen = policy.saveValidationPolicy(databasePath, project.id, {
      entries: [entry({ args: ["test", "frozen"] })],
      expectedVersion: 1,
      operationId: operationId(9),
      warningAccepted: true,
    }, resolver).policy;
    const database = openDatabase(databasePath);
    seedFrozenExecution(databasePath, database, project.id, frozen);
    database.close();
    const later = policy.saveValidationPolicy(databasePath, project.id, {
      entries: [entry({ args: ["test", "later"] })],
      expectedVersion: 2,
      operationId: operationId(10),
      warningAccepted: true,
    }, resolver).policy;

    const corrupt = openDatabase(databasePath);
    corrupt.exec(`
      INSERT INTO execution_tool_calls (
        id,project_id,execution_id,attempt_id,action_id,business_round,type,request_hash,
        status,public_request_json,started_at,finished_at
      ) VALUES (
        'tool-later','${project.id}','execution','attempt',NULL,2,'command','${HASH}',
        'succeeded','{}','${NOW}','${NOW}'
      );
    `);
    corrupt.prepare(`
      INSERT INTO execution_validation_results (
        id,project_id,execution_id,attempt_id,policy_revision_id,policy_entry_id,
        tool_call_id,sandbox_manifest_hash,required,exit_code,succeeded,stdout_bytes,
        stderr_bytes,stdout_sha256,stderr_sha256,stdout_truncated,stderr_truncated,finished_at
      ) VALUES (
        'validation-later',?,'execution','attempt',?,?,'tool-later',?,1,0,1,0,0,?,?,0,0,?
      )
    `).run(
      project.id,
      later.revisionId,
      later.entries[0]!.id,
      HASH,
      HASH,
      HASH,
      NOW,
    );
    corrupt.close();

    expect(() => openDatabase(databasePath)).toThrow(
      expect.objectContaining({ code: "SCHEMA_DATA_INVALID" }),
    );
  });
});

function seedFrozenExecution(
  databasePath: string,
  database: DatabaseSync,
  projectId: string,
  active: Policy,
): void {
  const entryId = active.entries[0]!.id;
  execV7Fixture(databasePath, database, `
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES ('provider','Provider','https://example.invalid','model','c','i','t',
      1,1,'key','***','${NOW}',1,'${NOW}','${NOW}');
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES ('agent','Agent','Role','Prompt','provider','model','A','sage',
      1,1,1,4096,2,1,'${NOW}','${NOW}');
    INSERT INTO project_memberships VALUES ('${projectId}','agent','${NOW}');
    INSERT INTO missions VALUES ('mission','${projectId}','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items VALUES (
      'work','mission','Work','Description','in_progress','agent',1,'${NOW}','${NOW}'
    );
    INSERT INTO collaboration_runs (
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES (
      'run','${projectId}','planned','agent',0,1,1,1,NULL,NULL,'${NOW}','${NOW}'
    );
    INSERT INTO executions (
      id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,current_attempt_no,created_at,updated_at
    ) VALUES (
      'execution','${projectId}','run','mission','work','agent',
      '${active.revisionId}','queued',1,'${NOW}','${NOW}'
    );
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,frozen_public_json,
      frozen_private_json,frozen_context_hash,frozen_policy_revision_id,
      frozen_policy_version,frozen_policy_hash,started_at
    ) VALUES (
      'attempt','${projectId}','execution',1,'ready','D:/sandbox','{}','{}',
      '${HASH}','${active.revisionId}',${active.version},'${active.policyHash}','${NOW}'
    );
    INSERT INTO execution_tool_calls (
      id,project_id,execution_id,attempt_id,action_id,business_round,type,request_hash,
      status,public_request_json,started_at,finished_at
    ) VALUES (
      'tool','${projectId}','execution','attempt',NULL,1,'command','${HASH}',
      'succeeded','{}','${NOW}','${NOW}'
    );
    INSERT INTO execution_validation_results (
      id,project_id,execution_id,attempt_id,policy_revision_id,policy_entry_id,
      tool_call_id,sandbox_manifest_hash,required,exit_code,succeeded,stdout_bytes,
      stderr_bytes,stdout_sha256,stderr_sha256,stdout_truncated,stderr_truncated,finished_at
    ) VALUES (
      'validation','${projectId}','execution','attempt','${active.revisionId}',
      '${entryId}','tool','${HASH}',1,0,1,0,0,'${HASH}','${HASH}',0,0,'${NOW}'
    );
  `);
}
