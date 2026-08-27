import { join } from "node:path";
import { z } from "zod";

import {
  executionErrorResponse,
  readBoundedExecutionJson,
} from "@/app/api/_shared/execution/execution-api";
import { executionService, recoveryActions, sqliteConnection } from "@/src/composition";

type RouteContext = { params: Promise<{ actionId: string; executionId: string }> };

const inputSchema = z.object({
  confirmation: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  operationId: z.string().uuid(),
}).strict();

const ACTION_ID = /^[a-z][a-z0-9_]{0,63}$/u;
const NO_STORE = { "cache-control": "no-store" };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { actionId, executionId } = await context.params;
  if (!ACTION_ID.test(actionId)) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Recovery input is invalid." } },
      { headers: NO_STORE, status: 400 },
    );
  }
  const parsedBody = await readBoundedExecutionJson(request);
  if (!parsedBody.ok) return parsedBody.response;
  const input = inputSchema.safeParse(parsedBody.value);
  if (!input.success) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Recovery input is invalid." } },
      { headers: NO_STORE, status: 400 },
    );
  }

  const database = sqliteConnection.openDatabase(databasePath());
  try {
    const current = executionService.executionDtoFromDatabase(database, executionId);
    const result = recoveryActions.undoRecoveryAction(
      databasePath(),
      current.projectId,
      executionId,
      { ...input.data, actionId },
    );
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    return executionErrorResponse(
      error,
      "POST /api/executions/:executionId/recovery-actions/:actionId/undo",
    );
  } finally {
    database.close();
  }
}
