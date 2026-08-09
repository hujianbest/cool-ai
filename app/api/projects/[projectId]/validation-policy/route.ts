import { join } from "node:path";
import { z } from "zod";

import { readBoundedExecutionJson } from "@/app/api/_shared/execution/execution-api";
import { validationPolicySchemaErrorResponse } from "@/app/api/_shared/execution/validation-policy-http";
import { SchemaError, validationPolicyService } from "@/src/composition";
import { ValidationPolicyError } from "@/src/modules/project-workspace";

type RouteContext = { params: Promise<{ projectId: string }> };

const inputSchema = z.object({
  entries: z.array(z.object({
    args: z.array(z.string().max(4096)).max(64),
    executable: z.string().min(1).max(4096),
    required: z.boolean(),
    workdir: z.string().min(1).max(4096),
  }).strict()).max(50),
  expectedVersion: z.number().int().positive(),
  operationId: z.string().uuid(),
  warningAccepted: z.boolean(),
}).strict();

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function errorResponse(error: unknown): Response {
  if (error instanceof ValidationPolicyError) {
    const status = error.code === "POLICY_NOT_FOUND"
      ? 404
      : error.code === "POLICY_VERSION_CONFLICT" || error.code === "OPERATION_CONFLICT"
        ? 409
        : error.code.includes("LIMIT")
          ? 413
          : 400;
    return Response.json(
      {
        error: {
          code: error.code,
          currentVersion: error.currentVersion,
          message: status === 409
            ? "Validation policy changed concurrently."
            : "Validation policy request is invalid.",
        },
      },
      { status },
    );
  }
  if (error instanceof SchemaError) {
    return validationPolicySchemaErrorResponse(error);
  }
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "Validation policy service failed." } },
    { status: 500 },
  );
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  try {
    return Response.json({ policy: validationPolicyService.getValidationPolicy(databasePath(), projectId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectId } = await context.params;
  const parsed = await readBoundedExecutionJson(request);
  if (!parsed.ok) return parsed.response;
  const input = inputSchema.safeParse(parsed.value);
  if (!input.success) {
    return Response.json(
      { error: { code: "INVALID_INPUT", message: "Validation policy input is invalid." } },
      { status: 400 },
    );
  }
  try {
    return Response.json(validationPolicyService.saveValidationPolicy(databasePath(), projectId, input.data));
  } catch (error) {
    return errorResponse(error);
  }
}
