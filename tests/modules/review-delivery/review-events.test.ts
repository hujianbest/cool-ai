import { describe, expect, it } from "vitest";

const modules = import.meta.glob<Record<string, unknown>>(
  "../../../src/shared/review-contracts.ts",
);

const HASH = "a".repeat(64);
const NOW = "2026-08-01T09:00:00.000Z";

const fixtures = [
  ["review_candidates_evaluated", { blockerCode: null, candidateAgentIds: ["reviewer"], resultId: "result", workItemId: "work" }],
  ["review_started", { attemptId: "attempt", materialHash: HASH, resultId: "result", resultVersion: 1, reviewerAgentId: "reviewer", workItemId: "work" }],
  ["review_model_call_started", { attemptId: "attempt", kind: "primary", modelCallId: "call" }],
  ["review_model_call_succeeded", { attemptId: "attempt", kind: "primary", modelCallId: "call" }],
  ["review_model_call_failed", { attemptId: "attempt", category: "timeout", kind: "primary", modelCallId: "call" }],
  ["review_usage_recorded", { attemptId: "attempt", completionTokens: null, modelCallId: "call", promptTokens: null, reported: false, totalTokens: null }],
  ["review_output_checkpointed", { attemptId: "attempt", modelCallId: "call", publicOutputHash: HASH }],
  ["review_finalize_failed", { attemptId: "attempt", code: "REVIEW_FINALIZE_FAILED", publicOutputHash: HASH }],
  ["review_attempt_failed", { attemptId: "attempt", category: "schema" }],
  ["review_attempt_interrupted", { attemptId: "attempt", category: "interrupted" }],
  ["review_attempt_discarded", { attemptId: "attempt", category: "context_changed" }],
  ["review_decided", { attemptId: "attempt", choice: "pass", decisionId: "decision", resultId: "result" }],
  ["rework_requested", { decisionId: "decision", resultId: "result", workItemId: "work" }],
  ["escalation_opened", { decisionId: "decision", escalationId: "escalation", resultId: "result", workItemId: "work" }],
  ["escalation_answered", { action: "continue_review", answerId: "answer", escalationId: "escalation" }],
  ["result_version_created", { executionId: "execution", resultId: "result", resultVersion: 1, supersedesResultId: null, workItemId: "work" }],
  ["memory_reused", { candidateId: "candidate", decisionId: "decision", memoryId: "memory", memoryVersion: 1 }],
  ["memory_created", { candidateId: "candidate", decisionId: "decision", memoryId: "memory", memoryVersion: 1 }],
  ["memory_superseded", { candidateId: "candidate", decisionId: "decision", memoryId: "memory", memoryVersion: 2 }],
  ["work_item_passed", { decisionId: "decision", reasonCode: "review_passed", resultId: "result", workItemId: "work" }],
  ["work_item_invalidated", { decisionId: "decision", reasonCode: "DEPENDENCY_REOPENED", resultId: "result", workItemId: "work" }],
  ["legacy_work_item_review_passed", { headVersion: 1, workItemId: "work" }],
  ["legacy_work_item_completion_invalidated", { reasonCode: "OWNER_REOPENED", workItemId: "work" }],
  ["completion_write_rejected", { blockerCodes: ["REVIEW_REQUIRED"], entryPoint: "owner", workItemId: "work" }],
  ["delivery_generation_started", { inputFingerprint: HASH, operationId: "operation" }],
  ["delivery_generation_failed", { category: "generation_failed", inputFingerprint: HASH, operationId: "operation" }],
  ["delivery_completed", { deliveryId: "delivery", deliveryVersion: 1, inputFingerprint: HASH }],
  ["delivery_invalidated", { deliveryId: "delivery", reasonCode: "OWNER_REOPENED", workItemIds: ["work"] }],
  ["mission_review_initialized", { contextVersion: 1, headVersion: 1, missionId: "mission" }],
  ["mission_context_changed", { contextVersion: 2, missionId: "mission", missionVersion: 2, reasonCode: "MISSION_UPDATED" }],
  ["mission_terminated", { reason: "owner_terminated" }],
  ["operation_replayed", { kind: "start_review", operationId: "operation" }],
] as const;

describe("typed review events", () => {
  it("covers every designed event with an exact strict payload", async () => {
    const load = modules["../../../src/shared/review-contracts.ts"];
    expect(load).toBeTypeOf("function");
    const module = await load!() as {
      reviewEventDtoSchema?: {
        safeParse(value: unknown): { success: boolean };
      };
      reviewEventTypeSchema?: { options: string[] };
    };
    expect(module.reviewEventDtoSchema).toBeDefined();
    expect(module.reviewEventTypeSchema).toBeDefined();
    expect([...module.reviewEventTypeSchema!.options].sort()).toEqual(
      fixtures.map(([type]) => type).sort(),
    );
    fixtures.forEach(([type, payload], index) => {
      const event = {
        actorId: null,
        actorType: "system",
        createdAt: NOW,
        id: `event-${index}`,
        payload,
        sequence: index + 1,
        type,
      };
      expect(module.reviewEventDtoSchema!.safeParse(event).success, type).toBe(true);
      expect(module.reviewEventDtoSchema!.safeParse({
        ...event,
        payload: { ...payload, rawProviderBody: "Bearer secret" },
      }).success, `${type} extras`).toBe(false);
    });
  });

  it("rejects sequence, usage nullability, and unknown event drift", async () => {
    const load = modules["../../../src/shared/review-contracts.ts"];
    const module = await load!() as {
      reviewEventDtoSchema: { safeParse(value: unknown): { success: boolean } };
    };
    const envelope = {
      actorId: null,
      actorType: "system",
      createdAt: NOW,
      id: "event",
      sequence: 1,
    };
    expect(module.reviewEventDtoSchema.safeParse({
      ...envelope,
      payload: { completionTokens: 0, modelCallId: "call", promptTokens: null, reported: false, totalTokens: null, attemptId: "attempt" },
      type: "review_usage_recorded",
    }).success).toBe(false);
    expect(module.reviewEventDtoSchema.safeParse({
      ...envelope,
      payload: {},
      sequence: 0,
      type: "future_review_event",
    }).success).toBe(false);
  });
});
