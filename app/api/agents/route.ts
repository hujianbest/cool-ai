import { join } from "node:path";

import { agentApiError, readAgentJson } from "@/app/api/_shared/agent-api";
import { agentService } from "@/src/composition";
import type { AgentInput } from "@/src/shared/team-contracts";

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(): Promise<Response> {
  try {
    return Response.json({ agents: agentService.listAgents(databasePath()) });
  } catch (error) {
    return agentApiError(error, "GET /api/agents");
  }
}

export async function POST(request: Request): Promise<Response> {
  const body = await readAgentJson(request);
  if (!body.ok) return body.response;

  try {
    return Response.json(
      { agent: agentService.createAgent(body.value as AgentInput, databasePath()) },
      { status: 201 },
    );
  } catch (error) {
    return agentApiError(error, "POST /api/agents");
  }
}
