import { join } from "node:path";

import {
  ReviewSliceError,
  startReview,
} from "@/src/server/review/review-slice-service";

type RouteContext = { params: Promise<{ workItemId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { workItemId } = await context.params;
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json(
      { error: { code: "INVALID_JSON", message: "请求格式无效" } },
      { status: 400 },
    );
  }
  try {
    return Response.json(await startReview(databasePath(), workItemId, input));
  } catch (error) {
    const known = error instanceof ReviewSliceError ? error : null;
    return Response.json(
      { error: { code: known?.code ?? "INTERNAL_ERROR", message: known?.message ?? "发生内部错误" } },
      { status: known?.status ?? 500 },
    );
  }
}
