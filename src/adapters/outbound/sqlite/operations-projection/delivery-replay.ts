import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { listProjectTimeline } from "@/src/adapters/outbound/sqlite/operations-projection/audit-projection-queries";
import {
  OperationsProjectionError,
  type DeliveryReplayDto,
} from "@/src/modules/operations-projection";

const AUDIT_PAGE = 100;

function replayHash(payload: Omit<DeliveryReplayDto, "replayHash">): string {
  const canonical = canonicalize(payload);
  if (canonical === undefined) {
    throw new OperationsProjectionError("INVALID_INPUT", "Replay payload could not be canonicalized.");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function matchesRun(item: DeliveryReplayDto["items"][number], runId: string): boolean {
  return item.payload.runId === runId
    || item.payload.executionId === runId
    || item.executionId === runId;
}

export function getDeliveryReplay(
  databasePath: string,
  projectId: string,
  options: { runId: string },
): DeliveryReplayDto {
  const runId = options.runId.trim();
  if (runId === "") {
    throw new OperationsProjectionError("INVALID_INPUT", "runId is required.");
  }
  const database = openDatabase(databasePath);
  try {
    const project = database.prepare("SELECT 1 AS found FROM projects WHERE id=?").get(projectId);
    if (project === undefined) {
      throw new OperationsProjectionError("PROJECT_NOT_FOUND", "Project was not found.");
    }
  } finally {
    database.close();
  }
  const items = listProjectTimeline(databasePath, projectId, { limit: AUDIT_PAGE })
    .items
    .filter((item) => matchesRun(item, runId));
  const unsigned: Omit<DeliveryReplayDto, "replayHash"> = {
    formatVersion: 1,
    items,
    scope: {
      detail: "只读回放",
      projectId,
      runId,
    },
  };
  return { ...unsigned, replayHash: replayHash(unsigned) };
}
