import { ExecutionError } from "./errors";
import type { RecoveryActionDto } from "./dto";

export const RECOVERY_CONFIRM_EXECUTE = "执行救援";
export const RECOVERY_CONFIRM_UNDO = "撤销救援";

const CATALOG: readonly (RecoveryActionDto & {
  reasonCode: string;
  status: string;
})[] = [
  {
    approvalRequired: false,
    id: "resume_queued",
    reasonCode: "STALE_EXECUTION",
    reversible: false,
    status: "stale",
    title: "恢复到可运行队列",
  },
  {
    approvalRequired: true,
    id: "abandon_unverified",
    reasonCode: "SANDBOX_UNVERIFIABLE",
    reversible: false,
    status: "paused",
    title: "放弃无法核验的沙箱",
  },
  {
    approvalRequired: true,
    id: "resolve_merge_old",
    reasonCode: "MERGE_MANUAL_RECOVERY",
    reversible: false,
    status: "conflicted",
    title: "合并恢复为旧版本",
  },
  {
    approvalRequired: true,
    id: "resolve_merge_new",
    reasonCode: "MERGE_MANUAL_RECOVERY",
    reversible: false,
    status: "conflicted",
    title: "合并恢复为新版本",
  },
];

const PREVIEWS: Record<string, string> = {
  abandon_unverified: "Execution 标记为 abandoned，不改工作区文件",
  resolve_merge_new: "合并恢复为新版本，不在本片写文件",
  resolve_merge_old: "合并恢复为旧版本，不在本片写文件",
  resume_queued: "Execution 回到 queued",
};

export function recoveryActionsFor(
  status: string,
  reasonCode: string | null,
): RecoveryActionDto[] {
  return CATALOG
    .filter((entry) => entry.status === status && entry.reasonCode === reasonCode)
    .map(({ approvalRequired, id, reversible, title }) => ({
      approvalRequired,
      id,
      reversible,
      title,
    }));
}

export function previewRecoveryAction(actionId: string): {
  actionId: string;
  changes: string[];
  writesFiles: false;
} {
  const change = PREVIEWS[actionId];
  if (change === undefined) {
    throw new ExecutionError("INVALID_INPUT", 400, "Unknown recovery action.");
  }
  return {
    actionId,
    changes: [change],
    writesFiles: false,
  };
}

export function recoveryCatalogEntry(actionId: string): RecoveryActionDto & {
  reasonCode: string;
  status: string;
} {
  const entry = CATALOG.find((item) => item.id === actionId);
  if (entry === undefined) {
    throw new ExecutionError("INVALID_INPUT", 400, "Unknown recovery action.");
  }
  return entry;
}
