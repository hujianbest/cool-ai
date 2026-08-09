import { threadRunStartPost } from "@/app/api/_shared/collaboration/thread-run-start-api";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadRunStartPost(request, context);
}
