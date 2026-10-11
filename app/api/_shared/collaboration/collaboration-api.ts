import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { ContextSnapshotError } from "@/src/application/workflows/project-context-snapshot";
import { SchemaError } from "@/src/composition";
import {
  collaborationErrorBody,
  CollaborationError,
} from "@/src/modules/public-collaboration";

export async function readCollaborationJson(
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

export function collaborationErrorResponse(error: unknown, route: string): Response {
  if (error instanceof CollaborationError) {
    return Response.json(collaborationErrorBody(error), { status: error.httpStatus });
  }
  // 上下文快照失败关闭：稳定 409 + 脱敏 fields（不泄漏原始异常与宿主路径）。
  if (error instanceof ContextSnapshotError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.missing === undefined
            ? {}
            : {
                fields: Object.fromEntries(
                  error.missing.map((fact) => [fact, "required"]),
                ),
              }),
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
  return storageErrorResponse(error) ?? internalErrorResponse(route);
}
