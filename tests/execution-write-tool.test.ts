import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/server/db";
import { discardExecutionAction } from "@/src/server/execution/execution-actions";
import { execV7Fixture } from "@/tests/v7-fixture-graph";

type Identity = {
  finalPath: string;
  identity: string;
  kind: "directory" | "file" | "link" | "reparse" | "special";
  size: number;
};
type FakeNode = {
  bytes?: Uint8Array;
  children?: Map<string, FakeNode>;
  identity: Identity;
  ownedBy?: string;
};
type Handle = { node: FakeNode; openedIdentity: Identity };
type WriteResult = {
  action: "created" | "replaced";
  afterHash: string;
  beforeHash: string | null;
  bytes: number;
  path: string;
};
type WriteModule = {
  executeWriteToolAction(input: {
    actionIndex: number;
    content: string;
    database: DatabaseSync;
    expectedHash: string | null | undefined;
    fs: FakeAdapter;
    hooks?: { afterWrite?: () => void | Promise<void> };
    operationId: string;
    path: string;
    projectId: string;
    sandboxRoot: string;
  }): Promise<{ affectedRows: 0 | 1; result: WriteResult | null }>;
  writeVerifiedFile(input: {
    content: string;
    expectedHash: string | null | undefined;
    fs: FakeAdapter;
    ownerId: string;
    path: string;
    sandboxRoot: string;
  }): Promise<WriteResult & { rollback(): Promise<boolean> }>;
};

class FakeAdapter {
  readonly roots = new Map<string, FakeNode>();
  readonly calls: string[] = [];
  durableDirectories = true;
  failPostReplaceIdentity = false;
  afterTempWrite?: (parent: FakeNode, name: string) => void;
  beforeReplace?: (parent: FakeNode, name: string) => void;
  hijackTempBeforeCleanup = false;
  private serial = 0;

  addRoot(path: string, root: FakeNode): void {
    this.roots.set(path, root);
  }

  async openRootDirectory(path: string): Promise<Handle> {
    const node = this.roots.get(path);
    if (!node) throw new Error("missing root");
    return handle(node);
  }

  async list(value: Handle): Promise<Array<{ identity: string; name: string }>> {
    return [...(value.node.children ?? new Map()).entries()].map(([name, node]) => ({
      identity: node.identity.identity,
      name,
    }));
  }

  async openChildNoFollow(parent: Handle, name: string): Promise<Handle> {
    const node = parent.node.children?.get(name);
    if (!node) throw new Error("missing child");
    return handle(node);
  }

  async identity(value: Handle): Promise<Identity> {
    return { ...value.openedIdentity };
  }

  async currentIdentity(value: Handle): Promise<Identity> {
    if (this.failPostReplaceIdentity && this.calls.includes("atomic-replace")) {
      throw new Error("post-replace identity unavailable");
    }
    return { ...value.node.identity };
  }

  async readFromHandle(value: Handle, maximumBytes: number): Promise<Uint8Array> {
    return (value.node.bytes ?? new Uint8Array()).slice(0, maximumBytes);
  }

  async createOwnedTemp(parent: Handle, ownerId: string): Promise<{ handle: Handle; name: string }> {
    const name = `.cool-ai-write-${ownerId}-${++this.serial}.tmp`;
    if (parent.node.children?.has(name)) throw new Error("temp collision");
    const node: FakeNode = {
      bytes: new Uint8Array(),
      identity: fileIdentity(`temp-${this.serial}`, `${parent.node.identity.finalPath}/${name}`, 0),
      ownedBy: ownerId,
    };
    parent.node.children ??= new Map();
    parent.node.children.set(name, node);
    this.calls.push("create-temp");
    return { handle: handle(node), name };
  }

  async writeAll(value: Handle, bytes: Uint8Array): Promise<void> {
    value.node.bytes = bytes.slice();
    value.node.identity = {
      ...value.node.identity,
      size: bytes.byteLength,
    };
    value.openedIdentity = { ...value.node.identity };
    this.calls.push("write-all");
    const parent = this.parentOf(value.node);
    if (parent) this.afterTempWrite?.(parent, this.nameOf(parent, value.node));
  }

  async fsyncFile(_value: Handle): Promise<boolean> {
    this.calls.push("fsync-file");
    return true;
  }

  async fsyncDirectory(_value: Handle): Promise<boolean> {
    this.calls.push("fsync-directory");
    return this.durableDirectories;
  }

  async conditionalAtomicReplace(input: {
    expectedTarget: Identity | null;
    name: string;
    ownerId: string;
    parent: Handle;
    tempName: string;
  }): Promise<{ previous: FakeNode | null; target: Handle; targetIdentity: Identity } | null> {
    this.beforeReplace?.(input.parent.node, input.name);
    const current = input.parent.node.children?.get(input.name) ?? null;
    if (!sameNodeIdentity(current, input.expectedTarget)) return null;
    const temp = input.parent.node.children?.get(input.tempName);
    if (!temp || temp.ownedBy !== input.ownerId) return null;
    input.parent.node.children?.delete(input.tempName);
    input.parent.node.children?.set(input.name, temp);
    temp.identity = {
      ...temp.identity,
      finalPath: `${input.parent.node.identity.finalPath}/${input.name}`,
    };
    this.calls.push("atomic-replace");
    return {
      previous: current,
      target: handle(temp),
      targetIdentity: { ...temp.identity },
    };
  }

  async conditionalRollback(input: {
    expectedCurrent: Identity;
    name: string;
    parent: Handle;
    previous: FakeNode | null;
  }): Promise<boolean> {
    const current = input.parent.node.children?.get(input.name) ?? null;
    if (!sameNodeIdentity(current, input.expectedCurrent)) return false;
    if (input.previous) input.parent.node.children?.set(input.name, input.previous);
    else input.parent.node.children?.delete(input.name);
    this.calls.push("rollback");
    return true;
  }

  async conditionalRemoveOwnedTemp(input: {
    expected: Identity;
    name: string;
    ownerId: string;
    parent: Handle;
  }): Promise<boolean> {
    const current = input.parent.node.children?.get(input.name);
    if (this.hijackTempBeforeCleanup && current) {
      current.ownedBy = "external";
      current.identity = fileIdentity("external-temp", current.identity.finalPath, current.identity.size);
    }
    if (
      !current
      || current.ownedBy !== input.ownerId
      || !sameNodeIdentity(current, input.expected)
    ) return false;
    input.parent.node.children?.delete(input.name);
    this.calls.push("cleanup-temp");
    return true;
  }

  async close(_value: Handle): Promise<void> {}

  bytes(root: string, path: string): Uint8Array | undefined {
    let node = this.roots.get(root);
    for (const segment of path.split("/")) node = node?.children?.get(segment);
    return node?.bytes;
  }

  private parentOf(child: FakeNode): FakeNode | undefined {
    for (const root of this.roots.values()) {
      const found = findParent(root, child);
      if (found) return found;
    }
  }

  private nameOf(parent: FakeNode, child: FakeNode): string {
    return [...(parent.children ?? new Map()).entries()]
      .find(([, candidate]) => candidate === child)?.[0] ?? "";
  }
}

const PROJECT_ID = "write-project";
const EXECUTION_ID = "write-execution";
const ATTEMPT_ID = "write-attempt";
const SANDBOX_A = "verified://sandbox-a";
const SANDBOX_B = "verified://sandbox-b";
const HASH = "a".repeat(64);
const NOW = "2026-07-30T04:00:00.000Z";

let directory: string;
let databasePath: string;
let writeTool: WriteModule;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cool-ai-write-tool-"));
  databasePath = join(directory, "cockpit.sqlite");
  try {
    writeTool = await import("@/src/server/execution/file-tools") as WriteModule;
  } catch {
    expect.fail("The T-10 write action is unavailable.");
  }
});

afterEach(() => rmSync(directory, { force: true, recursive: true }));

describe("expected-hash durable sandbox write", () => {
  it("creates and replaces complete UTF-8 bytes through owned temp, fsync, and atomic replace", async () => {
    const fs = adapterWithFile(Buffer.from("old", "utf8"));
    const beforeHash = sha256("old");
    const replaced = await writeTool.writeVerifiedFile({
      content: "café",
      expectedHash: beforeHash,
      fs,
      ownerId: "replace-owner",
      path: "src/value.txt",
      sandboxRoot: SANDBOX_A,
    });
    expect(replaced).toMatchObject({
      action: "replaced",
      afterHash: sha256("café"),
      beforeHash,
      bytes: 5,
      path: "src/value.txt",
    });
    expect(Buffer.from(fs.bytes(SANDBOX_A, "src/value.txt") ?? []).toString("utf8")).toBe("café");
    expect(fs.calls).toEqual([
      "create-temp",
      "write-all",
      "fsync-file",
      "atomic-replace",
      "fsync-directory",
    ]);

    fs.calls.length = 0;
    const created = await writeTool.writeVerifiedFile({
      content: "x".repeat(1_048_576),
      expectedHash: null,
      fs,
      ownerId: "create-owner",
      path: "src/new.txt",
      sandboxRoot: SANDBOX_A,
    });
    expect(created).toMatchObject({
      action: "created",
      beforeHash: null,
      bytes: 1_048_576,
    });
    expect(fs.bytes(SANDBOX_A, "src/new.txt")).toHaveLength(1_048_576);
  });

  it("rejects invalid text, excess bytes, and incorrect create/replace expectations before mutation", async () => {
    for (const [content, expectedHash, code] of [
      ["before\0after", null, "TEXT_INVALID"],
      ["\ud800", null, "TEXT_INVALID"],
      ["x".repeat(1_048_577), null, "FILE_LIMIT_EXCEEDED"],
      ["new", null, "SANDBOX_FILE_CONFLICT"],
      ["new", undefined, "SANDBOX_FILE_CONFLICT"],
      ["new", "f".repeat(64), "SANDBOX_FILE_CONFLICT"],
      ["new", "not-a-hash", "SANDBOX_FILE_CONFLICT"],
    ] as const) {
      const fs = adapterWithFile(Buffer.from("old", "utf8"));
      await expect(writeTool.writeVerifiedFile({
        content,
        expectedHash,
        fs,
        ownerId: "invalid-owner",
        path: "src/value.txt",
        sandboxRoot: SANDBOX_A,
      })).rejects.toMatchObject({ code });
      expect(Buffer.from(fs.bytes(SANDBOX_A, "src/value.txt") ?? []).toString()).toBe("old");
      expect(fs.calls).toEqual([]);
    }
  });

  it("fails closed on parent/target races or missing directory durability and cleans only owned temp", async () => {
    const parentRace = adapterWithFile(Buffer.from("old"));
    parentRace.afterTempWrite = () => {
      const src = parentRace.roots.get(SANDBOX_A)?.children?.get("src");
      if (src) src.identity = directoryIdentity("outside", "/outside");
    };
    await expect(writeTool.writeVerifiedFile({
      content: "new",
      expectedHash: sha256("old"),
      fs: parentRace,
      ownerId: "parent-race",
      path: "src/value.txt",
      sandboxRoot: SANDBOX_A,
    })).rejects.toMatchObject({ code: "SANDBOX_UNVERIFIABLE" });
    expect(Buffer.from(parentRace.bytes(SANDBOX_A, "src/value.txt") ?? []).toString()).toBe("old");

    const targetRace = adapterWithFile(Buffer.from("old"));
    targetRace.beforeReplace = (parent, name) => {
      parent.children?.set(name, fileNode("external", `${parent.identity.finalPath}/${name}`));
    };
    targetRace.hijackTempBeforeCleanup = true;
    await expect(writeTool.writeVerifiedFile({
      content: "new",
      expectedHash: sha256("old"),
      fs: targetRace,
      ownerId: "target-race",
      path: "src/value.txt",
      sandboxRoot: SANDBOX_A,
    })).rejects.toMatchObject({ code: "SANDBOX_FILE_CONFLICT" });
    expect(Buffer.from(targetRace.bytes(SANDBOX_A, "src/value.txt") ?? []).toString()).toBe("external");
    expect(targetRace.calls).not.toContain("cleanup-temp");

    const noDurability = adapterWithFile(Buffer.from("old"));
    noDurability.durableDirectories = false;
    await expect(writeTool.writeVerifiedFile({
      content: "new",
      expectedHash: sha256("old"),
      fs: noDurability,
      ownerId: "no-durability",
      path: "src/value.txt",
      sandboxRoot: SANDBOX_A,
    })).rejects.toMatchObject({ code: "SANDBOX_UNVERIFIABLE" });
    expect(Buffer.from(noDurability.bytes(SANDBOX_A, "src/value.txt") ?? []).toString()).toBe("old");
    expect(noDurability.calls).toContain("rollback");

    const unverifiablePost = adapterWithFile(Buffer.from("old"));
    unverifiablePost.failPostReplaceIdentity = true;
    await expect(writeTool.writeVerifiedFile({
      content: "new",
      expectedHash: sha256("old"),
      fs: unverifiablePost,
      ownerId: "post-identity",
      path: "src/value.txt",
      sandboxRoot: SANDBOX_A,
    })).rejects.toMatchObject({ code: "SANDBOX_UNVERIFIABLE" });
    expect(Buffer.from(unverifiablePost.bytes(SANDBOX_A, "src/value.txt") ?? []).toString()).toBe("old");
    expect(unverifiablePost.calls).toContain("rollback");
  });

  it("keeps two sandbox roots independent", async () => {
    const fs = adapterWithFile(Buffer.from("same"));
    fs.addRoot(SANDBOX_B, rootNode("/sandbox-b", Buffer.from("same")));
    await writeTool.writeVerifiedFile({
      content: "only-a",
      expectedHash: sha256("same"),
      fs,
      ownerId: "sandbox-a",
      path: "src/value.txt",
      sandboxRoot: SANDBOX_A,
    });
    expect(Buffer.from(fs.bytes(SANDBOX_A, "src/value.txt") ?? []).toString()).toBe("only-a");
    expect(Buffer.from(fs.bytes(SANDBOX_B, "src/value.txt") ?? []).toString()).toBe("same");
  });
});

describe("write permission and atomic durable facts", () => {
  it("requires Agent write permission before filesystem mutation", async () => {
    const database = seedDatabase(1, false);
    const fs = adapterWithFile(Buffer.from("old"));
    try {
      await expect(runWrite(database, fs, 1, sha256("old"))).rejects.toMatchObject({
        code: "AGENT_WRITE_FORBIDDEN",
      });
      expect(fs.calls).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("persists action, tool, event, and before/after hashes in one finalize transaction", async () => {
    const database = seedDatabase(2, true);
    const fs = adapterWithFile(Buffer.from("old"));
    try {
      const result = await runWrite(database, fs, 2, sha256("old"));
      expect(result.affectedRows).toBe(1);
      expect(result.result).toMatchObject({
        action: "replaced",
        beforeHash: sha256("old"),
        afterHash: sha256("new"),
      });
      expect(database.prepare(`
        SELECT type,status,before_sandbox_hash AS beforeHash,
               after_sandbox_hash AS afterHash
        FROM execution_tool_calls
      `).get()).toEqual({
        afterHash: sha256("new"),
        beforeHash: sha256("old"),
        status: "succeeded",
        type: "write",
      });
      expect(database.prepare(
        "SELECT status,result_json AS resultJson FROM execution_actions",
      ).get()).toMatchObject({ status: "succeeded", resultJson: JSON.stringify(result.result) });
      expect(JSON.parse(String((database.prepare(
        "SELECT payload_json AS value FROM execution_events",
      ).get() as { value: string }).value))).toMatchObject({
        afterHash: sha256("new"),
        beforeHash: sha256("old"),
        type: "write",
      });
    } finally {
      database.close();
    }
  });

  it("rolls back the conditional target change when stop wins before database finalize", async () => {
    const database = seedDatabase(3, true);
    const fs = adapterWithFile(Buffer.from("old"));
    try {
      const result = await writeTool.executeWriteToolAction({
        actionIndex: 0,
        content: "new",
        database,
        expectedHash: sha256("old"),
        fs,
        hooks: {
          afterWrite() {
            expect(discardExecutionAction(database, {
              actionId: "write-action-3",
              body: { outcome: "stopped" },
              httpStatus: 409,
              projectId: PROJECT_ID,
            })).toEqual({ affectedRows: 1 });
          },
        },
        operationId: operationId(3),
        path: "src/value.txt",
        projectId: PROJECT_ID,
        sandboxRoot: SANDBOX_A,
      });
      expect(result).toEqual({ affectedRows: 0, result: null });
      expect(Buffer.from(fs.bytes(SANDBOX_A, "src/value.txt") ?? []).toString()).toBe("old");
      expect(database.prepare("SELECT count(*) AS count FROM execution_tool_calls").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT count(*) AS count FROM execution_events").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls back the conditional target change when the action expires before finalize", async () => {
    const database = seedDatabase(4, true);
    const fs = adapterWithFile(Buffer.from("old"));
    try {
      const result = await writeTool.executeWriteToolAction({
        actionIndex: 0,
        content: "new",
        database,
        expectedHash: sha256("old"),
        fs,
        hooks: {
          afterWrite() {
            database.prepare(`
              UPDATE execution_actions
              SET lease_expires_at='2020-01-01T00:00:00.000Z',
                  overall_deadline_at='2020-01-01T00:00:00.000Z'
              WHERE id='write-action-4'
            `).run();
          },
        },
        operationId: operationId(4),
        path: "src/value.txt",
        projectId: PROJECT_ID,
        sandboxRoot: SANDBOX_A,
      });
      expect(result).toEqual({ affectedRows: 0, result: null });
      expect(Buffer.from(fs.bytes(SANDBOX_A, "src/value.txt") ?? []).toString()).toBe("old");
      expect(database.prepare("SELECT count(*) AS count FROM execution_tool_calls").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT count(*) AS count FROM execution_events").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});

function handle(node: FakeNode): Handle {
  return { node, openedIdentity: { ...node.identity } };
}

function sameNodeIdentity(node: FakeNode | null | undefined, expected: Identity | null): boolean {
  if (!node || !expected) return node == null && expected == null;
  return node.identity.identity === expected.identity
    && node.identity.kind === expected.kind
    && node.identity.finalPath === expected.finalPath
    && node.identity.size === expected.size;
}

function findParent(root: FakeNode, child: FakeNode): FakeNode | undefined {
  for (const candidate of root.children?.values() ?? []) {
    if (candidate === child) return root;
    const nested = findParent(candidate, child);
    if (nested) return nested;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function directoryIdentity(value: string, finalPath: string): Identity {
  return { finalPath, identity: value, kind: "directory", size: 0 };
}

function fileIdentity(value: string, finalPath: string, size: number): Identity {
  return { finalPath, identity: value, kind: "file", size };
}

function fileNode(value: string, finalPath = "/sandbox/src/value.txt"): FakeNode {
  const bytes = Buffer.from(value);
  return { bytes, identity: fileIdentity(`file-${value}`, finalPath, bytes.byteLength) };
}

function rootNode(path: string, bytes: Uint8Array): FakeNode {
  const file: FakeNode = {
    bytes: bytes.slice(),
    identity: fileIdentity("target", `${path}/src/value.txt`, bytes.byteLength),
  };
  const src: FakeNode = {
    children: new Map([["value.txt", file]]),
    identity: directoryIdentity("src", `${path}/src`),
  };
  return {
    children: new Map([["src", src]]),
    identity: directoryIdentity("root", path),
  };
}

function adapterWithFile(bytes: Uint8Array): FakeAdapter {
  const fs = new FakeAdapter();
  fs.addRoot(SANDBOX_A, rootNode("/sandbox-a", bytes));
  return fs;
}

function operationId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function runWrite(
  database: DatabaseSync,
  fs: FakeAdapter,
  index: number,
  expectedHash: string | null,
) {
  return writeTool.executeWriteToolAction({
    actionIndex: 0,
    content: "new",
    database,
    expectedHash,
    fs,
    operationId: operationId(index),
    path: "src/value.txt",
    projectId: PROJECT_ID,
    sandboxRoot: SANDBOX_A,
  });
}

function seedDatabase(index: number, canWrite: boolean): DatabaseSync {
  const database = openDatabase(databasePath);
  execV7Fixture(databasePath, database, `
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Write','${NOW}','D:\\workspace','d:/workspace',1);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'provider','Provider','http://127.0.0.1','model','c','i','t',1,1,'k','***',
      '${NOW}',1,'${NOW}','${NOW}'
    );
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES (
      'agent','Agent','Builder','private','provider','model','A','sage',
      1,${canWrite ? 1 : 0},1,1000,5,1,'${NOW}','${NOW}'
    );
    INSERT INTO project_memberships (project_id,agent_id,joined_at)
    VALUES ('${PROJECT_ID}','agent','${NOW}');
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','${PROJECT_ID}','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES ('work','mission','Work','','in_progress','agent',1,'${NOW}','${NOW}');
    INSERT INTO collaboration_runs (
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES (
      'run','${PROJECT_ID}','planned','agent',1,1,1,1,NULL,NULL,'${NOW}','${NOW}'
    );
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES (
      'policy','${PROJECT_ID}',NULL,'system',1,
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      1,0,2,0,'${NOW}'
    );
    INSERT INTO project_validation_policies (
      project_id,active_revision_id,version,updated_at
    ) VALUES ('${PROJECT_ID}','policy',1,'${NOW}');
    INSERT INTO executions (
      id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES (
      '${EXECUTION_ID}','${PROJECT_ID}','run','mission','work','agent','policy',
      'queued',NULL,NULL,0,NULL,1,0,0,1,1,'${NOW}',NULL,NULL,'${NOW}',NULL
    );
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES (
      '${ATTEMPT_ID}','${PROJECT_ID}','${EXECUTION_ID}',1,'ready','${SANDBOX_A}',
      NULL,NULL,NULL,'{}','{}','${"c".repeat(64)}','policy',1,'${"d".repeat(64)}',
      '${NOW}',NULL
    );
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,
      action_count,final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES (
      '${operationId(index)}','${PROJECT_ID}','${EXECUTION_ID}','advance','${HASH}',
      1,1,NULL,'pending',NULL,NULL,'${NOW}','${NOW}'
    );
    INSERT INTO execution_actions (
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,overall_deadline_at,created_at
    ) VALUES (
      'write-action-${index}','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',
      '${operationId(index)}',0,'file_write','pending','${HASH}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now')
    );
  `);
  return database;
}
