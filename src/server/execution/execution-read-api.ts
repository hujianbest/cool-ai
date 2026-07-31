import { join } from "node:path";

import { executionErrorResponse } from "@/src/server/execution/execution-api";

export function executionDatabasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export function readQuery(request: Request): {
  after?: string;
  limit?: string;
  offset?: string;
} {
  const parameters = new URL(request.url).searchParams;
  const allowed = new Set(["after", "limit", "offset"]);
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) {
      throw new Error("INVALID_READ_QUERY");
    }
  }
  return {
    after: parameters.get("after") ?? undefined,
    limit: parameters.get("limit") ?? undefined,
    offset: parameters.get("offset") ?? undefined,
  };
}

export async function executionReadResponse(
  route: string,
  operation: () => Promise<unknown>,
): Promise<Response> {
  try {
    return Response.json(await operation());
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_READ_QUERY") {
      return Response.json(
        { error: { code: "INVALID_INPUT", message: "The request is invalid." } },
        { status: 400 },
      );
    }
    return executionErrorResponse(error, route);
  }
}
