import { randomUUID } from "node:crypto";

import { ProviderVerificationError, SchemaError } from "@/src/composition";
import { ProviderServiceError } from "@/src/modules/identity-capability";

export async function readJsonBody(
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

export function providerApiError(error: unknown, route: string): Response {
  if (error instanceof ProviderServiceError || error instanceof ProviderVerificationError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...("correlationId" in error && error.correlationId
            ? { correlationId: error.correlationId }
            : {}),
          ...("fields" in error && error.fields ? { fields: error.fields } : {}),
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
  console.error({ correlationId, code: "INTERNAL_ERROR", route });
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
