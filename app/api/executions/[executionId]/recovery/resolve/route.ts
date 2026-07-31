import { join } from "node:path";
import { z } from "zod";

import { openDatabase } from "@/src/server/db";
import {
  executionErrorResponse,
  readExecutionJson,
} from "@/src/server/execution/execution-api";
import {
  executionDtoFromDatabase,
} from "@/src/server/execution/execution-service";
import { resolveManualRecovery } from "@/src/server/execution/merge-journal-service";

type RouteContext = { params: Promise<{ executionId: string }> };

const inputSchema = z.object({
  action: z.enum(["recovered_old", "recovered_new", "abandon"]),
  expectedVersion: z.number().int().positive(),
  observedManifestHash: z.string().regex(/^[0-9a-f]{64}$/u),
  operationId: z.string().uuid(),
}).strict();

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { executionId } = await context.params;
  const parsedBody = await readExecutionJson(request);
  if (!parsedBody.ok) return parsedBody.response;
  const input = inputSchema.safeParse(parsedBody.value);
  if (!input.success) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Manual recovery input is invalid." } },
      { status: 400 },
    );
  }

  const database = openDatabase(databasePath());
  try {
    const current = executionDtoFromDatabase(database, executionId);
    const result = await resolveManualRecovery({
      ...input.data,
      database,
      executionId,
      projectId: current.projectId,
    });
    if (result.status !== 200) {
      return Response.json(result.body, { status: result.status });
    }
    const body = result.body as Record<string, unknown>;
    return Response.json({
      ...body,
      execution: executionDtoFromDatabase(database, executionId),
    });
  } catch (error) {
    return executionErrorResponse(
      error,
      "POST /api/executions/:executionId/recovery/resolve",
    );
  } finally {
    database.close();
  }
}
