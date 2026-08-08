import { threadHistoryGet } from "@/src/server/collaboration/thread-history-api";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadHistoryGet("facts", request, context);
}
