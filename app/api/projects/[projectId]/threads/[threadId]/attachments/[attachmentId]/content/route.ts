import { threadAttachmentContentGet } from "@/app/api/_shared/collaboration/thread-attachments-api";

type RouteContext = {
  params: Promise<{ attachmentId: string; projectId: string; threadId: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return threadAttachmentContentGet(request, context);
}
