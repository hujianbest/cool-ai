import { afterEach, describe, expect, it, vi } from "vitest";

const answerEscalation = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn());
const openDatabase = vi.hoisted(() => vi.fn(() => ({ close })));
const readReviewWorkspace = vi.hoisted(() => vi.fn());

vi.mock("@/src/adapters/outbound/sqlite/connection", () => ({ openDatabase }));
vi.mock("@/src/server/review/review-escalation-service", () => ({
  answerEscalation,
}));
vi.mock("@/src/server/review/review-read-service", () => ({
  readReviewWorkspace,
}));

type AnswerRoute = {
  POST(request: Request, context: {
    params: Promise<{ escalationId: string }>;
  }): Promise<Response>;
};

const routeModules = import.meta.glob<AnswerRoute>(
  "../app/api/escalations/[escalationId]/answer/route.ts",
);

const body = {
  action: "continue_review",
  answer: "请结合补充说明继续复核。",
  expectedHeadVersion: 8,
  operationId: "26000000-0000-4000-8000-000000000001",
};

async function route(): Promise<AnswerRoute> {
  const load = routeModules[
    "../app/api/escalations/[escalationId]/answer/route.ts"
  ];
  expect(load, "strict escalation answer route must exist").toBeTypeOf("function");
  return load!();
}

async function post(value: unknown, escalationId = "escalation-1"): Promise<Response> {
  const { POST } = await route();
  return POST(new Request(
    `http://localhost/api/escalations/${escalationId}/answer`,
    {
      body: JSON.stringify(value),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  ), { params: Promise.resolve({ escalationId }) });
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.COCKPIT_DB_PATH;
});

describe("POST /api/escalations/:escalationId/answer", () => {
  it("strictly parses public input, calls the atomic service, and returns strict workspace plus answer", async () => {
    process.env.COCKPIT_DB_PATH = "answer-route.sqlite";
    answerEscalation.mockReturnValue({
      action: "continue_review",
      answer: body.answer,
      answerId: "answer-1",
      escalationId: "escalation-1",
      next: "new_review_attempt",
      resultId: "result-1",
      state: "pending_review",
      workItemId: "work-1",
    });
    readReviewWorkspace.mockReturnValue({
      answeredEscalations: [{
        answer: {
          action: "continue_review",
          answer: body.answer,
          answerId: "answer-1",
          answerVersion: 1,
          createdAt: "2026-08-01T09:00:00.000Z",
        },
        attemptId: "attempt-1",
        escalationId: "escalation-1",
        resultId: "result-1",
      }],
      blockers: [],
      candidates: [],
      currentAttempt: null,
      currentEscalation: null,
      effectiveStatus: "pending_review",
      headVersion: 9,
      historyCount: 1,
      result: {
        createdAt: "2026-08-01T08:00:00.000Z",
        executorAgentId: "executor",
        id: "result-1",
        source: {
          contextHash: "a".repeat(64),
          projectId: "project-1",
          runId: "run-1",
          threadId: "thread-1",
        },
        version: 1,
      },
      workItem: {
        boardStatus: "in_progress",
        id: "work-1",
        title: "Work",
        version: 1,
      },
    });

    const response = await post(body);

    expect(response.status).toBe(200);
    expect(answerEscalation).toHaveBeenCalledWith(
      expect.anything(),
      "escalation-1",
      body,
      { actorType: "owner" },
    );
    expect(readReviewWorkspace).toHaveBeenCalledWith(
      "answer-route.sqlite",
      "work-1",
    );
    expect(await response.json()).toEqual({
      answer: expect.objectContaining({
        action: "continue_review",
        answerId: "answer-1",
        escalationId: "escalation-1",
      }),
      workspace: expect.objectContaining({
        answeredEscalations: [expect.objectContaining({
          escalationId: "escalation-1",
        })],
        currentEscalation: null,
      }),
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    [{ ...body, actorType: "owner" }],
    [{ ...body, attemptId: "forged-attempt" }],
    [{ ...body, resultId: "forged-result" }],
    [{ ...body, answer: "" }],
    [{ ...body, action: "pass" }],
    [{ ...body, expectedHeadVersion: 0 }],
    [{ ...body, operationId: "not-a-uuid" }],
  ])("rejects unknown, forged, or invalid input without opening storage", async (value) => {
    const response = await post(value);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_INPUT", message: "输入不符合约束" },
    });
    expect(openDatabase).not.toHaveBeenCalled();
    expect(answerEscalation).not.toHaveBeenCalled();
  });

  it("maps invalid JSON and atomic service errors through the shared registry", async () => {
    const { POST } = await route();
    const invalidJson = await POST(new Request(
      "http://localhost/api/escalations/escalation-1/answer",
      { body: "{", method: "POST" },
    ), { params: Promise.resolve({ escalationId: "escalation-1" }) });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({
      error: { code: "INVALID_JSON", message: "请求格式无效" },
    });

    answerEscalation.mockImplementation(() => {
      throw Object.assign(new Error("private storage detail"), {
        code: "REVIEW_STATE_CONFLICT",
      });
    });
    const stale = await post(body);
    expect(stale.status).toBe(409);
    const stalePayload = await stale.json();
    expect(stalePayload).toEqual({
      error: { code: "REVIEW_STATE_CONFLICT", message: "复核状态已变化" },
    });
    expect(JSON.stringify(stalePayload)).not.toContain("private storage detail");
  });
});
