import { threadAttachmentPost } from "@/app/api/_shared/collaboration/thread-attachments-api";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadAttachmentPost(request, context);
}
