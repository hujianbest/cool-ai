import type { TransactionContext } from "@/src/application/transaction-context";

import type {
  InitializeMissionDeliveryCommand,
  MissionDeliveryInitialized,
} from "./dto";
import type { ReviewOperationResponse } from "@/src/shared/review-contracts";

/**
 * 使命交付初始化的事务内命令能力（T-06 已放行事务协调 Port 类型依赖）。
 * 当前具体实现为
 * src/adapters/outbound/sqlite/review-delivery/sqlite-review-delivery-command-capability.ts。
 */
export interface ReviewDeliveryCommandCapability {
  initializeForMission(
    transaction: TransactionContext,
    command: InitializeMissionDeliveryCommand,
  ): MissionDeliveryInitialized;
}

/** 命令级 envelope（当前实现以 { body, status } 或冻结契约 DTO 承载，T-14 入站收编后由 route 仅依赖本面）。 */
export type ReviewDeliveryCommandResult<Body> = {
  body: Body;
  status: number;
};

/**
 * review-delivery 公开命令面（DTO 级声明，不要求具体实现 implements）。
 * 当前具体实现为 src/adapters/outbound/sqlite/review-delivery/ 下的
 * 连接级自由函数，由 app/api route 与留原地的传输层直接调用（T-13/T-14 收编为
 * Workflow/事务协调 Port）。
 * 说明：
 * - rawInput 为传输层未知输入，由实现侧 schema（startReviewInputSchema /
 *   generateDeliveryInputSchema / answerEscalation 解析）严格校验；
 * - 复核/交付生成是长任务编排入口，响应为冻结契约 ReviewOperationResponse 或
 *   交付 envelope；精确错误联合由 public/errors 的稳定 envelope 承载。
 */
export interface ReviewDeliveryCommands {
  startPublicReview(
    databasePath: string,
    workItemId: string,
    rawInput: unknown,
  ): Promise<ReviewOperationResponse>;
  answerEscalation(
    databasePath: string,
    escalationId: string,
    rawInput: unknown,
  ): Promise<Record<string, unknown>>;
  generatePublicDelivery(
    databasePath: string,
    missionId: string,
    rawInput: unknown,
  ): Promise<Record<string, unknown>>;
}
