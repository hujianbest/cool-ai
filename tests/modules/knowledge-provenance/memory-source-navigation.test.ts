

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { listMemoriesInDatabase } from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { createWorkItem } from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
import { createMission } from "@/src/composition/mission-commands";
import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type SourceResolverModule = {
  resolveMemorySource(
    database: DatabaseSync,
    input: {
      confirmingReviewAttemptId: string;
      id: string;
      projectId: string;
      type: string;
      version: string;
    },
  ): { href: string; id: string; type: string; version: string };
};
const resolverModules = import.meta.glob<SourceResolverModule>(
  "../../../src/adapters/outbound/sqlite/knowledge-provenance/memory-source-resolver.ts",
);

const NOW = "2026-08-01T09:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let databasePath: string;
let database: DatabaseSync;

function expectInvalid(operation: () => unknown): void {
  try {
    operation();
    throw new Error("expected invalid source");
  } catch (error) {
    expect(error).toMatchObject({ code: "INVALID_SOURCE", httpStatus: 400 });
    expect(String((error as Error).message)).not.toContain("foreign-secret");
  }
}

async function resolver(): Promise<SourceResolverModule["resolveMemorySource"]> {
  const load = resolverModules["../../../src/adapters/outbound/sqlite/knowledge-provenance/memory-source-resolver.ts"];
  expect(load, "the memory source resolver module must exist").toBeTypeOf("function");
  return (await load()).resolveMemorySource;
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  const project = createProject("Sources", databasePath);
  const mission = createMission(databasePath, project.id, {
    expectedVersion: 0,
    goal: "Goal",
    operationId: "16000000-0000-4000-8000-000000000113",
    title: "Mission",
  });
  const workItem = createWorkItem(databasePath, mission.id, {
    assigneeAgentId: null,
    dependencyIds: [],
    description: "",
    title: "Task",
  });
  database = openDatabase(databasePath);
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    UPDATE work_items SET version=3 WHERE id='${workItem.id}';
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES ('result-1','${project.id}','${mission.id}','${workItem.id}',2,
      'execution-1','staged-1','journal-1',NULL,'agent-1','${NOW}');
    INSERT INTO review_operations(
      id,project_id,kind,parent_id,request_hash,status,http_status,response_json,
      created_at,updated_at
    ) VALUES ('operation-1','${project.id}','start_review','${workItem.id}',
      '${HASH_A}','pending',NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO review_attempts(
      id,project_id,mission_id,work_item_id,result_id,reviewer_agent_id,
      operation_id,status,lease_token,lease_expires_at,frozen_material_json,
      frozen_material_hash,prompt_hash,provider_id,provider_version,
      credential_generation,verified_at,model,parsed_output_json,
      parsed_output_hash,output_checkpointed_at,finalize_error_code,error_category,
      started_at,finished_at
    ) VALUES ('attempt-1','${project.id}','${mission.id}','${workItem.id}',
      'result-1','reviewer-1','operation-1','calling','lease',
      '2026-08-01T09:02:00.000Z',
      '{"sourceRefs":[
        {"type":"task","id":"${workItem.id}","version":"3"},
        {"type":"result","id":"result-1","version":"2"},
        {"type":"review","id":"attempt-1","version":"1"},
        {"type":"validation","id":"validation-1","version":"${HASH_A}"},
        {"type":"artifact","id":"artifact-1","version":"${HASH_B}"},
        {"type":"execution","id":"execution-event-1","version":"1"}
      ]}',
      '${HASH_A}','${HASH_B}','provider-1',1,1,'${NOW}','model',
      NULL,NULL,NULL,NULL,NULL,'${NOW}',NULL);
    INSERT INTO execution_validation_results(
      id,project_id,execution_id,attempt_id,policy_revision_id,policy_entry_id,
      tool_call_id,sandbox_manifest_hash,required,exit_code,succeeded,stdout_bytes,
      stderr_bytes,stdout_sha256,stderr_sha256,stdout_truncated,stderr_truncated,
      finished_at
    ) VALUES ('validation-1','${project.id}','execution-1','execution-attempt-1',
      'policy-1','entry-1','tool-1','${HASH_A}',1,0,1,0,0,'${HASH_A}','${HASH_A}',
      0,0,'${NOW}');
    INSERT INTO execution_artifacts(
      id,project_id,execution_id,attempt_id,name,path,content_bytes,sha256,truncated,
      created_at
    ) VALUES ('artifact-1','${project.id}','execution-1','execution-attempt-1',
      'artifact','artifact.txt',0,'${HASH_B}',0,'${NOW}');
    INSERT INTO agents(
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,
      created_at,updated_at,review_capable
    ) VALUES ('reviewer-1','Reviewer','Reviewer','Review','provider-1','model',
      'R','sage',1,0,0,1000,2,1,'${NOW}','${NOW}',1);
    INSERT INTO review_decisions(
      id,attempt_id,result_id,reviewer_agent_id,choice,public_summary,findings_json,
      evidence_refs_json,limitations_json,created_at
    ) VALUES ('decision-1','attempt-1','result-1','reviewer-1','pass','Approved',
      '[]','[]','[]','${NOW}');
    INSERT INTO memory_entries(
      id,project_id,chain_id,version,type,content,dedupe_hash,source_type,source_id,
      source_version,proposer_actor_type,proposer_actor_id,
      confirming_review_attempt_id,persistence_actor,supersedes_id,created_at
    ) VALUES ('memory-agent','${project.id}','memory-agent',1,'fact','Reviewed fact',
      '${HASH_A}','result','result-1','2','agent','reviewer-1','attempt-1',
      'platform',NULL,'${NOW}');
  `);
  database.exec("PRAGMA foreign_keys=ON");
});

afterEach(() => {
  database.close();
});

describe("memory source resolver", () => {
  it("projects Agent proposer, pass confirmer, and platform persistence responsibility", () => {
    const projectId =
      (database.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string }).id;

    expect(listMemoriesInDatabase(database, projectId)).toContainEqual(
      expect.objectContaining({
        actor: {
          confirmer: { decisionId: "decision-1", reviewAttemptId: "attempt-1" },
          persistedBy: "platform",
          proposerAgent: {
            accentToken: "sage",
            avatarText: "R",
            id: "reviewer-1",
            name: "Reviewer",
          },
          proposerType: "agent",
        },
        source: {
          href: expect.stringContaining("/results/result-1?version=2"),
          id: "result-1",
          type: "result",
          version: "2",
        },
      }),
    );
  });

  it.each([
    ["task", "TASK", "3"],
    ["result", "RESULT", "2"],
    ["review", "REVIEW", "1"],
    ["validation", "VALIDATION", HASH_A],
    ["artifact", "ARTIFACT", HASH_B],
  ] as const)("resolves exact %s id/version to a versioned product href", async (type, token, version) => {
    const resolveMemorySource = await resolver();
    const source = resolveMemorySource(database, {
      confirmingReviewAttemptId: "attempt-1",
      id: type === "task"
        ? (database.prepare("SELECT id FROM work_items LIMIT 1").get() as { id: string }).id
        : type === "review"
        ? "attempt-1"
        : `${type}-1`,
      projectId: (database.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string }).id,
      type,
      version,
    });

    expect(source).toEqual({
      href: expect.stringMatching(new RegExp(`/${type === "task" ? "tasks" : token.toLowerCase()}`)),
      id: source.id,
      type,
      version,
    });
    expect(source.href).toContain(encodeURIComponent(source.id));
    expect(source.href).toContain(`version=${encodeURIComponent(version)}`);
  });

  it("fails closed for cross-project, drifted, unknown, and extra-field sources", async () => {
    const resolveMemorySource = await resolver();
    const projectId =
      (database.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string }).id;
    const base = {
      confirmingReviewAttemptId: "attempt-1",
      id: "result-1",
      projectId,
      type: "result",
      version: "2",
    } as const;

    expectInvalid(() => resolveMemorySource(database, { ...base, projectId: "foreign-secret" }));
    expectInvalid(() => resolveMemorySource(database, { ...base, version: "999" }));
    expectInvalid(() => resolveMemorySource(database, { ...base, type: "unknown" } as never));
    expectInvalid(() => resolveMemorySource(database, {
      ...base,
      leaked: "foreign-secret",
    } as never));
    expectInvalid(() => resolveMemorySource(database, {
      ...base,
      confirmingReviewAttemptId: "missing-attempt",
    }));
  });
});
