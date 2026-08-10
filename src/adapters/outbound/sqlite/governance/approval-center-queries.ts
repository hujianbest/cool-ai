import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { listPendingProposals } from "@/src/adapters/outbound/sqlite/public-collaboration/structured-message-store";
import {
  approvalCenterItemDtoSchema,
  GovernanceError,
  type ApprovalCenterItemDto,
} from "@/src/modules/governance";

type ExecutionApprovalRow = {
  createdAt: string;
  executionId: string;
  id: string;
  kind: string;
  publicRequestJson: string;
  status: string;
};

function ensureProject(database: DatabaseSync, projectId: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) {
    throw new GovernanceError("PROJECT_NOT_FOUND", "Project was not found.");
  }
}

// public_request_json 是 safe-execution 写路径已脱敏的公开白名单对象；审批中心
// 摘要只再提取 executable/args/expectedEffect 三个公开键，宁缺毋滥——hash、
// policySource、agentPermission、attemptId 等键一律不进入审批中心 wire。
function summarizeCommand(publicRequestJson: string): {
  impactSummary: string | null;
  title: string | null;
} {
  const parsed: unknown = JSON.parse(publicRequestJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { impactSummary: null, title: null };
  }
  const request = parsed as Record<string, unknown>;
  const executable = typeof request.executable === "string" && request.executable.length > 0
    ? request.executable
    : null;
  const args = Array.isArray(request.args)
    ? request.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const title = executable ? [executable, ...args].join(" ") : null;
  const impactSummary = typeof request.expectedEffect === "string"
      && request.expectedEffect.length > 0
    ? request.expectedEffect
    : null;
  return { impactSummary, title };
}

/**
 * GovernanceApprovalCenterQueries 的实现（特性 029 T-01）。
 * 执行域直读本 owner 的 execution_approvals；内联决策域经 public-collaboration
 * 公开查询缝 listPendingProposals 取数，不直读他域表。
 * 失效态（expired/replaced/revoked）如实映射为 decisionHint；落定态
 * （approved/consumed/rejected）与已 resolve 的 proposal 不入列。
 */
export function listPendingApprovals(
  databasePath: string,
  projectId: string,
): ApprovalCenterItemDto[] {
  const database = openDatabase(databasePath);
  let executionItems: ApprovalCenterItemDto[];
  try {
    ensureProject(database, projectId);
    const rows = database.prepare(
      `SELECT id,execution_id AS executionId,kind,status,
              public_request_json AS publicRequestJson,created_at AS createdAt
       FROM execution_approvals
       WHERE project_id=? AND status IN('pending','expired','replaced','revoked')`,
    ).all(projectId) as unknown as ExecutionApprovalRow[];
    executionItems = rows.map((row) => {
      const summary = row.kind === "command"
        ? summarizeCommand(row.publicRequestJson)
        : { impactSummary: null, title: null };
      return approvalCenterItemDtoSchema.parse({
        approvalId: row.id,
        createdAt: row.createdAt,
        decisionHint: row.status === "pending" ? null : row.status,
        domain: "execution",
        impactSummary: summary.impactSummary,
        kind: row.kind,
        sourceRef: {
          executionId: row.executionId,
          messageId: null,
          runId: null,
          threadId: null,
        },
        status: row.status,
        title: summary.title,
      });
    });
  } finally {
    database.close();
  }
  const proposalItems = listPendingProposals(databasePath, projectId).map((proposal) =>
    approvalCenterItemDtoSchema.parse({
      approvalId: proposal.blockId,
      createdAt: proposal.createdAt,
      decisionHint: null,
      domain: "inline_decision",
      impactSummary: proposal.body,
      kind: "proposal",
      sourceRef: {
        executionId: null,
        messageId: proposal.messageId,
        runId: proposal.runId,
        threadId: proposal.threadId,
      },
      status: "pending",
      title: proposal.title,
    })
  );
  return [...executionItems, ...proposalItems].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? 1 : -1;
    }
    if (left.approvalId === right.approvalId) return 0;
    return left.approvalId < right.approvalId ? -1 : 1;
  });
}
