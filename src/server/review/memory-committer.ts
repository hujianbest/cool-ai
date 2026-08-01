import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ReviewMemoryCandidate = {
  content: string;
  id: string;
  sourceId: string;
  sourceType: string;
  sourceVersion: string;
  supersedesMemoryId: string | null;
  type: string;
};

export type ReviewMemoryAssociation = {
  memoryId: string;
  outcome: "created" | "reused";
};

type ActiveMemoryRow = {
  content: string;
  id: string;
  sourceId: string;
  sourceType: string;
  sourceVersion: string | null;
  type: string;
};

function dedupeHash(candidate: ReviewMemoryCandidate): string {
  return createHash("sha256").update(JSON.stringify([
    candidate.type,
    candidate.content,
    candidate.sourceType,
    candidate.sourceId,
    candidate.sourceVersion,
  ]), "utf8").digest("hex");
}

function exactActiveMemory(
  database: DatabaseSync,
  projectId: string,
  candidate: ReviewMemoryCandidate,
  hash: string,
): ActiveMemoryRow | undefined {
  const rows = database.prepare(`
    SELECT entry.id,entry.type,entry.content,
           entry.source_type AS sourceType,entry.source_id AS sourceId,
           entry.source_version AS sourceVersion
    FROM memory_entries entry
    WHERE entry.project_id=? AND entry.type=? AND entry.dedupe_hash=?
      AND NOT EXISTS (
        SELECT 1 FROM memory_entries child WHERE child.supersedes_id=entry.id
      )
    ORDER BY entry.id
  `).all(projectId, candidate.type, hash) as ActiveMemoryRow[];

  return rows.find((entry) =>
    entry.type === candidate.type
    && entry.content === candidate.content
    && entry.sourceType === candidate.sourceType
    && entry.sourceId === candidate.sourceId
    && entry.sourceVersion === candidate.sourceVersion
  );
}

export function commitReviewMemoryCandidateTx(
  database: DatabaseSync,
  input: {
    attemptId: string;
    candidate: ReviewMemoryCandidate;
    decisionId: string;
    memoryId: string;
    now: string;
    projectId: string;
    reviewerAgentId: string;
  },
): ReviewMemoryAssociation {
  if (input.candidate.supersedesMemoryId !== null) {
    throw new Error("Memory supersedes is not part of deterministic dedupe.");
  }

  const hash = dedupeHash(input.candidate);
  const existing = exactActiveMemory(database, input.projectId, input.candidate, hash);
  const memoryId = existing?.id ?? input.memoryId;
  const outcome = existing ? "reused" : "created";

  if (!existing) {
    database.prepare(`
      INSERT INTO memory_entries(
        id,project_id,chain_id,version,type,content,dedupe_hash,source_type,
        source_id,source_version,proposer_actor_type,proposer_actor_id,
        confirming_review_attempt_id,persistence_actor,supersedes_id,created_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'agent', ?, ?, 'platform', NULL, ?)
    `).run(
      memoryId,
      input.projectId,
      memoryId,
      input.candidate.type,
      input.candidate.content,
      hash,
      input.candidate.sourceType,
      input.candidate.sourceId,
      input.candidate.sourceVersion,
      input.reviewerAgentId,
      input.attemptId,
      input.now,
    );
  }

  database.prepare(`
    INSERT INTO review_memory_associations(
      candidate_id,decision_id,memory_id,outcome,created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    input.candidate.id,
    input.decisionId,
    memoryId,
    outcome,
    input.now,
  );

  return { memoryId, outcome };
}
