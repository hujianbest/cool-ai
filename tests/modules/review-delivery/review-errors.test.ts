import { describe, expect, it } from "vitest";

const modules = import.meta.glob<Record<string, unknown>>(
  "../../../src/modules/review-delivery/public/errors.ts",
);

const expected = {
  CREDENTIAL_UNAVAILABLE: [503, "复核凭据暂不可用", null],
  DELIVERY_CONTEXT_CHANGED: [409, "使命上下文已变化，请基于最新内容重试", "delivery_invalidated"],
  DELIVERY_INTERRUPTED: [409, "交付生成已中断，请显式重试", "delivery_generation_failed"],
  DELIVERY_INVARIANT_FAILED: [500, "交付数据不一致", "delivery_generation_failed"],
  DELIVERY_NOT_FOUND: [404, "未找到对应的交付", null],
  DELIVERY_RESPONSE_LIMIT_EXCEEDED: [413, "交付摘要超过既有限制", "delivery_generation_failed"],
  ESCALATION_ALREADY_ANSWERED: [409, "该升级问题已被回答", "escalation_answered"],
  ESCALATION_NOT_FOUND: [404, "未找到对应的升级", null],
  INTERNAL_ERROR: [500, "发生内部错误", null],
  INVALID_INPUT: [400, "输入不符合约束", null],
  INVALID_JSON: [400, "请求格式无效", null],
  LEGACY_DONE_UNREVIEWED: [409, "旧完成状态未经独立复核", "completion_write_rejected"],
  MEMORY_NOT_ACTIVE: [409, "被取代的记忆不能再次取代", "review_finalize_failed"],
  MEMORY_SOURCE_INVALID: [422, "记忆来源无效", "review_finalize_failed"],
  MEMORY_SUPERSEDES_INVALID: [422, "记忆版本关系无效", "review_finalize_failed"],
  MEMORY_TYPE_MISMATCH: [409, "记忆类型不匹配", "review_finalize_failed"],
  MISSION_COMPLETION_BLOCKED: [409, "使命尚未满足最终完成条件", null],
  MISSION_CONTEXT_CHANGED: [409, "使命上下文已变化，请基于最新内容重试", "review_attempt_discarded"],
  NO_INDEPENDENT_REVIEWER: [409, "缺少可用的独立复核 Agent", "review_candidates_evaluated"],
  OPERATION_CONFLICT: [409, "操作标识与原请求冲突", null],
  OPERATION_IN_PROGRESS: [409, "操作仍在进行", "operation_replayed"],
  OWNER_REQUIRED: [403, "仅 Owner 可执行此操作", null],
  PROJECT_NOT_FOUND: [404, "未找到对应的项目", null],
  PROVIDER_AUTH: [401, "Provider 身份验证失败，请检查配置。", "review_model_call_failed"],
  PROVIDER_RESPONSE_INVALID: [502, "Provider 返回了无效响应。", "review_model_call_failed"],
  PROVIDER_TIMEOUT: [504, "Provider 请求超时，请稍后重试。", "review_model_call_failed"],
  PROVIDER_UNREACHABLE: [502, "当前无法连接 Provider。", "review_model_call_failed"],
  PROVIDER_UPSTREAM: [502, "Provider 服务暂时异常。", "review_model_call_failed"],
  RATE_LIMITED: [429, "Provider 请求过于频繁，请稍后重试。", "review_model_call_failed"],
  REQUEST_LIMIT_EXCEEDED: [413, "请求超过既有限制", null],
  RESPONSE_LIMIT_EXCEEDED: [413, "响应超过既有限制", null],
  RESULT_NOT_FOUND: [404, "未找到对应的结果", null],
  RESULT_SUPERSEDED: [409, "结果版本已被取代", "review_attempt_discarded"],
  REVIEW_ALREADY_IN_PROGRESS: [409, "已有复核正在进行", null],
  REVIEW_CONTENT_INCOMPLETE: [422, "复核材料正文不完整，不能通过", "review_finalize_failed"],
  REVIEW_CONTEXT_STALE: [409, "复核上下文已变化，请基于最新内容重试", null],
  REVIEW_FINALIZE_FAILED: [500, "复核结果已保存，但本地提交失败；重试不会再次调用模型", "review_finalize_failed"],
  REVIEW_INVARIANT_FAILED: [500, "复核数据不一致", "review_finalize_failed"],
  REVIEW_MATERIAL_INVALID: [422, "公开复核材料无效", "review_attempt_failed"],
  REVIEW_MATERIAL_LIMIT_EXCEEDED: [413, "公开复核材料超过既有限制", "review_attempt_failed"],
  REVIEW_NOT_FOUND: [404, "未找到对应的复核", null],
  REVIEW_OUTPUT_REDACTED: [422, "复核公开输出包含不可持久化内容", "review_model_call_failed"],
  REVIEW_REQUIRED: [409, "任务尚未通过独立复核", "completion_write_rejected"],
  REVIEW_STATE_CONFLICT: [409, "复核状态已变化", null],
  REVIEW_TOKEN_BOUNDARY: [409, "复核 Agent 已达到 token 使用边界", "review_attempt_failed"],
  REVIEWER_INELIGIBLE: [403, "所选 Agent 不具备独立复核资格", "review_candidates_evaluated"],
  SCHEMA_DATA_INVALID: [500, "本地数据结构不可安全读取", null],
  SCHEMA_DRIFT: [500, "本地数据结构不可安全读取", null],
  SCHEMA_TOO_NEW: [500, "本地数据结构不可安全读取", null],
  STORAGE_UNAVAILABLE: [503, "存储暂不可用", null],
  STRUCTURED_OUTPUT_INVALID: [400, "复核输出格式无效", "review_model_call_failed"],
  VALIDATION_REQUIRED: [422, "必需验证或证据不可用", "review_finalize_failed"],
  WORK_ITEM_NOT_FOUND: [404, "未找到对应的任务", null],
} as const;

describe("review error registry", () => {
  it("maps every designed code to one HTTP status, fixed Chinese copy, and typed event", async () => {
    const load = modules["../../../src/modules/review-delivery/public/errors.ts"];
    expect(load).toBeTypeOf("function");
    const module = await load!() as {
      REVIEW_ERROR_REGISTRY?: Record<string, { eventType: string | null; message: string; status: number }>;
    };
    expect(module.REVIEW_ERROR_REGISTRY).toBeDefined();
    expect(Object.keys(module.REVIEW_ERROR_REGISTRY!).sort()).toEqual(Object.keys(expected).sort());
    for (const [code, [status, message, eventType]] of Object.entries(expected)) {
      expect(module.REVIEW_ERROR_REGISTRY![code], code).toEqual({ eventType, message, status });
    }
  });

  it("creates only sanitized envelopes and never reflects unknown database/provider text", async () => {
    const load = modules["../../../src/modules/review-delivery/public/errors.ts"];
    const module = await load!() as {
      reviewErrorResponse?: (error: unknown, route: string) => Response;
    };
    expect(module.reviewErrorResponse).toBeTypeOf("function");
    const response = module.reviewErrorResponse!(
      new Error("Bearer provider-secret at D:\\private\\database.sqlite"),
      "GET /api/reviews/:attemptId",
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        correlationId: expect.any(String),
        message: "发生内部错误",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/Bearer|provider-secret|D:\\|database\.sqlite/);
  });
});
