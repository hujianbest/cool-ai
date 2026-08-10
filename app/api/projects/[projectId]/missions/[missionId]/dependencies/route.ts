import { join } from "node:path";

import { missionApiError } from "@/app/api/_shared/mission-api";
import { missionWorkDependencyInsight } from "@/src/composition";
import { MissionError } from "@/src/modules/mission-work";

type RouteContext = { params: Promise<{ projectId: string; missionId: string }> };
type FieldError = { field: string; code: string };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function tuple(
  request: Request,
  params: { projectId: string; missionId: string },
): { missionId: string; projectId: string } {
  const fields: FieldError[] = [];
  const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
  const missionId = typeof params.missionId === "string" ? params.missionId.trim() : "";
  if (projectId.length === 0 || projectId.length > 200) {
    fields.push({ field: "projectId", code: "invalid_format" });
  }
  if (missionId.length === 0 || missionId.length > 200) {
    fields.push({ field: "missionId", code: "invalid_format" });
  }
  for (const key of new URL(request.url).searchParams.keys()) {
    fields.push({ field: key, code: "not_supported" });
  }
  if (fields.length > 0) {
    throw new MissionError("INVALID_INPUT", 400, "Mission input is invalid.", fields);
  }
  return { missionId, projectId };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const params = await context.params;
  try {
    const { projectId, missionId } = tuple(request, params);
    return Response.json(
      missionWorkDependencyInsight.getMissionDependencyInsight(
        databasePath(),
        projectId,
        missionId,
      ),
    );
  } catch (error) {
    return missionApiError(
      error,
      "GET /api/projects/:projectId/missions/:missionId/dependencies",
    );
  }
}
