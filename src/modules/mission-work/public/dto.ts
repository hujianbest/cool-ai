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

export type TaskExecutor = (goal: string) => string;
