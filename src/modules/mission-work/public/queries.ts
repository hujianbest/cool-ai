import type {
  MissionDependencyInsight,
  MissionState,
  SopStateProjection,
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
  getSopStateProjection: (
    databasePath: string,
    projectId: string,
  ) => Promise<SopStateProjection>;
  listProjectTasks: (
    projectId: string,
    databasePath: string,
  ) => { events: TaskEvent[]; tasks: TaskRun[] };
}
