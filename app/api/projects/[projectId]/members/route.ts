import { join } from "node:path";

import {
  membershipApiError,
  readMembershipJson,
} from "@/app/api/_shared/membership-api";
import { membershipService } from "@/src/composition";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

type ReplaceMembersInput = {
  agentIds: string[];
  expectedProjectVersion: number;
};

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    return Response.json(membershipService.getMembers(databasePath(), projectId));
  } catch (error) {
    return membershipApiError(error, "GET /api/projects/:projectId/members");
  }
}

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  const body = await readMembershipJson(request);
  if (!body.ok) return body.response;
  try {
    return Response.json(
      membershipService.replaceMembers(
        databasePath(),
        projectId,
        body.value as ReplaceMembersInput,
      ),
    );
  } catch (error) {
    return membershipApiError(error, "PUT /api/projects/:projectId/members");
  }
}
