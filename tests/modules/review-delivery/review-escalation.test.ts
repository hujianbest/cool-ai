import { createHash } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { finalizeCheckpointedReview } from "@/src/adapters/outbound/sqlite/review-delivery/review-finalizer";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type EscalationService = {
  answerEscalation?: (
    database: DatabaseSync,
    escalationId: string,
    input: {
      action: "continue_review" | "rework" | "terminate_mission";
      answer: string;
      expectedHeadVersion: number;
      operationId: string;
    },
    dependencies?: {
      actorType?: "owner" | "agent";
      clock?: () => Date;
      randomUUID?: () => string;
    },
  ) => any;
};

const serviceModules = import.meta.glob<EscalationService>(
  "../../../src/adapters/outbound/sqlite/review-delivery/review-escalation-service.ts",
);

const NOW = "2026-08-01T08:00:00.000Z";
let database: DatabaseSync;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function seed(): string {
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec(`
    INSERT INTO projects(id,name,created_at,version)
    VALUES ('project','Escalation','${NOW}',1);
    INSERT INTO providers(
      id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
      credential_version,credential_generation,key_id,api_key_mask,verified_at,
      version,created_at,updated_at
    ) VALUES ('provider','Provider','https://provider.invalid/v1','model',
      'cipher','iv','tag',1,1,'key','mask','${NOW}',1,'${NOW}','${NOW}');
    INSERT INTO agents(
      id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
      can_read,can_write,can_execute,max_tokens,max_handoffs,version,
      created_at,updated_at,review_capable
    ) VALUES
      ('executor','Executor','Builder','Build','provider','model','E','sage',
       1,1,1,1000,2,1,'${NOW}','${NOW}',0),
      ('reviewer','Reviewer','Reviewer','Review','provider','model','R','slate',
       1,0,0,1000,2,1,'${NOW}','${NOW}',1);
    INSERT INTO project_memberships(project_id,agent_id,joined_at)
    VALUES ('project','executor','${NOW}'),('project','reviewer','${NOW}');
    INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
    VALUES ('mission','project','Mission','Goal',1,'${NOW}','${NOW}');
    INSERT INTO work_items(
      id,mission_id,title,description,status,assignee_agent_id,version,created_at,updated_at,
      lease_token,lease_expires_at,last_heartbeat_at
    ) VALUES ('work','mission','Work','','in_progress','executor',4,'${NOW}','${NOW}','work-lease','2099-01-01T00:00:00.000Z','${NOW}');
    INSERT INTO work_item_result_versions(
      id,project_id,mission_id,work_item_id,version,execution_id,staged_result_id,
      merge_journal_id,supersedes_result_id,executor_agent_id,created_at
    ) VALUES ('result','project','mission','work',1,'execution','staged','journal',
      NULL,'executor','${NOW}');
    INSERT INTO review_operations(
      id,project_id,kind,parent_id,request_hash,status,http_status,response_json,
      created_at,updated_at
    ) VALUES ('review-operation','project','start_review','work','${"a".repeat(64)}',
      'pending',NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO review_attempts(
      id,project_id,mission_id,work_item_id,result_id,reviewer_agent_id,
      operation_id,status,lease_token,lease_expires_at,frozen_material_json,
      frozen_material_hash,prompt_hash,provider_id,provider_version,
      credential_generation,verified_at,model,parsed_output_json,
      parsed_output_hash,output_checkpointed_at,finalize_error_code,error_category,
      started_at,finished_at
    ) VALUES ('attempt','project','mission','work','result','reviewer','review-operation',
      'calling','lease','2026-08-01T08:02:00.000Z','{"sourceRefs":[]}',
      '${"b".repeat(64)}','${"c".repeat(64)}','provider',1,1,'${NOW}','model',
      NULL,NULL,NULL,NULL,NULL,'${NOW}',NULL);
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
      state,version,updated_at
    ) VALUES ('work','project','mission','result','attempt','reviewing',7,'${NOW}');
    INSERT INTO mission_delivery_heads(
      mission_id,project_id,context_version,state,current_delivery_id,current_operation_id,
      generation_lease_token,generation_lease_expires_at,last_error_code,
      next_event_sequence,version,updated_at
    ) VALUES ('mission','project',1,'ongoing',NULL,NULL,NULL,NULL,NULL,2,1,'${NOW}');
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES ('initial','project','mission',1,'mission_review_initialized',
      'system',NULL,'{}','${NOW}');
  `);
  database.exec("PRAGMA foreign_keys=ON");
  const json = JSON.stringify(canonicalize({
    decision: { choice: "escalate", options: ["继续检查", "要求补证"], question: "如何处理？" },
    evidenceRefs: [],
    findings: [],
    limitations: [],
    memoryCandidates: [],
    publicSummary: "需要 Owner 决策",
  }));
  const hash = createHash("sha256").update(json).digest("hex");
  database.prepare(`
    UPDATE review_attempts
    SET status='finalizing',parsed_output_json=?,parsed_output_hash=?,output_checkpointed_at=?
    WHERE id='attempt'
  `).run(json, hash, NOW);
  return hash;
}

function finalizeEscalation(hash: string) {
  const response = finalizeCheckpointedReview(database, {
    attemptId: "attempt",
    checkpointHash: hash,
  }, {
    clock: () => new Date(NOW),
    randomUUID: (() => {
      let value = 0;
      return () => `escalation-${++value}`;
    })(),
  });
  if (response.state !== "escalated") {
    throw new Error(`Expected escalated review, received ${response.state}`);
  }
  return response;
}

async function escalationService(): Promise<EscalationService> {
  const load = serviceModules["../../../src/adapters/outbound/sqlite/review-delivery/review-escalation-service.ts"];
  expect(load, "T-10 escalation service must exist").toBeTypeOf("function");
  return load!();
}

beforeEach(() => {
  database = openDatabase(memoryDatabasePath());
});

afterEach(() => {
  database.close();
});

describe("review escalation issue and owner answer", () => {
  it("finalizes one immutable open issue and never passes the original attempt", () => {
    const hash = seed();
    const response = finalizeEscalation(hash);

    expect(response).toMatchObject({ state: "escalated", retry: { kind: "none" } });
    expect(database.prepare(`
      SELECT a.status,d.choice,h.state,h.current_attempt_id AS currentAttempt,
             (SELECT COUNT(*) FROM review_escalations) AS issues
      FROM review_attempts a
      JOIN review_decisions d ON d.attempt_id=a.id
      JOIN work_item_review_heads h ON h.work_item_id=a.work_item_id
      WHERE a.id='attempt'
    `).get()).toEqual({
      choice: "escalate",
      currentAttempt: null,
      issues: 1,
      state: "waiting_owner",
      status: "escalated",
    });
    expect(() => finalizeEscalation(hash)).not.toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_escalations").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_decisions WHERE choice='pass'").get())
      .toEqual({ count: 0 });
    expect(() => database.prepare(
      "UPDATE review_attempts SET status='passed' WHERE id='attempt'",
    ).run()).toThrow(/IMMUTABLE_REVIEW_ATTEMPT/u);
  });

  it("continues idempotently on the same result and requires a fresh attempt", async () => {
    const hash = seed();
    const issue = finalizeEscalation(hash);
    const service = await escalationService();
    expect(service.answerEscalation).toBeTypeOf("function");
    const input = {
      action: "continue_review" as const,
      answer: "沿用当前结果，按补充说明重新复核。",
      expectedHeadVersion: 8,
      operationId: "70000000-0000-4000-8000-000000000001",
    };
    const first = service.answerEscalation!(
      database,
      issue.escalationId,
      input,
      { actorType: "owner", clock: () => new Date(NOW), randomUUID: () => "answer-1" },
    );
    const replay = service.answerEscalation!(
      database,
      issue.escalationId,
      input,
      { actorType: "owner", clock: () => new Date(NOW), randomUUID: () => "ignored" },
    );

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      action: "continue_review",
      next: "new_review_attempt",
      resultId: "result",
      state: "pending_review",
    });
    expect(database.prepare(`
      SELECT h.current_result_id AS resultId,h.current_attempt_id AS currentAttempt,
             h.state,(SELECT COUNT(*) FROM review_escalation_answers) AS answers,
             (SELECT COUNT(*) FROM review_attempts) AS attempts,
             (SELECT COUNT(*) FROM review_decisions WHERE choice='pass') AS passes
      FROM work_item_review_heads h WHERE h.work_item_id='work'
    `).get()).toEqual({
      answers: 1,
      attempts: 1,
      currentAttempt: null,
      passes: 0,
      resultId: "result",
      state: "pending_review",
    });
    expect(() => database.prepare(
      "UPDATE review_escalation_answers SET action='rework' WHERE id='answer-1'",
    ).run()).toThrow(/IMMUTABLE_ESCALATION_ANSWER/u);
  });

  it.each([
    ["rework", "rework", "new_execution_result"],
    ["terminate_mission", "waiting_owner", "mission_terminated"],
  ] as const)("applies owner action %s without forging pass", async (action, expectedState, next) => {
    const hash = seed();
    const issue = finalizeEscalation(hash);
    const service = await escalationService();
    let generatedId = 0;
    const result = service.answerEscalation!(
      database,
      issue.escalationId,
      {
        action,
        answer: action === "rework" ? "补齐证据后返工。" : "由 Owner 终止使命。",
        expectedHeadVersion: 8,
        operationId: `70000000-0000-4000-8000-${action === "rework" ? "000000000002" : "000000000003"}`,
      },
      {
        actorType: "owner",
        clock: () => new Date(NOW),
        randomUUID: () => `answer-${++generatedId}`,
      },
    );

    expect(result).toMatchObject({ action, next });
    expect(database.prepare(
      "SELECT state FROM work_item_review_heads WHERE work_item_id='work'",
    ).get()).toEqual({ state: expectedState });
    expect(database.prepare(
      "SELECT state,current_delivery_id AS delivery FROM mission_delivery_heads WHERE mission_id='mission'",
    ).get()).toEqual({
      delivery: null,
      state: action === "terminate_mission" ? "owner_terminated" : "ongoing",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_decisions WHERE choice='pass'").get())
      .toEqual({ count: 0 });
  });

  it("allows only the owner and keeps one winner across different operations", async () => {
    const hash = seed();
    const issue = finalizeEscalation(hash);
    const service = await escalationService();
    const base = {
      action: "continue_review" as const,
      answer: "继续。",
      expectedHeadVersion: 8,
      operationId: "70000000-0000-4000-8000-000000000004",
    };
    expect(() => service.answerEscalation!(
      database,
      issue.escalationId,
      base,
      { actorType: "agent" },
    )).toThrowError(expect.objectContaining({ code: "OWNER_REQUIRED" }));

    const winner = service.answerEscalation!(
      database,
      issue.escalationId,
      base,
      { actorType: "owner", randomUUID: () => "winner" },
    );
    const loser = service.answerEscalation!(
      database,
      issue.escalationId,
      { ...base, action: "rework", operationId: "70000000-0000-4000-8000-000000000005" },
      { actorType: "owner", randomUUID: () => "loser" },
    );
    expect(loser).toEqual(winner);
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_escalation_answers").get())
      .toEqual({ count: 1 });
  });
});
