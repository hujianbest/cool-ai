import { join } from "node:path";

import { listValidationPolicyAudits } from "@/src/server/execution/validation-policy-service";

type RouteContext = { params: Promise<{ projectId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { projectId } = await context.params;
  const limitValue = new URL(request.url).searchParams.get("limit") ?? "20";
  const limit = Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Audit limit is invalid." } },
      { status: 400 },
    );
  }
  try {
    const audits = listValidationPolicyAudits(databasePath(), projectId);
    const items = audits.slice(-limit);
    return Response.json({
      items,
      nextCursor: audits.length > items.length ? String(items[0]?.sequence ?? "") : null,
    });
  } catch {
    return Response.json(
      { error: { code: "STORAGE_UNAVAILABLE", message: "Storage is unavailable." } },
      { status: 503 },
    );
  }
}
