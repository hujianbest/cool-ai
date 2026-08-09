import { describe, expect, it } from "vitest";

const contractModules = import.meta.glob<Record<string, unknown>>(
  "../../../src/shared/review-contracts.ts",
);
const readModules = import.meta.glob<Record<string, unknown>>(
  "../../../src/adapters/outbound/sqlite/review-delivery/review-read-service.ts",
);
const routeModules = import.meta.glob<Record<string, unknown>>([
  "../../../app/api/work-items/[workItemId]/review/route.ts",
  "../../../app/api/work-items/[workItemId]/reviews/route.ts",
  "../../../app/api/reviews/[attemptId]/route.ts",
  "../../../app/api/missions/[missionId]/review-events/route.ts",
]);

const HASH = "a".repeat(64);
const NOW = "2026-08-01T09:00:00.000Z";

function baseAttempt(overrides: Record<string, unknown> = {}) {
  return {
    calls: [],
    decision: null,
    errorCategory: null,
    finalize: {
      checkpoint: null,
      lastErrorCode: null,
      mode: "none",
      retryRequiresProvider: false,
    },
    id: "attempt",
    material: { hash: HASH, resultVersion: 1, sourceCount: 0 },
    provider: { id: "provider", model: "model", name: "Provider", version: 1 },
    result: { id: "result", version: 1 },
    reviewer: { accentToken: "slate", avatarText: "R", id: "reviewer", name: "Reviewer" },
    startedAt: NOW,
    finishedAt: null,
    status: "calling",
    usageTotal: {
      completionTokens: 0,
      promptTokens: 0,
      repairCalls: 0,
      reportedCalls: 0,
      totalTokens: 0,
      unreportedCalls: 0,
    },
    ...overrides,
  };
}

async function contracts() {
  const load = contractModules["../../../src/shared/review-contracts.ts"];
  expect(load).toBeTypeOf("function");
  const module = await load!();
  expect(module.reviewAttemptDtoSchema).toBeDefined();
  expect(module.reviewAttemptDetailDtoSchema).toBeDefined();
  expect(module.reviewWorkspaceDtoSchema).toBeDefined();
  return module as {
    reviewAttemptDtoSchema: { safeParse(value: unknown): { success: boolean } };
    reviewAttemptDetailDtoSchema: { safeParse(value: unknown): { success: boolean } };
  };
}

describe("strict review read API", () => {
  it("shares one strict attempt union across workspace, history, and detail", async () => {
    const { reviewAttemptDtoSchema, reviewAttemptDetailDtoSchema } = await contracts();
    const checkpoint = { checkpointedAt: NOW, publicOutputHash: HASH };
    const cases = [
      baseAttempt(),
      baseAttempt({
        finalize: {
          checkpoint,
          lastErrorCode: null,
          mode: "local-finalize-only",
          retryRequiresProvider: false,
        },
      }),
      baseAttempt({
        finalize: {
          checkpoint,
          lastErrorCode: "REVIEW_FINALIZE_FAILED",
          mode: "local-finalize-only",
          retryRequiresProvider: false,
        },
        status: "finalizing",
      }),
      baseAttempt({
        finalize: {
          checkpoint: null,
          lastErrorCode: "PROVIDER_TIMEOUT",
          mode: "new-provider-attempt",
          retryRequiresProvider: true,
        },
        finishedAt: NOW,
        status: "failed",
      }),
      baseAttempt({
        finalize: {
          checkpoint: null,
          lastErrorCode: "STORAGE_UNAVAILABLE",
          mode: "new-provider-attempt",
          retryRequiresProvider: true,
        },
        finishedAt: NOW,
        status: "interrupted",
      }),
      baseAttempt({
        decision: {
          choice: "pass",
          evidenceRefs: [],
          findings: [],
          id: "decision",
          publicSummary: "通过",
        },
        finalize: {
          checkpoint,
          lastErrorCode: null,
          mode: "none",
          retryRequiresProvider: false,
        },
        finishedAt: NOW,
        status: "passed",
      }),
    ];
    for (const value of cases) {
      expect(reviewAttemptDtoSchema.safeParse(value).success, value.status).toBe(true);
      expect(reviewAttemptDtoSchema.safeParse({ ...value, unexpected: "secret" }).success)
        .toBe(false);
      expect(reviewAttemptDetailDtoSchema.safeParse({
        ...value,
        answeredEscalations: [],
        candidateAssociations: [],
        currentEscalation: null,
        frozenMaterial: { sourceRefs: [] },
      }).success).toBe(true);
    }
  });

  it("rejects every unsafe checkpoint/retry/decision combination fail closed", async () => {
    const { reviewAttemptDtoSchema } = await contracts();
    const checkpoint = { checkpointedAt: NOW, publicOutputHash: HASH };
    const illegal = [
      baseAttempt({
        finalize: {
          checkpoint: null,
          lastErrorCode: null,
          mode: "new-provider-attempt",
          retryRequiresProvider: true,
        },
        status: "finalizing",
      }),
      baseAttempt({
        finalize: {
          checkpoint,
          lastErrorCode: null,
          mode: "local-finalize-only",
          retryRequiresProvider: false,
        },
        status: "interrupted",
      }),
      baseAttempt({
        decision: null,
        finalize: {
          checkpoint,
          lastErrorCode: null,
          mode: "none",
          retryRequiresProvider: false,
        },
        status: "passed",
      }),
    ];
    for (const value of illegal) {
      expect(reviewAttemptDtoSchema.safeParse(value).success).toBe(false);
    }
  });

  it("keeps primary and repair call usage/failure nullable and fully discriminated", async () => {
    const { reviewAttemptDtoSchema } = await contracts();
    const valid = baseAttempt({
      calls: [
        {
          callIndex: 1,
          failure: null,
          finishedAt: null,
          id: "primary",
          kind: "primary",
          startedAt: NOW,
          status: "calling",
          usage: {
            completionTokens: null,
            promptTokens: null,
            reported: false,
            totalTokens: null,
          },
        },
        {
          callIndex: 2,
          failure: {
            apiErrorCode: "STRUCTURED_OUTPUT_INVALID",
            category: "schema",
          },
          finishedAt: NOW,
          id: "repair",
          kind: "repair",
          startedAt: NOW,
          status: "response_invalid",
          usage: {
            completionTokens: 2,
            promptTokens: 3,
            reported: true,
            totalTokens: 5,
          },
        },
      ],
      usageTotal: {
        completionTokens: 2,
        promptTokens: 3,
        repairCalls: 1,
        reportedCalls: 1,
        totalTokens: 5,
        unreportedCalls: 1,
      },
    });
    expect(reviewAttemptDtoSchema.safeParse(valid).success).toBe(true);
    expect(reviewAttemptDtoSchema.safeParse({
      ...valid,
      calls: [{
        ...(valid.calls as Array<Record<string, unknown>>)[0],
        usage: {
          completionTokens: 0,
          promptTokens: null,
          reported: false,
          totalTokens: null,
        },
      }],
    }).success).toBe(false);
  });

  it("publishes bounded route-scoped history/detail/event reads", async () => {
    for (const path of [
      "../../../app/api/work-items/[workItemId]/review/route.ts",
      "../../../app/api/work-items/[workItemId]/reviews/route.ts",
      "../../../app/api/reviews/[attemptId]/route.ts",
      "../../../app/api/missions/[missionId]/review-events/route.ts",
    ]) {
      expect(routeModules[path], `${path} must exist`).toBeTypeOf("function");
    }
    const load = readModules["../../../src/adapters/outbound/sqlite/review-delivery/review-read-service.ts"];
    expect(load).toBeTypeOf("function");
    const module = await load!();
    expect(module.listReviewAttempts).toBeTypeOf("function");
    expect(module.readReviewAttemptDetail).toBeTypeOf("function");
    expect(module.listReviewEvents).toBeTypeOf("function");
  });
});
