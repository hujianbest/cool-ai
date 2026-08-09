import type { TransactionContext } from "@/src/application/transaction-context";
import type { WorkItem } from "@/src/shared/project-context-contracts";

export type TransitionReceipt =
  | { ok: true; workItem: WorkItem }
  | {
      error: {
        blockers?: Array<{ code: string; workItemId: string | null }>;
        code: string;
        currentVersion?: number;
        message: string;
        status: number;
      };
      ok: false;
    };

export type ControlOperationPrior = {
  kind: string;
  requestHash: string;
  responseJson: string;
  status: string;
};

/**
 * T-06 预建的 public-collaboration 公开面（T-10 波次落地完整 Module）：
 * mission 控制类 operation receipt 的注册/重放能力。当前具体实现为
 * src/adapters/outbound/sqlite/public-collaboration/mission-control-receipts.ts 的
 * DatabaseSync 自由函数（adapter→adapter 过渡边，T-13/T-14 收编为事务协调 Port 形态）。
 */
export interface MissionControlReceiptCommands {
  insertTransitionReceipt(
    transaction: TransactionContext,
    input: {
      operationId: string;
      projectId: string;
      requestHash: string;
      receipt: TransitionReceipt;
    },
  ): void;
  readControlOperationPrior(
    transaction: TransactionContext,
    projectId: string,
    operationId: string,
  ): ControlOperationPrior | undefined;
}
