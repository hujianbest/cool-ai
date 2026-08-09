import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { execV7Fixture } from "@/tests/fixtures/execution/current-graph";

const databaseDirectories: string[] = [];

afterEach(() => {
  for (const directory of databaseDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

type Entry = {
  content?: string;
  kind: "binary" | "link" | "special" | "text";
  modeTag: string;
  path: string;
  sha256: string;
  size: number;
};

type StagingModule = {
  assertTextChunkInvariants(
    header: { bytes: number; sha256: string },
    chunks: Array<{
      byteLength: number;
      byteOffset: number;
      sha256: string;
      text: string;
    }>,
  ): void;
  computeStagedSnapshot(input: {
    attemptId: string;
    baseline: AsyncIterable<Entry>;
    baselineManifestHash: string;
    contextHash: string;
    lastFileChangeAt?: string | null;
    pendingApproval: boolean;
    pendingAction?: boolean;
    policyHash: string;
    policyRevisionId: string;
    requiredValidations: Array<{
      exitCode: number;
      finishedAt: string;
      manifestHash: string;
      policyEntryId: string;
      policyRevisionId: string;
      required: boolean;
      stderrSha256: string;
      stderrTruncated: boolean;
      stdoutSha256: string;
      stdoutTruncated: boolean;
      succeeded: boolean;
    }>;
    requiredPolicyEntryIds: string[];
    sandbox: AsyncIterable<Entry>;
    sandboxManifestHash: string;
  }): Promise<{
    blockReasons: string[];
    blockers: Array<{ kind: string; secondaryCodes: string[] }>;
    classification: "approval_required" | "auto_eligible" | "blocked";
    mergeFiles: Entry[];
    observations: Array<{ kind: string; path: string }>;
    outcome: "no_changes" | "ready";
    stagedHash: string | null;
    totals: {
      blockerCount: number;
      mergeFileCount: number;
      mergeFinalBytes: number;
      observedFinalBytes: number;
      observedPathCount: number;
    };
  }>;
  createBoundedUtf8Text(value: string): {
    bytes: number;
    chunks: Array<{
      byteLength: number;
      byteOffset: number;
      sha256: string;
      text: string;
    }>;
    sha256: string;
    truncated: boolean;
  };
  persistArtifactOutput(database: DatabaseSync, input: {
    attemptId: string;
    executionId: string;
    name: string;
    output: ReturnType<StagingModule["createBoundedUtf8Text"]>;
    path: string;
    projectId: string;
  }): string;
  persistComputedStage(database: DatabaseSync, input: {
    actionId: string;
    baselineManifestHash: string;
    body: unknown;
    contextHash: string;
    executionId: string;
    expectedVersion: number;
    leaseToken: string;
    policyHash: string;
    projectId: string;
    sandboxManifestHash: string;
    snapshot: Awaited<ReturnType<StagingModule["computeStagedSnapshot"]>>;
  }): { affectedRows: 0 | 1; stagedResultId: string | null };
  persistValidationOutput(database: DatabaseSync, input: {
    attemptId: string;
    executionId: string;
    exitCode: number;
    policyEntryId: string;
    policyRevisionId: string;
    projectId: string;
    required: boolean;
    sandboxManifestHash: string;
    stderr: ReturnType<StagingModule["createBoundedUtf8Text"]>;
    stdout: ReturnType<StagingModule["createBoundedUtf8Text"]>;
    succeeded: boolean;
    toolCallId: string;
  }): string;
};

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const HASH = "a".repeat(64);
const EMPTY_POLICY_HASH = createHash("sha256").update("[]").digest("hex");

function text(path: string, content = path, modeTag = "644"): Entry {
  return {
    content,
    kind: "text",
    modeTag,
    path,
    sha256: hash(content),
    size: Buffer.byteLength(content, "utf8"),
  };
}

async function* entries(values: Iterable<Entry>): AsyncIterable<Entry> {
  yield* values;
}

async function loadStaging(): Promise<StagingModule> {
  const moduleId = "@/src/adapters/outbound/sqlite/safe-execution/stage-service";
  try {
    return await import(/* @vite-ignore */ moduleId) as StagingModule;
  } catch {
    expect.fail("The execution staging service is unavailable.");
  }
}

function input(baseline: Iterable<Entry>, sandbox: Iterable<Entry>) {
  return {
    attemptId: "attempt",
    baseline: entries(baseline),
    baselineManifestHash: HASH,
    contextHash: "b".repeat(64),
    pendingApproval: false,
    policyHash: "c".repeat(64),
    policyRevisionId: "policy",
    requiredPolicyEntryIds: ["required"],
    requiredValidations: [{
      exitCode: 0,
      finishedAt: "2026-07-30T10:00:00.000Z",
      manifestHash: "d".repeat(64),
      policyEntryId: "required",
      policyRevisionId: "policy",
      required: true,
      stderrSha256: hash(""),
      stderrTruncated: false,
      stdoutSha256: hash("ok"),
      stdoutTruncated: false,
      succeeded: true,
    }],
    sandbox: entries(sandbox),
    sandboxManifestHash: "d".repeat(64),
  };
}

function seedStageDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "cool-ai-staging-"));
  databaseDirectories.push(directory);
  const databasePath = join(directory, "cockpit.sqlite");
  const database = openDatabase(databasePath);
  const now = "2026-07-30T10:00:00.000Z";
  const policyHash = EMPTY_POLICY_HASH;
  execV7Fixture(databasePath, database, `
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('project','Project','${now}','D:\\canonical','d:/canonical',1);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES ('provider','Provider','http://127.0.0.1','model','cipher','iv','tag',
      1,1,'key','***','${now}',1,'${now}','${now}');
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
    ) VALUES ('agent','Agent','Builder','private','provider','model','A','sage',
      1,1,1,1000,5,1,'${now}','${now}');
    INSERT INTO project_memberships (project_id,agent_id,joined_at)
    VALUES ('project','agent','${now}');
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','project','Mission','Goal',1,'${now}','${now}');
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,2,1,'${now}');
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES ('staging-review-init','project','mission',1,
      'mission_review_initialized','system',NULL,'{}','${now}');
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES ('work','mission','Work','','in_progress','agent',1,'${now}','${now}');
    INSERT INTO collaboration_runs (
      id,project_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES ('run','project','planned','agent',1,1,1,1,NULL,NULL,'${now}','${now}');
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES ('policy','project',NULL,'system',1,'${policyHash}',1,0,2,0,'${now}');
    INSERT INTO project_validation_policies (project_id,active_revision_id,version,updated_at)
    VALUES ('project','policy',1,'${now}');
    INSERT INTO executions (
      id,project_id,source_collaboration_run_id,mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES ('execution','project','run','mission','work','agent','policy',
      'running',NULL,NULL,0,NULL,1,1,1,1,1,'${now}',
      '2099-01-01T00:15:00.000Z','2099-01-01T00:00:00.000Z','${now}',NULL);
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES ('attempt','project','execution',1,'acting','D:\\sandbox',NULL,
      '${HASH}','${"d".repeat(64)}','{}','{}','${"b".repeat(64)}',
      'policy',1,'${policyHash}','${now}',NULL);
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,
      action_count,final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES ('operation','project','execution','advance','${HASH}',1,1,NULL,
      'pending',NULL,NULL,'${now}','${now}');
    INSERT INTO execution_actions (
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,lease_token,lease_expires_at,overall_deadline_at,last_heartbeat_at,
      result_json,error_code,created_at,started_at,finished_at
    ) VALUES ('stage-action','project','execution','attempt','operation',0,
      'stage_compute','running','${HASH}','lease','2099-01-01T00:10:00.000Z',
      '2099-01-01T00:15:00.000Z','${now}',NULL,NULL,'${now}','${now}',NULL);
  `);
  return database;
}

describe("execution staging", () => {
  it("detects no changes without fabricating a staged result", async () => {
    const staging = await loadStaging();
    const same = text("same.txt", "same");
    const result = await staging.computeStagedSnapshot(input([same], [same]));

    expect(result).toEqual(expect.objectContaining({
      classification: "blocked",
      observations: [],
      outcome: "no_changes",
      stagedHash: null,
      totals: {
        blockerCount: 0,
        mergeFileCount: 0,
        mergeFinalBytes: 0,
        observedFinalBytes: 0,
        observedPathCount: 0,
      },
    }));
  });

  it("keeps all observations but only creates merge rows for globally eligible input", async () => {
    const staging = await loadStaging();
    const hundred = Array.from({ length: 100 }, (_, index) =>
      text(`file-${String(index).padStart(3, "0")}.txt`, "x"));
    const eligible = await staging.computeStagedSnapshot(input([], hundred));
    expect(eligible.outcome).toBe("ready");
    expect(eligible.classification).toBe("auto_eligible");
    expect(eligible.totals).toEqual(expect.objectContaining({
      mergeFileCount: 100,
      observedPathCount: 100,
    }));

    const oneHundredOne = await staging.computeStagedSnapshot(
      input([], [...hundred, text("file-100.txt", "x")]),
    );
    expect(oneHundredOne.totals.observedPathCount).toBe(101);
    expect(oneHundredOne.classification).toBe("blocked");
    expect(oneHundredOne.mergeFiles).toHaveLength(0);
    expect(oneHundredOne.blockers.some((blocker) => blocker.kind === "file_count_limit"))
      .toBe(true);
  });

  it("scans 100000 generated observations without materializing sandbox files", async () => {
    const staging = await loadStaging();
    async function* generated(): AsyncIterable<Entry> {
      for (let index = 0; index < 100_000; index += 1) {
        yield text(`generated/${String(index).padStart(6, "0")}.txt`, "");
      }
    }
    const result = await staging.computeStagedSnapshot({
      ...input([], []),
      sandbox: generated(),
    });
    expect(result.totals.observedPathCount).toBe(100_000);
    expect(result.observations.at(-1)?.path).toBe("generated/099999.txt");
    expect(result.classification).toBe("blocked");
    expect(result.mergeFiles).toHaveLength(0);
  }, 60_000);

  it("classifies delete, stable rename, binary, permission, link, and oversize blockers", async () => {
    const staging = await loadStaging();
    const renamed = text("old.txt", "rename-me");
    const baseline = [
      text("deleted.txt", "gone"),
      renamed,
      text("permission.txt", "same", "644"),
    ];
    const sandbox = [
      { ...renamed, path: "new.txt" },
      { ...text("binary.dat", "bytes"), content: undefined, kind: "binary" as const },
      text("permission.txt", "same", "755"),
      { ...text("linked", ""), content: undefined, kind: "link" as const },
      { ...text("too-large.txt", ""), content: undefined, size: 1_048_577 },
    ];
    const result = await staging.computeStagedSnapshot(input(baseline, sandbox));
    const kinds = new Set(result.observations.map((observation) => observation.kind));

    expect(kinds).toEqual(new Set([
      "binary",
      "deleted",
      "permission",
      "renamed",
      "special",
      "added",
    ]));
    expect(new Set(result.blockers.map((blocker) => blocker.kind))).toEqual(new Set([
      "binary",
      "deleted",
      "file_size_limit",
      "permission",
      "renamed",
      "special",
    ]));
    expect(result.classification).toBe("blocked");
    expect(result.mergeFiles).toHaveLength(0);
  });

  it("requires exact frozen policy validations and uses staged-hash approval for empty policy", async () => {
    const staging = await loadStaging();
    const changed = () => input([], [text("added.txt", "new")]);
    const fresh = await staging.computeStagedSnapshot(changed());
    expect(fresh.classification).toBe("auto_eligible");

    const stale = await staging.computeStagedSnapshot({
      ...changed(),
      requiredValidations: [{
        ...changed().requiredValidations[0],
        manifestHash: "e".repeat(64),
      }],
    });
    expect(stale.classification).toBe("blocked");
    expect(stale.blockReasons).toContain("VALIDATION_REQUIRED");

    const beforeLastWrite = await staging.computeStagedSnapshot({
      ...changed(),
      lastFileChangeAt: "2026-07-30T10:00:01.000Z",
    });
    expect(beforeLastWrite.classification).toBe("blocked");
    expect(beforeLastWrite.blockReasons).toContain("VALIDATION_REQUIRED");

    const wrongFrozenPolicy = await staging.computeStagedSnapshot({
      ...changed(),
      requiredValidations: [{
        ...changed().requiredValidations[0],
        policyRevisionId: "different-policy",
      }],
    });
    expect(wrongFrozenPolicy.classification).toBe("blocked");
    expect(wrongFrozenPolicy.blockReasons).toContain("VALIDATION_REQUIRED");

    const emptyPolicy = await staging.computeStagedSnapshot({
      ...changed(),
      requiredPolicyEntryIds: [],
      requiredValidations: [],
    });
    expect(emptyPolicy.classification).toBe("approval_required");
    expect(emptyPolicy.stagedHash).toMatch(/^[0-9a-f]{64}$/u);

    await expect(staging.computeStagedSnapshot({
      ...changed(),
      pendingApproval: true,
    })).rejects.toMatchObject({ code: "APPROVAL_STATE_CONFLICT" });
    await expect(staging.computeStagedSnapshot({
      ...changed(),
      pendingAction: true,
    })).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
  });

  it("chunks 0, 16, and worst-case 17 UTF-8 chunks without splitting a scalar", async () => {
    const staging = await loadStaging();
    const empty = staging.createBoundedUtf8Text("");
    expect(empty.chunks).toHaveLength(0);
    staging.assertTextChunkInvariants(empty, empty.chunks);

    const sixteen = staging.createBoundedUtf8Text("x".repeat(1_048_576));
    expect(sixteen.bytes).toBe(1_048_576);
    expect(sixteen.chunks).toHaveLength(16);
    staging.assertTextChunkInvariants(sixteen, sixteen.chunks);

    const worst = staging.createBoundedUtf8Text("€".repeat(349_525));
    expect(worst.bytes).toBe(1_048_575);
    expect(worst.chunks).toHaveLength(17);
    expect(worst.chunks.every((chunk) => chunk.byteLength <= 65_536)).toBe(true);
    expect(worst.chunks.map((chunk) => chunk.text).join("")).toBe("€".repeat(349_525));
    staging.assertTextChunkInvariants(worst, worst.chunks);
  });

  it("rejects chunk gaps, reorder, and hash corruption", async () => {
    const staging = await loadStaging();
    const output = staging.createBoundedUtf8Text("x".repeat(70_000));
    expect(() => staging.assertTextChunkInvariants(output, [
      output.chunks[0],
      { ...output.chunks[1], byteOffset: output.chunks[1].byteOffset + 1 },
    ])).toThrow(/gap|offset/iu);
    expect(() => staging.assertTextChunkInvariants(output, [...output.chunks].reverse()))
      .toThrow(/index|offset|order/iu);
    expect(() => staging.assertTextChunkInvariants(output, [
      { ...output.chunks[0], sha256: "0".repeat(64) },
      ...output.chunks.slice(1),
    ])).toThrow(/hash/iu);
  });

  it("commits staged facts, execution state, action, and receipt atomically after late rechecks", async () => {
    const staging = await loadStaging();
    const database = seedStageDatabase();
    try {
      const snapshot = await staging.computeStagedSnapshot({
        ...input([], [text("added.txt", "new")]),
        requiredPolicyEntryIds: [],
        requiredValidations: [],
      });
      const persist = () => staging.persistComputedStage(database, {
        actionId: "stage-action",
        baselineManifestHash: HASH,
        body: { stagedHash: snapshot.stagedHash },
        contextHash: "b".repeat(64),
        executionId: "execution",
        expectedVersion: 1,
        leaseToken: "lease",
        policyHash: EMPTY_POLICY_HASH,
        projectId: "project",
        sandboxManifestHash: "d".repeat(64),
        snapshot,
      });

      database.prepare(
        "UPDATE execution_attempts SET frozen_context_hash=? WHERE id='attempt'",
      ).run("e".repeat(64));
      expect(persist).toThrowError(expect.objectContaining({ code: "STALE_EXECUTION" }));
      expect(database.prepare("SELECT COUNT(*) AS count FROM execution_staged_results").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT status FROM execution_actions WHERE id='stage-action'").get())
        .toEqual({ status: "running" });

      database.prepare(
        "UPDATE execution_attempts SET frozen_context_hash=? WHERE id='attempt'",
      ).run("b".repeat(64));
      expect(persist()).toEqual({ affectedRows: 1, stagedResultId: expect.any(String) });
      expect(database.prepare("SELECT status,version FROM executions WHERE id='execution'").get())
        .toEqual({ status: "staged", version: 2 });
      expect(database.prepare(`
        SELECT observed_path_count AS observedPathCount,merge_file_count AS mergeFileCount,
               classification FROM execution_staged_results
      `).get()).toEqual({
        classification: "approval_required",
        mergeFileCount: 1,
        observedPathCount: 1,
      });
      expect(database.prepare("SELECT status FROM execution_actions WHERE id='stage-action'").get())
        .toEqual({ status: "succeeded" });
      expect(database.prepare("SELECT status,http_status AS httpStatus FROM execution_operations").get())
        .toEqual({ httpStatus: 200, status: "completed" });
    } finally {
      database.close();
    }
  });

  it("drops a late staged result without writing any staged facts", async () => {
    const staging = await loadStaging();
    const database = seedStageDatabase();
    try {
      const snapshot = await staging.computeStagedSnapshot({
        ...input([], [text("added.txt", "new")]),
        requiredPolicyEntryIds: [],
        requiredValidations: [],
      });
      database.exec(`
        UPDATE execution_actions
        SET status='discarded',lease_token=NULL,lease_expires_at=NULL,
            finished_at='2026-07-30T10:00:01.000Z'
        WHERE id='stage-action';
      `);
      const result = staging.persistComputedStage(database, {
        actionId: "stage-action",
        baselineManifestHash: HASH,
        body: {},
        contextHash: "b".repeat(64),
        executionId: "execution",
        expectedVersion: 1,
        leaseToken: "lease",
        policyHash: "c".repeat(64),
        projectId: "project",
        sandboxManifestHash: "d".repeat(64),
        snapshot,
      });
      expect(result).toEqual({ affectedRows: 0, stagedResultId: null });
      expect(database.prepare("SELECT COUNT(*) AS count FROM execution_staged_results").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT status,version FROM executions WHERE id='execution'").get())
        .toEqual({ status: "running", version: 1 });
    } finally {
      database.close();
    }
  });

  it("persists empty and worst-case artifact/validation bodies as immutable chunks", async () => {
    const staging = await loadStaging();
    const database = seedStageDatabase();
    try {
      const empty = staging.createBoundedUtf8Text("");
      const worst = staging.createBoundedUtf8Text("€".repeat(349_525));
      staging.persistArtifactOutput(database, {
        attemptId: "attempt",
        executionId: "execution",
        name: "empty",
        output: empty,
        path: "artifact/empty",
        projectId: "project",
      });
      staging.persistArtifactOutput(database, {
        attemptId: "attempt",
        executionId: "execution",
        name: "worst",
        output: worst,
        path: "artifact/worst",
        projectId: "project",
      });
      database.exec(`
        INSERT INTO project_validation_policy_entries (
          id,project_id,revision_id,position,executable,executable_identity,args_json,
          workdir,required,tuple_hash
        ) VALUES ('entry','project','policy',0,'node','${HASH}','[]','.',1,'${HASH}');
        INSERT INTO execution_tool_calls (
          id,project_id,execution_id,attempt_id,action_id,business_round,type,
          request_hash,status,public_request_json,public_result_json,
          before_sandbox_hash,after_sandbox_hash,started_at,finished_at
        ) VALUES ('validation-tool','project','execution','attempt','stage-action',1,
          'list','${HASH}','succeeded','{}','{}',NULL,'${"d".repeat(64)}',
          '2026-07-30T10:00:00.000Z','2026-07-30T10:00:01.000Z');
      `);
      staging.persistValidationOutput(database, {
        attemptId: "attempt",
        executionId: "execution",
        exitCode: 0,
        policyEntryId: "entry",
        policyRevisionId: "policy",
        projectId: "project",
        required: true,
        sandboxManifestHash: "d".repeat(64),
        stderr: empty,
        stdout: worst,
        succeeded: true,
        toolCallId: "validation-tool",
      });

      expect(database.prepare(`
        SELECT name,content_bytes AS bytes,
               (SELECT COUNT(*) FROM execution_artifact_chunks c
                WHERE c.artifact_id=a.id) AS chunks
        FROM execution_artifacts a ORDER BY name
      `).all()).toEqual([
        { bytes: 0, chunks: 0, name: "empty" },
        { bytes: 1_048_575, chunks: 17, name: "worst" },
      ]);
      expect(database.prepare(`
        SELECT stream,COUNT(*) AS chunks FROM execution_validation_output_chunks
        GROUP BY stream ORDER BY stream
      `).all()).toEqual([{ chunks: 17, stream: "stdout" }]);
    } finally {
      database.close();
    }
  });
});
