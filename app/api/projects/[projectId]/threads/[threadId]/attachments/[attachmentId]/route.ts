import { threadAttachmentDelete } from "@/app/api/_shared/collaboration/thread-attachments-api";

type RouteContext = {
  params: Promise<{ attachmentId: string; projectId: string; threadId: string }>;
};

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadAttachmentDelete(request, context);
}
