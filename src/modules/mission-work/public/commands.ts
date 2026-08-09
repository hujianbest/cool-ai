import type { TransactionContext } from "@/src/application/transaction-context";
import type {
  CreateMissionCommand,
  CreateMissionInput,
  CreateWorkItemInput,
  Mission,
  MissionCreated,
  TaskExecutor,
  TaskStateResponse,
  TransitionWorkItemInput,
  UpdateMissionInput,
  UpdateWorkItemInput,
  WorkItem,
} from "./dto";

export interface MissionCommandCapability {
  createMission(
    transaction: TransactionContext,
    command: CreateMissionCommand,
  ): MissionCreated;
}

export interface MissionWorkCommands {
  createMission: (
    databasePath: string,
    projectId: string,
    input: CreateMissionInput,
  ) => Mission;
  createTask: (projectId: string, goal: string, databasePath: string) => TaskStateResponse;
  createWorkItem: (
    databasePath: string,
    missionId: string,
    input: CreateWorkItemInput,
  ) => WorkItem;
  executeTask: (
    taskId: string,
    databasePath: string,
    executor?: TaskExecutor,
  ) => TaskStateResponse;
  startTask: (taskId: string, databasePath: string) => TaskStateResponse;
  transitionWorkItem: (
    databasePath: string,
    workItemId: string,
    input: TransitionWorkItemInput,
  ) => WorkItem;
  updateMission: (
    databasePath: string,
    missionId: string,
    input: UpdateMissionInput,
  ) => Mission;
  updateWorkItem: (
    databasePath: string,
    workItemId: string,
    input: UpdateWorkItemInput,
  ) => WorkItem;
}
