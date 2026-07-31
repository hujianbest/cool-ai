import { z } from "zod";

export const executionStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "paused",
  "staged",
  "stale",
  "conflicted",
  "failed",
  "stopped",
  "merged",
]);

export const executionActionKindSchema = z.enum([
  "sandbox_build",
  "model",
  "file_list",
  "file_read",
  "file_write",
  "command",
  "stage_compute",
  "merge_apply",
  "merge_recover",
  "manual_resolution",
]);

export const executionEventTypeSchema = z.enum([
  "execution_created",
  "sandbox_preflight",
  "sandbox_ready",
  "action_started",
  "action_finished",
  "action_reconciled",
  "status_changed",
  "attempt_started",
  "attempt_interrupted",
  "model_call_started",
  "model_call_succeeded",
  "model_call_failed",
  "usage_recorded",
  "tool_requested",
  "tool_succeeded",
  "tool_rejected",
  "tool_failed",
  "approval_requested",
  "approval_decided",
  "approval_consumed",
  "validation_recorded",
  "staged_created",
  "stale_detected",
  "conflict_detected",
  "control_applied",
  "merge_prepared",
  "merge_recovered",
  "merged",
  "manual_recovery_required",
  "manual_recovery_resolved",
  "operation_replayed",
]);

export const executionDtoSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sourceCollaborationRunId: z.string().min(1),
  workItem: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
  }).strict(),
  agent: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    avatarText: z.string().min(1),
    accentToken: z.string().min(1),
  }).strict(),
  status: executionStatusSchema,
  reasonCode: z.string().nullable(),
  resumeTarget: z.enum(["queued", "running", "waiting_approval"]).nullable(),
  attemptNo: z.number().int().positive(),
  version: z.number().int().positive(),
  businessRounds: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  limits: z.object({
    businessRounds: z.literal(20),
    toolCalls: z.literal(40),
    businessWallClockSeconds: z.literal(900),
    businessClockStarts: z.literal("first_running"),
    sandboxBuildSeconds: z.literal(900),
    commandSeconds: z.literal(120),
  }).strict(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    maxTokens: z.number().int().nonnegative(),
  }).strict(),
  currentAction: z.object({
    kind: executionActionKindSchema.nullable(),
    actionIndex: z.number().int().nonnegative().nullable(),
    startedAt: z.string().nullable(),
    overallDeadlineAt: z.string().nullable(),
    lastHeartbeatAt: z.string().nullable(),
  }).strict(),
  manualRecoveryRequired: z.boolean(),
  createdAt: z.string(),
  firstRunningAt: z.string().nullable(),
  businessDeadlineAt: z.string().nullable(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
}).strict();

export const executionListResponseSchema = z.object({
  executions: z.array(executionDtoSchema).max(50),
}).strict();

export const startExecutionInputSchema = z.object({
  operationId: z.string().uuid(),
  sourceCollaborationRunId: z.string().min(1),
  workItemId: z.string().min(1),
}).strict();

export const startExecutionResponseSchema = z.object({
  execution: executionDtoSchema,
}).strict();

export const advanceExecutionInputSchema = z.object({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
}).strict();

export const advanceExecutionResponseSchema = z.object({
  execution: executionDtoSchema,
  attempt: z.object({
    id: z.string().min(1),
    attemptNo: z.number().int().positive(),
    status: z.enum([
      "preparing",
      "ready",
      "acting",
      "interrupted",
      "failed",
      "superseded",
      "completed",
    ]),
  }).strict(),
  actionResult: z.object({
    kind: executionActionKindSchema,
    status: z.enum(["succeeded", "failed", "interrupted", "discarded"]),
    summary: z.string().max(65_536),
  }).strict(),
  newEvents: z.array(z.object({
    id: z.string().min(1),
    sequence: z.number().int().positive(),
    type: executionEventTypeSchema,
  }).strict()).max(10),
}).strict();

export const mergeExecutionInputSchema = z.object({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  stagedHash: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

export const mergeExecutionResponseSchema = z.object({
  execution: executionDtoSchema,
  result: z.object({
    createdAt: z.string(),
    executionId: z.string().min(1),
    id: z.string().min(1),
    mergeJournalId: z.string().min(1),
    stagedResultId: z.string().min(1),
    status: z.literal("awaiting_review"),
  }).strict(),
}).strict();

export const recoveryMergeFileStatuses = [
  "pending",
  "temp_ready",
  "applied",
  "rolled_back",
  "rolled_forward",
  "verified",
] as const;

export const recoveryMergeFileStatusSchema = z.enum(recoveryMergeFileStatuses);

export const recoveryFileDtoSchema = z.object({
  isMismatch: z.boolean(),
  oldExists: z.boolean(),
  oldHash: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  path: z.string().min(1),
  pathKey: z.string().min(1),
  postHash: z.string().regex(/^[0-9a-f]{64}$/u),
  position: z.number().int().nonnegative(),
  status: recoveryMergeFileStatusSchema,
}).strict().superRefine((file, context) => {
  if (file.oldExists !== (file.oldHash !== null)) {
    context.addIssue({
      code: "custom",
      message: "oldExists and oldHash are inconsistent",
      path: ["oldHash"],
    });
  }
});

export const recoveryFilePageSchema = z.object({
  items: z.array(recoveryFileDtoSchema).max(20),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export const executionControlInputSchema = z.object({
  operationId: z.string().uuid(),
  action: z.enum(["pause", "continue", "retry", "stop"]),
  expectedVersion: z.number().int().positive(),
}).strict();

export const executionControlResponseSchema = z.object({
  execution: executionDtoSchema,
}).strict();

export const executionApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "consumed",
  "rejected",
  "revoked",
  "replaced",
  "expired",
]);

export const executionApprovalDtoSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["command", "staged_merge"]),
  status: executionApprovalStatusSchema,
  requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/u),
  stagedHash: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  command: z.object({
    executable: z.string().min(1),
    args: z.array(z.string()).max(64),
    workdir: z.string().min(1),
    expectedEffect: z.string().min(1),
    riskReasons: z.array(z.string()),
    permission: z.literal("execute"),
  }).strict().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  consumedAt: z.string().nullable(),
}).strict();

export const executionApprovalInputSchema = z.object({
  operationId: z.string().uuid(),
  action: z.enum(["approve", "reject", "revoke", "replace"]),
  expectedVersion: z.number().int().positive(),
}).strict();

export const executionApprovalResponseSchema = z.object({
  execution: executionDtoSchema,
  approval: executionApprovalDtoSchema,
}).strict();

export const taskRejectionSchema = z.object({
  workItemId: z.string().min(1),
  code: z.enum([
    "NOT_FOUND",
    "NOT_IN_PROGRESS",
    "UNASSIGNED",
    "ASSIGNEE_NOT_MEMBER",
    "DEPENDENCY_NOT_DONE",
    "RELATED_SELECTION",
    "TASK_ACTIVE",
    "AGENT_ACTIVE",
    "PROJECT_LIMIT",
  ]),
  messageKey: z.string().min(1),
}).strict();

export const startExecutionRejectionSchema = z.object({
  rejection: taskRejectionSchema,
}).strict();

export type ExecutionDto = z.infer<typeof executionDtoSchema>;
export type ExecutionEventType = z.infer<typeof executionEventTypeSchema>;
export type ExecutionListResponse = z.infer<typeof executionListResponseSchema>;
export type AdvanceExecutionInput = z.infer<typeof advanceExecutionInputSchema>;
export type AdvanceExecutionResponse = z.infer<typeof advanceExecutionResponseSchema>;
export type MergeExecutionInput = z.infer<typeof mergeExecutionInputSchema>;
export type MergeExecutionResponse = z.infer<typeof mergeExecutionResponseSchema>;
export type RecoveryMergeFileStatus = z.infer<typeof recoveryMergeFileStatusSchema>;
export type RecoveryFileDto = z.infer<typeof recoveryFileDtoSchema>;
export type ExecutionControlInput = z.infer<typeof executionControlInputSchema>;
export type ExecutionControlResponse = z.infer<typeof executionControlResponseSchema>;
export type ExecutionApprovalDto = z.infer<typeof executionApprovalDtoSchema>;
export type ExecutionApprovalInput = z.infer<typeof executionApprovalInputSchema>;
export type ExecutionApprovalResponse = z.infer<typeof executionApprovalResponseSchema>;
export type StartExecutionInput = z.infer<typeof startExecutionInputSchema>;
export type StartExecutionResponse = z.infer<typeof startExecutionResponseSchema>;
export type TaskRejection = z.infer<typeof taskRejectionSchema>;
export type StartExecutionRejection = z.infer<typeof startExecutionRejectionSchema>;
