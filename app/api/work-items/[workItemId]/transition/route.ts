import { join } from "node:path";

import { missionApiError, readMissionJson } from "@/src/server/mission-api";
import { transitionWorkItem } from "@/src/server/mission-service";
import type { WorkItemStatus } from "@/src/shared/project-context-contracts";

type RouteContext = { params: Promise<{ workItemId: string }> };
type TransitionInput = {
  toStatus: WorkItemStatus;
  expectedVersion: number;
};

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { workItemId } = await context.params;
  const body = await readMissionJson(request);
  if (!body.ok) return body.response;
  try {
    return Response.json({
      workItem: transitionWorkItem(
        databasePath(),
        workItemId,
        body.value as TransitionInput,
      ),
    });
  } catch (error) {
    return missionApiError(error, "POST /api/work-items/:workItemId/transition");
  }
}
