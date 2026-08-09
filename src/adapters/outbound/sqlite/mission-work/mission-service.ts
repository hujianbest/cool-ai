import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { CompletionGateError } from "@/src/modules/review-delivery";
import {
  invalidateCompletionTx,
  writeWorkItemStatusTx,
} from "@/src/adapters/outbound/sqlite/review-delivery/completion-gate";
import { invalidateMissionContextTx } from "@/src/adapters/outbound/sqlite/review-delivery/delivery-service";
import { canonicalRequestHash } from "@/src/adapters/outbound/sqlite/public-collaboration/operation-receipts";
import { createServerComposition } from "@/src/server/composition/server-composition";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  insertTransitionReceipt,
  readControlOperationPrior,
} from "@/src/adapters/outbound/sqlite/public-collaboration/mission-control-receipts";
import { MissionError } from "@/src/modules/mission-work";
import type { TransitionReceipt } from "@/src/modules/public-collaboration";
import type {
  Mission,
  MissionState,
  WorkItem,
  WorkItemStatus,
} from "@/src/shared/project-context-contracts";

export { MissionError } from "@/src/modules/mission-work";

type MissionRow = Omit<Mission, "projectId"> & { projectId: string };
type WorkItemRow = Omit<WorkItem, "dependencyIds" | "status"> & {
  status: WorkItemStatus;
};
type FieldError = { field: string; code: string };

type CreateMissionInput = {
  title: string;
  goal: string;
  expectedVersion: number;
  operationId: string;
};
type UpdateMissionInput = {
  title: string;
  goal: string;
  expectedVersion: number;
};
type CreateWorkItemInput = {
  title: string;
  description: string;
  assigneeAgentId: string | null;
  dependencyIds: string[];
};
type UpdateWorkItemInput = CreateWorkItemInput & { expectedVersion: number };
type TransitionWorkItemInput = {
  toStatus: WorkItemStatus;
  expectedVersion: number;
  operationId?: string;
};
export type WorkItemBatchProposal = {
  clientKey: string;
  title: string;
  description: string;
  dependsOnKeys: string[];
};
export type MissionWriteActor =
  | { type: "owner" }
  | { type: "agent"; agentId: string };

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
const workItemStatuses: readonly WorkItemStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
];
const allowedTransitions: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  todo: ["in_progress", "blocked"],
  in_progress: ["blocked", "done"],
  blocked: ["todo", "in_progress"],
  done: ["in_progress"],
};

function graphemeLength(value: string): number {
  return Array.from(segmenter.segment(value)).length;
}

function textField(
  value: unknown,
  field: string,
  maximum: number,
  allowEmpty: boolean,
  fields: FieldError[],
): string {
  if (typeof value !== "string") {
    fields.push({ field, code: "invalid_format" });
    return "";
  }
  const trimmed = value.trim();
  const length = graphemeLength(trimmed);
  if (!allowEmpty && length === 0) fields.push({ field, code: "required" });
  else if (length > maximum) fields.push({ field, code: "too_long" });
  return trimmed;
}

function invalid(fields: FieldError[]): never {
  throw new MissionError(
    "INVALID_INPUT",
    400,
    "Mission input is invalid.",
    fields,
  );
}

function missionTextInput(input: { title: string; goal: string }): {
  title: string;
  goal: string;
} {
  const fields: FieldError[] = [];
  const title = textField(input?.title, "title", 80, false, fields);
  const goal = textField(input?.goal, "goal", 5000, false, fields);
  if (fields.length > 0) invalid(fields);
  return { goal, title };
}

function missionInput(input: CreateMissionInput): CreateMissionInput {
  const fields: FieldError[] = [];
  const { goal, title } = missionTextInput(input);
  const operationId = input?.operationId;
  if (operationId === undefined) {
    fields.push({ field: "operationId", code: "required" });
  } else if (
    typeof operationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(operationId)
  ) {
    fields.push({ field: "operationId", code: "invalid_format" });
  }
  const createVersion = input?.expectedVersion;
  if (createVersion === undefined) {
    fields.push({ field: "expectedVersion", code: "required" });
  } else if (createVersion !== 0) {
    fields.push({ field: "expectedVersion", code: "invalid_value" });
  }
  if (fields.length > 0) invalid(fields);
  return {
    expectedVersion: createVersion,
    goal,
    operationId,
    title,
  };
}

function workItemInput(input: CreateWorkItemInput): CreateWorkItemInput {
  const fields: FieldError[] = [];
  const title = textField(input?.title, "title", 160, false, fields);
  const description = textField(input?.description, "description", 5000, true, fields);
  if (
    input?.assigneeAgentId !== null &&
    typeof input?.assigneeAgentId !== "string"
  ) {
    fields.push({ field: "assigneeAgentId", code: "invalid_format" });
  }
  if (
    !Array.isArray(input?.dependencyIds) ||
    !input.dependencyIds.every(
      (dependencyId) => typeof dependencyId === "string" && dependencyId.length > 0,
    )
  ) {
    fields.push({ field: "dependencyIds", code: "invalid_format" });
  }
  if (fields.length > 0) invalid(fields);
  return {
    assigneeAgentId: input.assigneeAgentId,
    dependencyIds: [...input.dependencyIds],
    description,
    title,
  };
}

function expectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    invalid([{ field: "expectedVersion", code: "invalid_format" }]);
  }
  return Number(value);
}

function missionById(database: DatabaseSync, missionId: string): MissionRow | undefined {
  return database
    .prepare(
      `SELECT
         id, project_id AS projectId, title, goal, version,
         created_at AS createdAt, updated_at AS updatedAt
       FROM missions
       WHERE id = ?`,
    )
    .get(missionId) as MissionRow | undefined;
}

function missionForProject(
  database: DatabaseSync,
  projectId: string,
): MissionRow | undefined {
  return database
    .prepare(
      `SELECT
         id, project_id AS projectId, title, goal, version,
         created_at AS createdAt, updated_at AS updatedAt
       FROM missions
       WHERE project_id = ?`,
    )
    .get(projectId) as MissionRow | undefined;
}

function dependencyIdsFor(database: DatabaseSync, workItemId: string): string[] {
  return (
    database
      .prepare(
        `SELECT dependencies.depends_on_id AS dependencyId
         FROM work_item_dependencies AS dependencies
         JOIN work_items AS prerequisite
           ON prerequisite.id = dependencies.depends_on_id
         WHERE dependencies.work_item_id = ?
         ORDER BY prerequisite.created_at ASC, prerequisite.id ASC`,
      )
      .all(workItemId) as Array<{ dependencyId: string }>
  ).map(({ dependencyId }) => dependencyId);
}

function workItemById(database: DatabaseSync, workItemId: string): WorkItem | undefined {
  const row = database
    .prepare(
      `SELECT
         id, mission_id AS missionId, title, description, status,
         assignee_agent_id AS assigneeAgentId, version,
         created_at AS createdAt, updated_at AS updatedAt
       FROM work_items
       WHERE id = ?`,
    )
    .get(workItemId) as WorkItemRow | undefined;
  return row
    ? { ...row, dependencyIds: dependencyIdsFor(database, workItemId) }
    : undefined;
}

function workItemsForMission(database: DatabaseSync, missionId: string): WorkItem[] {
  const rows = database
    .prepare(
      `SELECT
         id, mission_id AS missionId, title, description, status,
         assignee_agent_id AS assigneeAgentId, version,
         created_at AS createdAt, updated_at AS updatedAt
       FROM work_items
       WHERE mission_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(missionId) as WorkItemRow[];
  return rows.map((row) => ({
    ...row,
    dependencyIds: dependencyIdsFor(database, row.id),
  }));
}

function ensureProject(database: DatabaseSync, projectId: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw new MissionError("PROJECT_NOT_FOUND", 404, "Project was not found.");
  }
}

function ensureAssignee(
  database: DatabaseSync,
  projectId: string,
  assigneeAgentId: string | null,
): void {
  if (!assigneeAgentId) return;
  const member = database
    .prepare(
      `SELECT 1
       FROM project_memberships
       WHERE project_id = ? AND agent_id = ?`,
    )
    .get(projectId, assigneeAgentId);
  if (!member) {
    throw new MissionError(
      "ASSIGNEE_NOT_MEMBER",
      409,
      "Work item assignee must be a project member.",
    );
  }
}

function dependencyScopeError(): MissionError {
  return new MissionError(
    "DEPENDENCY_SCOPE",
    409,
    "Work item dependencies must reference unique items in the same mission.",
  );
}

function ensureDependencyScope(
  database: DatabaseSync,
  missionId: string,
  workItemId: string,
  dependencyIds: string[],
): void {
  if (
    new Set(dependencyIds).size !== dependencyIds.length ||
    dependencyIds.includes(workItemId)
  ) {
    throw dependencyScopeError();
  }
  if (dependencyIds.length === 0) return;
  const placeholders = dependencyIds.map(() => "?").join(", ");
  const matches = database
    .prepare(
      `SELECT id
       FROM work_items
       WHERE mission_id = ? AND id IN (${placeholders})`,
    )
    .all(missionId, ...dependencyIds) as Array<{ id: string }>;
  if (matches.length !== dependencyIds.length) throw dependencyScopeError();
}

function ensureReplacementAcyclic(
  database: DatabaseSync,
  missionId: string,
  workItemId: string,
  dependencyIds: string[],
): void {
  const itemIds = (
    database
      .prepare("SELECT id FROM work_items WHERE mission_id = ?")
      .all(missionId) as Array<{ id: string }>
  ).map(({ id }) => id);
  const graph = new Map(itemIds.map((id) => [id, [] as string[]]));
  const rows = database
    .prepare(
      `SELECT dependencies.work_item_id AS workItemId,
              dependencies.depends_on_id AS dependsOnId
       FROM work_item_dependencies AS dependencies
       JOIN work_items AS item ON item.id = dependencies.work_item_id
       WHERE item.mission_id = ?`,
    )
    .all(missionId) as Array<{ workItemId: string; dependsOnId: string }>;
  for (const row of rows) {
    graph.get(row.workItemId)?.push(row.dependsOnId);
  }
  graph.set(workItemId, [...dependencyIds]);

  const colors = new Map<string, 0 | 1 | 2>();
  function visit(id: string): boolean {
    const color = colors.get(id) ?? 0;
    if (color === 1) return true;
    if (color === 2) return false;
    colors.set(id, 1);
    for (const dependencyId of graph.get(id) ?? []) {
      if (visit(dependencyId)) return true;
    }
    colors.set(id, 2);
    return false;
  }
  if (itemIds.some(visit)) {
    throw new MissionError(
      "DEPENDENCY_CYCLE",
      409,
      "Work item dependencies must remain acyclic.",
    );
  }
}

function ensureDependenciesDone(
  database: DatabaseSync,
  dependencyIds: string[],
): void {
  if (dependencyIds.length === 0) return;
  const placeholders = dependencyIds.map(() => "?").join(", ");
  const unfinished = database
    .prepare(
      `SELECT 1
       FROM work_items prerequisite
       LEFT JOIN work_item_review_heads head ON head.work_item_id=prerequisite.id
       WHERE prerequisite.id IN (${placeholders})
         AND (prerequisite.status <> 'done' OR head.state IS NOT 'passed')
       LIMIT 1`,
    )
    .get(...dependencyIds);
  if (unfinished) throw dependencyNotReadyError();
}

function dependencyNotReadyError(): MissionError {
  return new MissionError(
    "DEPENDENCY_NOT_READY",
    409,
    "Work item dependencies are not ready.",
  );
}

function actionConflict(currentVersion?: number): MissionError {
  return new MissionError(
    "ACTION_CONFLICT",
    409,
    "Mission action conflicts with current project state.",
    undefined,
    currentVersion,
  );
}

function replaceDependencyRows(
  database: DatabaseSync,
  workItemId: string,
  dependencyIds: string[],
): void {
  database
    .prepare("DELETE FROM work_item_dependencies WHERE work_item_id = ?")
    .run(workItemId);
  const insert = database.prepare(
    `INSERT INTO work_item_dependencies (work_item_id, depends_on_id)
     VALUES (?, ?)`,
  );
  for (const dependencyId of dependencyIds) {
    insert.run(workItemId, dependencyId);
  }
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
      // Preserve the stable domain error.
    }
    throw error;
  }
}

function createWorkItemTx(
  database: DatabaseSync,
  mission: MissionRow,
  parsed: CreateWorkItemInput,
): WorkItem {
  ensureAssignee(database, mission.projectId, parsed.assigneeAgentId);
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO work_items (
         id, mission_id, title, description, status, assignee_agent_id,
         version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'todo', ?, 1, ?, ?)`,
    )
    .run(
      id,
      mission.id,
      parsed.title,
      parsed.description,
      parsed.assigneeAgentId,
      timestamp,
      timestamp,
    );
  ensureDependencyScope(database, mission.id, id, parsed.dependencyIds);
  ensureReplacementAcyclic(database, mission.id, id, parsed.dependencyIds);
  replaceDependencyRows(database, id, parsed.dependencyIds);
  return workItemById(database, id)!;
}

function validateBatch(
  proposals: WorkItemBatchProposal[],
): Array<WorkItemBatchProposal & Pick<CreateWorkItemInput, "title" | "description">> {
  if (!Array.isArray(proposals) || proposals.length > 20) {
    invalid([{ field: "proposals", code: "invalid_format" }]);
  }
  const parsed = proposals.map((proposal, index) => {
    const fields: FieldError[] = [];
    if (
      typeof proposal?.clientKey !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(proposal.clientKey)
    ) {
      fields.push({ field: `proposals.${index}.clientKey`, code: "invalid_format" });
    }
    if (
      !Array.isArray(proposal?.dependsOnKeys) ||
      !proposal.dependsOnKeys.every(
        (key) => typeof key === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(key),
      )
    ) {
      fields.push({
        field: `proposals.${index}.dependsOnKeys`,
        code: "invalid_format",
      });
    }
    if (fields.length > 0) invalid(fields);
    const item = workItemInput({
      assigneeAgentId: null,
      dependencyIds: [],
      description: proposal.description,
      title: proposal.title,
    });
    return {
      ...proposal,
      description: item.description,
      title: item.title,
      dependsOnKeys: [...proposal.dependsOnKeys],
    };
  });
  const keys = parsed.map(({ clientKey }) => clientKey);
  if (new Set(keys).size !== keys.length) {
    invalid([{ field: "clientKey", code: "duplicate" }]);
  }
  const keySet = new Set(keys);
  for (const proposal of parsed) {
    if (
      new Set(proposal.dependsOnKeys).size !== proposal.dependsOnKeys.length ||
      proposal.dependsOnKeys.includes(proposal.clientKey) ||
      proposal.dependsOnKeys.some((key) => !keySet.has(key))
    ) {
      throw dependencyScopeError();
    }
  }
  const colors = new Map<string, 0 | 1 | 2>();
  const graph = new Map(parsed.map(({ clientKey, dependsOnKeys }) => [clientKey, dependsOnKeys]));
  function visit(key: string): boolean {
    const color = colors.get(key) ?? 0;
    if (color === 1) return true;
    if (color === 2) return false;
    colors.set(key, 1);
    for (const dependencyKey of graph.get(key) ?? []) {
      if (visit(dependencyKey)) return true;
    }
    colors.set(key, 2);
    return false;
  }
  if (keys.some(visit)) {
    throw new MissionError(
      "DEPENDENCY_CYCLE",
      409,
      "Work item dependencies must remain acyclic.",
    );
  }
  return parsed;
}

export function createWorkItemBatchTx(
  database: DatabaseSync,
  projectId: string,
  expectedMissionId: string,
  proposals: WorkItemBatchProposal[],
  actor: MissionWriteActor,
): Record<string, string> {
  const mission = missionForProject(database, projectId);
  if (!mission || mission.id !== expectedMissionId) throw actionConflict();
  if (
    !actor ||
    (actor.type !== "owner" && actor.type !== "agent") ||
    (actor.type === "agent" &&
      (typeof actor.agentId !== "string" ||
        !database
          .prepare(
            `SELECT 1 FROM project_memberships
             WHERE project_id = ? AND agent_id = ?`,
          )
          .get(projectId, actor.agentId)))
  ) {
    throw actionConflict();
  }

  const parsed = validateBatch(proposals);
  const keyToId: Record<string, string> = {};
  for (const proposal of parsed) keyToId[proposal.clientKey] = randomUUID();
  const timestamp = new Date().toISOString();
  const insertItem = database.prepare(
    `INSERT INTO work_items (
       id, mission_id, title, description, status, assignee_agent_id,
       version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'todo', NULL, 1, ?, ?)`,
  );
  for (const proposal of parsed) {
    insertItem.run(
      keyToId[proposal.clientKey],
      mission.id,
      proposal.title,
      proposal.description,
      timestamp,
      timestamp,
    );
  }
  const insertDependency = database.prepare(
    `INSERT INTO work_item_dependencies (work_item_id, depends_on_id)
     VALUES (?, ?)`,
  );
  for (const proposal of parsed) {
    for (const dependencyKey of proposal.dependsOnKeys) {
      insertDependency.run(keyToId[proposal.clientKey], keyToId[dependencyKey]);
    }
  }
  if (parsed.length > 0) {
    const updated = database
      .prepare(
        `UPDATE missions
         SET version = version + 1, updated_at = ?
         WHERE id = ? AND project_id = ?`,
      )
      .run(timestamp, expectedMissionId, projectId);
    if (updated.changes !== 1) throw actionConflict();
  }
  return keyToId;
}

export function claimWorkItemTx(
  database: DatabaseSync,
  projectId: string,
  workItemId: string,
  agentId: string,
  expectedWorkItemVersion: number,
): WorkItem {
  const version = expectedVersion(expectedWorkItemVersion);
  const current = workItemById(database, workItemId);
  const mission = current ? missionById(database, current.missionId) : undefined;
  const isMember = database
    .prepare(
      `SELECT 1 FROM project_memberships
       WHERE project_id = ? AND agent_id = ?`,
    )
    .get(projectId, agentId);
  if (!current || mission?.projectId !== projectId || !isMember) {
    throw actionConflict(current?.version);
  }
  if (current.version !== version) throw actionConflict(current.version);

  const timestamp = new Date().toISOString();
  const updated = database
    .prepare(
      `UPDATE work_items
       SET assignee_agent_id = ?, status = 'in_progress',
           version = version + 1, updated_at = ?
       WHERE id = ?
         AND version = ?
         AND status = 'todo'
         AND assignee_agent_id IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM work_item_dependencies AS dependencies
           JOIN work_items AS prerequisite
             ON prerequisite.id = dependencies.depends_on_id
           LEFT JOIN work_item_review_heads AS review_head
             ON review_head.work_item_id = prerequisite.id
           WHERE dependencies.work_item_id = work_items.id
             AND (
               prerequisite.status <> 'done'
               OR review_head.state IS NOT 'passed'
             )
         )`,
    )
    .run(agentId, timestamp, workItemId, version);
  if (updated.changes !== 1) {
    throw actionConflict(workItemById(database, workItemId)?.version);
  }
  return workItemById(database, workItemId)!;
}

export function getMissionState(
  databasePath: string,
  projectId: string,
): MissionState {
  const database = openDatabase(databasePath);
  try {
    ensureProject(database, projectId);
    const mission = missionForProject(database, projectId);
    return {
      mission: mission ?? null,
      workItems: mission ? workItemsForMission(database, mission.id) : [],
    };
  } finally {
    database.close();
  }
}

export function createMission(
  databasePath: string,
  projectId: string,
  input: CreateMissionInput,
): Mission {
  const parsed = missionInput(input);
  const command = {
    expectedVersion: parsed.expectedVersion,
    goal: parsed.goal,
    operationId: parsed.operationId,
    projectId,
    title: parsed.title,
  };
  const { createMissionWorkflow } = createServerComposition(databasePath);
  return createMissionWorkflow.execute({
    ...command,
    requestHash: canonicalRequestHash(command),
  });
}

export function updateMission(
  databasePath: string,
  missionId: string,
  input: UpdateMissionInput,
): Mission {
  const parsed = missionTextInput(input);
  const version = expectedVersion(input?.expectedVersion);
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      const current = missionById(database, missionId);
      if (!current) {
        throw new MissionError("MISSION_NOT_FOUND", 404, "Mission was not found.");
      }
      if (current.version !== version) {
        throw new MissionError(
          "RESOURCE_CONFLICT",
          409,
          "Mission version is stale.",
          undefined,
          current.version,
        );
      }
      database
        .prepare(
          `UPDATE missions
           SET title = ?, goal = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(parsed.title, parsed.goal, new Date().toISOString(), missionId, version);
      invalidateMissionContextTx(database, {
        missionId,
        projectId: current.projectId,
        reason: "MISSION_CONTEXT_CHANGED",
      });
      return missionById(database, missionId)!;
    });
  } finally {
    database.close();
  }
}

export function createWorkItem(
  databasePath: string,
  missionId: string,
  input: CreateWorkItemInput,
): WorkItem {
  const parsed = workItemInput(input);
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      const mission = missionById(database, missionId);
      if (!mission) {
        throw new MissionError("MISSION_NOT_FOUND", 404, "Mission was not found.");
      }
      return createWorkItemTx(database, mission, parsed);
    });
  } finally {
    database.close();
  }
}

export function updateWorkItem(
  databasePath: string,
  workItemId: string,
  input: UpdateWorkItemInput,
): WorkItem {
  const parsed = workItemInput(input);
  const version = expectedVersion(input?.expectedVersion);
  const database = openDatabase(databasePath);
  try {
    return transaction(database, () => {
      const current = workItemById(database, workItemId);
      if (!current) {
        throw new MissionError(
          "WORK_ITEM_NOT_FOUND",
          404,
          "Work item was not found.",
        );
      }
      if (current.version !== version) {
        throw new MissionError(
          "RESOURCE_CONFLICT",
          409,
          "Work item version is stale.",
          undefined,
          current.version,
        );
      }
      const mission = missionById(database, current.missionId)!;
      ensureAssignee(database, mission.projectId, parsed.assigneeAgentId);
      ensureDependencyScope(
        database,
        current.missionId,
        workItemId,
        parsed.dependencyIds,
      );
      ensureReplacementAcyclic(
        database,
        current.missionId,
        workItemId,
        parsed.dependencyIds,
      );
      if (current.status === "in_progress" || current.status === "done") {
        ensureDependenciesDone(database, parsed.dependencyIds);
      }
      database
        .prepare(
          `UPDATE work_items
           SET title = ?, description = ?, assignee_agent_id = ?,
               version = version + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          parsed.title,
          parsed.description,
          parsed.assigneeAgentId,
          new Date().toISOString(),
          workItemId,
        );
      replaceDependencyRows(database, workItemId, parsed.dependencyIds);
      if (current.status === "done") {
        invalidateCompletionTx(database, {
          reason: "WORK_ITEM_MATERIAL_CHANGED",
          workItemId,
        });
      }
      return workItemById(database, workItemId)!;
    });
  } finally {
    database.close();
  }
}

export function transitionWorkItemTx(
  database: DatabaseSync,
  input: {
    actor: MissionWriteActor;
    expectedVersion: number;
    toStatus: WorkItemStatus;
    workItemId: string;
  },
): WorkItem {
  const current = workItemById(database, input.workItemId);
  if (!current) {
    throw new MissionError("WORK_ITEM_NOT_FOUND", 404, "Work item was not found.");
  }
  if (current.version !== input.expectedVersion) {
    throw new MissionError(
      "RESOURCE_CONFLICT",
      409,
      "Work item version is stale.",
      undefined,
      current.version,
    );
  }
  if (input.toStatus === "done") {
    writeWorkItemStatusTx(database, {
      expectedVersion: input.expectedVersion,
      toStatus: "done",
      workItemId: input.workItemId,
    });
    return workItemById(database, input.workItemId)!;
  }
  if (!allowedTransitions[current.status].includes(input.toStatus)) {
    throw new MissionError(
      "INVALID_TRANSITION",
      409,
      "Work item transition is not allowed.",
    );
  }
  if (current.status === "done" && input.toStatus === "in_progress") {
    invalidateCompletionTx(database, {
      reason: input.actor.type === "agent" ? "AGENT_REOPENED" : "OWNER_REOPENED",
      workItemId: input.workItemId,
    });
    return workItemById(database, input.workItemId)!;
  }
  if (input.toStatus === "in_progress") {
    ensureDependenciesDone(database, current.dependencyIds);
  }
  const updated = database.prepare(`
    UPDATE work_items
    SET status=?,version=version+1,updated_at=?
    WHERE id=? AND version=? AND status=?
  `).run(
    input.toStatus,
    new Date().toISOString(),
    input.workItemId,
    input.expectedVersion,
    current.status,
  );
  if (updated.changes !== 1) {
    throw new MissionError(
      "RESOURCE_CONFLICT",
      409,
      "Work item version is stale.",
      undefined,
      workItemById(database, input.workItemId)?.version,
    );
  }
  return workItemById(database, input.workItemId)!;
}

function receiptError(receipt: Extract<TransitionReceipt, { ok: false }>): never {
  const error = receipt.error;
  if (error.blockers) {
    throw new CompletionGateError(
      error.code,
      error.status,
      error.message,
      error.blockers,
      error.currentVersion,
    );
  }
  throw new MissionError(
    error.code,
    error.status,
    error.message,
    undefined,
    error.currentVersion,
  );
}

export function transitionWorkItem(
  databasePath: string,
  workItemId: string,
  input: TransitionWorkItemInput,
): WorkItem {
  if (!input || !workItemStatuses.includes(input.toStatus)) {
    invalid([{ field: "status", code: "invalid_format" }]);
  }
  const version = expectedVersion(input.expectedVersion);
  if (
    input.operationId !== undefined
    && (typeof input.operationId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(input.operationId))
  ) {
    invalid([{ field: "operationId", code: "invalid_format" }]);
  }
  const database = openDatabase(databasePath);
  try {
    const current = workItemById(database, workItemId);
    if (!current) {
      throw new MissionError("WORK_ITEM_NOT_FOUND", 404, "Work item was not found.");
    }
    const mission = missionById(database, current.missionId)!;
    const requestHash = canonicalRequestHash({ ...input, workItemId });
    if (input.operationId) {
      const prior = readControlOperationPrior(database, mission.projectId, input.operationId);
      if (prior) {
        if (
          prior.kind !== "control"
          || prior.requestHash !== requestHash
        ) {
          throw new MissionError(
            "OPERATION_CONFLICT",
            409,
            "Operation id was already used for different input.",
          );
        }
        const receipt = JSON.parse(prior.responseJson) as TransitionReceipt;
        if (!receipt.ok) receiptError(receipt);
        return receipt.workItem;
      }
    }
    try {
      return transaction(database, () => {
        const transitioned = transitionWorkItemTx(database, {
          actor: { type: "owner" },
          expectedVersion: version,
          toStatus: input.toStatus,
          workItemId,
        });
        if (input.operationId) {
          insertTransitionReceipt(database, {
            operationId: input.operationId,
            projectId: mission.projectId,
            receipt: { ok: true, workItem: transitioned },
            requestHash,
          });
        }
        return transitioned;
      });
    } catch (error) {
      if (
        input.operationId
        && (error instanceof MissionError || error instanceof CompletionGateError)
      ) {
        const receipt: TransitionReceipt = {
          error: {
            ...(error instanceof CompletionGateError && error.blockers
              ? { blockers: error.blockers }
              : {}),
            code: error.code,
            ...(error.currentVersion !== undefined
              ? { currentVersion: error.currentVersion }
              : {}),
            message: error.message,
            status: error.httpStatus,
          },
          ok: false,
        };
        transaction(database, () => insertTransitionReceipt(database, {
          operationId: input.operationId!,
          projectId: mission.projectId,
          receipt,
          requestHash,
        }));
      }
      throw error;
    }
  } finally {
    database.close();
  }
}
