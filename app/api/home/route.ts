import { join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import {
  agentService,
  membershipService,
  projects,
  threadService,
} from "@/src/composition";
import type { HomeState } from "@/src/shared/home-contracts";

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidHomeBody(): Response {
  return Response.json(
    {
      error: {
        code: "INVALID_INPUT",
        message: "Home does not accept a request body.",
      },
    },
    { status: 400 },
  );
}

async function rejectHomeBody(request: Request): Promise<Response | null> {
  if (request.headers.has("content-type")) {
    return invalidHomeBody();
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && declaredLength !== "0") {
    return invalidHomeBody();
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 0) {
    return invalidHomeBody();
  }
  return null;
}

function readReadyHome(path: string): HomeState {
  const agents = agentService.listAgents(path);
  const firstAgent = agents.at(0);
  if (!firstAgent) {
    return { kind: "needs_agent" };
  }

  const project = projects.findDirectProject(path);
  if (!project) {
    return { kind: "needs_direct_chat" };
  }
  const membership = membershipService.getMembers(path, project.id);
  const member = membership.members.at(0);
  if (!member) {
    return { kind: "needs_direct_chat" };
  }
  const threads = threadService.listThreads(path, project.id, { limit: 100 });
  return {
    agent: {
      accentToken: member.accentToken,
      avatarText: member.avatarText,
      id: member.agentId,
      name: member.name,
      role: member.role,
    },
    kind: "ready",
    project,
    threads: threads.body.threads,
  };
}

function ensureReadyHome(path: string): HomeState {
  const agents = agentService.listAgents(path);
  const firstAgent = agents.at(0);
  if (!firstAgent) {
    return { kind: "needs_agent" };
  }

  const project = projects.ensureDirectProject(path);
  let membership = membershipService.getMembers(path, project.id);
  if (membership.members.length === 0) {
    membership = membershipService.setDirectChatAgent(
      path,
      project.id,
      firstAgent.id,
      membership.projectVersion,
    );
  }
  const member = membership.members.at(0);
  if (!member) {
    throw new Error("Direct chat membership is unavailable.");
  }
  const threads = threadService.listThreads(path, project.id, { limit: 100 });
  return {
    agent: {
      accentToken: member.accentToken,
      avatarText: member.avatarText,
      id: member.agentId,
      name: member.name,
      role: member.role,
    },
    kind: "ready",
    project,
    threads: threads.body.threads,
  };
}

export async function GET(): Promise<Response> {
  try {
    return Response.json(readReadyHome(databasePath()));
  } catch (error) {
    return (
      storageErrorResponse(error) ??
      internalErrorResponse("GET /api/home")
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const invalid = await rejectHomeBody(request);
    if (invalid) return invalid;
    return Response.json(ensureReadyHome(databasePath()));
  } catch (error) {
    return (
      storageErrorResponse(error) ??
      internalErrorResponse("POST /api/home")
    );
  }
}
