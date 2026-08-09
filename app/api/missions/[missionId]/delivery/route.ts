import { join } from "node:path";

import { deliveryApplicationService, deliveryReadService } from "@/src/composition";
import {
  ReviewApiError,
  reviewErrorResponse,
} from "@/src/modules/review-delivery";
import { generateDeliveryInputSchema } from "@/src/shared/review-contracts";

type RouteContext = { params: Promise<{ missionId: string }> };
const MAX_REQUEST_BYTES = 128 * 1024;

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalidInput(): Response {
  return Response.json({
    error: { code: "INVALID_INPUT", message: "输入不符合约束" },
  }, { status: 422 });
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { missionId } = await context.params;
  try {
    if ([...new URL(request.url).searchParams.keys()].length > 0) {
      throw new ReviewApiError("INVALID_INPUT");
    }
    return Response.json(deliveryReadService.readMissionDelivery(databasePath(), missionId));
  } catch (error) {
    return reviewErrorResponse(error, "GET /api/missions/:missionId/delivery");
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { missionId } = await context.params;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return reviewErrorResponse(
      new ReviewApiError("INVALID_JSON"),
      "POST /api/missions/:missionId/delivery",
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
    return reviewErrorResponse(
      new ReviewApiError("REQUEST_LIMIT_EXCEEDED"),
      "POST /api/missions/:missionId/delivery",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return reviewErrorResponse(
      new ReviewApiError("INVALID_JSON"),
      "POST /api/missions/:missionId/delivery",
    );
  }
  const parsed = generateDeliveryInputSchema.safeParse(value);
  if (!parsed.success) return invalidInput();
  try {
    return Response.json(
      await deliveryApplicationService.generatePublicDelivery(databasePath(), missionId, parsed.data),
    );
  } catch (error) {
    return reviewErrorResponse(error, "POST /api/missions/:missionId/delivery");
  }
}
