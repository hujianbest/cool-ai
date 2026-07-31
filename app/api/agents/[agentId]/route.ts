import { join } from "node:path";

import { agentApiError, readAgentJson } from "@/src/server/agent-api";
import { updateAgent } from "@/src/server/agent-service";
import type { UpdateAgentInput } from "@/src/shared/team-contracts";

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const body = await readAgentJson(request);
  if (!body.ok) return body.response;
  const { agentId } = await context.params;

  try {
    return Response.json({
      agent: updateAgent(
        agentId,
        body.value as UpdateAgentInput,
        databasePath(),
      ),
    });
  } catch (error) {
    return agentApiError(error, "PATCH /api/agents/:agentId");
  }
}
