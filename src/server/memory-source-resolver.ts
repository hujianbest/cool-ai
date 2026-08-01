import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import {
  memorySourceTypeSchema,
  type MemorySource,
} from "@/src/shared/memory-contracts";

const candidateSourceTypes = [
  "task",
  "result",
  "review",
  "validation",
  "artifact",
] as const;

const resolverInputSchema = z.object({
  confirmingReviewAttemptId: z.string().min(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  type: z.enum(candidateSourceTypes),
  version: z.string().min(1),
}).strict();

const frozenRefSchema = z.object({
  id: z.string().min(1),
  type: memorySourceTypeSchema,
  version: z.string().min(1),
}).strict();

const frozenMaterialSchema = z.object({
  sourceRefs: z.array(frozenRefSchema),
}).passthrough();

type ResolverInput = z.input<typeof resolverInputSchema>;

export class MemorySourceResolutionError extends Error {
  readonly code = "INVALID_SOURCE";
  readonly httpStatus = 400;

  constructor() {
    super("Memory source is invalid.");
    this.name = "MemorySourceResolutionError";
  }
}

function invalidSource(): never {
  throw new MemorySourceResolutionError();
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function attemptMaterial(
  database: DatabaseSync,
  projectId: string,
  attemptId: string,
): z.infer<typeof frozenMaterialSchema> {
  const row = database.prepare(`
    SELECT frozen_material_json AS material
    FROM review_attempts WHERE id=? AND project_id=?
  `).get(attemptId, projectId) as { material: string } | undefined;
  if (!row) invalidSource();
  try {
    return frozenMaterialSchema.parse(JSON.parse(row.material));
  } catch {
    return invalidSource();
  }
}

export function resolveMemorySource(
  database: DatabaseSync,
  unsafeInput: ResolverInput,
): MemorySource & { href: string; version: string } {
  const parsed = resolverInputSchema.safeParse(unsafeInput);
  if (!parsed.success) invalidSource();
  const input = parsed.data;
  const material = attemptMaterial(
    database,
    input.projectId,
    input.confirmingReviewAttemptId,
  );
  if (!material.sourceRefs.some((ref) =>
    ref.type === input.type
    && ref.id === input.id
    && ref.version === input.version
  )) invalidSource();

  const project = segment(input.projectId);
  const id = segment(input.id);
  const version = encodeURIComponent(input.version);
  let href: string;

  switch (input.type) {
    case "task": {
      const row = database.prepare(`
        SELECT w.id,w.version
        FROM work_items w JOIN missions m ON m.id=w.mission_id
        WHERE w.id=? AND m.project_id=?
      `).get(input.id, input.projectId) as { id: string; version: number } | undefined;
      if (!row || String(row.version) !== input.version) invalidSource();
      href = `/projects/${project}/tasks/${id}?version=${version}`;
      break;
    }
    case "result": {
      const row = database.prepare(`
        SELECT id,version,work_item_id AS workItemId
        FROM work_item_result_versions WHERE id=? AND project_id=?
      `).get(input.id, input.projectId) as {
        id: string;
        version: number;
        workItemId: string;
      } | undefined;
      if (!row || String(row.version) !== input.version) invalidSource();
      href = `/projects/${project}/tasks/${segment(row.workItemId)}/results/${id}?version=${version}`;
      break;
    }
    case "review": {
      const row = database.prepare(`
        SELECT id,work_item_id AS workItemId
        FROM review_attempts WHERE id=? AND project_id=?
      `).get(input.id, input.projectId) as {
        id: string;
        workItemId: string;
      } | undefined;
      if (!row) invalidSource();
      href = `/projects/${project}/tasks/${segment(row.workItemId)}/reviews/${id}?version=${version}`;
      break;
    }
    case "validation": {
      const row = database.prepare(`
        SELECT id,execution_id AS executionId,sandbox_manifest_hash AS sourceVersion
        FROM execution_validation_results WHERE id=? AND project_id=?
      `).get(input.id, input.projectId) as {
        executionId: string;
        id: string;
        sourceVersion: string;
      } | undefined;
      if (!row || row.sourceVersion !== input.version) invalidSource();
      href = `/projects/${project}/executions/${segment(row.executionId)}/validations/${id}?version=${version}`;
      break;
    }
    case "artifact": {
      const row = database.prepare(`
        SELECT id,execution_id AS executionId,sha256 AS sourceVersion
        FROM execution_artifacts WHERE id=? AND project_id=?
      `).get(input.id, input.projectId) as {
        executionId: string;
        id: string;
        sourceVersion: string;
      } | undefined;
      if (!row || row.sourceVersion !== input.version) invalidSource();
      href = `/projects/${project}/executions/${segment(row.executionId)}/artifacts/${id}?version=${version}`;
      break;
    }
  }

  return {
    href,
    id: input.id,
    type: input.type,
    version: input.version,
  };
}
