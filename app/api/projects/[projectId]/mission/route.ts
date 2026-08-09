import { join } from "node:path";

import { missionApiError, readMissionJson } from "@/app/api/_shared/mission-api";
import { missionWork } from "@/src/composition";
import { createMission } from "@/src/composition/mission-commands";

type RouteContext = { params: Promise<{ projectId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    return Response.json(missionWork.getMissionState(databasePath(), projectId));
  } catch (error) {
    return missionApiError(error, "GET /api/projects/:projectId/mission");
  }
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  const body = await readMissionJson(request);
  if (!body.ok) return body.response;
  try {
    return Response.json(
      {
        mission: createMission(
          databasePath(),
          projectId,
          body.value as {
            title: string;
            goal: string;
            expectedVersion: number;
            operationId: string;
          },
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    return missionApiError(error, "POST /api/projects/:projectId/mission");
  }
}
