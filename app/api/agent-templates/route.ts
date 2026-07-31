import { agentApiError } from "@/src/server/agent-api";
import { getAgentTemplates } from "@/src/server/agent-service";

export async function GET(): Promise<Response> {
  try {
    return Response.json({ templates: getAgentTemplates() });
  } catch (error) {
    return agentApiError(error, "GET /api/agent-templates");
  }
}
