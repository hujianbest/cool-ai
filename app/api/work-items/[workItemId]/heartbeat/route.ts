import { postWorkItemLeaseCommand } from "@/app/api/_shared/work-item-lease-api";

type RouteContext = { params: Promise<{ workItemId: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { workItemId } = await context.params;
  return postWorkItemLeaseCommand(request, workItemId, "heartbeat");
}
