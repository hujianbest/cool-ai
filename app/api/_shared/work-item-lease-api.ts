import { join } from "node:path";

import { missionApiError, readMissionJson } from "@/app/api/_shared/mission-api";
import { missionWork } from "@/src/composition";
import { MissionError } from "@/src/modules/mission-work";
import type { WorkItem } from "@/src/shared/project-context-contracts";

type FieldError = { field: string; code: string };
type LeaseCommand = {
  actorType: "agent" | "owner";
  agentId?: string;
  expectedVersion: number;
  operationId: string;
};
type LeaseKind = "heartbeat" | "reclaim" | "release";

const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ALLOWED_KEYS = ["actorType", "agentId", "expectedVersion", "operationId"] as const;

function databasePath(): string {
  return process.env.COCKPIT_DB_PATH ?? join(process.cwd(), ".data", "cockpit.sqlite");
}

function invalid(fields: FieldError[]): never {
  throw new MissionError("INVALID_INPUT", 400, "Mission input is invalid.", fields);
}

function workItemIdFrom(
  request: Request,
  workItemId: string,
): string {
  const fields: FieldError[] = [];
  const trimmed = typeof workItemId === "string" ? workItemId.trim() : "";
  if (trimmed.length === 0 || trimmed.length > 200) {
    fields.push({ field: "workItemId", code: "invalid_format" });
  }
  for (const key of new URL(request.url).searchParams.keys()) {
    fields.push({ field: key, code: "not_supported" });
  }
  if (fields.length > 0) invalid(fields);
  return trimmed;
}

function parseLeaseCommand(value: unknown): LeaseCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid([{ field: "body", code: "invalid_format" }]);
  }
  const body = value as Record<string, unknown>;
  const fields: FieldError[] = [];
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.includes(key as (typeof ALLOWED_KEYS)[number])) {
      fields.push({ field: key, code: "not_supported" });
    }
  }
  if (body.actorType !== undefined && body.actorType !== "owner" && body.actorType !== "agent") {
    fields.push({ field: "actorType", code: "invalid_format" });
  }
  const actorType = body.actorType === "owner" ? "owner" : "agent";
  if (actorType === "agent") {
    if (body.agentId === undefined) {
      fields.push({ field: "agentId", code: "required" });
    } else if (typeof body.agentId !== "string" || body.agentId.trim().length === 0) {
      fields.push({ field: "agentId", code: "invalid_format" });
    }
  } else if (body.agentId !== undefined) {
    fields.push({ field: "agentId", code: "not_supported" });
  }
  if (body.expectedVersion === undefined) {
    fields.push({ field: "expectedVersion", code: "required" });
  } else if (
    !Number.isInteger(body.expectedVersion)
    || Number(body.expectedVersion) < 1
  ) {
    fields.push({ field: "expectedVersion", code: "invalid_format" });
  }
  if (body.operationId === undefined) {
    fields.push({ field: "operationId", code: "required" });
  } else if (
    typeof body.operationId !== "string"
    || !OPERATION_ID.test(body.operationId)
  ) {
    fields.push({ field: "operationId", code: "invalid_format" });
  }
  if (fields.length > 0) invalid(fields);
  return {
    actorType,
    ...(actorType === "agent"
      ? { agentId: (body.agentId as string).trim() }
      : {}),
    expectedVersion: Number(body.expectedVersion),
    operationId: body.operationId as string,
  };
}

function applyLeaseCommand(
  kind: LeaseKind,
  workItemId: string,
  command: LeaseCommand,
): WorkItem {
  const path = databasePath();
  const projectId = missionWork.workItemProjectId(path, workItemId);
  switch (kind) {
    case "heartbeat":
      if (command.actorType !== "agent" || !command.agentId) {
        invalid([{ field: "agentId", code: "required" }]);
      }
      return missionWork.heartbeatWorkItem(
        path,
        projectId,
        workItemId,
        command.agentId,
        command.expectedVersion,
        new Date(),
        command.operationId,
      );
    case "release":
      if (command.actorType !== "agent" || !command.agentId) {
        invalid([{ field: "agentId", code: "required" }]);
      }
      return missionWork.releaseWorkItem(
        path,
        projectId,
        workItemId,
        command.agentId,
        command.expectedVersion,
        new Date(),
        command.operationId,
      );
    case "reclaim":
      return missionWork.reclaimExpiredWorkItem(
        path,
        projectId,
        workItemId,
        command.actorType === "owner"
          ? { type: "owner" }
          : { agentId: command.agentId!, type: "agent" },
        command.expectedVersion,
        new Date(),
        command.operationId,
      );
  }
}

export async function postWorkItemLeaseCommand(
  request: Request,
  workItemId: string,
  kind: LeaseKind,
): Promise<Response> {
  const body = await readMissionJson(request);
  if (!body.ok) return body.response;
  try {
    const id = workItemIdFrom(request, workItemId);
    const command = parseLeaseCommand(body.value);
    return Response.json({
      workItem: applyLeaseCommand(kind, id, command),
    });
  } catch (error) {
    return missionApiError(error, `POST /api/work-items/:workItemId/${kind}`);
  }
}
