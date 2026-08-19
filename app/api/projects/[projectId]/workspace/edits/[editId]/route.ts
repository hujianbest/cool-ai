import { workspaceEditGet, workspaceEditPut } from "@/app/api/_shared/workspace-edit-api";

type RouteContext = {
  params: Promise<{ projectId: string; editId: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return workspaceEditGet(request, context);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  return workspaceEditPut(request, context);
}
