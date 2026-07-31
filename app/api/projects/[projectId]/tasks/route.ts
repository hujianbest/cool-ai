import {
  createTaskResponse,
  getProjectTasksResponse,
  type RouteContext,
} from "@/src/server/task-api";

export function GET(
  _request: Request,
  context: RouteContext<"projectId">,
): Promise<Response> {
  return getProjectTasksResponse(context);
}

export function POST(
  request: Request,
  context: RouteContext<"projectId">,
): Promise<Response> {
  return createTaskResponse(request, context);
}
