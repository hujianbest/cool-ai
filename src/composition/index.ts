/**
 * 唯一生产装配根（product/architecture.md 第 7 节）：concrete Adapter 只经此处
 * 暴露给入站 route / app/api/_shared 传输助手。按模块分组，每个被使用的
 * Adapter 文件一个命名空间；本文件不含业务分支、校验或状态转换。
 */

// identity-capability
export * as agentService from "@/src/adapters/outbound/sqlite/identity-capability/agent-service";
export * as providerService from "@/src/adapters/outbound/sqlite/identity-capability/provider-service";
export * as skillService from "@/src/adapters/outbound/sqlite/identity-capability/skill-service";

// knowledge-provenance
export * as memoryService from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";

// mission-work
export * as missionWork from "@/src/adapters/outbound/sqlite/mission-work/mission-service";
export * as missionWorkDependencyInsight from "@/src/adapters/outbound/sqlite/mission-work/dependency-insight";
export * as missionWorkTasks from "@/src/adapters/outbound/sqlite/mission-work/tasks";

// project-workspace
export * as membershipService from "@/src/adapters/outbound/sqlite/project-workspace/membership-service";
export * as projects from "@/src/adapters/outbound/sqlite/project-workspace/projects";
export * as validationPolicyService from "@/src/adapters/outbound/sqlite/project-workspace/validation-policy-service";
export * as workspaceBrowseService from "@/src/adapters/outbound/sqlite/project-workspace/workspace-browse-service";
export * as workspaceService from "@/src/adapters/outbound/sqlite/project-workspace/workspace-service";

// public-collaboration
export * as advanceExecutor from "@/src/adapters/outbound/sqlite/public-collaboration/advance-executor";
export * as attachmentService from "@/src/adapters/outbound/sqlite/public-collaboration/attachment-service";
export * as inlineDecisionService from "@/src/adapters/outbound/sqlite/public-collaboration/inline-decision-service";
export * as publicTextCredentialClassifier from "@/src/adapters/outbound/sqlite/public-collaboration/public-text-credential-classifier";
export * as runService from "@/src/adapters/outbound/sqlite/public-collaboration/run-service";
export * as runTimelineService from "@/src/adapters/outbound/sqlite/public-collaboration/run-timeline-service";
export * as structuredMessageStore from "@/src/adapters/outbound/sqlite/public-collaboration/structured-message-store";
export * as inputHistoryService from "@/src/adapters/outbound/sqlite/public-collaboration/input-history-service";
export * as threadDraftService from "@/src/adapters/outbound/sqlite/public-collaboration/thread-draft-service";
export * as threadFavoriteService from "@/src/adapters/outbound/sqlite/public-collaboration/thread-favorite-service";
export * as threadService from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
export * as turnOrchestrator from "@/src/adapters/outbound/sqlite/public-collaboration/turn-orchestrator";
export * as verifiedSourceProjection from "@/src/adapters/outbound/sqlite/public-collaboration/verified-source-projection";

// review-delivery
export * as deliveryApplicationService from "@/src/adapters/outbound/sqlite/review-delivery/delivery-application-service";
export * as deliveryReadService from "@/src/adapters/outbound/sqlite/review-delivery/delivery-read-service";
export * as reviewApplicationService from "@/src/adapters/outbound/sqlite/review-delivery/review-application-service";
export * as reviewEscalationService from "@/src/adapters/outbound/sqlite/review-delivery/review-escalation-service";
export * as reviewReadService from "@/src/adapters/outbound/sqlite/review-delivery/review-read-service";

// safe-execution
export * as actionOrchestrator from "@/src/adapters/outbound/sqlite/safe-execution/action-orchestrator";
export * as executionApprovalService from "@/src/adapters/outbound/sqlite/safe-execution/execution-approval-service";
export * as executionControlService from "@/src/adapters/outbound/sqlite/safe-execution/execution-control-service";
export * as executionReadService from "@/src/adapters/outbound/sqlite/safe-execution/execution-read-service";
export * as executionService from "@/src/adapters/outbound/sqlite/safe-execution/execution-service";

// sqlite 技术边界（connection/lifecycle 能力）
export * as sqliteConnection from "@/src/adapters/outbound/sqlite/connection";

// workspace 技术 Adapter（不带 server-only 副作用的部分；
// merge/windows verified-host 能力经 ./execution-host 独立入口装配，
// 避免 server-only 标记模块进入本 barrel 的传递闭包）
export * as processRunner from "@/src/adapters/outbound/workspace/process-runner";
export * as sandboxExecution from "@/src/adapters/outbound/workspace/sandbox-executor";

// 跨边界存储/运行时错误契约（入站错误映射使用；canonical 定义仍在 Adapter 边界）
export { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";
export { ProviderVerificationError } from "@/src/adapters/outbound/model-runtime/provider-verifier";

export { createServerComposition } from "./server-composition";
export type { ServerComposition } from "./server-composition";
export { createMission } from "./mission-commands";
