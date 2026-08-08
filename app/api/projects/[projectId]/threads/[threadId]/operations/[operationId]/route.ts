import { threadOperationGet } from "@/src/server/collaboration/thread-message-api";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string; operationId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadOperationGet(request, context);
}
