import { join } from "node:path";

import { reviewReadService } from "@/src/composition";
import { reviewErrorResponse } from "@/src/modules/review-delivery";

type RouteContext = { params: Promise<{ attemptId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { attemptId } = await context.params;
  try {
    return Response.json(reviewReadService.readReviewAttemptDetail(databasePath(), attemptId));
  } catch (error) {
    return reviewErrorResponse(error, "GET /api/reviews/:attemptId");
  }
}
