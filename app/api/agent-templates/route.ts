import { agentApiError } from "@/app/api/_shared/agent-api";
import { agentService } from "@/src/composition";

export async function GET(): Promise<Response> {
  try {
    return Response.json({ templates: agentService.getAgentTemplates() });
  } catch (error) {
    return agentApiError(error, "GET /api/agent-templates");
  }
}
