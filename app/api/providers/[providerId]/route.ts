import { join } from "node:path";

import { providerApiError, readJsonBody } from "@/src/server/provider-api";
import { updateProvider } from "@/src/server/provider-service";

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ providerId: string }> },
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const payload =
    body.value && typeof body.value === "object"
      ? (body.value as { draft?: unknown; validationToken?: unknown })
      : {};
  const { providerId } = await context.params;

  try {
    const provider = updateProvider(
      providerId,
      payload.draft,
      typeof payload.validationToken === "string" ? payload.validationToken : undefined,
      databasePath(),
    );
    return Response.json({ provider });
  } catch (error) {
    return providerApiError(error, "PATCH /api/providers/:id");
  }
}
