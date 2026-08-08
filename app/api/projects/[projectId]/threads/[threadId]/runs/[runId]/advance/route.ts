import { threadRunAdvancePost } from "@/src/server/collaboration/thread-run-advance-api";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string; runId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadRunAdvancePost(request, context);
}
