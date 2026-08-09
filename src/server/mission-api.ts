import { randomUUID } from "node:crypto";

import { MissionError } from "@/src/server/mission-service";
import { CompletionGateError } from "@/src/server/review/completion-gate";
import { SchemaError } from "@/src/server/storage/schema-error";

export async function readMissionJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return {
      ok: false,
      response: Response.json(
        { error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } },
        { status: 400 },
      ),
    };
  }
}

export function missionApiError(error: unknown, route: string): Response {
  if (error instanceof MissionError || error instanceof CompletionGateError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error instanceof CompletionGateError && error.blockers
            ? { blockers: error.blockers }
            : {}),
          ...(error instanceof MissionError && error.fields
            ? { fields: error.fields }
            : {}),
          ...(error.currentVersion !== undefined
            ? { currentVersion: error.currentVersion }
            : {}),
        },
      },
      { status: error.httpStatus },
    );
  }
  if (error instanceof SchemaError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: 503 },
    );
  }
  const correlationId = randomUUID();
  console.error({ code: "INTERNAL_ERROR", correlationId, route });
  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        correlationId,
        message: "An unexpected error occurred.",
      },
    },
    { status: 500 },
  );
}
