import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/server/db";
import {
  MemorySourceResolutionError,
  resolveMemorySource,
} from "@/src/server/memory-source-resolver";
import {
  memoryEntryV6Schema,
  type MemoryEntryV6,
  type MemoryType,
} from "@/src/shared/memory-contracts";

type SourceType = "owner_input" | "work_item" | "artifact_path";
type FieldError = { field: string; code: string };
export type CreateMemoryInput = {
  type: MemoryType;
  content: string;
  sourceType: SourceType;
  sourceRef: string;
  supersedesId?: string;
};
type MemoryResult = MemoryEntryV6;
type MemoryRow = {
  accentToken: string | null;
  active: number;
  chainId: string;
  confirmerChoice: string | null;
  confirmerReviewerAgentId: string | null;
  confirmingReviewAttemptId: string | null;
  content: string;
  createdAt: string;
  decisionId: string | null;
  id: string;
  persistenceActor: string;
  projectId: string;
  proposerActorId: string | null;
  proposerActorType: string;
  proposerAgentName: string | null;
  proposerAvatarText: string | null;
  sourceId: string;
  sourceType: MemoryEntryV6["source"]["type"];
  sourceVersion: string | null;
  supersedesId: string | null;
  type: MemoryType;
  version: number;
};

const memoryTypes: readonly MemoryType[] = [
  "goal",
  "decision",
  "fact",
  "artifact",
  "experience",
];
const sourceTypes: readonly SourceType[] = [
  "owner_input",
  "work_item",
  "artifact_path",
];
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

export class MemoryError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly fields?: FieldError[],
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

function graphemeLength(value: string): number {
  return Array.from(segmenter.segment(value)).length;
}

function invalidInput(fields: FieldError[]): never {
  throw new MemoryError(
    "INVALID_INPUT",
    400,
    "Memory input is invalid.",
    fields,
  );
}

function invalidSource(): never {
  throw new MemoryError(
    "INVALID_SOURCE",
    400,
    "Memory source is invalid.",
    [{ field: "sourceRef", code: "invalid_format" }],
  );
}

export function normalizeArtifactPath(sourceRef: string): string {
  const value = sourceRef.trim();
  if (
    !value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    invalidSource();
  }
  const stack: string[] = [];
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) invalidSource();
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  if (stack.length === 0) invalidSource();
  return stack.join("/");
}

function parseInput(input: CreateMemoryInput): CreateMemoryInput {
  const fields: FieldError[] = [];
  if (
    !input
    || typeof input !== "object"
    || Object.keys(input).some((key) =>
      !["type", "content", "sourceType", "sourceRef", "supersedesId"].includes(key)
    )
  ) {
    fields.push({ field: "input", code: "invalid_format" });
  }
  if (!input || !memoryTypes.includes(input.type)) {
    fields.push({ field: "type", code: "invalid_format" });
  }
  const content = typeof input?.content === "string" ? input.content.trim() : "";
  const contentLength = graphemeLength(content);
  if (typeof input?.content !== "string") {
    fields.push({ field: "content", code: "invalid_format" });
  } else if (contentLength === 0) {
    fields.push({ field: "content", code: "required" });
  } else if (contentLength > 20_000) {
    fields.push({ field: "content", code: "too_long" });
  }
  if (!input || !sourceTypes.includes(input.sourceType)) {
    fields.push({ field: "sourceType", code: "invalid_format" });
  }
  if (
    input?.supersedesId !== undefined &&
    (typeof input.supersedesId !== "string" || input.supersedesId.length === 0)
  ) {
    fields.push({ field: "supersedesId", code: "invalid_format" });
  }
  if (fields.length > 0) invalidInput(fields);

  if (typeof input.sourceRef !== "string") invalidSource();
  const sourceRef = input.sourceRef.trim();
  const sourceLength = graphemeLength(sourceRef);
  if (sourceLength === 0 || sourceLength > 2048) invalidSource();
  return {
    content,
    sourceRef,
    sourceType: input.sourceType,
    supersedesId: input.supersedesId,
    type: input.type,
  };
}

function ensureProject(database: DatabaseSync, projectId: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw new MemoryError("PROJECT_NOT_FOUND", 404, "Project was not found.");
  }
}

function validateSource(
  database: DatabaseSync,
  projectId: string,
  sourceType: SourceType,
  sourceRef: string,
): string {
  if (sourceType === "owner_input") return sourceRef;
  if (sourceType === "artifact_path") return normalizeArtifactPath(sourceRef);
  const workItem = database
    .prepare(
      `SELECT 1
       FROM work_items
       JOIN missions ON missions.id = work_items.mission_id
       WHERE work_items.id = ? AND missions.project_id = ?`,
    )
    .get(sourceRef, projectId);
  if (!workItem) invalidSource();
  return sourceRef;
}

function toMemory(database: DatabaseSync, row: MemoryRow): MemoryResult {
  let source: MemoryEntryV6["source"];
  if (row.proposerActorType === "owner") {
    if (
      row.proposerActorId !== null
      || row.confirmingReviewAttemptId !== null
      || row.sourceVersion !== null
      || !sourceTypes.includes(row.sourceType as SourceType)
    ) invalidSource();
    source = {
      href: null,
      id: row.sourceId,
      type: row.sourceType,
      version: null,
    };
  } else if (row.proposerActorType === "agent") {
    if (
      !row.proposerActorId
      || !row.proposerAgentName
      || !row.proposerAvatarText
      || !row.accentToken
      || !row.confirmingReviewAttemptId
      || !row.decisionId
      || row.confirmerChoice !== "pass"
      || row.confirmerReviewerAgentId !== row.proposerActorId
      || !row.sourceVersion
    ) invalidSource();
    try {
      source = resolveMemorySource(database, {
        confirmingReviewAttemptId: row.confirmingReviewAttemptId,
        id: row.sourceId,
        projectId: row.projectId,
        type: row.sourceType as "task" | "result" | "review" | "validation" | "artifact",
        version: row.sourceVersion,
      });
    } catch (error) {
      if (error instanceof MemorySourceResolutionError) invalidSource();
      throw error;
    }
  } else {
    invalidSource();
  }

  const memory = memoryEntryV6Schema.parse({
    active: row.active === 1,
    actor: row.proposerActorType === "owner"
      ? {
          confirmer: null,
          persistedBy: row.persistenceActor,
          proposerAgent: null,
          proposerType: "owner",
        }
      : {
          confirmer: {
            decisionId: row.decisionId,
            reviewAttemptId: row.confirmingReviewAttemptId,
          },
          persistedBy: row.persistenceActor,
          proposerAgent: {
            accentToken: row.accentToken,
            avatarText: row.proposerAvatarText,
            id: row.proposerActorId,
            name: row.proposerAgentName,
          },
          proposerType: "agent",
        },
    chainId: row.chainId,
    content: row.content,
    createdAt: row.createdAt,
    id: row.id,
    projectId: row.projectId,
    source,
    supersedesId: row.supersedesId,
    type: row.type,
    version: row.version,
  });
  if (row.proposerActorType === "owner") {
    Object.defineProperties(memory, {
      createdBy: { enumerable: false, value: "owner" },
      sourceRef: { enumerable: false, value: row.sourceId },
      sourceType: { enumerable: false, value: row.sourceType },
    });
  }
  return memory as MemoryResult;
}

function memoryById(database: DatabaseSync, memoryId: string): MemoryResult | undefined {
  const row = database
    .prepare(
      `SELECT
         entry.id,
         entry.project_id AS projectId,
         entry.chain_id AS chainId,
         entry.version,
         entry.type,
         entry.content,
         entry.source_type AS sourceType,
         entry.source_id AS sourceId,
         entry.source_version AS sourceVersion,
         entry.proposer_actor_type AS proposerActorType,
         entry.proposer_actor_id AS proposerActorId,
         proposer.name AS proposerAgentName,
         proposer.avatar_text AS proposerAvatarText,
         proposer.accent_token AS accentToken,
         entry.confirming_review_attempt_id AS confirmingReviewAttemptId,
         decision.id AS decisionId,
         decision.choice AS confirmerChoice,
         decision.reviewer_agent_id AS confirmerReviewerAgentId,
         entry.persistence_actor AS persistenceActor,
         entry.supersedes_id AS supersedesId,
         entry.created_at AS createdAt,
         CASE WHEN EXISTS (
           SELECT 1 FROM memory_entries child WHERE child.supersedes_id = entry.id
         ) THEN 0 ELSE 1 END AS active
       FROM memory_entries entry
       LEFT JOIN agents proposer ON proposer.id=entry.proposer_actor_id
       LEFT JOIN review_decisions decision
         ON decision.attempt_id=entry.confirming_review_attempt_id
       WHERE entry.id = ?`,
    )
    .get(memoryId) as MemoryRow | undefined;
  return row ? toMemory(database, row) : undefined;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the stable memory error.
    }
    throw error;
  }
}

export function createMemory(
  databasePath: string,
  projectId: string,
  input: CreateMemoryInput,
): MemoryResult {
  const parsed = parseInput(input);
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      ensureProject(database, projectId);
      const sourceRef = validateSource(
        database,
        projectId,
        parsed.sourceType,
        parsed.sourceRef,
      );
      if (parsed.supersedesId) {
        const target = memoryById(database, parsed.supersedesId);
        if (!target) {
          throw new MemoryError(
            "MEMORY_NOT_FOUND",
            404,
            "Memory entry was not found.",
          );
        }
        if (target.projectId !== projectId || target.type !== parsed.type) {
          throw new MemoryError(
            "MEMORY_TYPE_MISMATCH",
            409,
            "Memory supersede target must have the same project and type.",
          );
        }
        if (!target.active) {
          throw new MemoryError(
            "MEMORY_NOT_ACTIVE",
            409,
            "Memory entry is no longer active.",
          );
        }
      }

      const id = randomUUID();
      const target = parsed.supersedesId
        ? database.prepare(
          "SELECT chain_id AS chainId,version FROM memory_entries WHERE id=?",
        ).get(parsed.supersedesId) as { chainId: string; version: number }
        : null;
      const dedupeHash = createHash("sha256").update(JSON.stringify([
        parsed.type, parsed.content, parsed.sourceType, sourceRef, null,
      ])).digest("hex");
      database
        .prepare(
          `INSERT INTO memory_entries (
             id,project_id,chain_id,version,type,content,dedupe_hash,source_type,
             source_id,source_version,proposer_actor_type,proposer_actor_id,
             confirming_review_attempt_id,persistence_actor,supersedes_id,created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'owner', NULL, NULL,
             'platform', ?, ?)`,
        )
        .run(
          id,
          projectId,
          target?.chainId ?? id,
          (target?.version ?? 0) + 1,
          parsed.type,
          parsed.content,
          dedupeHash,
          parsed.sourceType,
          sourceRef,
          parsed.supersedesId ?? null,
          new Date().toISOString(),
        );
      return memoryById(database, id)!;
    });
  } finally {
    database.close();
  }
}

export function listMemories(
  databasePath: string,
  projectId: string,
  includeInactive = false,
): MemoryResult[] {
  const database = openDatabase(databasePath);
  try {
    return listMemoriesInDatabase(database, projectId, includeInactive);
  } finally {
    database.close();
  }
}

export function listMemoriesInDatabase(
  database: DatabaseSync,
  projectId: string,
  includeInactive = false,
): MemoryResult[] {
  ensureProject(database, projectId);
  const rows = database
    .prepare(
      `SELECT
           entry.id,
           entry.project_id AS projectId,
           entry.chain_id AS chainId,
           entry.version,
           entry.type,
           entry.content,
           entry.source_type AS sourceType,
           entry.source_id AS sourceId,
           entry.source_version AS sourceVersion,
           entry.proposer_actor_type AS proposerActorType,
           entry.proposer_actor_id AS proposerActorId,
           proposer.name AS proposerAgentName,
           proposer.avatar_text AS proposerAvatarText,
           proposer.accent_token AS accentToken,
           entry.confirming_review_attempt_id AS confirmingReviewAttemptId,
           decision.id AS decisionId,
           decision.choice AS confirmerChoice,
           decision.reviewer_agent_id AS confirmerReviewerAgentId,
           entry.persistence_actor AS persistenceActor,
           entry.supersedes_id AS supersedesId,
           entry.created_at AS createdAt,
           CASE WHEN EXISTS (
             SELECT 1 FROM memory_entries child WHERE child.supersedes_id = entry.id
           ) THEN 0 ELSE 1 END AS active
         FROM memory_entries entry
         LEFT JOIN agents proposer ON proposer.id=entry.proposer_actor_id
         LEFT JOIN review_decisions decision
           ON decision.attempt_id=entry.confirming_review_attempt_id
         WHERE entry.project_id = ?
           AND (? = 1 OR NOT EXISTS (
             SELECT 1 FROM memory_entries child WHERE child.supersedes_id = entry.id
           ))
         ORDER BY entry.created_at ASC, entry.id ASC`,
    )
    .all(projectId, Number(includeInactive)) as MemoryRow[];
  return rows.map((row) => toMemory(database, row));
}
