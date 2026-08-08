import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "@/src/server/db";
import { discardExecutionAction } from "@/src/server/execution/execution-actions";
import { execV7Fixture } from "@/tests/v7-fixture-graph";

vi.mock("server-only", () => ({}));

type Identity = {
  finalPath: string;
  identity: string;
  kind: "directory" | "file" | "link" | "reparse" | "special";
  size: number;
};

type Handle = { node: FakeNode; openedIdentity: Identity };
type FakeNode = {
  children?: Map<string, FakeNode>;
  identity: Identity;
};

type ListModule = {
  executeListToolAction(input: {
    actionIndex: number;
    database: DatabaseSync;
    fs: FakeAdapter;
    hooks?: { afterList?: () => void | Promise<void> };
    operationId: string;
    path: string;
    projectId: string;
    sandboxRoot: string;
  }): Promise<{
    affectedRows: 0 | 1;
    result: null | {
      entries: Array<{ kind: "directory" | "file"; name: string; size: number }>;
      path: string;
      totalObserved: number;
      truncated: boolean;
    };
  }>;
};

type GuardModule = {
  PathGuardError: new (...args: never[]) => Error & { code: string };
  validateSandboxRelativePath(path: string): {
    path: string;
    segments: string[];
  };
};

class FakeAdapter {
  readonly roots = new Map<string, FakeNode>();
  afterOpen?: (name: string, node: FakeNode) => void;

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
    const handle = { node, openedIdentity: { ...node.identity } };
    this.afterOpen?.(name, node);
    return handle;
  }

  async identity(handle: Handle): Promise<Identity> {
    return { ...handle.openedIdentity };
  }

  async currentIdentity(handle: Handle): Promise<Identity> {
    return { ...handle.node.identity };
  }

  async close(_handle: Handle): Promise<void> {}
}

const PROJECT_ID = "list-project";
const EXECUTION_ID = "list-execution";
const ATTEMPT_ID = "list-attempt";
const SANDBOX_ROOT = "verified://sandbox";
const HASH = "a".repeat(64);
const NOW = "2026-07-30T04:00:00.000Z";

let directory: string;
let databasePath: string;
let guard: GuardModule;
let listTool: ListModule;

function identity(
  value: string,
  kind: Identity["kind"],
  finalPath: string,
  size = 0,
): Identity {
  return { finalPath, identity: value, kind, size };
}

function directoryNode(
  value: string,
  finalPath: string,
  children: Array<[string, FakeNode]> = [],
): FakeNode {
  return {
    children: new Map(children),
    identity: identity(value, "directory", finalPath),
  };
}

function fileNode(value: string, finalPath: string, size: number): FakeNode {
  return { identity: identity(value, "file", finalPath, size) };
}

function operationId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cool-ai-list-tool-"));
  databasePath = join(directory, "cockpit.sqlite");
  try {
    guard = await import("@/src/server/execution/path-guard") as GuardModule;
    listTool = await import("@/src/server/execution/file-tools") as ListModule;
  } catch {
    expect.fail("The T-8 path guard and list action are unavailable.");
  }
});

afterEach(() => rmSync(directory, { force: true, recursive: true }));

describe("cross-platform relative path guard", () => {
  it.each([
    "",
    "\0",
    "a\0b",
    "/etc",
    "\\server\\share",
    "//server/share",
    "C:\\temp",
    "c:/temp",
    "\\\\?\\C:\\temp",
    "\\\\.\\PhysicalDrive0",
    "../secret",
    "safe/../secret",
    "safe/..",
    ".",
    "./safe",
    "safe/./file",
    "safe//file",
    "safe/file:stream",
    "safe/file.",
    "safe/file ",
    "safe\\file",
  ])("rejects unsafe or ambiguous path %j", (path) => {
    expect(() => guard.validateSandboxRelativePath(path)).toThrow(
      expect.objectContaining({ code: "PATH_INVALID" }),
    );
  });

  it.each([
    "CON",
    "con.txt",
    "PrN.JSON",
    "aux.",
    "nul ",
    "CLOCK$.log",
    "com1",
    "COM9.tar.gz",
    "lpt1",
    "LpT9.ext",
    "safe/Con.md",
  ])("rejects case-insensitive Windows reserved names including extensions: %s", (path) => {
    expect(() => guard.validateSandboxRelativePath(path)).toThrow(
      expect.objectContaining({ code: "PATH_INVALID" }),
    );
  });

  it("normalizes NFC segments and enforces segment and path byte limits", () => {
    expect(guard.validateSandboxRelativePath("src/cafe\u0301.txt")).toEqual({
      path: "src/café.txt",
      segments: ["src", "café.txt"],
    });
    expect(() => guard.validateSandboxRelativePath(`${"a".repeat(256)}/file`)).toThrow(
      expect.objectContaining({ code: "PATH_INVALID" }),
    );
    expect(() => guard.validateSandboxRelativePath("safe/\u007f")).toThrow(
      expect.objectContaining({ code: "PATH_INVALID" }),
    );
  });
});

describe("verified-handle bounded list", () => {
  it("wires production file and stage actions without the Node path fallback", async () => {
    const moduleId = "@/src/server/execution/windows-verified-execution-adapter";
    let adapterLoaded = false;
    try {
      const adapter = await import(/* @vite-ignore */ moduleId) as {
        createWindowsVerifiedExecutionAdapters?: unknown;
      };
      adapterLoaded = typeof adapter.createWindowsVerifiedExecutionAdapters === "function";
    } catch {
      adapterLoaded = false;
    }
    const route = readFileSync(
      join(process.cwd(), "app/api/executions/[executionId]/advance/route.ts"),
      "utf8",
    );

    expect({
      adapterLoaded,
      nativeFactoryWired: route.includes("createWindowsVerifiedExecutionAdapters"),
      nodeFallbackRemoved: !route.includes("nodeFileToolAdapter"),
    }).toEqual({
      adapterLoaded: true,
      nativeFactoryWired: true,
      nodeFallbackRemoved: true,
    });
  });

  it("lists at most 1000 direct ordinary children in stable UTF-8 name order", async () => {
    const children: Array<[string, FakeNode]> = [];
    for (let index = 1000; index >= 0; index -= 1) {
      const name = `item-${String(index).padStart(4, "0")}.txt`;
      children.push([
        name,
        fileNode(`file-${index}`, `/sandbox/src/${name}`, index),
      ]);
    }
    const root = directoryNode("root", "/sandbox", [
      ["src", directoryNode("src", "/sandbox/src", children)],
    ]);
    const fs = new FakeAdapter();
    fs.addRoot(SANDBOX_ROOT, root);

    const result = await runList(fs, "src", 1);

    expect(result.affectedRows).toBe(1);
    expect(result.result).toMatchObject({
      path: "src",
      totalObserved: 1001,
      truncated: true,
    });
    expect(result.result?.entries).toHaveLength(1000);
    expect(result.result?.entries[0]).toEqual({
      kind: "file",
      name: "item-0000.txt",
      size: 0,
    });
    expect(result.result?.entries.at(-1)?.name).toBe("item-0999.txt");
    expect(JSON.stringify(result.result)).not.toContain("/sandbox");
    expect(JSON.stringify(result.result)).not.toContain("identity");
  });

  it.each(["link", "reparse", "special"] as const)(
    "fails closed when a direct child is %s",
    async (kind) => {
      const unsafe: FakeNode = {
        identity: identity("unsafe", kind, "/outside", 0),
      };
      const root = directoryNode("root", "/sandbox", [
        ["src", directoryNode("src", "/sandbox/src", [["unsafe", unsafe]])],
      ]);
      const fs = new FakeAdapter();
      fs.addRoot(SANDBOX_ROOT, root);

      await expect(runList(fs, "src", 2)).rejects.toMatchObject({
        code: "SPECIAL_FILE_REJECTED",
      });
    },
  );

  it("fails closed when an existing segment or listed child changes identity", async () => {
    const target = directoryNode("src", "/sandbox/src", [
      ["file.txt", fileNode("file", "/sandbox/src/file.txt", 4)],
    ]);
    const root = directoryNode("root", "/sandbox", [["src", target]]);
    const parentRace = new FakeAdapter();
    parentRace.addRoot(SANDBOX_ROOT, root);
    parentRace.afterOpen = (name, node) => {
      if (name === "src") node.identity = identity("replacement", "directory", "/outside");
    };
    await expect(runList(parentRace, "src", 3)).rejects.toMatchObject({
      code: "SANDBOX_UNVERIFIABLE",
    });

    target.identity = identity("src", "directory", "/sandbox/src");
    const childRace = new FakeAdapter();
    childRace.addRoot(SANDBOX_ROOT, root);
    childRace.afterOpen = (name, node) => {
      if (name === "file.txt") node.identity = identity("replacement", "file", "/outside", 9);
    };
    await expect(runList(childRace, "src", 4)).rejects.toMatchObject({
      code: "SANDBOX_UNVERIFIABLE",
    });
  });
});

describe("durable list child action", () => {
  it("durably pauses list native failure with failed tool/action and completed 422 receipt", async () => {
    const fs = simpleAdapter();
    fs.openRootDirectory = async () => {
      throw new Error("native identity unavailable");
    };
    const database = seedDatabase(7);
    try {
      await expect(listTool.executeListToolAction({
        actionIndex: 0,
        database,
        fs,
        operationId: operationId(7),
        path: "src",
        projectId: PROJECT_ID,
        sandboxRoot: SANDBOX_ROOT,
      })).rejects.toMatchObject({ code: "SANDBOX_UNVERIFIABLE" });
      expect(database.prepare(`
        SELECT status,resume_target AS resumeTarget,reason_code AS reasonCode
        FROM executions WHERE id=?
      `).get(EXECUTION_ID)).toEqual({
        reasonCode: "SANDBOX_UNVERIFIABLE",
        resumeTarget: "running",
        status: "paused",
      });
      expect(database.prepare(`
        SELECT status,error_code AS errorCode FROM execution_actions
      `).get()).toEqual({ errorCode: "SANDBOX_UNVERIFIABLE", status: "failed" });
      expect(database.prepare(`
        SELECT status,public_result_json AS resultJson FROM execution_tool_calls
      `).get()).toEqual({
        resultJson: JSON.stringify({ code: "SANDBOX_UNVERIFIABLE" }),
        status: "failed",
      });
      expect(database.prepare(`
        SELECT status,http_status AS httpStatus FROM execution_operations
      `).get()).toEqual({ httpStatus: 422, status: "completed" });
    } finally {
      database.close();
    }
  });

  it("atomically persists typed tool facts, count, event, action, and receipt", async () => {
    const fs = simpleAdapter();
    const database = seedDatabase(5);
    try {
      const result = await listTool.executeListToolAction({
        actionIndex: 0,
        database,
        fs,
        operationId: operationId(5),
        path: "src",
        projectId: PROJECT_ID,
        sandboxRoot: SANDBOX_ROOT,
      });
      expect(result.affectedRows).toBe(1);
      expect(database.prepare(`
        SELECT type,status,public_request_json AS requestJson,
               public_result_json AS resultJson
        FROM execution_tool_calls
      `).get()).toEqual({
        requestJson: JSON.stringify({ path: "src", type: "list" }),
        resultJson: JSON.stringify(result.result),
        status: "succeeded",
        type: "list",
      });
      expect(database.prepare(`
        SELECT tool_call_count AS toolCalls,next_event_sequence AS nextSequence
        FROM executions WHERE id=?
      `).get(EXECUTION_ID)).toEqual({ nextSequence: 2, toolCalls: 1 });
      expect(database.prepare(`
        SELECT type,payload_json AS payloadJson FROM execution_events
      `).get()).toEqual({
        payloadJson: expect.stringContaining('"type":"list"'),
        type: "tool_succeeded",
      });
      expect(database.prepare(`
        SELECT status,result_json AS resultJson FROM execution_actions
      `).get()).toEqual({
        resultJson: JSON.stringify(result.result),
        status: "succeeded",
      });
      expect(database.prepare(`
        SELECT status,http_status AS httpStatus,response_json AS responseJson
        FROM execution_operations
      `).get()).toEqual({
        httpStatus: 200,
        responseJson: JSON.stringify({ result: result.result }),
        status: "completed",
      });
    } finally {
      database.close();
    }
  });

  it("commits no tool fact, count, or event when stop/discard wins before finalize", async () => {
    const fs = simpleAdapter();
    const database = seedDatabase(6);
    try {
      const durableBody = { outcome: "stopped" };
      const result = await listTool.executeListToolAction({
        actionIndex: 0,
        database,
        fs,
        hooks: {
          afterList() {
            expect(discardExecutionAction(database, {
              actionId: "list-action-6",
              body: durableBody,
              httpStatus: 409,
              projectId: PROJECT_ID,
            })).toEqual({ affectedRows: 1 });
          },
        },
        operationId: operationId(6),
        path: "src",
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
      expect(database.prepare(`
        SELECT status,http_status AS httpStatus,response_json AS responseJson
        FROM execution_operations
      `).get()).toEqual({
        httpStatus: 409,
        responseJson: JSON.stringify(durableBody),
        status: "completed",
      });
    } finally {
      database.close();
    }
  });
});

function simpleAdapter(): FakeAdapter {
  const fs = new FakeAdapter();
  fs.addRoot(SANDBOX_ROOT, directoryNode("root", "/sandbox", [
    ["src", directoryNode("src", "/sandbox/src", [
      ["b.txt", fileNode("b", "/sandbox/src/b.txt", 2)],
      ["a", directoryNode("a", "/sandbox/src/a")],
    ])],
  ]));
  return fs;
}

async function runList(fs: FakeAdapter, path: string, index: number) {
  rmSync(databasePath, { force: true });
  const database = seedDatabase(index);
  try {
    return await listTool.executeListToolAction({
      actionIndex: 0,
      database,
      fs,
      operationId: operationId(index),
      path,
      projectId: PROJECT_ID,
      sandboxRoot: SANDBOX_ROOT,
    });
  } finally {
    database.close();
  }
}

function seedDatabase(index: number): DatabaseSync {
  const database = openDatabase(databasePath);
  execV7Fixture(databasePath, database, `
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('${PROJECT_ID}','List','${NOW}','D:\\workspace','d:/workspace',1);
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
      'list-action-${index}','${PROJECT_ID}','${EXECUTION_ID}','${ATTEMPT_ID}',
      '${operationId(index)}',0,'file_list','pending','${HASH}',
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now')
    );
  `);
  return database;
}
