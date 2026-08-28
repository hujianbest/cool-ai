import { join } from "node:path";

import { z } from "zod";

import {
  parseCurationResourceId,
  readStrictCurationJson,
  requireNoCurationUrlSuffix,
} from "@/app/api/_shared/memory-curation-http";
import { memoryApiError } from "@/app/api/_shared/memory-api";
import { memoryCuration } from "@/src/composition";
import {
  memorySourceTypeSchema,
  memoryTypeSchema,
} from "@/src/shared/memory-contracts";

type RouteContext = { params: Promise<{ projectId: string }> };

const NO_STORE = { "cache-control": "no-store" };
const sourceSchema = z.object({
  id: z.string(),
  type: memorySourceTypeSchema,
  version: z.string().nullable().optional(),
}).strict();
const proposalSchema = z.object({
  agentId: z.string(),
  content: z.string(),
  operationId: z.string(),
  sources: z.array(sourceSchema).min(1).max(8),
  supersedesId: z.string().optional(),
  type: memoryTypeSchema,
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
    { error: { code: "INVALID_INPUT", message: "Curation request is invalid." } },
    { headers: NO_STORE, status: 400 },
  );
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    requireNoCurationUrlSuffix(request);
    const projectId = parseCurationResourceId(
      (await context.params).projectId,
      "projectId",
    );
    return Response.json({
      candidates: memoryCuration.listCurationCandidates(databasePath(), projectId),
    }, { headers: NO_STORE });
  } catch (error) {
    return withNoStore(
      memoryApiError(error, "GET /api/projects/:projectId/memory-curation-candidates"),
    );
  }
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    requireNoCurationUrlSuffix(request);
    const projectId = parseCurationResourceId(
      (await context.params).projectId,
      "projectId",
    );
    const parsed = proposalSchema.safeParse(await readStrictCurationJson(request));
    if (!parsed.success) return invalidRequest();
    return Response.json({
      candidate: memoryCuration.proposeCuration(
        databasePath(),
        projectId,
        parsed.data,
      ),
    }, { headers: NO_STORE, status: 201 });
  } catch (error) {
    return withNoStore(
      memoryApiError(error, "POST /api/projects/:projectId/memory-curation-candidates"),
    );
  }
}
