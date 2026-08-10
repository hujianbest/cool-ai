import type {
  MissionDependencyInsight,
  MissionState,
  TaskEvent,
  TaskRun,
} from "./dto";

export interface MissionWorkQueries {
  getMissionState: (databasePath: string, projectId: string) => MissionState;
  getMissionDependencyInsight: (
    databasePath: string,
    projectId: string,
    missionId: string,
  ) => MissionDependencyInsight;
  listProjectTasks: (
    projectId: string,
    databasePath: string,
  ) => { events: TaskEvent[]; tasks: TaskRun[] };
}
