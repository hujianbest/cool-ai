import { join } from "node:path";

import { agentApiError, readAgentJson } from "@/app/api/_shared/agent-api";
import { agentService } from "@/src/composition";
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
      agent: agentService.updateAgent(
        agentId,
        body.value as UpdateAgentInput,
        databasePath(),
      ),
    });
  } catch (error) {
    return agentApiError(error, "PATCH /api/agents/:agentId");
  }
}
