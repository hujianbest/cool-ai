import { threadHistoryGet } from "@/app/api/_shared/collaboration/thread-history-api";
import { threadMessagePost } from "@/app/api/_shared/collaboration/thread-message-api";

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
