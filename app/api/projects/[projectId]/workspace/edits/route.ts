import { workspaceEditsPost } from "@/app/api/_shared/workspace-edit-api";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return workspaceEditsPost(request, context);
}
