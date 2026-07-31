import { join } from "node:path";

import {
  listValidationPolicyRevisions,
  ValidationPolicyError,
} from "@/src/server/execution/validation-policy-service";

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
      { error: { code: "INVALID_INPUT", message: "Revision limit is invalid." } },
      { status: 400 },
    );
  }
  try {
    const revisions = listValidationPolicyRevisions(databasePath(), projectId);
    const items = revisions.slice(-limit);
    return Response.json({
      items,
      nextCursor: revisions.length > items.length ? String(items[0]?.revisionNo ?? "") : null,
    });
  } catch (error) {
    if (error instanceof ValidationPolicyError && error.code === "POLICY_NOT_FOUND") {
      return Response.json(
        { error: { code: error.code, message: "Validation policy was not found." } },
        { status: 404 },
      );
    }
    return Response.json(
      { error: { code: "STORAGE_UNAVAILABLE", message: "Storage is unavailable." } },
      { status: 503 },
    );
  }
}
