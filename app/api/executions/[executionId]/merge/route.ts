import { join } from "node:path";

import {
  executionErrorResponse,
  readBoundedExecutionJson,
} from "@/app/api/_shared/execution/execution-api";
import { mergeService } from "@/src/composition/execution-host";
import { mergeExecutionInputSchema } from "@/src/shared/execution-contracts";

type RouteContext = { params: Promise<{ executionId: string }> };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { executionId } = await context.params;
  const parsed = await readBoundedExecutionJson(request);
  if (!parsed.ok) return parsed.response;
  const input = mergeExecutionInputSchema.safeParse(parsed.value);
  if (!input.success) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Merge input is invalid." } },
      { status: 400 },
    );
  }
  try {
    const result = await mergeService.mergeExecution(databasePath(), executionId, input.data);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    return executionErrorResponse(
      error,
      "POST /api/executions/:executionId/merge",
    );
  }
}
