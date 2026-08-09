import type { DatabaseSync } from "node:sqlite";

import { CollaborationError } from "@/src/modules/public-collaboration";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  timelinePayloadSchemas,
  type CursorPage,
  type TimelineEvent,
  type TimelineEventType,
} from "@/src/shared/collaboration-contracts";

type TimelineEventDto = TimelineEvent & {
  projectId: string;
  threadId: string;
};

type EventRow = {
  id: string;
  projectId: string;
  threadId: string;
  runId: string;
  sequence: number;
  type: string;
  actorType: "owner" | "agent" | "system";
  actorId: string | null;
  payloadJson: string;
  createdAt: string;
};

export type TimelineCursor = {
  after: number;
  limit: number;
};

function resourceNotFound(): never {
  throw new CollaborationError(
    "RESOURCE_NOT_FOUND",
    404,
    "Resource was not found.",
  );
}

function requireRunTuple(
  database: DatabaseSync,
  projectId: string,
  threadId: string,
  runId: string,
): void {
  const row = database.prepare(
    `SELECT 1
     FROM collaboration_runs AS run
     JOIN collaboration_threads AS thread
       ON thread.project_id=run.project_id AND thread.id=run.thread_id
     WHERE run.project_id=? AND run.thread_id=? AND run.id=?`,
  ).get(projectId, threadId, runId);
  if (!row) resourceNotFound();
}

export function readRunTimeline(
  databasePath: string,
  projectId: string,
  threadId: string,
  runId: string,
  cursor: TimelineCursor,
): { body: CursorPage<TimelineEventDto>; status: 200 } {
  const database = openDatabase(databasePath);
  try {
    requireRunTuple(database, projectId, threadId, runId);
    const rows = database.prepare(
      `SELECT id,project_id AS projectId,thread_id AS threadId,run_id AS runId,
              sequence,type,actor_type AS actorType,actor_id AS actorId,
              payload_json AS payloadJson,created_at AS createdAt
       FROM collaboration_events
       WHERE project_id=? AND thread_id=? AND run_id=? AND sequence>?
       ORDER BY sequence ASC
       LIMIT ?`,
    ).all(
      projectId,
      threadId,
      runId,
      cursor.after,
      cursor.limit + 1,
    ) as EventRow[];
    const hasMore = rows.length > cursor.limit;
    const items = (hasMore ? rows.slice(0, cursor.limit) : rows).map(
      ({ payloadJson, ...row }) => {
        const schema = timelinePayloadSchemas[row.type as TimelineEventType];
        if (!schema) {
          throw new Error("Invalid persisted collaboration event type.");
        }
        return {
          ...row,
          payload: schema.parse(JSON.parse(payloadJson)),
        } as TimelineEventDto;
      },
    );
    return {
      body: {
        items,
        nextAfter: hasMore ? items.at(-1)?.sequence ?? null : null,
      },
      status: 200,
    };
  } finally {
    database.close();
  }
}
