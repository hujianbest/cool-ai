import { join } from "node:path";
import { z } from "zod";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { answerEscalation } from "@/src/adapters/outbound/sqlite/review-delivery/review-escalation-service";
import {
  ReviewApiError,
  reviewErrorResponse,
} from "@/src/modules/review-delivery";
import { readReviewWorkspace } from "@/src/adapters/outbound/sqlite/review-delivery/review-read-service";
import { reviewWorkspaceDtoSchema } from "@/src/shared/review-contracts";

type RouteContext = { params: Promise<{ escalationId: string }> };

const MAX_REQUEST_BYTES = 128 * 1_024;
const inputSchema = z.object({
  action: z.enum(["continue_review", "rework", "terminate_mission"]),
  answer: z.string().trim().min(1).max(5_000),
  expectedHeadVersion: z.number().int().positive(),
  operationId: z.string().uuid(),
}).strict();
const answerSchema = z.object({
  action: z.enum(["continue_review", "rework", "terminate_mission"]),
  answer: z.string().min(1).max(5_000),
  answerId: z.string().min(1),
  escalationId: z.string().min(1),
  next: z.enum(["new_review_attempt", "new_execution_result", "mission_terminated"]),
  resultId: z.string().min(1),
  state: z.enum(["pending_review", "rework", "owner_terminated"]),
  workItemId: z.string().min(1),
}).strict();
const responseSchema = z.object({
  answer: answerSchema,
  workspace: reviewWorkspaceDtoSchema,
}).strict();

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(): Response {
  return Response.json({
    error: { code: "INVALID_INPUT", message: "输入不符合约束" },
  }, { status: 422 });
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { escalationId } = await context.params;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return reviewErrorResponse(
      new ReviewApiError("INVALID_JSON"),
      "POST /api/escalations/:escalationId/answer",
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
    return reviewErrorResponse(
      new ReviewApiError("REQUEST_LIMIT_EXCEEDED"),
      "POST /api/escalations/:escalationId/answer",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reviewErrorResponse(
      new ReviewApiError("INVALID_JSON"),
      "POST /api/escalations/:escalationId/answer",
    );
  }
  const input = inputSchema.safeParse(raw);
  if (!input.success) return invalidInput();

  const path = databasePath();
  const database = openDatabase(path);
  try {
    const answer = answerEscalation(
      database,
      escalationId,
      input.data,
      { actorType: "owner" },
    );
    database.close();
    const workspace = readReviewWorkspace(path, answer.workItemId);
    const response = responseSchema.safeParse({ answer, workspace });
    if (!response.success) throw new ReviewApiError("REVIEW_INVARIANT_FAILED");
    return Response.json(response.data);
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the stable application error.
    }
    return reviewErrorResponse(error, "POST /api/escalations/:escalationId/answer");
  }
}
