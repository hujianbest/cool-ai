import { join } from "node:path";

import { listMissionDeliveries } from "@/src/adapters/outbound/sqlite/review-delivery/delivery-read-service";
import {
  ReviewApiError,
  reviewErrorResponse,
} from "@/src/modules/review-delivery";

type RouteContext = { params: Promise<{ missionId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function query(request: Request): { after?: string; limit?: string } {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (!["after", "limit"].includes(key) || parameters.getAll(key).length !== 1) {
      throw new ReviewApiError("INVALID_INPUT");
    }
  }
  return {
    after: parameters.get("after") ?? undefined,
    limit: parameters.get("limit") ?? undefined,
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { missionId } = await context.params;
  try {
    return Response.json(
      listMissionDeliveries(databasePath(), missionId, query(request)),
    );
  } catch (error) {
    return reviewErrorResponse(error, "GET /api/missions/:missionId/deliveries");
  }
}
