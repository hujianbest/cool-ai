import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { discardExecutionAction } from "@/src/server/execution/execution-actions";
import { execV7Fixture } from "@/tests/fixtures/execution/current-graph";

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
};
type Handle = { node: FakeNode; openedIdentity: Identity };
type ReadModule = {
  executeReadToolAction(input: {
    actionIndex: number;
    database: DatabaseSync;
    fs: FakeAdapter;
    hooks?: { afterRead?: () => void | Promise<void> };
    operationId: string;
    path: string;
    projectId: string;
    redaction?: {
      cipherValues?: string[];
      masterKeyMarker?: string;
      providerApiKey?: string;
    };
    sandboxRoot: string;
  }): Promise<{
    affectedRows: 0 | 1;
    result: null | {
      bytes: number;
      content: string;
      guardCategory: "credential_redacted" | null;
      path: string;
      redacted: boolean;
      sha256: string;
    };
  }>;
  readVerifiedFile(input: {
    fs: FakeAdapter;
    path: string;
    redaction?: {
      cipherValues?: string[];
      masterKeyMarker?: string;
      providerApiKey?: string;
    };
    sandboxRoot: string;
  }): Promise<{
    bytes: number;
    content: string;
    guardCategory: "credential_redacted" | null;
    path: string;
    redacted: boolean;
    sha256: string;
  }>;
};

class FakeAdapter {
  readonly roots = new Map<string, FakeNode>();
  afterRead?: (node: FakeNode) => void;

  addRoot(path: string, root: FakeNode): void {
    this.roots.set(path, root);
  }

  async openRootDirectory(path: string): Promise<Handle> {
    const node = this.roots.get(path);
    if (!node) throw new Error("missing root");
    return { node, openedIdentity: { ...node.identity } };
  }

  async list(handle: Handle): Promise<Array<{ identity: string; name: string }>> {
    return [...(handle.node.children ?? new Map()).entries()].map(([name, node]) => ({
      identity: node.identity.identity,
      name,
    }));
  }

  async openChildNoFollow(parent: Handle, name: string): Promise<Handle> {
    const node = parent.node.children?.get(name);
    if (!node) throw new Error("missing child");
    return { node, openedIdentity: { ...node.identity } };
  }

  async identity(handle: Handle): Promise<Identity> {
    return { ...handle.openedIdentity };
  }

  async currentIdentity(handle: Handle): Promise<Identity> {
    return { ...handle.node.identity };
  }

  async readFromHandle(handle: Handle, maximumBytes: number): Promise<Uint8Array> {
    const bytes = handle.node.bytes ?? new Uint8Array();
    const result = bytes.slice(0, maximumBytes);
    this.afterRead?.(handle.node);
    return result;
  }

  async close(_handle: Handle): Promise<void> {}
}

const PROJECT_ID = "read-project";
const EXECUTION_ID = "read-execution";
const ATTEMPT_ID = "read-attempt";
const SANDBOX_ROOT = "verified://sandbox";
const HASH = "a".repeat(64);
const NOW = "2026-07-30T04:00:00.000Z";

let directory: string;
let databasePath: string;
let readTool: ReadModule;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cool-ai-read-tool-"));
  databasePath = join(directory, "cockpit.sqlite");
  try {
    readTool = await import("@/src/server/execution/file-tools") as ReadModule;
  } catch {
    expect.fail("The T-9 read action is unavailable.");
  }
});

afterEach(() => rmSync(directory, { force: true, recursive: true }));

describe("verified-handle UTF-8 read", () => {
  it("accepts empty, BOM, and exactly 1 MiB files and hashes original bytes", async () => {
    for (const [index, bytes, content] of [
      [1, new Uint8Array(), ""],
      [2, Buffer.from("\uFEFFhello", "utf8"), "hello"],
      [3, Buffer.alloc(1_048_576, 0x61), "a".repeat(1_048_576)],
    ] as const) {
      const result = await readTool.readVerifiedFile({
        fs: adapterWithFile(bytes),
        path: "src/value.txt",
        sandboxRoot: SANDBOX_ROOT,
      });
      expect(result, String(index)).toEqual({
        bytes: bytes.byteLength,
        content,
        guardCategory: null,
        path: "src/value.txt",
        redacted: false,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  });

  it("rejects 1 MiB + 1, NUL, malformed UTF-8, and non-files without partial text", async () => {
    for (const [bytes, code] of [
      [Buffer.alloc(1_048_577, 0x61), "FILE_LIMIT_EXCEEDED"],
      [Buffer.from("before\0after", "utf8"), "TEXT_INVALID"],
      [Buffer.from([0x66, 0x80, 0x6f]), "TEXT_INVALID"],
    ] as const) {
      await expect(readTool.readVerifiedFile({
        fs: adapterWithFile(bytes),
        path: "src/value.txt",
        sandboxRoot: SANDBOX_ROOT,
      })).rejects.toMatchObject({ code });
    }

    for (const kind of ["directory", "link", "reparse", "special"] as const) {
      const fs = adapterWithFile(Buffer.from("must-not-return"));
      const target = fs.roots.get(SANDBOX_ROOT)?.children?.get("src")?.children?.get("value.txt");
      if (!target) throw new Error("fixture");
      target.identity = identity("target", kind, `/sandbox/src/value.txt`, 15);
      await expect(readTool.readVerifiedFile({
        fs,
        path: "src/value.txt",
        sandboxRoot: SANDBOX_ROOT,
      })).rejects.toMatchObject({ code: "SPECIAL_FILE_REJECTED" });
    }
  });

  it("rejects file and ancestor identity changes after reading", async () => {
    const fileRace = adapterWithFile(Buffer.from("safe", "utf8"));
    fileRace.afterRead = (node) => {
      node.identity = identity("replacement", "file", "/outside/value.txt", 6);
      node.bytes = Buffer.from("secret", "utf8");
    };
    await expect(readTool.readVerifiedFile({
      fs: fileRace,
      path: "src/value.txt",
      sandboxRoot: SANDBOX_ROOT,
    })).rejects.toMatchObject({ code: "SANDBOX_UNVERIFIABLE" });

    const ancestorRace = adapterWithFile(Buffer.from("safe", "utf8"));
    ancestorRace.afterRead = () => {
      const src = ancestorRace.roots.get(SANDBOX_ROOT)?.children?.get("src");
      if (src) src.identity = identity("renamed", "directory", "/outside");
    };
    await expect(readTool.readVerifiedFile({
      fs: ancestorRace,
      path: "src/value.txt",
      sandboxRoot: SANDBOX_ROOT,
    })).rejects.toMatchObject({ code: "SANDBOX_UNVERIFIABLE" });
  });
});

describe("read redaction and durable CAS", () => {
  it("redacts configured and credential-like values before model, DTO, event, or DB storage", async () => {
    const providerKey = "provider-key-T9-secret";
    const masterKey = "master-key-T9-secret";
    const cipher = "cipher-T9-secret";
    const text = [
      `api_key=${providerKey}`,
      `COCKPIT_MASTER_KEY=${masterKey}`,
      `api_key_cipher=${cipher}`,
      "Authorization: Bearer auth-T9-secret",
      "password=generic-T9-secret",
    ].join("\n");
    const database = seedDatabase(10);
    try {
      const result = await readTool.executeReadToolAction({
        actionIndex: 0,
        database,
        fs: adapterWithFile(Buffer.from(text, "utf8")),
        operationId: operationId(10),
        path: "src/value.txt",
        projectId: PROJECT_ID,
        redaction: {
          cipherValues: [cipher],
          masterKeyMarker: masterKey,
          providerApiKey: providerKey,
        },
        sandboxRoot: SANDBOX_ROOT,
      });
      expect(result.affectedRows).toBe(1);
      expect(result.result).toMatchObject({
        guardCategory: "credential_redacted",
        redacted: true,
      });
      expect(result.result?.content).toBe([
        "api_key=[REDACTED:CREDENTIAL]",
        "COCKPIT_MASTER_KEY=[REDACTED:CREDENTIAL]",
        "api_key_cipher=[REDACTED:CREDENTIAL]",
        "Authorization: [REDACTED:CREDENTIAL]",
        "password=[REDACTED:CREDENTIAL]",
      ].join("\n"));
      expect(result.result?.sha256).toBe(createHash("sha256").update(text).digest("hex"));

      const persisted = JSON.stringify({
        action: database.prepare("SELECT result_json FROM execution_actions").get(),
        event: database.prepare("SELECT payload_json FROM execution_events").get(),
        operation: database.prepare("SELECT response_json FROM execution_operations").get(),
        tool: database.prepare(
          "SELECT public_request_json,public_result_json FROM execution_tool_calls",
        ).get(),
      });
      for (const secret of [providerKey, masterKey, cipher, "auth-T9-secret", "generic-T9-secret"]) {
        expect(persisted).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(secret);
      }
      expect(database.prepare(`
        SELECT tool_call_count AS toolCalls,next_event_sequence AS nextSequence
        FROM executions WHERE id=?
      `).get(EXECUTION_ID)).toEqual({ nextSequence: 2, toolCalls: 1 });
      expect(JSON.parse(String((database.prepare(
        "SELECT payload_json AS value FROM execution_events",
      ).get() as { value: string }).value))).toMatchObject({
        resultSummary: {
          bytes: Buffer.byteLength(text),
          guardCategory: "credential_redacted",
          path: "src/value.txt",
          redacted: true,
          sha256: result.result?.sha256,
        },
        type: "read",
      });
    } finally {
      database.close();
    }
  });

  it("discards a late read result when stop wins without facts, count, event, or secret", async () => {
    const secret = "late-secret-T9";
    const database = seedDatabase(11);
    try {
      const result = await readTool.executeReadToolAction({
        actionIndex: 0,
        database,
        fs: adapterWithFile(Buffer.from(`token=${secret}`, "utf8")),
        hooks: {
          afterRead() {
            expect(discardExecutionAction(database, {
              actionId: "read-action-11",
              body: { outcome: "stopped" },
              httpStatus: 409,
              projectId: PROJECT_ID,
            })).toEqual({ affectedRows: 1 });
          },
        },
        operationId: operationId(11),
        path: "src/value.txt",
        projectId: PROJECT_ID,
        sandboxRoot: SANDBOX_ROOT,
      });
      expect(result).toEqual({ affectedRows: 0, result: null });
      expect(database.prepare("SELECT count(*) AS count FROM execution_tool_calls").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT count(*) AS count FROM execution_events").get())
        .toEqual({ count: 0 });
      expect(database.prepare(
        "SELECT tool_call_count AS count FROM executions WHERE id=?",
      ).get(EXECUTION_ID)).toEqual({ count: 0 });
      expect(JSON.stringify(database.prepare(
        "SELECT result_json FROM execution_actions",
      ).get())).not.toContain(secret);
    } finally {
      database.close();
    }
  });
});

function identity(
  value: string,
  kind: Identity["kind"],
  finalPath: string,
  size = 0,
): Identity {
  return { finalPath, identity: value, kind, size };
}

function adapterWithFile(bytes: Uint8Array): FakeAdapter {
  const file: FakeNode = {
    bytes,
    identity: identity("target", "file", "/sandbox/src/value.txt", bytes.byteLength),
  };
  const src: FakeNode = {
    children: new Map([["value.txt", file]]),
    identity: identity("src", "directory", "/sandbox/src"),
  };
  const root: FakeNode = {
    children: new Map([["src", src]]),
    identity: identity("root", "directory", "/sandbox"),
  };
  const fs = new FakeAdapter();
  fs.addRoot(SANDBOX_ROOT, root);
  return fs;
}

function operationId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function seedDatabase(index: number): DatabaseSync {
  const database = openDatabase(databasePath);
  execV7Fixture(databasePath, database, `
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','Read','${NOW}','D:\\workspace','d:/workspace',1);
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
      1,1,1,1000,5,1,'${NOW}','${NOW}'
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
      '${ATTEMPT_ID}','${PROJECT_ID}','${EXECUTION_ID}',1,'ready','${SANDBOX_ROOT}',
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
      'read-action-${index}','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',
      '${operationId(index)}',0,'file_read','pending','${HASH}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now')
    );
  `);
  return database;
}
