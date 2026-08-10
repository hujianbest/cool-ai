import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { MissionError } from "@/src/modules/mission-work";
import type {
  MissionDependencyCycle,
  MissionDependencyEdge,
  MissionDependencyInsight,
  MissionDependencyNode,
} from "@/src/modules/mission-work";
import type { WorkItemStatus } from "@/src/shared/project-context-contracts";

export type MissionDependencySourceItem = {
  id: string;
  status: WorkItemStatus;
  title: string;
};

export type MissionDependencySourceRow = {
  dependsOnId: string;
  workItemId: string;
};

const UNRESOLVED_STATUS_LABELS: ReadonlyArray<readonly [WorkItemStatus, string]> = [
  ["todo", "待办"],
  ["in_progress", "进行中"],
  ["blocked", "阻塞"],
];

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byEdge(left: MissionDependencyEdge, right: MissionDependencyEdge): number {
  return (
    byId(left.fromWorkItemId, right.fromWorkItemId) ||
    byId(left.toWorkItemId, right.toWorkItemId)
  );
}

function deriveBlockedReason(
  dependencyStatuses: WorkItemStatus[],
  missingCount: number,
): string | null {
  const segments: string[] = [];
  for (const [status, label] of UNRESOLVED_STATUS_LABELS) {
    const count = dependencyStatuses.filter((candidate) => candidate === status).length;
    if (count > 0) segments.push(`${label} ${count} 项`);
  }
  const parts: string[] = [];
  if (segments.length > 0) parts.push(`前置依赖未完成：${segments.join("、")}`);
  if (missingCount > 0) parts.push(`${missingCount} 项前置依赖缺失`);
  return parts.length > 0 ? parts.join("；") : null;
}

// Tarjan over id-sorted nodes with id-sorted adjacency: same input always
// yields the same components in the same completion order, so cycle ids are
// stable across calls.
function stronglyConnectedComponents(
  sortedIds: string[],
  adjacency: Map<string, string[]>,
): string[][] {
  let nextIndex = 0;
  const indexById = new Map<string, number>();
  const lowlinkById = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  function connect(id: string): void {
    indexById.set(id, nextIndex);
    lowlinkById.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);
    for (const neighbor of adjacency.get(id) ?? []) {
      if (!indexById.has(neighbor)) {
        connect(neighbor);
        lowlinkById.set(
          id,
          Math.min(lowlinkById.get(id)!, lowlinkById.get(neighbor)!),
        );
      } else if (onStack.has(neighbor)) {
        lowlinkById.set(id, Math.min(lowlinkById.get(id)!, indexById.get(neighbor)!));
      }
    }
    if (lowlinkById.get(id) === indexById.get(id)) {
      const component: string[] = [];
      let member = "";
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      components.push(component);
    }
  }

  for (const id of sortedIds) {
    if (!indexById.has(id)) connect(id);
  }
  return components;
}

// Deterministic witness: DFS from the smallest member id over id-sorted
// neighbors inside the component until an edge closes back to the start.
function cycleWitnessPath(
  start: string,
  members: Set<string>,
  adjacency: Map<string, string[]>,
): string[] {
  const visited = new Set([start]);
  const path = [start];
  function walk(current: string): string[] | null {
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!members.has(neighbor)) continue;
      if (neighbor === start) return [...path, start];
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      path.push(neighbor);
      const found = walk(neighbor);
      if (found) return found;
      path.pop();
    }
    return null;
  }
  return walk(start) ?? [start];
}

export function deriveMissionDependencyInsight(
  items: MissionDependencySourceItem[],
  dependencyRows: MissionDependencySourceRow[],
): MissionDependencyInsight {
  const sortedItems = [...items].sort((left, right) => byId(left.id, right.id));
  const itemById = new Map(sortedItems.map((item) => [item.id, item]));

  const blockedBy = new Map<string, string[]>();
  const blocking = new Map<string, string[]>();
  const missing = new Map<string, Set<string>>();
  const edges: MissionDependencyEdge[] = [];
  const seenEdges = new Set<string>();

  for (const row of dependencyRows) {
    if (!itemById.has(row.workItemId)) continue;
    if (!itemById.has(row.dependsOnId)) {
      const list = missing.get(row.workItemId) ?? new Set<string>();
      list.add(row.dependsOnId);
      missing.set(row.workItemId, list);
      continue;
    }
    const edgeKey = `${row.dependsOnId}\0${row.workItemId}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    edges.push({ fromWorkItemId: row.dependsOnId, toWorkItemId: row.workItemId });
    const dependencies = blockedBy.get(row.workItemId) ?? [];
    dependencies.push(row.dependsOnId);
    blockedBy.set(row.workItemId, dependencies);
    const dependents = blocking.get(row.dependsOnId) ?? [];
    dependents.push(row.workItemId);
    blocking.set(row.dependsOnId, dependents);
  }

  edges.sort(byEdge);
  const adjacency = new Map<string, string[]>(
    sortedItems.map((item) => [
      item.id,
      (blockedBy.get(item.id) ?? []).slice().sort(byId),
    ]),
  );

  const cycles: MissionDependencyCycle[] = [];
  const cycleIdByWorkItemId = new Map<string, string>();
  const sortedIds = sortedItems.map((item) => item.id);
  for (const component of stronglyConnectedComponents(sortedIds, adjacency)) {
    const isCycle =
      component.length > 1 ||
      (adjacency.get(component[0]) ?? []).includes(component[0]);
    if (!isCycle) continue;
    const cycleId = `cycle-${cycles.length + 1}`;
    const memberWorkItemIds = [...component].sort(byId);
    const witness = cycleWitnessPath(
      memberWorkItemIds[0],
      new Set(memberWorkItemIds),
      adjacency,
    );
    cycles.push({
      cycleId,
      memberWorkItemIds,
      path: witness.map((id) => itemById.get(id)!.title).join(" → "),
    });
    for (const memberId of memberWorkItemIds) {
      cycleIdByWorkItemId.set(memberId, cycleId);
    }
  }

  const nodes: MissionDependencyNode[] = sortedItems.map((item) => {
    const blockedByIds = (blockedBy.get(item.id) ?? []).sort(byId);
    const blockingIds = (blocking.get(item.id) ?? []).sort(byId);
    const missingDependencyIds = [...(missing.get(item.id) ?? [])].sort(byId);
    return {
      workItemId: item.id,
      title: item.title,
      status: item.status,
      blockedByIds,
      blockingIds,
      blockedReason: deriveBlockedReason(
        blockedByIds.map((id) => itemById.get(id)!.status),
        missingDependencyIds.length,
      ),
      cycleId: cycleIdByWorkItemId.get(item.id) ?? null,
      missingDependencyIds,
    };
  });

  return {
    nodes,
    edges,
    cycles,
    hasDependencies: edges.length > 0 || missing.size > 0,
  };
}

function ensureProject(database: DatabaseSync, projectId: string): void {
  if (!database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw new MissionError("PROJECT_NOT_FOUND", 404, "Project was not found.");
  }
}

export function getMissionDependencyInsight(
  databasePath: string,
  projectId: string,
  missionId: string,
): MissionDependencyInsight {
  const database = openDatabase(databasePath);
  try {
    ensureProject(database, projectId);
    const mission = database
      .prepare("SELECT id FROM missions WHERE id = ? AND project_id = ?")
      .get(missionId, projectId);
    if (!mission) {
      throw new MissionError("MISSION_NOT_FOUND", 404, "Mission was not found.");
    }
    const items = database
      .prepare(
        `SELECT id, title, status
         FROM work_items
         WHERE mission_id = ?`,
      )
      .all(missionId) as unknown as MissionDependencySourceItem[];
    // Deliberately no join on depends_on_id: dangling references must stay
    // visible to the derivation so they are reported as missing, not dropped.
    const dependencyRows = database
      .prepare(
        `SELECT dependencies.work_item_id AS workItemId,
                dependencies.depends_on_id AS dependsOnId
         FROM work_item_dependencies AS dependencies
         JOIN work_items AS item ON item.id = dependencies.work_item_id
         WHERE item.mission_id = ?`,
      )
      .all(missionId) as unknown as MissionDependencySourceRow[];
    return deriveMissionDependencyInsight(items, dependencyRows);
  } finally {
    database.close();
  }
}
