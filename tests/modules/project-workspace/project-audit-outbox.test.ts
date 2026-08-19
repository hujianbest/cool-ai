import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { replaceMembers } from "@/src/adapters/outbound/sqlite/project-workspace/membership-service";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { saveValidationPolicy } from "@/src/adapters/outbound/sqlite/project-workspace/validation-policy-service";
import { bindWorkspace } from "@/src/adapters/outbound/sqlite/project-workspace/workspace-service";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

const NOW = "2026-08-12T03:00:00.000Z";

let databasePath: string;
let database: DatabaseSync;

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-project-audit-"));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  databasePath = memoryDatabasePath();
  database = openDatabase(databasePath);
});

afterEach(() => {
  try {
    database.close();
  } catch {
    // The connection may already be closed by reopen exercises.
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
  vi.useRealTimers();
});

function nextOutboxSeq(): number {
  return (database.prepare(
    "SELECT COALESCE(MAX(outbox_seq),0)+1 AS nextSeq FROM audit_event_outbox",
  ).get() as { nextSeq: number }).nextSeq;
}

describe("project-workspace audit outbox schema", () => {
  it("bootstraps identity 22 and accepts the project_workspace outbox source", () => {
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
    const project = createProject("ProjectWorkspaceAudit", databasePath);
    database.prepare(`
      INSERT INTO audit_event_outbox (
        id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
      ) VALUES ('pws-event-1',?,'project_workspace','project_created','{}',?,?)
    `).run(project.id, NOW, nextOutboxSeq());
    expect(database.prepare(
      "SELECT source FROM audit_event_outbox WHERE id='pws-event-1'",
    ).get()).toEqual({ source: "project_workspace" });
    expect(() => database.prepare(`
      INSERT INTO audit_event_outbox (
        id,project_id,source,event_type,payload_json,occurred_at,outbox_seq
      ) VALUES ('pws-event-2',?,'project-workspace','project_created','{}',?,?)
    `).run(project.id, NOW, nextOutboxSeq())).toThrow();
  });
});

type OutboxRow = {
  eventType: string;
  id: string;
  occurredAt: string;
  payloadJson: string;
  projectId: string;
  seq: number;
  source: string;
};

function outboxRows(path: string = databasePath): OutboxRow[] {
  const reader = openDatabase(path);
  try {
    return reader.prepare(`
      SELECT id,project_id AS projectId,source,event_type AS eventType,
             payload_json AS payloadJson,occurred_at AS occurredAt,outbox_seq AS seq
      FROM audit_event_outbox ORDER BY outbox_seq
    `).all() as OutboxRow[];
  } finally {
    reader.close();
  }
}

describe("project-workspace audit outbox project creation", () => {
  it("mirrors project creation into the outbox in the same transaction", () => {
    const project = createProject("ProjectWorkspaceAudit", databasePath);

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "project_created",
      occurredAt: NOW,
      projectId: project.id,
      seq: 1,
      source: "project_workspace",
    });
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      occurredAt: NOW,
      projectName: "ProjectWorkspaceAudit",
      type: "project_created",
    });
  });
});

describe("project-workspace audit outbox workspace binding", () => {
  it("mirrors bind and rebind with redacted workspace names, never host paths", async () => {
    const root = temporaryRoot();
    const firstPath = join(root, "alpha-workspace");
    const secondPath = join(root, "beta-workspace");
    mkdirSync(firstPath);
    mkdirSync(secondPath);
    const project = createProject("WorkspaceAudit", databasePath);

    const bound = await bindWorkspace(databasePath, project.id, {
      confirmRebind: false,
      expectedVersion: 1,
      path: firstPath,
    });
    const rebound = await bindWorkspace(databasePath, project.id, {
      confirmRebind: true,
      expectedVersion: bound.projectVersion,
      path: secondPath,
    });
    expect(rebound.projectVersion).toBe(3);

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "project_created",
      "workspace_bound",
      "workspace_rebound",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(new Set(rows.map((row) => row.source))).toEqual(new Set(["project_workspace"]));

    const boundPayload = JSON.parse(rows[1]!.payloadJson) as Record<string, unknown>;
    expect(boundPayload).toEqual({
      actorId: null,
      actorType: "owner",
      occurredAt: NOW,
      type: "workspace_bound",
      workspaceName: "alpha-workspace",
    });
    const reboundPayload = JSON.parse(rows[2]!.payloadJson) as Record<string, unknown>;
    expect(reboundPayload).toEqual({
      actorId: null,
      actorType: "owner",
      occurredAt: NOW,
      previousWorkspaceName: "alpha-workspace",
      type: "workspace_rebound",
      workspaceName: "beta-workspace",
    });

    for (const row of rows) {
      expect(row.payloadJson).not.toContain(root);
      expect(row.payloadJson).not.toContain(bound.workspace!.path);
      expect(row.payloadJson).not.toContain(rebound.workspace!.path);
    }
  });
});

function seedAgents(): void {
  database.exec(`
    INSERT INTO providers (
      id, name, base_url, default_model, api_key_cipher, api_key_iv, api_key_tag,
      credential_version, credential_generation, key_id, api_key_mask, verified_at,
      version, created_at, updated_at
    ) VALUES (
      'provider-1', 'Provider', 'https://example.invalid', 'model-a',
      'cipher', 'iv', 'tag', 1, 1, 'key', '****', 'now', 1, 'now', 'now'
    );
    INSERT INTO agents (
      id, name, role, system_prompt, provider_id, model, avatar_text, accent_token,
      can_read, can_write, can_execute, max_tokens, max_handoffs, version, created_at, updated_at
    ) VALUES
      (
        'agent-alpha', 'Alpha', 'Plans', 'private alpha', 'provider-1', 'model-a', 'A', 'sage',
        1, 0, 0, 1000, 1, 1, '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'
      ),
      (
        'agent-beta', 'Beta', 'Builds', 'private beta', 'provider-1', 'model-a', 'B', 'gold',
        1, 1, 1, 1000, 1, 1, '2026-07-29T00:00:01.000Z', '2026-07-29T00:00:01.000Z'
      ),
      (
        'agent-gamma', 'Gamma', 'Reviews', 'private gamma', 'provider-1', 'model-a', 'G', 'slate',
        1, 0, 1, 1000, 1, 1, '2026-07-29T00:00:02.000Z', '2026-07-29T00:00:02.000Z'
      );
  `);
}

describe("project-workspace audit outbox membership", () => {
  it("mirrors member joins and removals with public display names", () => {
    const project = createProject("MembershipAudit", databasePath);
    seedAgents();

    replaceMembers(databasePath, project.id, {
      agentIds: ["agent-beta", "agent-alpha"],
      expectedProjectVersion: 1,
    });
    replaceMembers(databasePath, project.id, {
      agentIds: ["agent-beta", "agent-gamma"],
      expectedProjectVersion: 2,
    });

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "project_created",
      "member_joined",
      "member_joined",
      "member_removed",
      "member_joined",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(rows.map((row) => row.projectId))).toEqual(new Set([project.id]));

    const agentOf = (row: OutboxRow) =>
      (JSON.parse(row.payloadJson) as Record<string, unknown>).agentId;
    expect(rows.slice(1).map(agentOf)).toEqual([
      "agent-alpha",
      "agent-beta",
      "agent-alpha",
      "agent-gamma",
    ]);
    expect(JSON.parse(rows[1]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      agentDisplayName: "Alpha",
      agentId: "agent-alpha",
      occurredAt: NOW,
      type: "member_joined",
    });
    expect(JSON.parse(rows[3]!.payloadJson)).toEqual({
      actorId: null,
      actorType: "owner",
      agentDisplayName: "Alpha",
      agentId: "agent-alpha",
      occurredAt: NOW,
      type: "member_removed",
    });
  });
});

const POLICY_OPERATION_ID = "16000000-0000-4000-8000-000000000236";
const EXECUTABLE_IDENTITY = "a".repeat(64);

describe("project-workspace audit outbox validation policy", () => {
  it("mirrors a saved policy change from the policy audits row in the same transaction", () => {
    const project = createProject("PolicyAudit", databasePath);

    const saved = saveValidationPolicy(databasePath, project.id, {
      entries: [{ args: ["test"], executable: "node", required: true, workdir: "." }],
      expectedVersion: 1,
      operationId: POLICY_OPERATION_ID,
      warningAccepted: true,
    }, {
      resolveExecutable(executable: string) {
        return {
          executable: `C:/verified-tools/${executable}.exe`,
          executableIdentity: EXECUTABLE_IDENTITY,
        };
      },
    });
    expect(saved.outcome).toBe("saved");

    const audits = database.prepare(`
      SELECT id, after_policy_hash AS afterPolicyHash
      FROM project_validation_policy_audits WHERE project_id=?
    `).all(project.id) as Array<{ afterPolicyHash: string; id: string }>;
    expect(audits).toHaveLength(1);

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "project_created",
      "validation_policy_changed",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(rows[1]!.id).toBe(audits[0]!.id);

    const payload = JSON.parse(rows[1]!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      actorId: null,
      actorType: "owner",
      entryCount: 1,
      occurredAt: NOW,
      policyHash: audits[0]!.afterPolicyHash,
      revisionNo: 2,
      type: "validation_policy_changed",
      warningAccepted: true,
    });
    // Policy entry executables are host paths and must never enter the feed.
    expect(rows[1]!.payloadJson).not.toContain("verified-tools");
    expect(rows[1]!.payloadJson).not.toContain("node.exe");
  });
});

describe("project-workspace audit outbox discipline", () => {
  it("truncates project name excerpts to 200 graphemes in the outbox payload", () => {
    createProject("项".repeat(250), databasePath);

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    const projectName = payload.projectName as string;
    expect([...projectName]).toHaveLength(201);
    expect(projectName.endsWith("…")).toBe(true);
    expect(projectName.startsWith("项".repeat(200))).toBe(true);
  });

  it("withholds credential-like project names without blocking the project write", () => {
    const project = createProject(
      "Rotate api_key=hunter2supersecret before launch",
      databasePath,
    );

    const stored = database.prepare(
      "SELECT name FROM projects WHERE id=?",
    ).get(project.id) as { name: string };
    expect(stored.name).toContain("hunter2supersecret");

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.projectName).toBe("[redacted]");
  });

  it("keeps same-workspace re-asserts and rejected policy saves out of the audit trail", async () => {
    const root = temporaryRoot();
    const workspacePath = join(root, "alpha-workspace");
    mkdirSync(workspacePath);
    const project = createProject("NoiseAudit", databasePath);

    const bound = await bindWorkspace(databasePath, project.id, {
      confirmRebind: false,
      expectedVersion: 1,
      path: workspacePath,
    });
    const reaffirmed = await bindWorkspace(databasePath, project.id, {
      confirmRebind: false,
      expectedVersion: bound.projectVersion,
      path: workspacePath,
    });
    expect(reaffirmed.projectVersion).toBe(3);

    const rejected = saveValidationPolicy(databasePath, project.id, {
      entries: [{ args: ["test"], executable: "node", required: true, workdir: "." }],
      expectedVersion: 1,
      operationId: "16000000-0000-4000-8000-000000000237",
      warningAccepted: false,
    });
    expect(rejected.outcome).toBe("rejected");
    const auditCount = database.prepare(
      "SELECT COUNT(*) AS count FROM project_validation_policy_audits WHERE project_id=?",
    ).get(project.id) as { count: number };
    expect(auditCount.count).toBe(1);

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "project_created",
      "workspace_bound",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
  });

  it("keeps project-workspace outbox rows intact across an idempotent reopen", async () => {
    const root = temporaryRoot();
    const workspacePath = join(root, "alpha-workspace");
    mkdirSync(workspacePath);
    const project = createProject("ReopenAudit", databasePath);
    await bindWorkspace(databasePath, project.id, {
      confirmRebind: false,
      expectedVersion: 1,
      path: workspacePath,
    });
    const before = outboxRows();
    expect(before).toHaveLength(2);

    database.close();
    database = openDatabase(databasePath);

    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 26 });
    expect(outboxRows()).toEqual(before);
  });

  it("records no outbox row when the business write is rejected", async () => {
    const root = temporaryRoot();
    const workspacePath = join(root, "alpha-workspace");
    mkdirSync(workspacePath);
    const project = createProject("AtomicAudit", databasePath);
    seedAgents();
    replaceMembers(databasePath, project.id, {
      agentIds: ["agent-alpha", "agent-beta"],
      expectedProjectVersion: 1,
    });

    expect(() => replaceMembers(databasePath, project.id, {
      agentIds: ["agent-alpha", "agent-gamma"],
      expectedProjectVersion: 1,
    })).toThrowError(expect.objectContaining({ code: "RESOURCE_CONFLICT" }));
    await expect(bindWorkspace(databasePath, project.id, {
      confirmRebind: false,
      expectedVersion: 1,
      path: workspacePath,
    })).rejects.toMatchObject({ code: "RESOURCE_CONFLICT" });
    expect(database.prepare(
      "SELECT workspace_path AS workspacePath FROM projects WHERE id=?",
    ).get(project.id)).toEqual({ workspacePath: null });

    const rows = outboxRows();
    expect(rows.map((row) => row.eventType)).toEqual([
      "project_created",
      "member_joined",
      "member_joined",
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
  });
});
