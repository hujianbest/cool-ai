import { randomUUID } from "node:crypto";

import { SkillServiceError } from "@/src/modules/identity-capability";
import { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";

export async function readSkillJson(
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

export function skillApiError(error: unknown, route: string): Response {
  if (error instanceof SkillServiceError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
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
