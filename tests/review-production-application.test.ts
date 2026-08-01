import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/work-items/[workItemId]/reviews/route";
import { createCredentialVault } from "@/src/server/credential-vault";
import { openDatabase } from "@/src/server/db";
import type { ModelCallResult } from "@/src/shared/collaboration-contracts";

type ApplicationModule = typeof import("../src/server/review/review-application-service");
const applicationModules = import.meta.glob<ApplicationModule>(
  "../src/server/review/review-application-service.ts",
);
const callOpenAiChat = vi.hoisted(() => vi.fn());
vi.mock("@/src/server/collaboration/openai-chat-client", async (load) => ({
  ...await load<typeof import("@/src/server/collaboration/openai-chat-client")>(),
  callOpenAiChat,
}));
vi.mock("@/src/server/db", async (load) => {
  const actual = await load<typeof import("@/src/server/db")>();
  return {
    ...actual,
    openDatabase(path: string) {
      const probe = new DatabaseSync(path);
      const version = Number(probe.prepare("PRAGMA user_version").get()!.user_version);
      probe.close();
      if (version === 0) return actual.openDatabase(path);
      const database = new DatabaseSync(path);
      database.exec("PRAGMA foreign_keys=ON");
      return database;
    },
  };
});

const NOW = "2026-08-01T08:30:00.000Z";
const roots: string[] = [];
const operationId = "24000000-0000-4000-8000-000000000001";
let databasePath: string;

function output(choice: "reject" | "escalate" | "pass"): ModelCallResult {
  return {
    content: JSON.stringify({
      decision: choice === "reject"
        ? { choice, reworkRequirements: ["修复公开行为"] }
        : choice === "escalate"
        ? { choice, options: ["继续", "终止"], question: "需要 Owner 选择" }
        : { choice },
      evidenceRefs: [{ id: "result", type: "result", version: "1" }],
      findings: [],
      limitations: [],
      memoryCandidates: choice === "pass"
        ? [{
            content: "复核确认的经验",
            source: { id: "result", type: "result", version: "1" },
            supersedesMemoryId: null,
            type: "experience",
          }]
        : [],
      publicSummary: `公开裁决 ${choice}`,
    }),
    error: null,
    httpStatus: 200,
    status: "succeeded",
    usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 },
    usageReported: true,
  };
}

function seed(path: string): void {
  const database = openDatabase(path);
  const envelope = createCredentialVault().encrypt("provider", "server-secret");
  database.exec("PRAGMA foreign_keys=OFF");
  database.prepare(`
    INSERT INTO projects(id,name,created_at,version)
    VALUES ('project','Production review',?,1)
  `).run(NOW);
  database.prepare(`
    INSERT INTO providers(
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES ('provider','Provider','https://provider.invalid/v1','model',
      ?,?,?,1,1,?,'****',?,1,?,?)
  `).run(
    envelope.apiKeyCipher,
    envelope.apiKeyIv,
    envelope.apiKeyTag,
    envelope.keyId,
    NOW,
    NOW,
    NOW,
  );
  database.exec(`
    INSERT INTO agents(
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,
      created_at,updated_at,review_capable
    ) VALUES
      ('executor','Executor','Builder','Build','provider','model','E','sage',
       1,1,1,1000,2,1,'${NOW}','${NOW}',0),
      ('reviewer','Reviewer','Review','Review safely','provider','model','R','slate',
       1,0,0,1000,2,1,'${NOW}','${NOW}',1);
    INSERT INTO project_memberships(project_id,agent_id,joined_at)
    VALUES ('project','executor','${NOW}'),('project','reviewer','${NOW}');
    INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','project','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items(
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES
      ('work','mission','Work','Do work','in_progress','executor',1,'${NOW}','${NOW}'),
      ('other-work','mission','Other','Other work','in_progress','executor',1,'${NOW}','${NOW}');
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES
      ('result','project','mission','work',1,'execution','staged','journal',NULL,'executor','${NOW}'),
      ('other-result','project','mission','other-work',1,'other-execution','other-staged',
       'other-journal',NULL,'executor','${NOW}');
    INSERT INTO execution_staged_results(
      id,project_id,execution_id,attempt_id,action_id,baseline_manifest_hash,
      sandbox_manifest_hash,context_hash,policy_hash,staged_hash,observed_path_count,
      observed_final_bytes,merge_file_count,merge_final_bytes,blocker_count,
      classification,block_reasons_json,created_at
    ) VALUES
      ('staged','project','execution','execution-attempt','action','${"1".repeat(64)}',
       '${"2".repeat(64)}','${"3".repeat(64)}','${"4".repeat(64)}','${"5".repeat(64)}',
       1,0,0,0,0,'auto_eligible','[]','${NOW}'),
      ('other-staged','project','other-execution','other-attempt','other-action',
       '${"6".repeat(64)}','${"7".repeat(64)}','${"8".repeat(64)}','${"9".repeat(64)}',
       '${"a".repeat(64)}',1,0,0,0,0,'auto_eligible','[]','${NOW}');
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,state,version,updated_at
    ) VALUES
      ('work','project','mission','result',NULL,'pending_review',1,'${NOW}'),
      ('other-work','project','mission','other-result',NULL,'pending_review',1,'${NOW}');
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,1,1,'${NOW}');
  `);
  database.exec("PRAGMA foreign_keys=ON");
  database.close();
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    expectedHeadVersion: 1,
    operationId,
    resultId: "result",
    reviewerAgentId: "reviewer",
    ...overrides,
  };
}

async function post(workItemId: string, value: unknown): Promise<Response> {
  return POST(new Request(`http://localhost/api/work-items/${workItemId}/reviews`, {
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
    method: "POST",
  }), { params: Promise.resolve({ workItemId }) });
}

function counts() {
  const database = openDatabase(databasePath);
  try {
    return {
      attempts: Number(database.prepare("SELECT count(*) AS n FROM review_attempts").get()!.n),
      decisions: Number(database.prepare("SELECT count(*) AS n FROM review_decisions").get()!.n),
      memories: Number(database.prepare("SELECT count(*) AS n FROM memory_entries").get()!.n),
      receipts: Number(database.prepare("SELECT count(*) AS n FROM review_operations").get()!.n),
    };
  } finally {
    database.close();
  }
}

async function application(): Promise<ApplicationModule> {
  const load = applicationModules["../src/server/review/review-application-service.ts"];
  expect(load, "public-input review application service must exist").toBeTypeOf("function");
  return load();
}

beforeEach(() => {
  process.env.COCKPIT_MASTER_KEY = Buffer.alloc(32, 24).toString("base64url");
  const root = mkdtempSync(join(tmpdir(), "review-production-"));
  roots.push(root);
  databasePath = join(root, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  callOpenAiChat.mockReset();
  seed(databasePath);
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("public production review application", () => {
  it("strictly rejects forged internal fields with 422 and no side effects", async () => {
    const response = await post("work", body({
      attemptId: "forged",
      credential: "forged",
      frozenMaterialJson: "{}",
      providerRequest: {},
      validationContext: {},
    }));
    expect(response.status).toBe(422);
    expect(counts()).toEqual({ attempts: 0, decisions: 0, memories: 0, receipts: 0 });
    expect(callOpenAiChat).not.toHaveBeenCalled();
  });

  it("fails assembly/acquire drift with the fixed 409 and zero writes", async () => {
    const { startPublicReview } = await application();
    await expect(startPublicReview(databasePath, "work", body(), {
      afterSnapshot: (database) => {
        database.prepare(
          "UPDATE work_item_review_heads SET version=version+1 WHERE work_item_id='work'",
        ).run();
      },
    })).rejects.toMatchObject({
      code: "REVIEW_CONTEXT_STALE",
      message: "复核上下文已变化，请基于最新内容重试",
      status: 409,
    });
    expect(counts()).toEqual({ attempts: 0, decisions: 0, memories: 0, receipts: 0 });
    expect(callOpenAiChat).not.toHaveBeenCalled();
  });

  it.each([
    ["reject", "rework", "rejected", 0],
    ["escalate", "waiting_owner", "escalated", 0],
    ["pass", "passed", "passed", 1],
  ] as const)("drives provider, checkpoint and atomic %s finalization", async (
    choice,
    expectedHead,
    expectedAttempt,
    expectedMemories,
  ) => {
    callOpenAiChat.mockResolvedValue(output(choice));
    const response = await post("work", body());
    expect(response.status).toBe(200);
    const database = openDatabase(databasePath);
    try {
      expect(database.prepare(
        "SELECT state FROM work_item_review_heads WHERE work_item_id='work'",
      ).get()).toEqual({ state: expectedHead });
      expect(database.prepare("SELECT status FROM review_attempts").get())
        .toEqual({ status: expectedAttempt });
      expect(database.prepare(
        "SELECT parsed_output_hash IS NOT NULL AS checkpointed FROM review_attempts",
      ).get()).toEqual({ checkpointed: 1 });
      expect(Number(database.prepare("SELECT count(*) AS n FROM memory_entries").get()!.n))
        .toBe(expectedMemories);
      expect(database.prepare("SELECT status FROM work_items WHERE id='work'").get())
        .toEqual({ status: choice === "pass" ? "done" : "in_progress" });
    } finally {
      database.close();
    }
  });

  it("replays the canonical tuple and conflicts on non-path or path changes", async () => {
    callOpenAiChat.mockResolvedValue(output("pass"));
    const first = await post("work", body());
    const firstPayload = await first.json();
    expect(await (await post("work", body())).json()).toEqual(firstPayload);
    expect(callOpenAiChat).toHaveBeenCalledTimes(1);
    const afterReplay = counts();

    const changed = await post("work", body({ expectedHeadVersion: 2 }));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: "OPERATION_CONFLICT" } });

    const changedPath = await post("other-work", body({
      resultId: "other-result",
    }));
    expect(changedPath.status).toBe(409);
    expect(await changedPath.json()).toMatchObject({ error: { code: "OPERATION_CONFLICT" } });
    expect(callOpenAiChat).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual(afterReplay);
  });
});
