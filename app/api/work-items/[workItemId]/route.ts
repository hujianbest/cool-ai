import { join } from "node:path";

import { missionApiError, readMissionJson } from "@/app/api/_shared/mission-api";
import { missionWork } from "@/src/composition";

type RouteContext = { params: Promise<{ workItemId: string }> };
type UpdateWorkItemInput = {
  title: string;
  description: string;
  assigneeAgentId: string | null;
  dependencyIds: string[];
  expectedVersion: number;
};

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { workItemId } = await context.params;
  const body = await readMissionJson(request);
  if (!body.ok) return body.response;
  try {
    return Response.json({
      workItem: missionWork.updateWorkItem(
        databasePath(),
        workItemId,
        body.value as UpdateWorkItemInput,
      ),
    });
  } catch (error) {
    return missionApiError(error, "PATCH /api/work-items/:workItemId");
  }
}
