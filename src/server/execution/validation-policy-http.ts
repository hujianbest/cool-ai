import { SchemaError } from "@/src/server/storage/schema-error";

export function validationPolicySchemaErrorResponse(error: unknown): Response {
  if (!(error instanceof SchemaError)) {
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Validation policy service failed." } },
      { status: 500 },
    );
  }
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: 503 },
  );
}
