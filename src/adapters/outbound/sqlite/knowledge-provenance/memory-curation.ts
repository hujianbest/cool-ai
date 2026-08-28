import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  listMemoriesInDatabase,
  validateMemorySource,
} from "@/src/adapters/outbound/sqlite/knowledge-provenance/memory-service";
import { canonicalRequestHash } from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import {
  MemoryError,
  type CurationApprovalProjectionDto,
  type CurationCandidateDto,
  type CurationCandidateListItemDto,
  type CurationDecisionResultDto,
  type CurationDiffLineDto,
  type DecideCurationInput,
  type ProposeCurationInput,
} from "@/src/modules/knowledge-provenance";
import {
  memorySourceTypeSchema,
  memoryTypeSchema,
  type MemorySourceType,
  type MemoryType,
} from "@/src/shared/memory-contracts";

type FieldError = { field: string; code: string };
type ParsedSource = {
  id: string;
  type: MemorySourceType;
  version: string | null;
};
type ParsedInput = {
  agentId: string;
  content: string;
  operationId: string;
  sources: ParsedSource[];
  supersedesId: string | null;
  type: MemoryType;
};
type CandidateRow = {
  agentId: string;
  content: string;
  createdAt: string;
  decisionOperationId: string | null;
  decisionRequestHash: string | null;
  id: string;
  projectId: string;
  publishedMemoryId: string | null;
  requestHash: string;
  status: CurationCandidateDto["status"];
  supersedesId: string | null;
  type: MemoryType;
  version: number;
};
type ListCandidateRow = CandidateRow & {
  agentName: string;
  supersededContent: string | null;
};
type ApprovalCandidateRow = {
  content: string;
  createdAt: string;
  id: string;
  status: "pending" | "replaced";
  supersedesId: string | null;
  supersedesVersion: number | null;
};
type AgentSnapshot = {
  accentToken: string;
  avatarText: string;
  name: string;
};
type SupersedesTarget = {
  active: number;
  chainId: string;
  id: string;
  projectId: string;
  type: string;
  version: number;
};

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
const operationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function invalidInput(fields: FieldError[]): never {
  throw new MemoryError("INVALID_INPUT", 400, "Curation input is invalid.", fields);
}

function invalidSource(): never {
  throw new MemoryError(
    "INVALID_SOURCE",
    400,
    "Memory source is invalid.",
    [{ field: "sources", code: "invalid_format" }],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function graphemeLength(value: string): number {
  return Array.from(segmenter.segment(value)).length;
}

function parseSource(value: unknown, index: number, fields: FieldError[]): ParsedSource | null {
  const field = `sources.${index}`;
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => !["type", "id", "version"].includes(key))
  ) {
    fields.push({ field, code: "invalid_format" });
    return null;
  }
  const parsedType = memorySourceTypeSchema.safeParse(value.type);
  if (!parsedType.success) {
    fields.push({ field: `${field}.type`, code: "invalid_format" });
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (id.length === 0) {
    fields.push({
      field: `${field}.id`,
      code: typeof value.id === "string" ? "required" : "invalid_format",
    });
  }
  let version: string | null = null;
  if (value.version !== undefined && value.version !== null) {
    if (typeof value.version !== "string" || value.version.trim().length === 0) {
      fields.push({ field: `${field}.version`, code: "invalid_format" });
    } else {
      version = value.version.trim();
    }
  }
  if (!parsedType.success || id.length === 0) return null;
  return { id, type: parsedType.data, version };
}

function parseInput(value: unknown): ParsedInput {
  const fields: FieldError[] = [];
  if (
    !isRecord(value)
    || Object.keys(value).some((key) =>
      !["agentId", "type", "content", "sources", "supersedesId", "operationId"].includes(key)
    )
  ) {
    invalidInput([{ field: "input", code: "invalid_format" }]);
  }

  const agentId = typeof value.agentId === "string" ? value.agentId.trim() : "";
  if (agentId.length === 0) {
    fields.push({
      field: "agentId",
      code: typeof value.agentId === "string" ? "required" : "invalid_format",
    });
  }
  const parsedType = memoryTypeSchema.safeParse(value.type);
  if (!parsedType.success) fields.push({ field: "type", code: "invalid_format" });

  const content = typeof value.content === "string" ? value.content.trim() : "";
  if (typeof value.content !== "string") {
    fields.push({ field: "content", code: "invalid_format" });
  } else if (content.length === 0) {
    fields.push({ field: "content", code: "required" });
  } else if (graphemeLength(content) > 4000) {
    fields.push({ field: "content", code: "too_long" });
  }

  const operationId = typeof value.operationId === "string" ? value.operationId : "";
  if (!operationIdPattern.test(operationId)) {
    fields.push({ field: "operationId", code: "invalid_format" });
  }

  let supersedesId: string | null = null;
  if (value.supersedesId !== undefined) {
    supersedesId = typeof value.supersedesId === "string" ? value.supersedesId.trim() : "";
    if (supersedesId.length === 0) {
      fields.push({ field: "supersedesId", code: "invalid_format" });
    }
  }

  const sources: ParsedSource[] = [];
  if (!Array.isArray(value.sources)) {
    fields.push({ field: "sources", code: "invalid_format" });
  } else if (value.sources.length === 0) {
    fields.push({ field: "sources", code: "too_small" });
  } else if (value.sources.length > 8) {
    fields.push({ field: "sources", code: "too_big" });
  } else {
    for (const [index, source] of value.sources.entries()) {
      const parsed = parseSource(source, index, fields);
      if (parsed !== null) sources.push(parsed);
    }
  }

  if (!parsedType.success || fields.length > 0) invalidInput(fields);
  return {
    agentId,
    content,
    operationId,
    sources,
    supersedesId,
    type: parsedType.data,
  };
}

function parseDecisionInput(value: unknown): DecideCurationInput {
  const fields: FieldError[] = [];
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => !["action", "operationId"].includes(key))
  ) {
    invalidInput([{ field: "input", code: "invalid_format" }]);
  }
  const action = value.action;
  const operationId = value.operationId;
  if (action !== "publish" && action !== "reject") {
    fields.push({ field: "action", code: "invalid_format" });
  }
  if (
    typeof operationId !== "string"
    || !operationIdPattern.test(operationId)
  ) {
    fields.push({ field: "operationId", code: "invalid_format" });
  }
  if (fields.length > 0) invalidInput(fields);
  if (
    (action !== "publish" && action !== "reject")
    || typeof operationId !== "string"
  ) {
    invalidInput([{ field: "input", code: "invalid_format" }]);
  }
  return {
    action,
    operationId,
  };
}

function ensureProject(database: DatabaseSync, projectId: string): void {
  if (database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId) === undefined) {
    throw new MemoryError("PROJECT_NOT_FOUND", 404, "Project was not found.");
  }
}

function memberSnapshot(
  database: DatabaseSync,
  projectId: string,
  agentId: string,
): AgentSnapshot {
  const member = database.prepare(`
    SELECT agents.name,agents.avatar_text AS avatarText,
           agents.accent_token AS accentToken
    FROM agents
    JOIN project_memberships membership ON membership.agent_id=agents.id
    WHERE agents.id=? AND membership.project_id=?
  `).get(agentId, projectId) as AgentSnapshot | undefined;
  if (member === undefined) {
    throw new MemoryError(
      "AGENT_NOT_MEMBER",
      404,
      "Agent is not a member of this project.",
    );
  }
  return member;
}

function validateSources(
  database: DatabaseSync,
  projectId: string,
  sources: ParsedSource[],
): ParsedSource[] {
  return sources.map((source) => {
    if (
      source.type === "owner_input"
      || source.type === "work_item"
      || source.type === "artifact_path"
    ) {
      if (source.version !== null) invalidSource();
      return {
        id: validateMemorySource(database, projectId, source.type, source.id),
        type: source.type,
        version: null,
      };
    }
    // Review-path source identities need a frozen ReviewAttempt resolver context,
    // which the curation proposal command does not yet own. Fail closed in T-01.
    return invalidSource();
  });
}

function validateSupersedes(
  database: DatabaseSync,
  projectId: string,
  type: MemoryType,
  supersedesId: string | null,
): void {
  if (supersedesId === null) return;
  const target = database.prepare(`
    SELECT project_id AS projectId,type,
      CASE WHEN EXISTS(
        SELECT 1 FROM memory_entries child WHERE child.supersedes_id=memory_entries.id
      ) THEN 0 ELSE 1 END AS active
    FROM memory_entries
    WHERE id=?
  `).get(supersedesId) as { active: number; projectId: string; type: string } | undefined;
  if (target === undefined) {
    throw new MemoryError("MEMORY_NOT_FOUND", 404, "Memory entry was not found.");
  }
  if (target.projectId !== projectId || target.type !== type) {
    throw new MemoryError(
      "MEMORY_TYPE_MISMATCH",
      409,
      "Memory supersede target must have the same project and type.",
    );
  }
  if (target.active !== 1) {
    throw new MemoryError("MEMORY_NOT_ACTIVE", 409, "Memory entry is no longer active.");
  }
}

function toCandidate(database: DatabaseSync, row: CandidateRow): CurationCandidateDto {
  const persistedSources = database.prepare(`
    SELECT source_type AS type,source_id AS id,source_version AS version
    FROM memory_curation_sources
    WHERE candidate_id=?
    ORDER BY position
  `).all(row.id) as ParsedSource[];
  const sources = persistedSources.map((source) => ({
    ...source,
    href: null,
  }));
  return {
    agentId: row.agentId,
    content: row.content,
    createdAt: row.createdAt,
    id: row.id,
    projectId: row.projectId,
    sources,
    status: row.status,
    supersedesId: row.supersedesId,
    type: row.type,
  };
}

function candidateByOperation(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
): CandidateRow | undefined {
  return database.prepare(`
    SELECT id,project_id AS projectId,agent_id AS agentId,type,content,
           supersedes_id AS supersedesId,status,request_hash AS requestHash,
           published_memory_id AS publishedMemoryId,version,
           decision_operation_id AS decisionOperationId,
           decision_request_hash AS decisionRequestHash,
           created_at AS createdAt
    FROM memory_curation_candidates
    WHERE project_id=? AND operation_id=?
  `).get(projectId, operationId) as CandidateRow | undefined;
}

function candidateByDecisionOperation(
  database: DatabaseSync,
  projectId: string,
  operationId: string,
): CandidateRow | undefined {
  return database.prepare(`
    SELECT id,project_id AS projectId,agent_id AS agentId,type,content,
           supersedes_id AS supersedesId,status,request_hash AS requestHash,
           published_memory_id AS publishedMemoryId,version,
           decision_operation_id AS decisionOperationId,
           decision_request_hash AS decisionRequestHash,
           created_at AS createdAt
    FROM memory_curation_candidates
    WHERE project_id=? AND decision_operation_id=?
  `).get(projectId, operationId) as CandidateRow | undefined;
}

function candidateById(
  database: DatabaseSync,
  projectId: string,
  candidateId: string,
): CandidateRow | undefined {
  return database.prepare(`
    SELECT id,project_id AS projectId,agent_id AS agentId,type,content,
           supersedes_id AS supersedesId,status,request_hash AS requestHash,
           published_memory_id AS publishedMemoryId,version,
           decision_operation_id AS decisionOperationId,
           decision_request_hash AS decisionRequestHash,
           created_at AS createdAt
    FROM memory_curation_candidates
    WHERE project_id=? AND id=?
  `).get(projectId, candidateId) as CandidateRow | undefined;
}

function lcsPrefixLengths(left: readonly string[], right: readonly string[]): Uint32Array {
  let previous = new Uint32Array(right.length + 1);
  for (const leftLine of left) {
    const current = new Uint32Array(right.length + 1);
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current[rightIndex + 1] = leftLine === right[rightIndex]
        ? previous[rightIndex] + 1
        : Math.max(previous[rightIndex + 1], current[rightIndex]);
    }
    previous = current;
  }
  return previous;
}

function longestCommonSubsequence(
  oldLines: readonly string[],
  newLines: readonly string[],
): string[] {
  if (oldLines.length === 0 || newLines.length === 0) return [];
  if (oldLines.length === 1) {
    return newLines.includes(oldLines[0] ?? "") ? [oldLines[0] ?? ""] : [];
  }

  const midpoint = Math.floor(oldLines.length / 2);
  const before = lcsPrefixLengths(oldLines.slice(0, midpoint), newLines);
  const after = lcsPrefixLengths(
    oldLines.slice(midpoint).reverse(),
    newLines.slice().reverse(),
  );
  let split = 0;
  let best = -1;
  for (let index = 0; index <= newLines.length; index += 1) {
    const score = (before[index] ?? 0) + (after[newLines.length - index] ?? 0);
    if (score > best) {
      best = score;
      split = index;
    }
  }
  return [
    ...longestCommonSubsequence(
      oldLines.slice(0, midpoint),
      newLines.slice(0, split),
    ),
    ...longestCommonSubsequence(
      oldLines.slice(midpoint),
      newLines.slice(split),
    ),
  ];
}

function lineDiff(
  priorContent: string | null,
  candidateContent: string,
): CurationDiffLineDto[] {
  const newLines = candidateContent.split("\n");
  if (priorContent === null) {
    return newLines.map((text) => ({ kind: "added", text }));
  }
  const oldLines = priorContent.split("\n");
  const commonLines = longestCommonSubsequence(oldLines, newLines);
  const diff: CurationDiffLineDto[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const commonLine of commonLines) {
    while (oldIndex < oldLines.length && oldLines[oldIndex] !== commonLine) {
      diff.push({ kind: "removed", text: oldLines[oldIndex] ?? "" });
      oldIndex += 1;
    }
    while (newIndex < newLines.length && newLines[newIndex] !== commonLine) {
      diff.push({ kind: "added", text: newLines[newIndex] ?? "" });
      newIndex += 1;
    }
    diff.push({ kind: "unchanged", text: commonLine });
    oldIndex += 1;
    newIndex += 1;
  }
  while (oldIndex < oldLines.length) {
    diff.push({ kind: "removed", text: oldLines[oldIndex] ?? "" });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    diff.push({ kind: "added", text: newLines[newIndex] ?? "" });
    newIndex += 1;
  }
  return diff;
}

function listCurationCandidatesInDatabase(
  database: DatabaseSync,
  projectId: string,
): CurationCandidateListItemDto[] {
  const rows = database.prepare(`
    SELECT candidate.id,candidate.project_id AS projectId,
           candidate.agent_id AS agentId,candidate.agent_name AS agentName,
           candidate.type,candidate.content,
           candidate.supersedes_id AS supersedesId,
           candidate.status,candidate.request_hash AS requestHash,
           candidate.published_memory_id AS publishedMemoryId,candidate.version,
           candidate.decision_operation_id AS decisionOperationId,
           candidate.decision_request_hash AS decisionRequestHash,
           candidate.created_at AS createdAt,
           superseded.content AS supersededContent
    FROM memory_curation_candidates candidate
    LEFT JOIN memory_entries superseded
      ON superseded.project_id=candidate.project_id
     AND superseded.id=candidate.supersedes_id
    WHERE candidate.project_id=?
    ORDER BY candidate.created_at DESC,candidate.id ASC
  `).all(projectId) as ListCandidateRow[];
  return rows.map((row) => ({
    ...toCandidate(database, row),
    agentName: row.agentName,
    diff: lineDiff(row.supersededContent, row.content),
  }));
}

export function listCurationCandidates(
  databasePath: string,
  projectId: string,
): CurationCandidateListItemDto[] {
  const database = openDatabase(databasePath);
  try {
    ensureProject(database, projectId);
    return listCurationCandidatesInDatabase(database, projectId);
  } finally {
    database.close();
  }
}

export function listPendingCurationApprovals(
  databasePath: string,
  projectId: string,
): CurationApprovalProjectionDto[] {
  const database = openDatabase(databasePath);
  try {
    ensureProject(database, projectId);
    return database.prepare(`
      SELECT candidate.id,candidate.content,candidate.status,
             candidate.supersedes_id AS supersedesId,
             candidate.created_at AS createdAt,
             superseded.version AS supersedesVersion
      FROM memory_curation_candidates candidate
      LEFT JOIN memory_entries superseded
        ON superseded.project_id=candidate.project_id
       AND superseded.id=candidate.supersedes_id
      WHERE candidate.project_id=?
        AND candidate.status IN('pending','replaced')
      ORDER BY candidate.created_at DESC,candidate.id ASC
    `).all(projectId) as ApprovalCandidateRow[];
  } finally {
    database.close();
  }
}

function actionConflict(): never {
  throw new MemoryError(
    "ACTION_CONFLICT",
    409,
    "Curation candidate cannot perform that action.",
  );
}

function operationConflict(): never {
  throw new MemoryError(
    "OPERATION_CONFLICT",
    409,
    "Operation already exists with different input.",
  );
}

function supersedesTarget(
  database: DatabaseSync,
  candidate: CandidateRow,
): SupersedesTarget | undefined {
  if (candidate.supersedesId === null) return undefined;
  return database.prepare(`
    SELECT entry.id,entry.project_id AS projectId,entry.chain_id AS chainId,
           entry.version,entry.type,
           CASE WHEN EXISTS(
             SELECT 1 FROM memory_entries child WHERE child.supersedes_id=entry.id
           ) THEN 0 ELSE 1 END AS active
    FROM memory_entries entry
    WHERE entry.id=?
  `).get(candidate.supersedesId) as SupersedesTarget | undefined;
}

function decisionResult(
  database: DatabaseSync,
  projectId: string,
  candidateId: string,
  memoryId: string | null,
): CurationDecisionResultDto {
  const candidate = listCurationCandidatesInDatabase(database, projectId)
    .find((item) => item.id === candidateId);
  if (candidate === undefined) {
    throw new MemoryError("STORAGE_UNAVAILABLE", 503, "Memory storage is unavailable.");
  }
  if (memoryId === null) return { candidate, memory: null };
  const memory = listMemoriesInDatabase(database, projectId, true)
    .find((item) => item.id === memoryId);
  if (memory === undefined) {
    throw new MemoryError("STORAGE_UNAVAILABLE", 503, "Memory storage is unavailable.");
  }
  return { candidate, memory };
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

export function proposeCuration(
  databasePath: string,
  projectId: string,
  input: ProposeCurationInput,
): CurationCandidateDto {
  const parsed = parseInput(input);
  const requestHash = canonicalRequestHash(parsed);
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      ensureProject(database, projectId);
      const existing = candidateByOperation(database, projectId, parsed.operationId);
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) {
          throw new MemoryError(
            "OPERATION_CONFLICT",
            409,
            "Operation already exists with different input.",
          );
        }
        return toCandidate(database, existing);
      }

      const agent = memberSnapshot(database, projectId, parsed.agentId);
      const sources = validateSources(database, projectId, parsed.sources);
      validateSupersedes(database, projectId, parsed.type, parsed.supersedesId);

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      database.prepare(`
        INSERT INTO memory_curation_candidates(
          id,project_id,agent_id,agent_name,agent_avatar_text,agent_accent_token,
          type,content,supersedes_id,status,published_memory_id,operation_id,
          request_hash,decision_operation_id,decision_request_hash,
          version,created_at,decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL, 1, ?, NULL)
      `).run(
        id,
        projectId,
        parsed.agentId,
        agent.name,
        agent.avatarText,
        agent.accentToken,
        parsed.type,
        parsed.content,
        parsed.supersedesId,
        parsed.operationId,
        requestHash,
        createdAt,
      );
      const insertSource = database.prepare(`
        INSERT INTO memory_curation_sources(
          candidate_id,position,source_type,source_id,source_version
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const [position, source] of sources.entries()) {
        insertSource.run(id, position, source.type, source.id, source.version);
      }
      const created = candidateByOperation(database, projectId, parsed.operationId);
      if (created === undefined) {
        throw new MemoryError("STORAGE_UNAVAILABLE", 503, "Memory storage is unavailable.");
      }
      return toCandidate(database, created);
    });
  } finally {
    database.close();
  }
}

export function decideCuration(
  databasePath: string,
  projectId: string,
  candidateId: string,
  input: DecideCurationInput,
): CurationDecisionResultDto {
  const parsed = parseDecisionInput(input);
  const decisionRequestHash = canonicalRequestHash({
    action: parsed.action,
    operationId: parsed.operationId,
  });
  const outcome = (() => {
    const database = openDatabase(databasePath);
    try {
      return transaction(database, () => {
        ensureProject(database, projectId);
        const operationCandidate = candidateByDecisionOperation(
          database,
          projectId,
          parsed.operationId,
        );
        if (operationCandidate !== undefined) {
          if (
            operationCandidate.id !== candidateId
            || operationCandidate.decisionRequestHash !== decisionRequestHash
          ) {
            operationConflict();
          }
        }
        const candidate = candidateById(database, projectId, candidateId);
        if (candidate === undefined) {
          throw new MemoryError(
            "CURATION_NOT_FOUND",
            404,
            "Curation candidate was not found.",
          );
        }

        if (candidate.status === "published") {
          if (parsed.action !== "publish") actionConflict();
          if (candidate.publishedMemoryId === null) {
            throw new MemoryError(
              "STORAGE_UNAVAILABLE",
              503,
              "Memory storage is unavailable.",
            );
          }
          return {
            kind: "completed" as const,
            result: decisionResult(
              database,
              projectId,
              candidate.id,
              candidate.publishedMemoryId,
            ),
          };
        }
        if (candidate.status === "rejected") {
          if (parsed.action !== "reject") actionConflict();
          return {
            kind: "completed" as const,
            result: decisionResult(database, projectId, candidate.id, null),
          };
        }
        if (candidate.status === "replaced") {
          return { kind: "replaced" as const };
        }

        const target = supersedesTarget(database, candidate);
        if (
          candidate.supersedesId !== null
          && (
            target === undefined
            || target.projectId !== projectId
            || target.type !== candidate.type
            || target.active !== 1
          )
        ) {
          database.prepare(`
            UPDATE memory_curation_candidates
            SET status='replaced',decided_at=?,decision_operation_id=?,
                decision_request_hash=?,version=version+1
            WHERE project_id=? AND id=? AND status='pending'
          `).run(
            new Date().toISOString(),
            parsed.operationId,
            decisionRequestHash,
            projectId,
            candidate.id,
          );
          return { kind: "replaced" as const };
        }

        if (parsed.action === "reject") {
          const decidedAt = new Date().toISOString();
          database.prepare(`
            UPDATE memory_curation_candidates
            SET status='rejected',decided_at=?,decision_operation_id=?,
                decision_request_hash=?,version=version+1
            WHERE project_id=? AND id=? AND status='pending'
          `).run(
            decidedAt,
            parsed.operationId,
            decisionRequestHash,
            projectId,
            candidate.id,
          );
          return {
            kind: "completed" as const,
            result: decisionResult(database, projectId, candidate.id, null),
          };
        }

        const sources = validateSources(
          database,
          projectId,
          toCandidate(database, candidate).sources,
        );
        const primarySource = sources[0];
        if (primarySource === undefined) invalidSource();

        const memoryId = randomUUID();
        const sourceVersion = primarySource.version;
        const dedupeHash = createHash("sha256").update(JSON.stringify([
          candidate.type,
          candidate.content,
          primarySource.type,
          primarySource.id,
          sourceVersion,
          candidate.agentId,
        ]), "utf8").digest("hex");
        const decidedAt = new Date().toISOString();
        database.prepare(`
          INSERT INTO memory_entries(
            id,project_id,chain_id,version,type,content,dedupe_hash,
            source_type,source_id,source_version,proposer_actor_type,
            proposer_actor_id,confirming_review_attempt_id,persistence_actor,
            supersedes_id,created_at
          ) VALUES (
            ?,?,?,?,?,?,?,?,?,?,'agent',?,NULL,'platform',?,?
          )
        `).run(
          memoryId,
          projectId,
          target?.chainId ?? memoryId,
          (target?.version ?? 0) + 1,
          candidate.type,
          candidate.content,
          dedupeHash,
          primarySource.type,
          primarySource.id,
          sourceVersion,
          candidate.agentId,
          candidate.supersedesId,
          decidedAt,
        );
        database.prepare(`
          UPDATE memory_curation_candidates
          SET status='published',published_memory_id=?,decided_at=?,
              decision_operation_id=?,decision_request_hash=?,version=version+1
          WHERE project_id=? AND id=? AND status='pending'
        `).run(
          memoryId,
          decidedAt,
          parsed.operationId,
          decisionRequestHash,
          projectId,
          candidate.id,
        );
        return {
          kind: "completed" as const,
          result: decisionResult(database, projectId, candidate.id, memoryId),
        };
      });
    } finally {
      database.close();
    }
  })();

  if (outcome.kind === "replaced") {
    throw new MemoryError(
      "MEMORY_NOT_ACTIVE",
      409,
      "Memory entry is no longer active.",
    );
  }
  return outcome.result;
}
