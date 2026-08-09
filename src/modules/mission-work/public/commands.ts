import type { TransactionContext } from "@/src/application/transaction-context";
import type {
  CreateMissionCommand,
  CreateMissionInput,
  CreateWorkItemInput,
  MarkReviewedWorkItemDoneInput,
  MarkWorkItemDoneInput,
  MarkWorkItemInProgressInput,
  Mission,
  MissionCreated,
  TaskExecutor,
  TaskStateResponse,
  TransitionWorkItemInput,
  UpdateMissionInput,
  UpdateWorkItemInput,
  WorkItem,
  WorkItemStatusWriteResult,
} from "./dto";

export interface MissionCommandCapability {
  createMission(
    transaction: TransactionContext,
    command: CreateMissionCommand,
  ): MissionCreated;
}

/**
 * work_items 看板状态写能力（T-11 登记的 DTO 级 seam）：
 * review-delivery 的完成门禁/复核定稿在各自事务内投影 work_items.status，
 * SQL 唯一 owner 为 mission-work。当前具体实现为
 * src/adapters/outbound/sqlite/mission-work/work-item-status-effects.ts 的
 * 连接级自由函数（adapter→adapter 过渡边，T-13 收编为事务协调 Port 形态）。
 */
export interface WorkItemStatusEffectCommands {
  markWorkItemDone(
    transaction: TransactionContext,
    input: MarkWorkItemDoneInput,
  ): WorkItemStatusWriteResult;
  markReviewedWorkItemDone(
    transaction: TransactionContext,
    input: MarkReviewedWorkItemDoneInput,
  ): WorkItemStatusWriteResult;
  markWorkItemInProgress(
    transaction: TransactionContext,
    input: MarkWorkItemInProgressInput,
  ): WorkItemStatusWriteResult;
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
