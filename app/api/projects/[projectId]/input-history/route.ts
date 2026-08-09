import {
  inputHistoryDelete,
  inputHistoryGet,
} from "@/app/api/_shared/collaboration/input-history-api";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return inputHistoryGet(request, context);
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return inputHistoryDelete(request, context);
}
