import {
  threadDraftDelete,
  threadDraftGet,
  threadDraftPut,
} from "@/app/api/_shared/collaboration/thread-draft-api";

type RouteContext = {
  params: Promise<{ projectId: string; threadId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadDraftGet(request, context);
}

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadDraftPut(request, context);
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return threadDraftDelete(request, context);
}
