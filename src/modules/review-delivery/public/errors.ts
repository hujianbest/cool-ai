import { randomUUID } from "node:crypto";

import type { CompletionBlocker } from "./dto";

export type ReviewErrorCode =
  | keyof typeof REVIEW_ERROR_REGISTRY;

type ReviewErrorDefinition = {
  eventType: string | null;
  message: string;
  status: number;
};

export const REVIEW_ERROR_REGISTRY = {
  CREDENTIAL_UNAVAILABLE: { eventType: null, message: "复核凭据暂不可用", status: 503 },
  DELIVERY_CONTEXT_CHANGED: { eventType: "delivery_invalidated", message: "使命上下文已变化，请基于最新内容重试", status: 409 },
  DELIVERY_INTERRUPTED: { eventType: "delivery_generation_failed", message: "交付生成已中断，请显式重试", status: 409 },
  DELIVERY_INVARIANT_FAILED: { eventType: "delivery_generation_failed", message: "交付数据不一致", status: 500 },
  DELIVERY_NOT_FOUND: { eventType: null, message: "未找到对应的交付", status: 404 },
  DELIVERY_RESPONSE_LIMIT_EXCEEDED: { eventType: "delivery_generation_failed", message: "交付摘要超过既有限制", status: 413 },
  ESCALATION_ALREADY_ANSWERED: { eventType: "escalation_answered", message: "该升级问题已被回答", status: 409 },
  ESCALATION_NOT_FOUND: { eventType: null, message: "未找到对应的升级", status: 404 },
  INTERNAL_ERROR: { eventType: null, message: "发生内部错误", status: 500 },
  INVALID_INPUT: { eventType: null, message: "输入不符合约束", status: 400 },
  INVALID_JSON: { eventType: null, message: "请求格式无效", status: 400 },
  LEGACY_DONE_UNREVIEWED: { eventType: "completion_write_rejected", message: "旧完成状态未经独立复核", status: 409 },
  MEMORY_NOT_ACTIVE: { eventType: "review_finalize_failed", message: "被取代的记忆不能再次取代", status: 409 },
  MEMORY_SOURCE_INVALID: { eventType: "review_finalize_failed", message: "记忆来源无效", status: 422 },
  MEMORY_SUPERSEDES_INVALID: { eventType: "review_finalize_failed", message: "记忆版本关系无效", status: 422 },
  MEMORY_TYPE_MISMATCH: { eventType: "review_finalize_failed", message: "记忆类型不匹配", status: 409 },
  MISSION_COMPLETION_BLOCKED: { eventType: null, message: "使命尚未满足最终完成条件", status: 409 },
  MISSION_CONTEXT_CHANGED: { eventType: "review_attempt_discarded", message: "使命上下文已变化，请基于最新内容重试", status: 409 },
  NO_INDEPENDENT_REVIEWER: { eventType: "review_candidates_evaluated", message: "缺少可用的独立复核 Agent", status: 409 },
  OPERATION_CONFLICT: { eventType: null, message: "操作标识与原请求冲突", status: 409 },
  OPERATION_IN_PROGRESS: { eventType: "operation_replayed", message: "操作仍在进行", status: 409 },
  OWNER_REQUIRED: { eventType: null, message: "仅 Owner 可执行此操作", status: 403 },
  PROJECT_NOT_FOUND: { eventType: null, message: "未找到对应的项目", status: 404 },
  PROVIDER_AUTH: { eventType: "review_model_call_failed", message: "Provider 身份验证失败，请检查配置。", status: 401 },
  PROVIDER_RESPONSE_INVALID: { eventType: "review_model_call_failed", message: "Provider 返回了无效响应。", status: 502 },
  PROVIDER_TIMEOUT: { eventType: "review_model_call_failed", message: "Provider 请求超时，请稍后重试。", status: 504 },
  PROVIDER_UNREACHABLE: { eventType: "review_model_call_failed", message: "当前无法连接 Provider。", status: 502 },
  PROVIDER_UPSTREAM: { eventType: "review_model_call_failed", message: "Provider 服务暂时异常。", status: 502 },
  RATE_LIMITED: { eventType: "review_model_call_failed", message: "Provider 请求过于频繁，请稍后重试。", status: 429 },
  REQUEST_LIMIT_EXCEEDED: { eventType: null, message: "请求超过既有限制", status: 413 },
  RESPONSE_LIMIT_EXCEEDED: { eventType: null, message: "响应超过既有限制", status: 413 },
  RESULT_NOT_FOUND: { eventType: null, message: "未找到对应的结果", status: 404 },
  RESULT_SUPERSEDED: { eventType: "review_attempt_discarded", message: "结果版本已被取代", status: 409 },
  REVIEW_ALREADY_IN_PROGRESS: { eventType: null, message: "已有复核正在进行", status: 409 },
  REVIEW_CONTENT_INCOMPLETE: { eventType: "review_finalize_failed", message: "复核材料正文不完整，不能通过", status: 422 },
  REVIEW_CONTEXT_STALE: { eventType: null, message: "复核上下文已变化，请基于最新内容重试", status: 409 },
  REVIEW_FINALIZE_FAILED: { eventType: "review_finalize_failed", message: "复核结果已保存，但本地提交失败；重试不会再次调用模型", status: 500 },
  REVIEW_INVARIANT_FAILED: { eventType: "review_finalize_failed", message: "复核数据不一致", status: 500 },
  REVIEW_MATERIAL_INVALID: { eventType: "review_attempt_failed", message: "公开复核材料无效", status: 422 },
  REVIEW_MATERIAL_LIMIT_EXCEEDED: { eventType: "review_attempt_failed", message: "公开复核材料超过既有限制", status: 413 },
  REVIEW_NOT_FOUND: { eventType: null, message: "未找到对应的复核", status: 404 },
  REVIEW_OUTPUT_REDACTED: { eventType: "review_model_call_failed", message: "复核公开输出包含不可持久化内容", status: 422 },
  REVIEW_REQUIRED: { eventType: "completion_write_rejected", message: "任务尚未通过独立复核", status: 409 },
  REVIEW_STATE_CONFLICT: { eventType: null, message: "复核状态已变化", status: 409 },
  REVIEW_TOKEN_BOUNDARY: { eventType: "review_attempt_failed", message: "复核 Agent 已达到 token 使用边界", status: 409 },
  REVIEWER_INELIGIBLE: { eventType: "review_candidates_evaluated", message: "所选 Agent 不具备独立复核资格", status: 403 },
  SCHEMA_DATA_INVALID: { eventType: null, message: "本地数据结构不可安全读取", status: 500 },
  SCHEMA_DRIFT: { eventType: null, message: "本地数据结构不可安全读取", status: 500 },
  SCHEMA_TOO_NEW: { eventType: null, message: "本地数据结构不可安全读取", status: 500 },
  STORAGE_UNAVAILABLE: { eventType: null, message: "存储暂不可用", status: 503 },
  STRUCTURED_OUTPUT_INVALID: { eventType: "review_model_call_failed", message: "复核输出格式无效", status: 400 },
  VALIDATION_REQUIRED: { eventType: "review_finalize_failed", message: "必需验证或证据不可用", status: 422 },
  WORK_ITEM_NOT_FOUND: { eventType: null, message: "未找到对应的任务", status: 404 },
} as const satisfies Record<string, ReviewErrorDefinition>;

export class ReviewApiError extends Error {
  constructor(
    public readonly code: ReviewErrorCode,
    message = REVIEW_ERROR_REGISTRY[code].message,
  ) {
    super(message);
    this.name = "ReviewApiError";
  }

  get status(): number {
    return REVIEW_ERROR_REGISTRY[this.code].status;
  }
}

function isReviewErrorCode(value: unknown): value is ReviewErrorCode {
  return typeof value === "string" && value in REVIEW_ERROR_REGISTRY;
}

export function reviewErrorResponse(error: unknown, route: string): Response {
  const candidate = error && typeof error === "object" && "code" in error
    ? (error as { code: unknown }).code
    : null;
  const code = isReviewErrorCode(candidate) ? candidate : "INTERNAL_ERROR";
  const definition = REVIEW_ERROR_REGISTRY[code];
  const correlationId = code === "INTERNAL_ERROR" ? randomUUID() : undefined;
  if (correlationId) {
    console.error({ code, correlationId, route });
  }
  return Response.json({
    error: {
      code,
      ...(correlationId ? { correlationId } : {}),
      message: definition.message,
    },
  }, { status: definition.status });
}

export class MissionInitializationError extends Error {
  readonly code = "MISSION_INITIALIZATION_CONFLICT";

  constructor() {
    super("Mission delivery initialization conflicts with current state.");
    this.name = "MissionInitializationError";
  }
}

export class CompletionGateError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly blockers?: CompletionBlocker[],
    public readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "CompletionGateError";
  }
}
