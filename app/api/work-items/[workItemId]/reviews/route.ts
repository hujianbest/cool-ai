import { join } from "node:path";

import { startReview } from "@/src/server/review/review-slice-service";
import {
  ReviewApiError,
  reviewErrorResponse,
} from "@/src/server/review/review-errors";
import { listReviewAttempts } from "@/src/server/review/review-read-service";

type RouteContext = { params: Promise<{ workItemId: string }> };

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
  const { workItemId } = await context.params;
  try {
    return Response.json(listReviewAttempts(databasePath(), workItemId, query(request)));
  } catch (error) {
    return reviewErrorResponse(error, "GET /api/work-items/:workItemId/reviews");
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { workItemId } = await context.params;
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return reviewErrorResponse(
      new ReviewApiError("INVALID_JSON"),
      "POST /api/work-items/:workItemId/reviews",
    );
  }
  try {
    return Response.json(await startReview(databasePath(), workItemId, input));
  } catch (error) {
    return reviewErrorResponse(error, "POST /api/work-items/:workItemId/reviews");
  }
}
