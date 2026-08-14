import { join } from "node:path";

import { missionApiError } from "@/app/api/_shared/mission-api";
import {
  missionWorkSopStateProjection,
  workspaceBrowseService,
} from "@/src/composition";
import { windowsVerifiedExecution } from "@/src/composition/execution-host";
import { MissionError } from "@/src/modules/mission-work";

type RouteContext = { params: Promise<{ projectId: string }> };
type FieldError = { field: string; code: string };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function projectIdFrom(
  request: Request,
  params: { projectId: string },
): string {
  const fields: FieldError[] = [];
  const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
  if (projectId.length === 0 || projectId.length > 200) {
    fields.push({ field: "projectId", code: "invalid_format" });
  }
  for (const key of new URL(request.url).searchParams.keys()) {
    fields.push({ field: key, code: "not_supported" });
  }
  if (fields.length > 0) {
    throw new MissionError("INVALID_INPUT", 400, "Mission input is invalid.", fields);
  }
  return projectId;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const params = await context.params;
  try {
    const projectId = projectIdFrom(request, params);
    const adapters = windowsVerifiedExecution.createWindowsVerifiedExecutionAdapters();
    return Response.json(
      await missionWorkSopStateProjection.getSopStateProjection(
        databasePath(),
        projectId,
        {
          listWorkspaceDirectory: (path, id, relativePath) =>
            workspaceBrowseService.listWorkspaceDirectory(
              path,
              id,
              relativePath,
              adapters.fileAdapter,
            ),
          readWorkspaceFilePreview: (path, id, relativePath) =>
            workspaceBrowseService.readWorkspaceFilePreview(
              path,
              id,
              relativePath,
              adapters.fileAdapter,
            ),
        },
      ),
    );
  } catch (error) {
    return missionApiError(error, "GET /api/projects/:projectId/sop-state");
  }
}
