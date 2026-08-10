import { join } from "node:path";

import {
  internalErrorResponse,
  storageErrorResponse,
} from "@/app/api/_shared/api-errors";
import { governanceApprovalCenterQueries, SchemaError } from "@/src/composition";
import { GovernanceError } from "@/src/modules/governance";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

type FieldError = { code: string; field: string };

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
const NO_STORE = { "cache-control": "no-store" };

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(fields: FieldError[]): Response {
  return Response.json(
    {
      error: {
        code: "INVALID_INPUT",
        fields,
        message: "Pending approvals query is invalid.",
      },
    },
    { headers: NO_STORE, status: 400 },
  );
}

function parseProjectId(value: string): string | Response {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return invalidInput([{ code: "invalid_format", field: "projectId" }]);
  }
  if (
    decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || decoded.includes("\0")
    || !RESOURCE_ID.test(decoded)
  ) {
    return invalidInput([{ code: "invalid_format", field: "projectId" }]);
  }
  return decoded;
}

// 审批中心列表是完整快照（无分页参数），任何 query/fragment 都按未知字段拒绝。
function rejectQuery(request: Request): Response | null {
  const url = new URL(request.url);
  const fields: FieldError[] = [];
  if (url.hash) fields.push({ code: "unknown", field: "fragment" });
  for (const key of new Set(url.searchParams.keys())) {
    fields.push({ code: "unknown", field: key });
  }
  return fields.length > 0 ? invalidInput(fields) : null;
}

function pendingApprovalsErrorResponse(error: unknown, route: string): Response {
  if (error instanceof GovernanceError) {
    const status =
      error.code === "PROJECT_NOT_FOUND"
        ? 404
        : error.code === "INVALID_INPUT"
          ? 400
          : 500;
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { headers: NO_STORE, status },
    );
  }
  if (error instanceof SchemaError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { headers: NO_STORE, status: 503 },
    );
  }
  return storageErrorResponse(error) ?? internalErrorResponse(route);
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const projectId = parseProjectId((await context.params).projectId);
    if (projectId instanceof Response) return projectId;
    const rejected = rejectQuery(request);
    if (rejected) return rejected;
    const approvals = governanceApprovalCenterQueries.listPendingApprovals(
      databasePath(),
      projectId,
    );
    return Response.json({ approvals }, { headers: NO_STORE });
  } catch (error) {
    return pendingApprovalsErrorResponse(
      error,
      "GET /api/projects/:projectId/approvals/pending",
    );
  }
}
