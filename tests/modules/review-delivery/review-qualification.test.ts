

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import * as reviewService from "@/src/adapters/outbound/sqlite/review-delivery/review-slice-service";
import { agentInputSchema } from "@/src/shared/team-schemas";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type Candidate = {
  agent: { id: string };
  qualification: ["current_member", "review_capable", "not_executor"];
};

type QualificationResult = {
  blockers: Array<{ code: string }>;
  candidates: Candidate[];
  selectedReviewerAgentId: null;
};

type QualificationModule = {
  listReviewCandidatesTx?: (
    database: DatabaseSync,
    workItemId: string,
    resultId: string,
  ) => QualificationResult;
};

const qualification = reviewService as QualificationModule;
const NOW = "2026-08-01T04:00:00.000Z";
let databasePath: string;
let database: DatabaseSync;

function seed(): void {
  database = openDatabase(databasePath);
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
    VALUES ('project','Review','${NOW}',NULL,NULL,1);
    INSERT INTO providers(
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES (
      'provider','Provider','https://provider.example/v1','model',
      'cipher','iv','tag',1,1,'key','mask','${NOW}',1,'${NOW}','${NOW}'
    );
    INSERT INTO agents(
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,
      created_at,updated_at,review_capable
    ) VALUES
      ('executor','Executor','Builder','Build','provider','model','E','sage',
       1,1,1,1000,2,1,'${NOW}','${NOW}',1),
      ('reviewer-a','Reviewer A','Review','Review','provider','model','A','slate',
       1,0,0,1000,2,1,'${NOW}','${NOW}',1),
      ('reviewer-b','Reviewer B','Review','Review','provider','model','B','gold',
       1,0,0,1000,2,1,'${NOW}','${NOW}',1),
      ('disabled','Disabled','Review','Review','provider','model','D','rose',
       1,0,0,1000,2,1,'${NOW}','${NOW}',0),
      ('outsider','Outsider','Review','Review','provider','model','O','olive',
       1,0,0,1000,2,1,'${NOW}','${NOW}',1);
    INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES
      ('project','executor','${NOW}'),
      ('project','reviewer-a','${NOW}'),
      ('project','reviewer-b','${NOW}'),
      ('project','disabled','${NOW}');
    INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','project','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items(
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at
    ) VALUES ('work','mission','Work','','in_progress','executor',1,'${NOW}','${NOW}');
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES
      ('result-1','project','mission','work',1,'execution-1','staged-1','journal-1',
       NULL,'executor','${NOW}'),
      ('result-2','project','mission','work',2,'execution-2','staged-2','journal-2',
       'result-1','reviewer-a','${NOW}');
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,state,version,updated_at
    ) VALUES ('work','project','mission','result-1',NULL,'pending_review',1,'${NOW}');
  `);
}

function list(resultId = "result-1"): QualificationResult {
  expect(
    qualification.listReviewCandidatesTx,
    "review qualification must be a reusable service",
  ).toBeTypeOf("function");
  return qualification.listReviewCandidatesTx!(database, "work", resultId);
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  seed();
});

afterEach(() => {
  database.close();
});

describe("review candidate qualification", () => {
  it("defaults existing v6 Agent rows to incapable and rejects non-boolean owner input", () => {
    database.exec(`
      INSERT INTO agents(
        id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
        can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,updated_at
      ) VALUES (
        'legacy-default','Legacy','Review','Review','provider','model','L','slate',
        1,0,0,1000,2,1,'${NOW}','${NOW}'
      )
    `);
    expect(database.prepare(
      "SELECT review_capable AS reviewCapable FROM agents WHERE id='legacy-default'",
    ).get()).toEqual({ reviewCapable: 0 });
    expect(agentInputSchema.safeParse({
      accentToken: "slate",
      avatarText: "R",
      maxHandoffs: 2,
      maxTokens: 1000,
      model: "model",
      name: "Reviewer",
      permissions: { readFiles: true, runCommands: false, writeFiles: false },
      providerId: "provider",
      reviewCapable: "true",
      role: "Review",
      skillIds: [],
      systemPrompt: "Review",
    }).success).toBe(false);
  });

  it("returns multiple current capable non-executors with auditable reasons and no selection", () => {
    expect(list()).toMatchObject({
      blockers: [],
      candidates: [
        {
          agent: { id: "reviewer-a" },
          qualification: ["current_member", "review_capable", "not_executor"],
        },
        {
          agent: { id: "reviewer-b" },
          qualification: ["current_member", "review_capable", "not_executor"],
        },
      ],
      selectedReviewerAgentId: null,
    });
  });

  it("never selects the sole candidate and reports the zero-candidate blocker", () => {
    database.prepare("DELETE FROM project_memberships WHERE agent_id='reviewer-b'").run();
    expect(list()).toMatchObject({
      blockers: [],
      candidates: [{ agent: { id: "reviewer-a" } }],
      selectedReviewerAgentId: null,
    });

    database.prepare("UPDATE agents SET review_capable=0 WHERE id='reviewer-a'").run();
    expect(list()).toEqual({
      blockers: [{ code: "NO_INDEPENDENT_REVIEWER" }],
      candidates: [],
      selectedReviewerAgentId: null,
    });
  });

  it("recomputes after membership, capability, and executor changes", () => {
    database.prepare("DELETE FROM project_memberships WHERE agent_id='reviewer-a'").run();
    database.prepare("UPDATE agents SET review_capable=0 WHERE id='reviewer-b'").run();
    expect(list().candidates).toEqual([]);

    database.prepare("UPDATE agents SET review_capable=1 WHERE id='reviewer-b'").run();
    database.prepare(`
      UPDATE work_item_review_heads
      SET current_result_id='result-2',version=version+1
      WHERE work_item_id='work'
    `).run();
    expect(list("result-2").candidates.map(({ agent }) => agent.id)).toEqual([
      "executor",
      "reviewer-b",
    ]);
  });

  it("rejects stale or non-current result ids instead of authorizing from a cached list", () => {
    expect(() => list("result-2")).toThrowError(
      expect.objectContaining({ code: "REVIEW_STATE_CONFLICT" }),
    );
  });
});
