import { join } from "node:path";

import { providerApiError, readJsonBody } from "@/app/api/_shared/provider-api";
import { providerService } from "@/src/composition";

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(): Promise<Response> {
  try {
    return Response.json({ providers: providerService.listProviders(databasePath()) });
  } catch (error) {
    return providerApiError(error, "GET /api/providers");
  }
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const payload =
    body.value && typeof body.value === "object"
      ? (body.value as { draft?: unknown; validationToken?: unknown })
      : {};

  try {
    const provider = providerService.createProvider(
      payload.draft,
      typeof payload.validationToken === "string" ? payload.validationToken : undefined,
      databasePath(),
    );
    return Response.json({ provider }, { status: 201 });
  } catch (error) {
    return providerApiError(error, "POST /api/providers");
  }
}
