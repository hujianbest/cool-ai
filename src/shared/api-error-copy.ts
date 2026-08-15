import type { ApiError } from "@/src/shared/contracts";

const errorCopy: Record<string, string> = {
  ACTION_CONFLICT: "协作事实已变化，请刷新后重试。",
  ACTION_INVALID: "Agent 提交的协作动作无效。",
  AGENT_NOT_FOUND: "未找到该 Agent。",
  AGENT_NOT_MEMBER: "所选 Agent 不是项目成员。",
  BOUNDARY_REACHED: "协作运行已达到配置边界。",
  COLLABORATION_ACTIVE: "项目仍有进行中的协作运行。",
  CONTEXT_NOT_READY: "项目协作上下文尚未就绪。",
  CREDENTIAL_UNAVAILABLE: "Provider 凭据当前不可用。",
  DECISION_ALREADY_ANSWERED: "该决策请求已经回答。",
  DECISION_NOT_FOUND: "未找到该决策请求。",
  EMPTY_GOAL: "请输入任务目标。",
  EMPTY_PROJECT_NAME: "请输入项目名称。",
  INTERNAL_ERROR: "服务暂时出现问题，请稍后重试。",
  INVALID_INPUT: "提交的内容无效，请检查后重试。",
  INVALID_JSON: "请求格式无效，请检查后重试。",
  INVALID_TRANSITION: "当前任务状态不支持此操作。",
  OPERATION_CONFLICT: "该操作标识已用于其他请求，请重新提交。",
  OPERATION_IN_PROGRESS: "该操作仍在处理中，请稍后重试。",
  POLICY_ENTRY_LIMIT_EXCEEDED: "验证政策最多包含 50 项。",
  POLICY_NOT_FOUND: "未找到验证政策。",
  POLICY_SIZE_LIMIT_EXCEEDED: "验证政策超过 64 KiB。",
  PICKER_UNAVAILABLE: "无法打开系统文件夹选择器",
  POLICY_VERSION_CONFLICT: "验证政策版本已变化，草稿已保留。",
  PROJECT_NOT_FOUND: "未找到该项目。",
  PROJECTION_REBUILD_IN_PROGRESS: "审计投影正在重建，请稍后重试。",
  PROVIDER_AUTH: "Provider 身份验证失败，请检查配置。",
  PROVIDER_RESPONSE_INVALID: "Provider 返回了无效响应。",
  PROVIDER_TIMEOUT: "Provider 请求超时，请稍后重试。",
  PROVIDER_UNREACHABLE: "当前无法连接 Provider。",
  PROVIDER_UPSTREAM: "Provider 服务暂时异常。",
  RATE_LIMITED: "Provider 请求过于频繁，请稍后重试。",
  RUN_NOT_FOUND: "未找到该协作运行。",
  RUN_STATE_CONFLICT: "当前协作运行状态不支持此操作。",
  STARTER_AGENT_PROTECTED: "系统自带 Agent 不能删除。",
  STORAGE_UNAVAILABLE: "服务暂时不可用，请稍后重试。",
  STRUCTURED_OUTPUT_INVALID: "Provider 返回的结构化内容无效。",
  TASK_EXECUTION_FAILED: "任务执行失败，请稍后重试。",
  TASK_NOT_FOUND: "未找到该任务。",
  TURN_IN_PROGRESS: "当前已有 Agent 轮次正在处理中。",
  WORKSPACE_ALREADY_BOUND: "该文件夹已绑定到其他项目。",
  WORKSPACE_INVALID: "请输入有效的本地文件夹绝对路径。",
  WORKSPACE_NOT_DIRECTORY: "所选路径不是文件夹。",
  WORKSPACE_NOT_FOUND: "未找到该文件夹，请检查路径后重试。",
  WORKSPACE_NOT_READABLE: "无法读取该文件夹，请检查权限后重试。",
};

export class ApiDisplayError extends Error {}

export function apiErrorCopy(
  payload: Partial<ApiError>,
  fallback = "请求失败，请稍后重试。",
): string {
  const code = payload.error?.code;
  return (code && errorCopy[code]) || fallback;
}

export function caughtApiErrorCopy(cause: unknown, fallback: string): string {
  return cause instanceof ApiDisplayError ? cause.message : fallback;
}
