import { join } from "node:path";

import { startPublicReview } from "@/src/server/review/review-application-service";
import {
  ReviewApiError,
  reviewErrorResponse,
} from "@/src/server/review/review-errors";
import { listReviewAttempts } from "@/src/server/review/review-read-service";

type RouteContext = { params: Promise<{ workItemId: string }> };

const MAXIMUM_MUTATION_BODY_BYTES = 128 * 1024;

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

async function readMutationJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  const declaredLength = request.headers.get("content-length");
  const declaredBytes = declaredLength === null ? null : Number(declaredLength);
  if (
    declaredBytes !== null
    && Number.isFinite(declaredBytes)
    && declaredBytes > MAXIMUM_MUTATION_BODY_BYTES
  ) {
    await reader?.cancel().catch(() => undefined);
    throw new ReviewApiError("REQUEST_LIMIT_EXCEEDED");
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAXIMUM_MUTATION_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ReviewApiError("REQUEST_LIMIT_EXCEEDED");
      }
      chunks.push(value);
    }
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

function query(request: Request): { after?: string; limit?: string } {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (!["after", "limit"].includes(key) || parameters.getAll(key).length !== 1) {
      throw new ReviewApiError("INVALID_INPUT");
    }
  }
  return {
    after: parameters.get("after") ?? undefined,
    limit: parameters.get("limit") ?? undefined,
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { workItemId } = await context.params;
  try {
    return Response.json(listReviewAttempts(databasePath(), workItemId, query(request)));
  } catch (error) {
    return reviewErrorResponse(error, "GET /api/work-items/:workItemId/reviews");
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { workItemId } = await context.params;
  let input: unknown;
  try {
    input = await readMutationJson(request);
  } catch (error) {
    return reviewErrorResponse(
      error instanceof ReviewApiError
        ? error
        : new ReviewApiError("INVALID_JSON"),
      "POST /api/work-items/:workItemId/reviews",
    );
  }
  try {
    return Response.json(await startPublicReview(databasePath(), workItemId, input));
  } catch (error) {
    return reviewErrorResponse(error, "POST /api/work-items/:workItemId/reviews");
  }
}
