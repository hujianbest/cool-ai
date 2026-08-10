import { z } from "zod";

/**
 * 跨域统一审批中心（特性 029）的 wire 契约。列表语义 = 待决 + 失效可辨识：
 * 已落定（approved/consumed/rejected/resolved）的请求不属于"在等 owner 拍板"，不入列。
 * 摘要字段只承载各域既有公开白名单键，宁缺毋滥。
 */
export const approvalCenterDomainSchema = z.enum(["execution", "inline_decision"]);

export const approvalCenterItemKindSchema = z.enum(["command", "staged_merge", "proposal"]);

export const approvalCenterItemStatusSchema = z.enum([
  "pending",
  "expired",
  "replaced",
  "revoked",
]);

/** null = 可裁决；否则为失效原因码（如实映射源域 status，不新造状态）。 */
export const approvalCenterDecisionHintSchema = z.enum(["expired", "replaced", "revoked"]);

export const approvalCenterSourceRefSchema = z.object({
  executionId: z.string().min(1).nullable(),
  messageId: z.string().min(1).nullable(),
  runId: z.string().min(1).nullable(),
  threadId: z.string().min(1).nullable(),
}).strict();

export const approvalCenterItemDtoSchema = z.object({
  approvalId: z.string().min(1),
  createdAt: z.string().min(1),
  decisionHint: approvalCenterDecisionHintSchema.nullable(),
  domain: approvalCenterDomainSchema,
  impactSummary: z.string().min(1).nullable(),
  kind: approvalCenterItemKindSchema,
  sourceRef: approvalCenterSourceRefSchema,
  status: approvalCenterItemStatusSchema,
  title: z.string().min(1).nullable(),
}).strict();

export type ApprovalCenterDecisionHint = z.infer<typeof approvalCenterDecisionHintSchema>;
export type ApprovalCenterDomain = z.infer<typeof approvalCenterDomainSchema>;
export type ApprovalCenterItemDto = z.infer<typeof approvalCenterItemDtoSchema>;
export type ApprovalCenterItemKind = z.infer<typeof approvalCenterItemKindSchema>;
export type ApprovalCenterItemStatus = z.infer<typeof approvalCenterItemStatusSchema>;
export type ApprovalCenterSourceRef = z.infer<typeof approvalCenterSourceRefSchema>;
