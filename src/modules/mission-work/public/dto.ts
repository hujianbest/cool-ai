import type {
  Mission,
  WorkItemStatus,
} from "@/src/shared/project-context-contracts";

export type {
  Mission,
  MissionState,
  WorkItem,
  WorkItemStatus,
} from "@/src/shared/project-context-contracts";
export type {
  TaskEvent,
  TaskFailureResponse,
  TaskRun,
  TaskStateResponse,
  TaskStatus,
} from "@/src/shared/contracts";

export type CreateMissionCommand = {
  expectedVersion: number;
  goal: string;
  operationId: string;
  projectId: string;
  requestHash: string;
  title: string;
};

export type MissionCreated = {
  mission: Mission;
  missionId: string;
  occurredAt: string;
  projectId: string;
};

export type CreateMissionInput = {
  title: string;
  goal: string;
  expectedVersion: number;
  operationId: string;
};
export type UpdateMissionInput = {
  title: string;
  goal: string;
  expectedVersion: number;
};
export type CreateWorkItemInput = {
  title: string;
  description: string;
  assigneeAgentId: string | null;
  dependencyIds: string[];
};
export type UpdateWorkItemInput = CreateWorkItemInput & { expectedVersion: number };
export type TransitionWorkItemInput = {
  toStatus: WorkItemStatus;
  expectedVersion: number;
  operationId?: string;
};
export type WorkItemBatchProposal = {
  clientKey: string;
  title: string;
  description: string;
  dependsOnKeys: string[];
};
export type MissionWriteActor =
  | { type: "owner" }
  | { type: "agent"; agentId: string };

export type MissionDependencyNode = {
  workItemId: string;
  title: string;
  status: WorkItemStatus;
  blockedByIds: string[];
  blockingIds: string[];
  blockedReason: string | null;
  cycleId: string | null;
  missingDependencyIds: string[];
};

export type MissionDependencyEdge = {
  fromWorkItemId: string;
  toWorkItemId: string;
};

export type MissionDependencyCycle = {
  cycleId: string;
  memberWorkItemIds: string[];
  path: string;
};

export type MissionDependencyInsight = {
  nodes: MissionDependencyNode[];
  edges: MissionDependencyEdge[];
  cycles: MissionDependencyCycle[];
  hasDependencies: boolean;
};

export type TaskExecutor = (goal: string) => string;

/**
 * work_items 看板状态写能力的输入（T-11：review-delivery 完成/重开投影的
 * 跨 owner 写提取自 src/server/review/，SQL 与并发语义逐字保持）。
 */
export type MarkWorkItemDoneInput = {
  expectedVersion: number;
  occurredAt: string;
  workItemId: string;
};

export type MarkReviewedWorkItemDoneInput = {
  missionId: string;
  occurredAt: string;
  workItemId: string;
};

export type MarkWorkItemInProgressInput = {
  occurredAt: string;
  workItemId: string;
};

/** 写能力的变更计数结果（调用方据 changes===1 判定并发冲突）。 */
export type WorkItemStatusWriteResult = {
  changes: number | bigint;
};
