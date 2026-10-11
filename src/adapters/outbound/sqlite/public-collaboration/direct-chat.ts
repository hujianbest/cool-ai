import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/modules/public-collaboration";

/**
 * 个人对话（direct chat）范围判定：未绑定工作区（path/key 均为 NULL）且恰好一名成员。
 *
 * 该范围没有 mission / workspace / 多成员协作语义，运行链路按单 Agent 直聊
 * 处理（回合以 reply 收束）；绑定过工作区、或已有多名成员的项目一律走
 * 多 Agent 协作口径（失败关闭）。
 *
 * 线程创建侧 `allowsSingleMemberThread` 在此基础上再要求「线程策略的唯一
 * 成员就是该项目唯一成员」，三者共享同一底层规则（无工作区 + 恰一成员）。
 */
export function isDirectChatProject(
  database: DatabaseSync,
  projectId: string,
): boolean {
  const project = database
    .prepare(
      `SELECT
         projects.workspace_path AS workspacePath,
         projects.workspace_key AS workspaceKey,
         count(project_memberships.agent_id) AS memberCount
       FROM projects
       LEFT JOIN project_memberships
         ON project_memberships.project_id = projects.id
       WHERE projects.id = ?
       GROUP BY projects.id`,
    )
    .get(projectId) as
    | { workspacePath: string | null; workspaceKey: string | null; memberCount: number }
    | undefined;
  if (!project) {
    throw new CollaborationError("RESOURCE_NOT_FOUND", 404, "Resource was not found.");
  }
  return project.workspacePath === null
    && project.workspaceKey === null
    && project.memberCount === 1;
}
