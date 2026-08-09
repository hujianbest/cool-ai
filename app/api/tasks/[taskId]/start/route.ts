import { startTaskResponse, type RouteContext } from "@/app/api/_shared/task-api";

export function POST(
  _request: Request,
  context: RouteContext<"taskId">,
): Promise<Response> {
  return startTaskResponse(context);
}
