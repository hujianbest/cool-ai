import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewSlice } from "@/components/review/review-slice";
import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import { CURRENT_DATA_INVARIANTS } from "@/src/server/storage/current-data-invariants";
import { validateFixtureDatabase } from "@/tests/fixtures/execution/current-graph";
import {
  executeMergeCommit,
  executeMergePrepare,
} from "@/src/server/execution/merge-journal-service";
import {
  readReviewWorkspace,
  startReview,
} from "@/src/server/review/review-slice-service";
import { createThread } from "@/src/server/collaboration/thread-service";
import type { ReviewWorkspaceDto } from "@/src/shared/review-contracts";
import { refreshExecutionFrozenFixture } from "@/tests/fixtures/execution/frozen-input";

const directories: string[] = [];
const servers: Server[] = [];
const NOW = "2026-08-01T04:00:00.000Z";
const HASH = "a".repeat(64);
const STAGED_HASH = "9".repeat(64);
const MASTER_KEY = Buffer.alloc(32, 61).toString("base64url");

vi.mock("server-only", () => ({}));

afterEach(() => {
  delete process.env.COCKPIT_MASTER_KEY;
  for (const server of servers.splice(0)) server.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function listenProvider(
  requests: Array<Record<string, unknown>>,
): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              decision: { choice: "pass" },
              evidenceRefs: [],
              findings: [],
              limitations: [],
              memoryCandidates: [],
              publicSummary: "冻结变更与必需验证一致，可以通过。",
            }),
          },
        }],
        usage: { completion_tokens: 13, prompt_tokens: 21, total_tokens: 34 },
      }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

function seed(
  databasePath: string,
  baseUrl: string,
  workspaceRoot: string,
  sandboxRoot: string,
): DatabaseSync {
  const database = openDatabase(databasePath);
  const credential = createCredentialVault().encrypt("provider", "review-secret");
  const workspace = workspaceRoot.replaceAll("'", "''");
  const sandbox = sandboxRoot.replaceAll("'", "''");
  const validationOutput = "required validation passed";
  database.exec(`
    INSERT INTO projects (id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('project','Review','${NOW}','${workspace}','${workspace.toLowerCase()}',1);
    INSERT INTO providers (
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'provider','Local Review Provider','${baseUrl}','review-model',
      '${credential.apiKeyCipher}','${credential.apiKeyIv}','${credential.apiKeyTag}',
      1,1,'${credential.keyId}','${credential.apiKeyMask}','${NOW}',1,'${NOW}','${NOW}'
    );
    INSERT INTO agents (
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at,
      review_capable
    ) VALUES
      ('executor','Executor','Builder','private executor','provider','review-model','E','sage',
       1,1,1,10000,5,1,'${NOW}','${NOW}',0),
      ('reviewer','Reviewer','Independent reviewer','private reviewer','provider','review-model','R','slate',
       1,1,0,10000,5,1,'${NOW}','${NOW}',1);
    INSERT INTO project_memberships (project_id,agent_id,joined_at) VALUES
      ('project','executor','${NOW}'),('project','reviewer','${NOW}');
    INSERT INTO missions (id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','project','Fresh v6 mission','Ship safely',1,'${NOW}','${NOW}');
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,2,1,'${NOW}');
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES ('mission-review-initialized','project','mission',1,
      'mission_review_initialized','system',NULL,
      '{"contextVersion":1,"headVersion":1,"missionId":"mission"}','${NOW}');
    INSERT INTO work_items (
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES ('work','mission','Fresh work item','Change a file','in_progress','executor',1,'${NOW}','${NOW}');
  `);
  database.close();
  const threadId = createThread(databasePath, "project", {
    memberAgentIds: ["executor", "reviewer"],
    operationId: "60000000-0000-4000-8000-000000000000",
    title: "Review source",
  }).body.thread.id;
  const seeded = openDatabase(databasePath);
  seeded.exec(`
    INSERT INTO collaboration_runs (
      id,project_id,thread_id,status,current_agent_id,round_count,next_event_sequence,
      version,execution_epoch,pause_reason,pause_category,created_at,updated_at
    ) VALUES ('run','project','${threadId}','planned','executor',1,1,1,1,NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO collaboration_thread_facts(
      id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
      run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
    ) VALUES (
      'run-linked','project','${threadId}',3,3,'run_linked','system',NULL,
      'run',NULL,NULL,NULL,'{"runId":"run"}','${NOW}'
    );
    UPDATE collaboration_threads
    SET next_fact_sequence=4,last_activity_sequence=3,version=version+1,updated_at='${NOW}'
    WHERE project_id='project' AND id='${threadId}';
    UPDATE collaboration_project_thread_sequences
    SET next_activity_sequence=4 WHERE project_id='project';
    INSERT INTO project_validation_policy_revisions (
      id,project_id,created_operation_id,created_actor_type,revision_no,policy_hash,
      classifier_version,warning_accepted,canonical_bytes,entry_count,created_at
    ) VALUES ('policy','project',NULL,'system',1,'${HASH}',1,0,2,1,'${NOW}');
    INSERT INTO project_validation_policy_entries (
      id,project_id,revision_id,position,executable,executable_identity,args_json,
      workdir,required,tuple_hash
    ) VALUES ('policy-entry','project','policy',0,'npm.cmd','${HASH}','["test"]','.',1,'${HASH}');
    INSERT INTO project_validation_policies(project_id,active_revision_id,version,updated_at)
    VALUES ('project','policy',1,'${NOW}');
    INSERT INTO executions (
      id,project_id,source_collaboration_thread_id,source_collaboration_run_id,
      mission_id,work_item_id,agent_id,
      current_policy_revision_id,status,resume_target,reason_code,
      manual_recovery_required,recovery_resolution,current_attempt_no,
      business_round_count,tool_call_count,next_event_sequence,version,created_at,
      business_deadline_at,first_running_at,updated_at,merged_at
    ) VALUES ('execution','project','${threadId}','run','mission','work','executor','policy',
      'staged',NULL,NULL,0,NULL,1,1,1,1,7,'${NOW}',
      '2026-08-01T04:15:00.000Z','${NOW}','${NOW}',NULL);
    INSERT INTO execution_attempts (
      id,project_id,execution_id,attempt_no,status,sandbox_root,
      baseline_manifest_path,baseline_manifest_hash,sandbox_manifest_hash,
      frozen_public_json,frozen_private_json,frozen_context_hash,
      frozen_policy_revision_id,frozen_policy_version,frozen_policy_hash,
      started_at,finished_at
    ) VALUES ('attempt','project','execution',1,'ready','${sandbox}',
      NULL,'${"b".repeat(64)}','${"e".repeat(64)}','{}','{}','${"c".repeat(64)}',
      'policy',1,'${HASH}','${NOW}',NULL);
    INSERT INTO execution_operations (
      id,project_id,execution_id,kind,request_hash,has_external_actions,action_count,
      final_action_index,status,http_status,response_json,created_at,updated_at
    ) VALUES ('stage-op','project','execution','stage','${HASH}',1,1,0,
      'completed',200,'{}','${NOW}','${NOW}');
    INSERT INTO execution_actions (
      id,project_id,execution_id,attempt_id,operation_id,action_index,kind,status,
      request_hash,overall_deadline_at,result_json,created_at,started_at,finished_at
    ) VALUES ('stage-action','project','execution','attempt','stage-op',0,
      'stage_compute','succeeded','${HASH}','2026-08-01T04:15:00.000Z','{}',
      '${NOW}','${NOW}','${NOW}');
    INSERT INTO execution_tool_calls (
      id,project_id,execution_id,attempt_id,action_id,business_round,type,request_hash,
      status,error_code,public_request_json,public_result_json,before_sandbox_hash,
      after_sandbox_hash,started_at,finished_at
    ) VALUES ('validation-tool','project','execution','attempt',NULL,1,'command','${HASH}',
      'succeeded',NULL,'{}','{}','${"e".repeat(64)}','${"e".repeat(64)}','${NOW}','${NOW}');
    INSERT INTO execution_validation_results (
      id,project_id,execution_id,attempt_id,policy_revision_id,policy_entry_id,
      tool_call_id,sandbox_manifest_hash,required,exit_code,succeeded,stdout_bytes,
      stderr_bytes,stdout_sha256,stderr_sha256,stdout_truncated,stderr_truncated,finished_at
    ) VALUES (
      'validation','project','execution','attempt','policy','policy-entry','validation-tool',
      '${"e".repeat(64)}',1,0,1,${Buffer.byteLength(validationOutput)},0,
      '${sha256(validationOutput)}','${sha256("")}',0,0,'${NOW}'
    );
    INSERT INTO execution_validation_output_chunks (
      validation_id,stream,chunk_index,byte_offset,byte_length,text,sha256
    ) VALUES (
      'validation','stdout',0,0,${Buffer.byteLength(validationOutput)},
      '${validationOutput}','${sha256(validationOutput)}'
    );
    INSERT INTO execution_staged_results (
      id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
      sandbox_manifest_hash,context_hash,policy_hash,staged_hash,observed_path_count,
      observed_final_bytes,merge_file_count,merge_final_bytes,blocker_count,
      classification,block_reasons_json,created_at
    ) VALUES ('staged','project','execution','attempt','stage-action',
      '${"b".repeat(64)}','${"e".repeat(64)}','${"c".repeat(64)}','${HASH}',
      '${STAGED_HASH}',1,5,1,5,0,'auto_eligible','[]','${NOW}');
    INSERT INTO execution_staged_observations (
      id,staged_result_id,position,path,path_key,kind,baseline_hash,observed_hash,
      final_size,diff_text,diff_bytes,diff_truncated
    ) VALUES ('observation','staged',0,'src/a.txt','src/a.txt','modified',
      '${sha256("old-a")}','${sha256("new-a")}',5,'-old-a
+new-a',13,0);
    INSERT INTO execution_staged_files (
      id,staged_result_id,observation_id,position,path,path_key,kind,
      baseline_hash,staged_hash,size
    ) VALUES ('file','staged','observation',0,'src/a.txt','src/a.txt','modified',
      '${sha256("old-a")}','${sha256("new-a")}',5);
  `);
  refreshExecutionFrozenFixture(seeded, "execution");
  return seeded;
}

async function createMergedFixture() {
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
  const requests: Array<Record<string, unknown>> = [];
  const baseUrl = await listenProvider(requests);
  const directory = mkdtempSync(join(tmpdir(), "cool-ai-review-slice-"));
  directories.push(directory);
  const workspaceRoot = join(directory, "workspace");
  const sandboxRoot = join(directory, "execution", "attempt", "sandbox");
  const journalBaseRoot = join(directory, "execution", "attempt", "merge");
  mkdirSync(join(workspaceRoot, "src"), { recursive: true });
  mkdirSync(join(sandboxRoot, "src"), { recursive: true });
  writeFileSync(join(workspaceRoot, "src", "a.txt"), "old-a");
  writeFileSync(join(sandboxRoot, "src", "a.txt"), "new-a");
  const databasePath = join(directory, "cockpit.sqlite");
  const database = seed(databasePath, baseUrl, workspaceRoot, sandboxRoot);
  const prepared = await executeMergePrepare({
    database,
    executionId: "execution",
    expectedVersion: 7,
    journalBaseRoot,
    operationId: "60000000-0000-4000-8000-000000000001",
    projectId: "project",
    stagedHash: STAGED_HASH,
    workspaceRoot,
  });
  const merged = await executeMergeCommit({ database, journalId: prepared.journalId });
  expect({
    foreignKeys: database.prepare("PRAGMA foreign_key_check").all(),
    invariants: CURRENT_DATA_INVARIANTS.flatMap((sql, index) =>
      database.prepare(sql).get() === undefined ? [] : [index]),
    validation: validateFixtureDatabase(database),
  }).toEqual({ foreignKeys: [], invariants: [], validation: null });
  database.close();
  return {
    databasePath,
    requests,
    resultId: (merged.body as { result: { id: string } }).result.id,
  };
}

describe("peer review slice", () => {
  it("runs a v7 execution merge through a selected non-executor and one provider decision", async () => {
    const fixture = await createMergedFixture();
    const before = readReviewWorkspace(fixture.databasePath, "work");
    expect(before.candidates.map(({ agent }) => agent.id)).toEqual(["reviewer"]);
    expect(before.currentAttempt).toBeNull();
    expect(before.result.source).toMatchObject({
      contextHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      projectId: "project",
      runId: "run",
      threadId: expect.any(String),
    });

    const reviewed = await startReview(fixture.databasePath, "work", {
      expectedHeadVersion: before.headVersion,
      operationId: "60000000-0000-4000-8000-000000000002",
      resultId: fixture.resultId,
      reviewerAgentId: "reviewer",
    });

    expect(fixture.requests).toHaveLength(1);
    const messages = fixture.requests[0]!.messages as Array<{ content: string }>;
    const frozenMaterial = JSON.parse(messages[2]!.content) as {
      changes: { observations: Array<{ publicDiff: { chunks: Array<{ text: string }> } }> };
      validations: Array<{ stdout: { chunks: Array<{ text: string }> } }>;
    };
    expect(frozenMaterial.changes.observations[0]?.publicDiff.chunks[0]?.text)
      .toBe("-old-a\n+new-a");
    expect(frozenMaterial.validations[0]?.stdout.chunks[0]?.text)
      .toBe("required validation passed");
    expect(reviewed.currentAttempt).toMatchObject({
      calls: [{
        status: "succeeded",
        usage: {
          completionTokens: 13,
          promptTokens: 21,
          reported: true,
          totalTokens: 34,
        },
      }],
      decision: { choice: "pass" },
      provider: { model: "review-model", name: "Local Review Provider" },
      reviewer: { id: "reviewer", name: "Reviewer" },
      status: "passed",
      usageTotal: { reportedCalls: 1, totalTokens: 34 },
    });
    const database = openDatabase(fixture.databasePath);
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_decisions").get())
      .toEqual({ count: 1 });
    database.close();
  }, 30_000);

  it("does not auto-start the sole candidate and exposes disabled, success, usage and focus states", async () => {
    const start = vi.fn(async (): Promise<ReviewWorkspaceDto> => ({
      ...workspace,
      currentAttempt: {
        calls: [{
          id: "call",
          status: "succeeded",
          usage: {
            completionTokens: 13,
            promptTokens: 21,
            reported: true,
            totalTokens: 34,
          },
        }],
        decision: { choice: "pass", id: "decision", publicSummary: "可以通过" },
        id: "attempt",
        material: { hash: HASH, sourceCount: 3 },
        provider: { id: "provider", model: "review-model", name: "Local" },
        reviewer: {
          accentToken: "slate",
          avatarText: "R",
          id: "reviewer",
          name: "Reviewer",
        },
        status: "passed",
        usageTotal: {
          completionTokens: 13,
          promptTokens: 21,
          reportedCalls: 1,
          totalTokens: 34,
        },
      },
      effectiveStatus: "passed",
      headVersion: 3,
    }));
    let resolveLoad!: (value: ReviewWorkspaceDto) => void;
    const load = vi.fn(() => new Promise<ReviewWorkspaceDto>((resolve) => {
      resolveLoad = resolve;
    }));
    render(<ReviewSlice load={load} start={start} workItemId="work" />);
    expect(screen.getByText("正在加载复核候选与材料…")).toHaveAttribute("aria-busy", "true");
    resolveLoad(workspace);
    expect(await screen.findByRole("radio", { name: /Reviewer/ })).not.toBeChecked();
    const button = screen.getByRole("button", { name: "确认并发起真实复核" });
    expect(button).toBeDisabled();
    expect(start).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("radio", { name: /Reviewer/ }));
    expect(button).toBeEnabled();
    await userEvent.click(button);
    const heading = await screen.findByRole("heading", { name: "唯一裁决：pass" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText("已由 Reviewer 完成独立复核。")).toBeInTheDocument();
    expect(screen.getByText("21 + 13 = 34")).toBeInTheDocument();
    expect(screen.getAllByText("pass").length).toBeGreaterThan(0);
  });

  it("distinguishes empty and error states with recovery", async () => {
    const empty = { ...workspace, blockers: [{ code: "NO_INDEPENDENT_REVIEWER" }], candidates: [] };
    const { unmount } = render(
      <ReviewSlice load={async () => empty} workItemId="work-empty" />,
    );
    expect(await screen.findByText(/缺少独立复核者/)).toBeInTheDocument();
    unmount();

    const load = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(workspace);
    render(<ReviewSlice load={load} workItemId="work-error" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法加载复核工作区");
    fireEvent.click(screen.getByRole("button", { name: "重试加载复核工作区" }));
    expect(await screen.findByRole("radio", { name: /Reviewer/ })).toBeInTheDocument();
  });
});

const workspace: ReviewWorkspaceDto = {
  blockers: [],
  candidates: [{
    agent: {
      accentToken: "slate",
      avatarText: "R",
      id: "reviewer",
      name: "Reviewer",
      role: "Independent reviewer",
    },
    provider: { id: "provider", model: "review-model", name: "Local" },
    qualification: ["current_member", "review_capable", "not_executor"],
  }],
  currentAttempt: null,
  effectiveStatus: "pending_review",
  headVersion: 1,
  result: {
    executorAgentId: "executor",
    id: "result",
    source: {
      contextHash: "a".repeat(64),
      projectId: "project",
      runId: "run",
      threadId: "thread",
    },
    version: 1,
  },
  workItem: { id: "work", title: "Fresh work item" },
};
