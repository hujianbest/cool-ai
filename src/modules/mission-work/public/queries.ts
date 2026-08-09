import type { MissionState, TaskEvent, TaskRun } from "./dto";

export interface MissionWorkQueries {
  getMissionState: (databasePath: string, projectId: string) => MissionState;
  listProjectTasks: (
    projectId: string,
    databasePath: string,
  ) => { events: TaskEvent[]; tasks: TaskRun[] };
}
