import { join } from "node:path";

import { missionApiError, readMissionJson } from "@/src/server/mission-api";
import { updateMission } from "@/src/server/mission-service";

type RouteContext = { params: Promise<{ missionId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { missionId } = await context.params;
  const body = await readMissionJson(request);
  if (!body.ok) return body.response;
  try {
    return Response.json({
      mission: updateMission(
        databasePath(),
        missionId,
        body.value as { title: string; goal: string; expectedVersion: number },
      ),
    });
  } catch (error) {
    return missionApiError(error, "PATCH /api/missions/:missionId");
  }
}
