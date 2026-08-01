import { join } from "node:path";

import { reviewErrorResponse } from "@/src/server/review/review-errors";
import { readReviewAttemptDetail } from "@/src/server/review/review-read-service";

type RouteContext = { params: Promise<{ attemptId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { attemptId } = await context.params;
  try {
    return Response.json(readReviewAttemptDetail(databasePath(), attemptId));
  } catch (error) {
    return reviewErrorResponse(error, "GET /api/reviews/:attemptId");
  }
}
