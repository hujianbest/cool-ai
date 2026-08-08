import { threadHistoryGet } from "@/src/server/collaboration/thread-history-api";
import { threadMessagePost } from "@/src/server/collaboration/thread-message-api";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadHistoryGet("messages", request, context);
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadMessagePost(request, context);
}
