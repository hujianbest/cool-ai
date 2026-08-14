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

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(): Promise<Response> {
  try {
    const path = databasePath();
    const agents = agentService.listAgents(path);
    const firstAgent = agents.at(0);
    if (!firstAgent) {
      return Response.json({ kind: "needs_agent" });
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

    return Response.json({
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
    });
  } catch (error) {
    return (
      storageErrorResponse(error) ??
      internalErrorResponse("GET /api/home")
    );
  }
}
