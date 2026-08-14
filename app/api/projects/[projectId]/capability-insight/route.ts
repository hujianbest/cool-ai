import { join } from "node:path";

import { membershipApiError } from "@/app/api/_shared/membership-api";
import { missionApiError } from "@/app/api/_shared/mission-api";
import {
  agentService,
  membershipService,
  missionWork,
  skillService,
} from "@/src/composition";
import { buildCapabilityInsight } from "@/src/modules/identity-capability";
import { MembershipError } from "@/src/modules/project-workspace";
import { capabilityInsightSchema } from "@/src/shared/capability-insight-contracts";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

type FieldError = { code: string; field: string };

const NO_STORE = { "cache-control": "no-store" };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(fields: FieldError[]): Response {
  return Response.json(
    {
      error: {
        code: "INVALID_INPUT",
        fields,
        message: "Capability insight query is invalid.",
      },
    },
    { headers: NO_STORE, status: 400 },
  );
}

function parseProjectId(value: string): string | Response {
  const projectId = typeof value === "string" ? value.trim() : "";
  if (projectId.length === 0 || projectId.length > 200) {
    return invalidInput([{ code: "invalid_format", field: "projectId" }]);
  }
  return projectId;
}

function rejectQuery(request: Request): Response | null {
  const fields: FieldError[] = [];
  for (const key of new Set(new URL(request.url).searchParams.keys())) {
    fields.push({ code: "unknown", field: key });
  }
  return fields.length > 0 ? invalidInput(fields) : null;
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function insightApiError(error: unknown, route: string): Response {
  if (error instanceof MembershipError) {
    return withNoStore(membershipApiError(error, route));
  }
  return withNoStore(missionApiError(error, route));
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const projectId = parseProjectId((await context.params).projectId);
    if (projectId instanceof Response) return projectId;
    const rejected = rejectQuery(request);
    if (rejected) return rejected;

    const membership = membershipService.getMembers(databasePath(), projectId);
    const memberIds = new Set(membership.members.map((member) => member.agentId));
    const agents = agentService
      .listAgents(databasePath())
      .filter((agent) => memberIds.has(agent.id))
      .map((agent) => ({
        id: agent.id,
        model: agent.model,
        name: agent.name,
        permissions: agent.permissions,
        reviewCapable: agent.reviewCapable,
        role: agent.role,
        skillIds: agent.skillIds,
      }));
    const skills = skillService.listSkills(databasePath()).map((skill) => ({
      id: skill.id,
      name: skill.name,
    }));
    const { workItems } = missionWork.getMissionState(databasePath(), projectId);
    const insight = capabilityInsightSchema.parse(
      buildCapabilityInsight({
        agents,
        skills,
        workItems: workItems.map((item) => ({
          assigneeAgentId: item.assigneeAgentId,
          description: item.description,
          id: item.id,
          status: item.status,
          title: item.title,
        })),
      }),
    );
    return Response.json(insight, { headers: NO_STORE });
  } catch (error) {
    return insightApiError(
      error,
      "GET /api/projects/:projectId/capability-insight",
    );
  }
}
