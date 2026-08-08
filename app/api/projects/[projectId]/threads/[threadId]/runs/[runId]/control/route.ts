import { threadRunControlPost } from "@/src/server/collaboration/thread-run-control-api";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string; runId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadRunControlPost(request, context);
}
