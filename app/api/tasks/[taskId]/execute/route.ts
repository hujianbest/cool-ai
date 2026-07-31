import { executeTaskResponse, type RouteContext } from "@/src/server/task-api";

export function POST(
  _request: Request,
  context: RouteContext<"taskId">,
): Promise<Response> {
  return executeTaskResponse(context);
}
