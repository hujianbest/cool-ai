import { workspaceEditStagePost } from "@/app/api/_shared/workspace-edit-api";

type RouteContext = {
  params: Promise<{ projectId: string; editId: string }>;
};

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return workspaceEditStagePost(request, context);
}
