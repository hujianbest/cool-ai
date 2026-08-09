import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { redactProcessOutput } from "@/src/adapters/outbound/workspace/process-runner";
import { executionEventDtoSchema } from "@/src/shared/execution-contracts";

const MAX_MATERIAL_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;
const SENSITIVE_TEXT =
  /(?:(?:^|[\s"'(])(?:[A-Za-z]:\\|\/(?:Users|home|root|workspace)\/)|private\s+prompt|system\s*prompt|chain[-_\s]?of[-_\s]?thought|hidden\s+(?:reasoning|thoughts?))/iu;

export type VersionRef = {
  id: string;
  type: "task" | "result" | "review" | "validation" | "artifact" | "memory" | "execution";
  version: string;
};

export type FrozenPublicContent = {
  chunks: Array<{ bytes: number; offset: number; sha256: string; text: string }>;
  includedBytes: number;
  mediaType: "text/plain" | "text/x-diff" | "application/json";
  originalBytes: number | null;
  reasonCode:
    | null
    | "SOURCE_MISSING"
    | "SOURCE_UNREADABLE"
    | "SOURCE_REDACTED"
    | "MATERIAL_BUDGET_EXHAUSTED";
  sha256: string | null;
  source: VersionRef;
  status: "complete" | "truncated" | "missing" | "unreadable";
};

type ReviewMaterial = Record<string, any> & {
  artifacts: Array<{ content: FrozenPublicContent; id: string }>;
  auditEvents: Array<{ payload: FrozenPublicContent }>;
  changes: Record<string, any> & {
    observations: Array<Record<string, any> & { publicDiff: FrozenPublicContent }>;
  };
  sourceRefs: VersionRef[];
  validations: Array<{
    afterLastWrite: boolean;
    exitCode: number;
    required: boolean;
    stderr: FrozenPublicContent;
    stdout: FrozenPublicContent;
    succeeded: boolean;
  }>;
};

type ContentCandidate = {
  content: FrozenPublicContent;
  required: boolean;
  stream: string;
  text: string | null;
};

const requiredByMaterial = new WeakMap<object, Set<string>>();

class ReviewMaterialInvalidError extends Error {
  readonly code = "REVIEW_MATERIAL_INVALID";
  readonly status = 422;

  constructor() {
    super("公开复核材料无效");
    this.name = "ReviewMaterialInvalidError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function containsPrivateMaterial(value: string): boolean {
  return SENSITIVE_TEXT.test(value) || redactProcessOutput(value) !== value;
}

function contentKey(content: FrozenPublicContent): string {
  return `${content.source.type}:${content.source.id}:${content.source.version}`;
}

function chunks(text: string): Array<{ bytes: number; offset: number; sha256: string; text: string }> {
  if (text.length === 0) return [];
  const output: Array<{ bytes: number; offset: number; sha256: string; text: string }> = [];
  let current = "";
  let currentBytes = 0;
  let offset = 0;
  const flush = () => {
    if (currentBytes === 0) return;
    output.push({ bytes: currentBytes, offset, sha256: sha256(current), text: current });
    offset += currentBytes;
    current = "";
    currentBytes = 0;
  };
  for (const point of text) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (currentBytes + bytes > MAX_CHUNK_BYTES) flush();
    current += point;
    currentBytes += bytes;
  }
  flush();
  return output;
}

function emptyContent(
  source: VersionRef,
  mediaType: FrozenPublicContent["mediaType"],
  originalBytes: number | null,
  expectedHash: string | null,
): FrozenPublicContent {
  return {
    chunks: [],
    includedBytes: 0,
    mediaType,
    originalBytes,
    reasonCode: null,
    sha256: expectedHash,
    source,
    status: "complete",
  };
}

function markUnavailable(
  content: FrozenPublicContent,
  status: "missing" | "unreadable",
  reasonCode: "SOURCE_MISSING" | "SOURCE_UNREADABLE" | "SOURCE_REDACTED",
): void {
  content.chunks = [];
  content.includedBytes = 0;
  content.reasonCode = reasonCode;
  content.status = status;
}

function allocate(material: ReviewMaterial, candidates: ContentCandidate[]): string {
  const ordered = [...candidates].sort((left, right) => {
    if (left.required !== right.required) return left.required ? -1 : 1;
    const a = left.content.source;
    const b = right.content.source;
    return compareUtf8(a.type, b.type)
      || compareUtf8(a.id, b.id)
      || compareUtf8(a.version, b.version)
      || compareUtf8(left.stream, right.stream);
  });
  for (const candidate of ordered) {
    const { content, required, text } = candidate;
    if (text === null) {
      markUnavailable(content, "missing", "SOURCE_MISSING");
      continue;
    }
    if (containsPrivateMaterial(text)) {
      markUnavailable(content, "unreadable", "SOURCE_REDACTED");
      continue;
    }
    const actualBytes = Buffer.byteLength(text, "utf8");
    const actualHash = sha256(text);
    if (
      content.originalBytes !== null
      && (content.originalBytes !== actualBytes || (content.sha256 !== null && content.sha256 !== actualHash))
    ) {
      markUnavailable(content, "unreadable", "SOURCE_UNREADABLE");
      continue;
    }
    content.originalBytes = actualBytes;
    content.sha256 = actualHash;
    for (const chunk of chunks(text)) {
      content.chunks.push(chunk);
      content.includedBytes += chunk.bytes;
      if (Buffer.byteLength(canonicalJson(material), "utf8") <= MAX_MATERIAL_BYTES) continue;
      content.chunks.pop();
      content.includedBytes -= chunk.bytes;
      if (required) throw new Error("REVIEW_MATERIAL_LIMIT_EXCEEDED");
      content.status = "truncated";
      content.reasonCode = "MATERIAL_BUDGET_EXHAUSTED";
      break;
    }
    if (content.includedBytes < actualBytes) {
      if (required) throw new Error("REVIEW_MATERIAL_LIMIT_EXCEEDED");
      content.status = "truncated";
      content.reasonCode = "MATERIAL_BUDGET_EXHAUSTED";
    }
  }
  const json = canonicalJson(material);
  if (Buffer.byteLength(json, "utf8") > MAX_MATERIAL_BYTES) {
    throw new Error("REVIEW_MATERIAL_LIMIT_EXCEEDED");
  }
  return json;
}

function eventPayload(row: Record<string, any>, value: unknown): Record<string, unknown> | null {
  const relevant = new Set([
    "manual_recovery_required", "manual_recovery_resolved", "merge_prepared",
    "merge_recovered", "merged", "staged_created", "status_changed", "validation_recorded",
  ]);
  if (!relevant.has(row.type)) return null;
  const parsed = executionEventDtoSchema.safeParse({
    actorId: row.actorId,
    actorType: row.actorType,
    attemptNo: row.attemptNo,
    createdAt: row.createdAt,
    id: row.id,
    payload: value,
    sequence: row.sequence,
    type: row.type,
  });
  return parsed.success ? parsed.data.payload as Record<string, unknown> : null;
}

export type ReviewMaterialHead = {
  missionId: string;
  projectId: string;
  resultId: string;
  resultVersion: number;
  workItemId: string;
};

export function frozenSourceMatchesTuple(
  frozen: {
    projectId: string | null | undefined;
    runId: string | null | undefined;
    threadId: string | null | undefined;
  },
  source: { projectId: string; runId: string; threadId: string },
  options: {
    allowAbsent?: boolean;
    legacyRunId?: unknown;
  } = {},
): boolean {
  const values = [frozen.projectId, frozen.threadId, frozen.runId];
  if (options.legacyRunId != null && options.legacyRunId !== source.runId) {
    return false;
  }
  if (values.every((value) => value == null)) {
    return options.legacyRunId === source.runId || options.allowAbsent === true;
  }
  return frozen.projectId === source.projectId
    && frozen.threadId === source.threadId
    && frozen.runId === source.runId;
}

export function freezeReviewMaterial(
  database: DatabaseSync,
  head: ReviewMaterialHead,
  attemptId: string,
  options: { requiredArtifactIds?: ReadonlySet<string> } = {},
): { hash: string; json: string; material: ReviewMaterial } {
  const result = database.prepare(`
    SELECT r.id,r.version,r.execution_id AS executionId,r.staged_result_id AS stagedResultId,
           r.merge_journal_id AS mergeJournalId,r.created_at AS createdAt,
           e.project_id AS sourceProjectId,
           e.source_collaboration_thread_id AS sourceThreadId,
           e.source_collaboration_run_id AS sourceRunId,
           a.frozen_context_hash AS sourceContextHash,
           json_extract(a.frozen_public_json,'$.facts.source.projectId')
             AS frozenSourceProjectId,
           json_extract(a.frozen_public_json,'$.facts.source.threadId')
             AS frozenSourceThreadId,
           json_extract(a.frozen_public_json,'$.facts.source.runId')
             AS frozenSourceRunId,
           json_extract(a.frozen_public_json,'$.facts.sourceCollaborationRunId')
             AS legacySourceRunId,
           json_extract(a.frozen_private_json,'$.facts.source.projectId')
             AS privateSourceProjectId,
           json_extract(a.frozen_private_json,'$.facts.source.threadId')
             AS privateSourceThreadId,
           json_extract(a.frozen_private_json,'$.facts.source.runId')
             AS privateSourceRunId,
           s.context_hash AS stagedContextHash
    FROM work_item_result_versions r
    JOIN executions e
      ON e.id=r.execution_id AND e.project_id=r.project_id
       AND e.mission_id=r.mission_id AND e.work_item_id=r.work_item_id
    JOIN execution_staged_results s
      ON s.id=r.staged_result_id AND s.project_id=r.project_id
       AND s.execution_id=r.execution_id
    JOIN execution_attempts a
      ON a.id=s.attempt_id AND a.project_id=s.project_id
       AND a.execution_id=s.execution_id
    JOIN collaboration_runs source_run
      ON source_run.project_id=e.project_id
       AND source_run.thread_id=e.source_collaboration_thread_id
       AND source_run.id=e.source_collaboration_run_id
    WHERE r.id=? AND r.project_id=? AND r.mission_id=?
      AND r.work_item_id=? AND r.version=?
  `).get(
    head.resultId,
    head.projectId,
    head.missionId,
    head.workItemId,
    head.resultVersion,
  ) as any;
  const project = database.prepare("SELECT id,name FROM projects WHERE id=?")
    .get(head.projectId) as any;
  const mission = database.prepare(`
    SELECT m.id,m.title,m.goal,m.version,h.context_version AS contextVersion
    FROM missions m JOIN mission_delivery_heads h ON h.mission_id=m.id
    WHERE m.id=? AND m.project_id=?
  `).get(head.missionId, head.projectId) as any;
  const task = database.prepare(`
    SELECT id,title,description,status AS boardStatus,
           assignee_agent_id AS assigneeAgentId,version
    FROM work_items WHERE id=? AND mission_id=?
  `).get(head.workItemId, head.missionId) as any;
  const executor = database.prepare(`
    SELECT a.id AS agentId,a.name FROM agents a
    JOIN work_item_result_versions r ON r.executor_agent_id=a.id WHERE r.id=?
  `).get(head.resultId) as any;
  const staged = database.prepare(`
    SELECT staged_hash AS stagedHash,classification,observed_path_count AS observedPathCount,
           observed_final_bytes AS observedFinalBytes,merge_file_count AS mergeFileCount,
           merge_final_bytes AS mergeFinalBytes
    FROM execution_staged_results WHERE id=?
  `).get(result.stagedResultId) as any;
  if (
    !result || !project || !mission || !task || !executor || !staged
    || result.version !== head.resultVersion
    || result.sourceProjectId !== head.projectId
    || result.sourceContextHash !== result.stagedContextHash
    || !frozenSourceMatchesTuple(
      {
        projectId: result.frozenSourceProjectId,
        runId: result.frozenSourceRunId,
        threadId: result.frozenSourceThreadId,
      },
      {
        projectId: result.sourceProjectId,
        runId: result.sourceRunId,
        threadId: result.sourceThreadId,
      },
      { legacyRunId: result.legacySourceRunId },
    )
    || !frozenSourceMatchesTuple(
      {
        projectId: result.privateSourceProjectId,
        runId: result.privateSourceRunId,
        threadId: result.privateSourceThreadId,
      },
      {
        projectId: result.sourceProjectId,
        runId: result.sourceRunId,
        threadId: result.sourceThreadId,
      },
      { allowAbsent: true },
    )
  ) throw new ReviewMaterialInvalidError();

  const dependencies = (database.prepare(`
    SELECT w.id,w.title,w.version,
           coalesce(h.state,'executing') AS effectiveStatus,
           h.current_result_id AS resultId,r.version AS resultVersion
    FROM work_item_dependencies d JOIN work_items w ON w.id=d.depends_on_id
    LEFT JOIN work_item_review_heads h ON h.work_item_id=w.id
    LEFT JOIN work_item_result_versions r ON r.id=h.current_result_id
    WHERE d.work_item_id=? ORDER BY w.created_at,w.id
  `).all(head.workItemId) as any[]).map((row) => ({ ...row }));
  const observations = database.prepare(`
    SELECT id,position,path,kind,baseline_hash AS baselineHash,observed_hash AS observedHash,
           final_size AS finalSize,diff_text AS diffText,diff_bytes AS diffBytes,
           diff_truncated AS diffTruncated
    FROM execution_staged_observations WHERE staged_result_id=? ORDER BY position,id
  `).all(result.stagedResultId) as any[];
  const blockers = database.prepare(`
    SELECT position,observation_id AS observationId,path,kind,
           json_extract(detail_json,'$.code') AS detailCode
    FROM execution_staged_blockers WHERE staged_result_id=? ORDER BY position,observation_id
  `).all(result.stagedResultId) as any[];
  const validationRows = database.prepare(`
    SELECT v.id,v.policy_entry_id AS policyEntryId,v.required,v.exit_code AS exitCode,
           v.succeeded,v.sandbox_manifest_hash AS version,v.stdout_bytes AS stdoutBytes,
           v.stdout_sha256 AS stdoutSha256,v.stdout_truncated AS stdoutTruncated,
           v.stderr_bytes AS stderrBytes,v.stderr_sha256 AS stderrSha256,
           v.stderr_truncated AS stderrTruncated,v.finished_at AS finishedAt,
           NOT EXISTS (
             SELECT 1 FROM execution_tool_calls t
             WHERE t.execution_id=v.execution_id AND t.type IN ('write','command')
               AND t.finished_at>v.finished_at
           ) AS afterLastWrite
    FROM execution_validation_results v WHERE v.execution_id=? ORDER BY v.finished_at,v.id
  `).all(result.executionId) as any[];
  const artifactRows = database.prepare(`
    SELECT id,name,path,content_bytes AS contentBytes,sha256,truncated,created_at AS createdAt
    FROM execution_artifacts WHERE execution_id=? ORDER BY created_at,id
  `).all(result.executionId) as any[];
  const eventRows = database.prepare(`
    SELECT id,sequence,attempt_no AS attemptNo,type,actor_type AS actorType,
           actor_id AS actorId,payload_json AS payloadJson,created_at AS createdAt
    FROM execution_events WHERE execution_id=? ORDER BY sequence,id
  `).all(result.executionId) as any[];
  const memoryRows = database.prepare(`
    SELECT id,version,type,content,source_type AS sourceType,
           source_id AS sourceId,source_version AS sourceVersion
    FROM memory_entries m WHERE project_id=?
      AND NOT EXISTS (SELECT 1 FROM memory_entries child WHERE child.supersedes_id=m.id)
    ORDER BY created_at,id
  `).all(head.projectId) as any[];
  const ownerAnswers = database.prepare(`
    SELECT escalation.id AS escalationId,answer.id AS answerId,
           answer.action,answer.answer,answer.created_at AS createdAt
    FROM review_escalations escalation
    JOIN review_escalation_answers answer ON answer.escalation_id=escalation.id
    WHERE escalation.work_item_id=? AND escalation.result_id=?
      AND answer.action='continue_review'
    ORDER BY answer.created_at,answer.id
  `).all(head.workItemId, head.resultId) as any[];

  const candidates: ContentCandidate[] = [];
  const requiredKeys = new Set<string>();
  const publicObservations = observations.map((row) => {
    const source: VersionRef = {
      id: row.id,
      type: "result",
      version: String(result.version),
    };
    const content = emptyContent(
      source,
      "text/x-diff",
      row.diffText === null ? null : Number(row.diffBytes),
      row.diffText === null ? null : sha256(String(row.diffText)),
    );
    const required = Number(row.diffBytes) > 0
      || ["binary", "permission", "special"].includes(String(row.kind));
    if (required) requiredKeys.add(contentKey(content));
    if (row.diffTruncated === 1) {
      content.status = "truncated";
      content.reasonCode = "MATERIAL_BUDGET_EXHAUSTED";
    }
    candidates.push({ content, required, stream: "diff", text: row.diffText });
    const { diffText: _, ...publicRow } = row;
    return { ...publicRow, diffTruncated: row.diffTruncated === 1, publicDiff: content };
  });
  const validations = validationRows.map((row) => {
    const source: VersionRef = { id: row.id, type: "validation", version: String(row.version) };
    const stdout = emptyContent(source, "text/plain", row.stdoutBytes, row.stdoutSha256);
    const stderr = emptyContent(source, "text/plain", row.stderrBytes, row.stderrSha256);
    const required = row.required === 1;
    if (required) requiredKeys.add(contentKey(stdout));
    const readStream = (stream: "stdout" | "stderr") => {
      const rows = database.prepare(`
        SELECT byte_offset AS byteOffset,byte_length AS byteLength,text,sha256
        FROM execution_validation_output_chunks
        WHERE validation_id=? AND stream=? ORDER BY chunk_index
      `).all(row.id, stream) as any[];
      return rows.length === 0 ? (Number(row[`${stream}Bytes`]) === 0 ? "" : null) : rows.map((item) => item.text).join("");
    };
    candidates.push({ content: stdout, required, stream: "stdout", text: readStream("stdout") });
    candidates.push({ content: stderr, required, stream: "stderr", text: readStream("stderr") });
    if (row.stdoutTruncated === 1) stdout.status = "truncated";
    if (row.stderrTruncated === 1) stderr.status = "truncated";
    return {
      afterLastWrite: row.afterLastWrite === 1,
      exitCode: row.exitCode,
      finishedAt: row.finishedAt,
      id: row.id,
      policyEntryId: row.policyEntryId,
      required,
      stderr,
      stdout,
      succeeded: row.succeeded === 1,
      version: String(row.version),
    };
  });
  const artifacts = artifactRows.map((row) => {
    const source: VersionRef = { id: row.id, type: "artifact", version: String(row.sha256) };
    const content = emptyContent(source, "text/plain", row.contentBytes, row.sha256);
    const required = options.requiredArtifactIds?.has(row.id) ?? false;
    if (required) requiredKeys.add(contentKey(content));
    const rows = database.prepare(`
      SELECT byte_offset AS byteOffset,byte_length AS byteLength,text,sha256
      FROM execution_artifact_chunks WHERE artifact_id=? ORDER BY chunk_index
    `).all(row.id) as any[];
    const text = rows.length === 0 ? (row.contentBytes === 0 ? "" : null) : rows.map((item) => item.text).join("");
    candidates.push({ content, required, stream: "artifact", text });
    return {
      content,
      createdAt: row.createdAt,
      id: row.id,
      name: row.name,
      path: containsPrivateMaterial(String(row.path)) ? "[redacted]" : row.path,
      version: String(row.sha256),
    };
  });
  const auditEvents = eventRows.flatMap((row) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payloadJson);
    } catch {
      return [];
    }
    const payload = eventPayload(row, parsed);
    if (!payload) return [];
    const source: VersionRef = {
      id: row.id,
      type: "execution",
      version: String(row.sequence),
    };
    const text = canonicalJson(payload);
    const content = emptyContent(source, "application/json", Buffer.byteLength(text), sha256(text));
    candidates.push({ content, required: false, stream: "event", text });
    return [{
      eventId: row.id,
      executionId: result.executionId,
      payload: content,
      sequence: row.sequence,
      type: row.type,
    }];
  });
  const fixedSourceRefs: VersionRef[] = [
    { id: head.workItemId, type: "task", version: String(task.version) },
    { id: head.resultId, type: "result", version: String(result.version) },
    { id: attemptId, type: "review", version: "1" },
  ];
  const sourceRefs: VersionRef[] = [
    ...fixedSourceRefs,
    ...validations.map((row) => ({ id: row.id, type: "validation" as const, version: row.version })),
    ...artifacts.map((row) => ({ id: row.id, type: "artifact" as const, version: row.version })),
    ...auditEvents.map((row) => ({
      id: row.eventId,
      type: "execution" as const,
      version: String(row.sequence),
    })),
    ...memoryRows.map((row) => ({ id: row.id, type: "memory" as const, version: String(row.version) })),
  ].sort((left, right) =>
    compareUtf8(left.type, right.type)
    || compareUtf8(left.id, right.id)
    || compareUtf8(left.version, right.version));
  const material: ReviewMaterial = {
    artifacts,
    auditEvents,
    changes: {
      blockers,
      classification: staged.classification,
      mergeFileCount: staged.mergeFileCount,
      mergeFinalBytes: staged.mergeFinalBytes,
      observations: publicObservations,
      observedFinalBytes: staged.observedFinalBytes,
      observedPathCount: staged.observedPathCount,
      stagedHash: staged.stagedHash,
    },
    dependencies,
    executor,
    mission,
    ownerAnswers: ownerAnswers.map((row) => ({
      action: "continue_review" as const,
      answer: row.answer,
      answerId: row.answerId,
      answerVersion: 1,
      createdAt: row.createdAt,
      escalationId: row.escalationId,
    })),
    project,
    result: {
      createdAt: result.createdAt,
      executionId: result.executionId,
      id: result.id,
      mergeJournalId: result.mergeJournalId,
      source: {
        contextHash: result.sourceContextHash,
        projectId: result.sourceProjectId,
        runId: result.sourceRunId,
        threadId: result.sourceThreadId,
      },
      sourceCollaborationRunId: result.sourceRunId,
      sourceCollaborationThreadId: result.sourceThreadId,
      sourceContextHash: result.sourceContextHash,
      stagedResultId: result.stagedResultId,
      version: result.version,
    },
    review: { attemptId, version: "1" },
    schemaVersion: 1,
    sharedMemories: memoryRows.map((row) => ({
      content: row.content,
      id: row.id,
      source: { id: row.sourceId, type: row.sourceType, version: row.sourceVersion },
      type: row.type,
      version: row.version,
    })),
    sourceRefs,
    task,
    validations,
  };
  requiredByMaterial.set(material, requiredKeys);
  const json = allocate(material, candidates);
  return { hash: sha256(json), json, material };
}

export function assertReviewMaterialPassable(
  material: ReviewMaterial,
  limitations: string[],
): void {
  const required = requiredByMaterial.get(material) ?? new Set<string>();
  const contents: FrozenPublicContent[] = [
    ...material.changes.observations.map((row) => row.publicDiff),
    ...material.validations.flatMap((row) => [row.stdout, row.stderr]),
    ...material.artifacts.map((row) => row.content),
    ...material.auditEvents.map((row) => row.payload),
  ];
  for (const content of contents) {
    const nonzeroWithoutBody = (content.originalBytes ?? 0) > 0 && content.chunks.length === 0;
    if (
      required.has(contentKey(content))
      && (content.status !== "complete" || nonzeroWithoutBody)
    ) throw new Error("REVIEW_CONTENT_INCOMPLETE");
    if (
      !required.has(contentKey(content))
      && content.status !== "complete"
      && limitations.length === 0
    ) throw new Error("REVIEW_CONTENT_INCOMPLETE");
  }
  if (material.validations.some((validation) =>
    validation.required
    && (!validation.succeeded || validation.exitCode !== 0 || !validation.afterLastWrite)
  )) {
    throw new Error("REVIEW_CONTENT_INCOMPLETE");
  }
}

export function reviewMaterialIsCurrent(
  database: DatabaseSync,
  head: ReviewMaterialHead,
  expectedHash: string,
  attemptId: string,
): boolean {
  try {
    return freezeReviewMaterial(database, head, attemptId).hash === expectedHash;
  } catch {
    return false;
  }
}
