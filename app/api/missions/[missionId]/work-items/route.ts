import { join } from "node:path";

import { missionApiError, readMissionJson } from "@/src/server/mission-api";
import { createWorkItem } from "@/src/server/mission-service";

type RouteContext = { params: Promise<{ missionId: string }> };
type CreateWorkItemInput = {
  title: string;
  description: string;
  assigneeAgentId: string | null;
  dependencyIds: string[];
};

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { missionId } = await context.params;
  const body = await readMissionJson(request);
  if (!body.ok) return body.response;
  try {
    return Response.json(
      {
        workItem: createWorkItem(
          databasePath(),
          missionId,
          body.value as CreateWorkItemInput,
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    return missionApiError(error, "POST /api/missions/:missionId/work-items");
  }
}
