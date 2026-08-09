/**
 * review-delivery 公开 DTO 面（T-11）：
 * - 传输/读模型 DTO 复用 src/shared/review-contracts 的冻结契约；
 * - 交付清单/包裹与完成门禁 blocker 等纯类型自适配器实现中提取归位，
 *   供浏览器组件与传输层经模块公开面访问（函数实现仍走 adapter 路径）；
 * - 命令输入在实现侧仍以 rawInput 由传输层 parse*Input 严格解析，
 *   精确的公开 Input 类型随 T-14 入站收编沉淀。
 */
export type {
  DeliveryVersionDto,
  GenerateDeliveryInput,
  MissionCompletionDto,
  ReviewAttemptDto,
  ReviewCandidateDto,
  ReviewOperationResponse,
  ReviewOutput,
  ReviewWorkspaceDto,
  StrictReviewAttemptDto,
  StrictReviewWorkspaceDto,
} from "@/src/shared/review-contracts";

export type InitializeMissionDeliveryCommand = {
  missionId: string;
  occurredAt: string;
  projectId: string;
  stepId: string;
};

export type MissionDeliveryInitialized = {
  deliveryHeadVersion: number;
  eventSequence: number;
  stepId: string;
};

export type CompletionBlocker = {
  code: string;
  workItemId: string | null;
};

export type CompletionInvalidationReason =
  | "DOWNSTREAM_REWORK_REQUESTED"
  | "OWNER_REOPENED"
  | "AGENT_REOPENED"
  | "WORK_ITEM_MATERIAL_CHANGED";

export type DeliveryContentStatus =
  | "complete"
  | "failed"
  | "truncated"
  | "stale"
  | "missing"
  | "unreadable";

export type DeliveryEvidenceStatus =
  | "passed"
  | "available"
  | "failed"
  | "truncated"
  | "stale"
  | "missing"
  | "unreadable";

export type DeliveryEvidenceKind =
  | "result"
  | "review"
  | "diff"
  | "validation"
  | "artifact"
  | "execution_event"
  | "memory";

export type DeliveryManifestEntry = {
  href: string;
  id: string;
  kind: DeliveryEvidenceKind;
  required: boolean;
  sha256: string | null;
  status: DeliveryEvidenceStatus;
  version: string;
};

export type DeliveryBlocker = {
  code: "MISSION_COMPLETION_BLOCKED";
  id: string;
  kind: DeliveryEvidenceKind;
  status: Exclude<DeliveryEvidenceStatus, "passed" | "available">;
  version: string;
};

export type DeliveryBundle = {
  blockers: DeliveryBlocker[];
  inputFingerprint: string;
  manifest: {
    entries: DeliveryManifestEntry[];
    inputFingerprint: string;
    schemaVersion: 1;
  };
  summary: {
    mission: {
      completedAt: string;
      conclusion: "completed";
      goal: string;
      id: string;
      title: string;
    };
    tasks: Array<{
      artifacts: Array<{ href: string; id: string; version: string }>;
      changes: { mergeFileCount: number; mergeFinalBytes: number; stagedHash: string };
      decision: { choice: "pass"; id: string; publicSummary: string };
      execution: {
        id: string;
        sourceCollaborationRunId: string;
        sourceCollaborationThreadId: string;
        sourceHref: string;
      };
      executor: { agentId: string; name: string };
      limitations: string[];
      memories: Array<{ href: string; id: string; version: string }>;
      result: { href: string; id: string; version: number };
      reviewer: { agentId: string; name: string };
      validations: {
        passedCount: number;
        refs: Array<{ href: string; id: string; version: string }>;
        requiredCount: number;
      };
      workItem: { id: string; title: string };
    }>;
  };
};
