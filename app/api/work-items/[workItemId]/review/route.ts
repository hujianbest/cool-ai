import { join } from "node:path";

import {
  readReviewWorkspace,
  ReviewSliceError,
} from "@/src/server/review/review-slice-service";

type RouteContext = { params: Promise<{ workItemId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { workItemId } = await context.params;
  try {
    return Response.json(readReviewWorkspace(databasePath(), workItemId));
  } catch (error) {
    const known = error instanceof ReviewSliceError ? error : null;
    return Response.json(
      { error: { code: known?.code ?? "INTERNAL_ERROR", message: known?.message ?? "发生内部错误" } },
      { status: known?.status ?? 500 },
    );
  }
}
