import { workspaceEditDiffGet } from "@/app/api/_shared/workspace-edit-api";

type RouteContext = {
  params: Promise<{ projectId: string; editId: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return workspaceEditDiffGet(request, context);
}
