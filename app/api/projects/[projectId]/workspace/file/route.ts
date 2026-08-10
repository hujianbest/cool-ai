import { workspaceBrowseFileGet } from "@/app/api/_shared/workspace-browse-api";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return workspaceBrowseFileGet(request, context);
}
