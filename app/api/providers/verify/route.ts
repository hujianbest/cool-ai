import { join } from "node:path";

import { providerApiError, readJsonBody } from "@/src/server/provider-api";
import { verifyProviderDraft } from "@/src/server/provider-service";

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  try {
    return Response.json(await verifyProviderDraft(body.value, databasePath()));
  } catch (error) {
    return providerApiError(error, "POST /api/providers/verify");
  }
}
