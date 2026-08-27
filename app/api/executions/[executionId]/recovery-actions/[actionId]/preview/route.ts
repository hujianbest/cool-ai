import { join } from "node:path";

import { executionErrorResponse } from "@/app/api/_shared/execution/execution-api";
import { executionService, recoveryActions, sqliteConnection } from "@/src/composition";

type RouteContext = { params: Promise<{ actionId: string; executionId: string }> };

const ACTION_ID = /^[a-z][a-z0-9_]{0,63}$/u;
const NO_STORE = { "cache-control": "no-store" };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.hash || Array.from(url.searchParams.keys()).length > 0) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Recovery input is invalid." } },
      { headers: NO_STORE, status: 400 },
    );
  }
  const { actionId, executionId } = await context.params;
  if (!ACTION_ID.test(actionId)) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Recovery input is invalid." } },
      { headers: NO_STORE, status: 400 },
    );
  }
  const database = sqliteConnection.openDatabase(databasePath());
  try {
    executionService.executionDtoFromDatabase(database, executionId);
    const preview = recoveryActions.previewRecoveryAction(actionId);
    return Response.json(preview, { headers: NO_STORE });
  } catch (error) {
    return executionErrorResponse(
      error,
      "POST /api/executions/:executionId/recovery-actions/:actionId/preview",
    );
  } finally {
    database.close();
  }
}
