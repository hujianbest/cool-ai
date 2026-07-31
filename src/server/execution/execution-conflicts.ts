import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type CanonicalPathState = {
  exists: boolean;
  identity: string | null;
  path: string;
  sha256: string | null;
};

export function normalizeCanonicalRelativePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (
    value.length === 0
    || value.includes("\0")
    || /^[a-zA-Z]:[\\/]/u.test(value)
    || value.startsWith("/")
    || value.startsWith("\\")
  ) {
    throw new Error("Expected a non-empty canonical relative path.");
  }
  const segments: string[] = [];
  for (const rawSegment of value.replaceAll("\\", "/").split("/")) {
    const segment = rawSegment.normalize("NFC");
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw new Error("Canonical relative path escapes its root.");
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) throw new Error("Expected a canonical relative path.");
  const normalized = segments.join("/");
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function stateMap(
  states: CanonicalPathState[],
  platform: NodeJS.Platform,
): Map<string, CanonicalPathState> {
  const result = new Map<string, CanonicalPathState>();
  for (const state of states) {
    const key = normalizeCanonicalRelativePath(state.path, platform);
    if (result.has(key)) throw new Error(`Canonical path states collide at ${key}.`);
    if (
      state.exists
        ? !state.identity || !state.sha256 || !/^[0-9a-f]{64}$/u.test(state.sha256)
        : state.identity !== null || state.sha256 !== null
    ) {
      throw new Error(`Canonical path state is inconsistent at ${key}.`);
    }
    result.set(key, { ...state, path: state.path.normalize("NFC") });
  }
  return result;
}

export function compareCanonicalPathStates(input: {
  current: CanonicalPathState[];
  frozen: CanonicalPathState[];
  relevantPaths: string[];
  platform?: NodeJS.Platform;
}): {
  disposition: "current" | "stale";
  mismatches: Array<{
    kind: string;
    path: string;
    pathKey: string;
  }>;
} {
  const platform = input.platform ?? process.platform;
  const frozen = stateMap(input.frozen, platform);
  const current = stateMap(input.current, platform);
  const relevant = [...new Set(input.relevantPaths.map((path) =>
    normalizeCanonicalRelativePath(path, platform)))].sort(compareUtf8);
  const mismatches: Array<{ kind: string; path: string; pathKey: string }> = [];
  for (const pathKey of relevant) {
    const before = frozen.get(pathKey) ?? {
      exists: false,
      identity: null,
      path: pathKey,
      sha256: null,
    };
    const after = current.get(pathKey) ?? {
      exists: false,
      identity: null,
      path: before.path,
      sha256: null,
    };
    let kind: string | null = null;
    if (before.exists !== after.exists) {
      kind = before.exists ? "path_missing" : "added_path_now_exists";
    } else if (before.exists && before.identity !== after.identity) {
      kind = "identity_changed";
    } else if (before.exists && before.sha256 !== after.sha256) {
      kind = "hash_changed";
    }
    if (kind) mismatches.push({ kind, path: before.path, pathKey });
  }
  mismatches.sort((left, right) => compareUtf8(left.pathKey, right.pathKey));
  return {
    disposition: mismatches.length === 0 ? "current" : "stale",
    mismatches,
  };
}

function transaction<T>(database: DatabaseSync, label: string, work: () => T): T {
  const ownsTransaction = !database.isTransaction;
  const savepoint = `${label}_${randomUUID().replaceAll("-", "")}`;
  database.exec(ownsTransaction ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  try {
    const result = work();
    if (ownsTransaction) database.exec("COMMIT");
    else database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    try {
      if (ownsTransaction) database.exec("ROLLBACK");
      else {
        database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
    } catch {
      // Preserve the boundary error.
    }
    throw error;
  }
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name));
}

export function staleExecutionForCanonicalPathChanges(
  database: DatabaseSync,
  input: {
    attemptNo: number;
    current: CanonicalPathState[];
    executionId: string;
    frozen: CanonicalPathState[];
    platform?: NodeJS.Platform;
    projectId: string;
    relevantPaths: string[];
  },
): ReturnType<typeof compareCanonicalPathStates> {
  const comparison = compareCanonicalPathStates(input);
  if (comparison.disposition === "current") return comparison;
  return transaction(database, "canonical_stale", () => {
    const execution = database.prepare(`
      SELECT status,next_event_sequence AS nextEventSequence
      FROM executions WHERE project_id=? AND id=?
    `).get(input.projectId, input.executionId) as {
      nextEventSequence: number;
      status: string;
    } | undefined;
    if (!execution) throw new Error("Execution was not found.");
    if (!["stale", "conflicted", "failed", "stopped", "merged"].includes(execution.status)) {
      database.prepare(`
        UPDATE executions
        SET status='stale',reason_code='STALE_EXECUTION',version=version+1
        WHERE project_id=? AND id=?
      `).run(input.projectId, input.executionId);
      if (tableExists(database, "execution_actions")) {
        database.prepare(`
          UPDATE execution_actions
          SET status='discarded',lease_token=NULL,lease_expires_at=NULL,result_json=NULL,
              error_code='STALE_EXECUTION',
              finished_at=coalesce(finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          WHERE project_id=? AND execution_id=? AND status IN ('pending','running')
        `).run(input.projectId, input.executionId);
      }
      if (tableExists(database, "execution_tool_calls")) {
        database.prepare(`
          UPDATE execution_tool_calls SET status='discarded',
            finished_at=coalesce(finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          WHERE project_id=? AND execution_id=? AND status IN ('requested','waiting_approval')
        `).run(input.projectId, input.executionId);
      }
      if (tableExists(database, "execution_approvals")) {
        database.prepare(`
          UPDATE execution_approvals SET status='expired',
            decided_at=coalesce(decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          WHERE project_id=? AND execution_id=? AND status IN ('pending','approved')
        `).run(input.projectId, input.executionId);
      }
      if (tableExists(database, "execution_operations")) {
        const body = JSON.stringify({
          error: {
            code: "STALE_EXECUTION",
            message: "Canonical workspace paths changed; retry from a new baseline.",
          },
        });
        database.prepare(`
          UPDATE execution_operations
          SET status='completed',final_action_index=action_count-1,http_status=409,
              response_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE project_id=? AND execution_id=? AND status='pending' AND action_count>0
        `).run(body, input.projectId, input.executionId);
      }
      database.prepare(`
        INSERT INTO execution_events (
          id,project_id,execution_id,sequence,attempt_no,type,actor_type,actor_id,
          payload_json,created_at
        ) VALUES (?, ?, ?, ?, ?, 'stale_detected', 'system', NULL, ?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        randomUUID(),
        input.projectId,
        input.executionId,
        execution.nextEventSequence,
        input.attemptNo,
        JSON.stringify({
          categories: ["external_workspace"],
          pathCount: comparison.mismatches.length,
        }),
      );
      database.prepare(`
        UPDATE executions SET next_event_sequence=next_event_sequence+1
        WHERE project_id=? AND id=?
      `).run(input.projectId, input.executionId);
    }
    return comparison;
  });
}

export function reserveExecutionStagedPaths(
  database: DatabaseSync,
  input: {
    attemptNo: number;
    executionId: string;
    paths: string[];
    platform?: NodeJS.Platform;
    persistReservation?: (database: DatabaseSync, pathKeys: string[]) => void;
    projectId: string;
  },
): {
  conflictingExecutionIds: string[];
  disposition: "conflicted" | "reserved";
  pathKeys: string[];
} {
  const pathKeys = [...new Set(input.paths.map((path) =>
    normalizeCanonicalRelativePath(path, input.platform ?? process.platform)))].sort(compareUtf8);
  return transaction(database, "path_reservation", () => {
    input.persistReservation?.(database, pathKeys);
    if (pathKeys.length === 0) {
      return { conflictingExecutionIds: [], disposition: "reserved", pathKeys };
    }
    const placeholders = pathKeys.map(() => "?").join(",");
    const conflictingRows = database.prepare(`
      SELECT DISTINCT s.execution_id AS executionId,f.path_key AS pathKey
      FROM execution_staged_files f
      JOIN execution_staged_results s ON s.id=f.staged_result_id
      JOIN executions e ON e.id=s.execution_id AND e.project_id=s.project_id
      WHERE s.project_id=? AND s.execution_id<>?
        AND e.status IN ('queued','running','waiting_approval','paused','staged','conflicted')
        AND f.path_key IN (${placeholders})
      ORDER BY s.execution_id,f.path_key
    `).all(input.projectId, input.executionId, ...pathKeys) as Array<{
      executionId: string;
      pathKey: string;
    }>;
    const conflictingExecutionIds = [...new Set(
      conflictingRows.map(({ executionId }) => executionId),
    )];
    if (conflictingExecutionIds.length === 0) {
      return { conflictingExecutionIds, disposition: "reserved", pathKeys };
    }

    const allExecutions = [input.executionId, ...conflictingExecutionIds].sort(compareUtf8);
    const executionPlaceholders = allExecutions.map(() => "?").join(",");
    const hasAttemptNo = (database.prepare("PRAGMA table_info(executions)").all() as Array<{
      name: string;
    }>).some(({ name }) => name === "current_attempt_no");
    const prior = database.prepare(`
      SELECT id,status,next_event_sequence AS nextEventSequence,
             ${hasAttemptNo ? "current_attempt_no" : String(input.attemptNo)} AS attemptNo
      FROM executions WHERE project_id=? AND id IN (${executionPlaceholders})
      ORDER BY id
    `).all(input.projectId, ...allExecutions) as Array<{
      attemptNo: number;
      id: string;
      nextEventSequence: number;
      status: string;
    }>;
    database.prepare(`
      UPDATE executions
      SET status='conflicted',reason_code='PATH_CONFLICT',version=version+1
      WHERE project_id=? AND id IN (${executionPlaceholders}) AND status<>'conflicted'
    `).run(input.projectId, ...allExecutions);
    const insertEvent = database.prepare(`
      INSERT INTO execution_events (
        id,project_id,execution_id,sequence,attempt_no,type,actor_type,actor_id,
        payload_json,created_at
      ) VALUES (?, ?, ?, ?, ?, 'conflict_detected', 'system', NULL, ?,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `);
    for (const execution of prior) {
      if (execution.status === "conflicted") continue;
      const others = allExecutions.filter((id) => id !== execution.id);
      const conflictingPathCount = execution.id === input.executionId
        ? new Set(conflictingRows.map(({ pathKey }) => pathKey)).size
        : new Set(conflictingRows
            .filter(({ executionId }) => executionId === execution.id)
            .map(({ pathKey }) => pathKey)).size;
      insertEvent.run(
        randomUUID(),
        input.projectId,
        execution.id,
        execution.nextEventSequence,
        execution.attemptNo,
        JSON.stringify({
          otherExecutionIds: others,
          pathCount: conflictingPathCount,
        }),
      );
      database.prepare(`
        UPDATE executions SET next_event_sequence=next_event_sequence+1
        WHERE project_id=? AND id=?
      `).run(input.projectId, execution.id);
    }
    return { conflictingExecutionIds, disposition: "conflicted", pathKeys };
  });
}
