import { join } from "node:path";

import { executionErrorResponse } from "@/app/api/_shared/execution/execution-api";
import { executionService, recoveryActions, sqliteConnection } from "@/src/composition";

type RouteContext = { params: Promise<{ executionId: string }> };

const NO_STORE = { "cache-control": "no-store" };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function GET(
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
  const { executionId } = await context.params;
  const database = sqliteConnection.openDatabase(databasePath());
  try {
    const current = executionService.executionDtoFromDatabase(database, executionId);
    const actions = recoveryActions.listRecoveryActions(
      databasePath(),
      current.projectId,
      executionId,
    );
    return Response.json({
      actions,
      reasonCode: current.reasonCode,
      status: current.status,
    }, { headers: NO_STORE });
  } catch (error) {
    return executionErrorResponse(
      error,
      "GET /api/executions/:executionId/recovery-actions",
    );
  } finally {
    database.close();
  }
}
