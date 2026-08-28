import { join } from "node:path";

import { z } from "zod";

import {
  parseCurationResourceId,
  readStrictCurationJson,
  requireNoCurationUrlSuffix,
} from "@/app/api/_shared/memory-curation-http";
import { memoryApiError } from "@/app/api/_shared/memory-api";
import { memoryCuration } from "@/src/composition";

type RouteContext = {
  params: Promise<{ candidateId: string; projectId: string }>;
};

const NO_STORE = { "cache-control": "no-store" };
const decisionSchema = z.object({
  operationId: z.string(),
}).strict();

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function withNoStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

function invalidRequest(): Response {
  return Response.json(
    { error: { code: "INVALID_INPUT", message: "Curation decision is invalid." } },
    { headers: NO_STORE, status: 400 },
  );
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    requireNoCurationUrlSuffix(request);
    const params = await context.params;
    const projectId = parseCurationResourceId(params.projectId, "projectId");
    const candidateId = parseCurationResourceId(params.candidateId, "candidateId");
    const parsed = decisionSchema.safeParse(await readStrictCurationJson(request));
    if (!parsed.success) return invalidRequest();
    return Response.json(
      memoryCuration.decideCuration(databasePath(), projectId, candidateId, {
        action: "reject",
        operationId: parsed.data.operationId,
      }),
      { headers: NO_STORE },
    );
  } catch (error) {
    return withNoStore(
      memoryApiError(
        error,
        "POST /api/projects/:projectId/memory-curation-candidates/:candidateId/reject",
      ),
    );
  }
}
