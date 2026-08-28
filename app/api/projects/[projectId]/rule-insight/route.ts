import { join } from "node:path";

import { membershipApiError } from "@/app/api/_shared/membership-api";
import {
  agentService,
  membershipService,
  skillService,
} from "@/src/composition";
import { buildRuleInsight } from "@/src/modules/identity-capability";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

type FieldError = { code: string; field: string };

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
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
        message: "Rule insight query is invalid.",
      },
    },
    { headers: NO_STORE, status: 400 },
  );
}

function parseProjectId(value: string): string | Response {
  let projectId: string;
  try {
    projectId = decodeURIComponent(value);
  } catch {
    return invalidInput([{ code: "invalid_format", field: "projectId" }]);
  }
  if (
    projectId === "."
    || projectId === ".."
    || projectId.includes("/")
    || projectId.includes("\\")
    || projectId.includes("\0")
    || !RESOURCE_ID.test(projectId)
  ) {
    return invalidInput([{ code: "invalid_format", field: "projectId" }]);
  }
  return projectId;
}

function rejectQuery(request: Request): Response | null {
  const url = new URL(request.url);
  const fields: FieldError[] = [];
  if (url.hash) fields.push({ code: "unknown", field: "fragment" });
  for (const key of new Set(url.searchParams.keys())) {
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

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const projectId = parseProjectId((await context.params).projectId);
    if (projectId instanceof Response) return projectId;
    const rejected = rejectQuery(request);
    if (rejected) return rejected;

    const path = databasePath();
    const membership = membershipService.getMembers(path, projectId);
    const memberIds = new Set(membership.members.map((member) => member.agentId));
    const skillsById = new Map(
      skillService.listSkills(path).map((skill) => [skill.id, skill]),
    );
    const agents = agentService
      .listAgents(path)
      .filter((agent) => memberIds.has(agent.id))
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        permissions: {
          runCommands: agent.permissions.runCommands,
          writeFiles: agent.permissions.writeFiles,
        },
        reviewCapable: agent.reviewCapable,
        skills: agent.skillIds.flatMap((skillId) => {
          const skill = skillsById.get(skillId);
          return skill
            ? [
                {
                  id: skill.id,
                  instructions: skill.instructions,
                  name: skill.name,
                },
              ]
            : [];
        }),
        systemPrompt: agent.systemPrompt,
      }));

    return Response.json(buildRuleInsight({ agents }), { headers: NO_STORE });
  } catch (error) {
    return withNoStore(
      membershipApiError(
        error,
        "GET /api/projects/:projectId/rule-insight",
      ),
    );
  }
}
