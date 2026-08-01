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
  memoryVersion: number;
  outcome: "created" | "reused" | "superseded";
};

type ActiveMemoryRow = {
  chainId: string;
  content: string;
  id: string;
  sourceId: string;
  sourceType: string;
  sourceVersion: string | null;
  type: string;
  version: number;
};

export class ReviewMemoryCommitError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReviewMemoryCommitError";
  }
}

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
    SELECT entry.id,entry.chain_id AS chainId,entry.version,entry.type,entry.content,
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

function supersedesTarget(
  database: DatabaseSync,
  projectId: string,
  candidate: ReviewMemoryCandidate,
): ActiveMemoryRow {
  const target = database.prepare(`
    SELECT entry.id,entry.project_id AS projectId,entry.chain_id AS chainId,
           entry.version,entry.type,entry.content,
           entry.source_type AS sourceType,entry.source_id AS sourceId,
           entry.source_version AS sourceVersion,
           NOT EXISTS(
             SELECT 1 FROM memory_entries child WHERE child.supersedes_id=entry.id
           ) AS active
    FROM memory_entries entry WHERE entry.id=?
  `).get(candidate.supersedesMemoryId) as
    | (ActiveMemoryRow & { active: number; projectId: string })
    | undefined;
  if (!target || target.projectId !== projectId) {
    throw new ReviewMemoryCommitError(
      "MEMORY_SUPERSEDES_INVALID",
      422,
      "Memory supersede target is invalid.",
    );
  }
  if (target.type !== candidate.type) {
    throw new ReviewMemoryCommitError(
      "MEMORY_TYPE_MISMATCH",
      409,
      "Memory supersede target must have the same type.",
    );
  }
  if (target.active !== 1) {
    throw new ReviewMemoryCommitError(
      "MEMORY_NOT_ACTIVE",
      409,
      "Memory supersede target is no longer active.",
    );
  }
  return target;
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
  const hash = dedupeHash(input.candidate);
  const existing = exactActiveMemory(database, input.projectId, input.candidate, hash);
  const target = input.candidate.supersedesMemoryId === null
    ? null
    : supersedesTarget(database, input.projectId, input.candidate);
  if (target && existing?.id === target.id) {
    throw new ReviewMemoryCommitError(
      "MEMORY_SUPERSEDES_INVALID",
      422,
      "An unchanged active memory cannot supersede itself.",
    );
  }
  const memoryId = existing?.id ?? input.memoryId;
  const outcome = existing ? "reused" : target ? "superseded" : "created";
  const memoryVersion = existing?.version ?? (target?.version ?? 0) + 1;

  if (!existing) {
    database.prepare(`
      INSERT INTO memory_entries(
        id,project_id,chain_id,version,type,content,dedupe_hash,source_type,
        source_id,source_version,proposer_actor_type,proposer_actor_id,
        confirming_review_attempt_id,persistence_actor,supersedes_id,created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?, 'platform', ?, ?)
    `).run(
      memoryId,
      input.projectId,
      target?.chainId ?? memoryId,
      memoryVersion,
      input.candidate.type,
      input.candidate.content,
      hash,
      input.candidate.sourceType,
      input.candidate.sourceId,
      input.candidate.sourceVersion,
      input.reviewerAgentId,
      input.attemptId,
      target?.id ?? null,
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

  return { memoryId, memoryVersion, outcome };
}
