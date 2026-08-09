import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { CollaborationError } from "@/src/modules/public-collaboration";
import {
  classifyPublicTextFromDatabaseConnection,
} from "@/src/adapters/outbound/sqlite/public-collaboration/public-text-credential-classifier";
import { graphemeLength } from "@/src/modules/public-collaboration/internal/structured-message-schema";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.string().trim().min(1).max(200);
const sourceRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("diff"),
    observationHash: hash,
    observationId: id,
    stagedResultId: id,
  }).strict(),
  z.object({
    artifactHash: hash,
    artifactId: id,
    executionId: id,
    kind: z.literal("file"),
  }).strict(),
  z.object({
    factId: id,
    kind: z.literal("handoff"),
    turnId: id,
  }).strict(),
]);

export type VerifiedSourceRef = z.infer<typeof sourceRefSchema>;
export type VerifiedSourceProjection = {
  actor?: { displayName: string; id: string; type: "agent" };
  display: Record<string, string>;
  identity: { id: string; kind: "artifact" | "execution" | "handoff"; version: string };
  navigation: { executionId?: string; runId?: string; sourceId: string };
  snapshotHash?: string;
  stagedHash?: string;
};

function unavailable(): never {
  throw new CollaborationError("RESOURCE_NOT_FOUND", 404, "Resource was not found.");
}

const HOST_PRIVATE_PATH =
  /(?:^|[\s"'(])(?:[A-Za-z]:\\|\/(?:Users|home|root|etc|var|tmp)\/)/mu;

export function assertPublicProjectionText(database: DatabaseSync, text: string): void {
  if (graphemeLength(text) > 20_000 || HOST_PRIVATE_PATH.test(text)) {
    throw new CollaborationError(
      "CREDENTIAL_CONTENT_REJECTED",
      422,
      "Public source content is not allowed.",
    );
  }
  const category = classifyPublicTextFromDatabaseConnection(database, text);
  if (category) {
    throw new CollaborationError(
      "CREDENTIAL_CONTENT_REJECTED",
      422,
      "Public source content is not allowed.",
      { category },
    );
  }
}

export function resolveVerifiedSource(
  database: DatabaseSync,
  tuple: { projectId: string; runId: string; threadId: string },
  rawInput: unknown,
): VerifiedSourceProjection {
  const parsed = sourceRefSchema.safeParse(rawInput);
  if (!parsed.success) unavailable();
  const input = parsed.data;
  if (input.kind === "diff") {
    const row = database.prepare(
      `SELECT e.id AS executionId,o.observed_hash AS observedHash,
              s.staged_hash AS stagedHash,o.diff_text AS preview
       FROM execution_staged_observations o
       JOIN execution_staged_results s ON s.id=o.staged_result_id
       JOIN executions e
         ON e.id=s.execution_id AND e.project_id=s.project_id
       WHERE e.project_id=? AND e.source_collaboration_thread_id=?
         AND e.source_collaboration_run_id=? AND s.id=? AND o.id=?
         AND o.observed_hash=?`,
    ).get(
      tuple.projectId,
      tuple.threadId,
      tuple.runId,
      input.stagedResultId,
      input.observationId,
      input.observationHash,
    ) as {
      executionId: string;
      observedHash: string;
      preview: string | null;
      stagedHash: string;
    } | undefined;
    if (!row?.preview) unavailable();
    assertPublicProjectionText(database, row.preview);
    return {
      display: { preview: row.preview },
      identity: { id: input.observationId, kind: "execution", version: row.observedHash },
      navigation: { executionId: row.executionId, sourceId: input.observationId },
      snapshotHash: createHash("sha256").update(row.preview).digest("hex"),
      stagedHash: row.stagedHash,
    };
  }
  if (input.kind === "file") {
    const row = database.prepare(
      `SELECT e.id AS executionId,a.name,a.sha256
       FROM execution_artifacts a
       JOIN executions e ON e.id=a.execution_id AND e.project_id=a.project_id
       WHERE e.project_id=? AND e.source_collaboration_thread_id=?
         AND e.source_collaboration_run_id=? AND e.id=? AND a.id=? AND a.sha256=?`,
    ).get(
      tuple.projectId,
      tuple.threadId,
      tuple.runId,
      input.executionId,
      input.artifactId,
      input.artifactHash,
    ) as { executionId: string; name: string; sha256: string } | undefined;
    if (!row) unavailable();
    return {
      display: { name: row.name },
      identity: { id: input.artifactId, kind: "artifact", version: row.sha256 },
      navigation: { executionId: row.executionId, sourceId: input.artifactId },
    };
  }
  const row = database.prepare(
    `SELECT f.run_event_id AS eventId,e.payload_json AS payloadJson,
            e.actor_id AS actorId,e.actor_type AS actorType,
            m.author_display_name AS actorDisplayName
     FROM collaboration_thread_facts f
     JOIN collaboration_events e
       ON (e.project_id,e.thread_id,e.run_id,e.id)=
          (f.project_id,f.thread_id,f.run_id,f.run_event_id)
     JOIN collaboration_turns t
       ON t.project_id=e.project_id AND t.thread_id=e.thread_id
      AND t.run_id=e.run_id AND t.id=json_extract(e.payload_json,'$.turnId')
     JOIN collaboration_messages m
       ON (m.project_id,m.thread_id,m.run_id,m.id)=
          (t.project_id,t.thread_id,t.run_id,t.message_id)
     WHERE f.project_id=? AND f.thread_id=? AND f.run_id=? AND f.id=?
       AND f.type='run_event' AND e.type='handoff' AND t.id=?`,
  ).get(
    tuple.projectId,
    tuple.threadId,
    tuple.runId,
    input.factId,
    input.turnId,
  ) as {
    actorDisplayName: string;
    actorId: string | null;
    actorType: string;
    eventId: string;
    payloadJson: string;
  } | undefined;
  if (!row) unavailable();
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    unavailable();
  }
  if (!payload || typeof payload !== "object") unavailable();
  const record = payload as Record<string, unknown>;
  if (
    typeof record.fromAgentId !== "string"
    || typeof record.toAgentId !== "string"
    || typeof record.summary !== "string"
    || row.actorType !== "agent"
    || row.actorId === null
    || row.actorId !== record.fromAgentId
  ) unavailable();
  assertPublicProjectionText(database, record.summary);
  return {
    actor: { displayName: row.actorDisplayName, id: row.actorId, type: "agent" },
    display: {
      fromAgentId: record.fromAgentId,
      summary: record.summary,
      toAgentId: record.toAgentId,
    },
    identity: { id: input.factId, kind: "handoff", version: row.eventId },
    navigation: { runId: tuple.runId, sourceId: input.factId },
  };
}
