import type { DatabaseSync } from "node:sqlite";

import { createThread } from "@/src/adapters/outbound/sqlite/public-collaboration/thread-service";
import { validateCurrentDataInvariants } from "@/src/adapters/outbound/sqlite/current-data-invariants";
import { seedMissionInitialization } from "@/tests/fixtures/review/mission-initialization";

const NOW = "2026-07-30T00:00:00.000Z";

function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    current += character;
    if (character === "'" && sql[index - 1] !== "\\") {
      if (quoted && sql[index + 1] === "'") {
        current += sql[++index]!;
      } else {
        quoted = !quoted;
      }
    }
    if (character === ";" && !quoted) {
      statements.push(current);
      current = "";
    }
  }
  if (current.trim()) statements.push(current);
  return statements;
}

function splitValues(value: string): string[] {
  const values: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "'" && value[index - 1] !== "\\") {
      if (quoted && value[index + 1] === "'") {
        current += character + value[++index]!;
        continue;
      }
      quoted = !quoted;
    }
    if (!quoted) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (character === "," && depth === 0) {
        values.push(current.trim());
        current = "";
        continue;
      }
    }
    current += character;
  }
  values.push(current.trim());
  return values;
}

function rewriteNamedInsert(
  statement: string,
  table: string,
  additions: Array<{
    after: string;
    column: string;
    value(columns: string[], values: string[]): string;
  }>,
): string {
  const expression = new RegExp(
    `(INSERT\\s+INTO\\s+${table}\\s*\\()([\\s\\S]*?)(\\)\\s*VALUES\\s*\\()([\\s\\S]*)(\\)\\s*;?\\s*)$`,
    "iu",
  );
  const match = statement.match(expression);
  if (!match) return statement;
  const columns = splitValues(match[2]!);
  const values = splitValues(match[4]!);
  if (columns.length !== values.length) return statement;
  for (const addition of additions) {
    if (columns.includes(addition.column)) continue;
    const index = columns.indexOf(addition.after);
    if (index < 0) continue;
    const value = addition.value(columns, values);
    columns.splice(index + 1, 0, addition.column);
    values.splice(index + 1, 0, value);
  }
  return `${match[1]}${columns.join(",")}${match[3]}${values.join(",")}${match[5]}`;
}

function projectThreadValue(columns: string[], values: string[]): string {
  const project = values[columns.indexOf("project_id")]!;
  return `(SELECT id FROM collaboration_threads WHERE project_id=${project} ORDER BY created_at,id LIMIT 1)`;
}

function attemptTupleValue(
  field: "project_id" | "thread_id",
  columns: string[],
  values: string[],
): string {
  const attempt = values[columns.indexOf("attempt_id")]!;
  return `(SELECT ${field} FROM collaboration_attempts WHERE id=${attempt})`;
}

function runTupleValue(
  field: "project_id" | "thread_id",
  columns: string[],
  values: string[],
): string {
  const run = values[columns.indexOf("run_id")]!;
  return `(SELECT ${field} FROM collaboration_runs WHERE id=${run})`;
}

function rewriteV7Tuples(statement: string): string {
  let rewritten = rewriteNamedInsert(statement, "collaboration_runs", [{
    after: "project_id",
    column: "thread_id",
    value: projectThreadValue,
  }]);
  rewritten = rewriteNamedInsert(rewritten, "executions", [{
    after: "source_collaboration_run_id",
    column: "source_collaboration_thread_id",
    value: projectThreadValue,
  }]);
  for (const table of [
    "collaboration_operations",
    "collaboration_attempts",
    "collaboration_messages",
  ]) {
    rewritten = rewriteNamedInsert(rewritten, table, [{
      after: "project_id",
      column: "thread_id",
      value: projectThreadValue,
    }]);
  }
  rewritten = rewriteNamedInsert(rewritten, "collaboration_project_sequences", [{
    after: "project_id",
    column: "thread_id",
    value: projectThreadValue,
  }]).replace(
    /\bINSERT\s+INTO\s+collaboration_project_sequences\b/iu,
    "INSERT OR REPLACE INTO collaboration_project_sequences",
  );
  rewritten = rewriteNamedInsert(rewritten, "collaboration_turns", [
    {
      after: "id",
      column: "project_id",
      value: (columns, values) => attemptTupleValue("project_id", columns, values),
    },
    {
      after: "project_id",
      column: "thread_id",
      value: (columns, values) => attemptTupleValue("thread_id", columns, values),
    },
  ]);
  rewritten = rewriteNamedInsert(rewritten, "collaboration_events", [
    {
      after: "id",
      column: "project_id",
      value: (columns, values) => runTupleValue("project_id", columns, values),
    },
    {
      after: "project_id",
      column: "thread_id",
      value: (columns, values) => runTupleValue("thread_id", columns, values),
    },
  ]);
  rewritten = rewriteNamedInsert(rewritten, "decision_requests", [
    {
      after: "id",
      column: "project_id",
      value: (columns, values) => runTupleValue("project_id", columns, values),
    },
    {
      after: "project_id",
      column: "thread_id",
      value: (columns, values) => runTupleValue("thread_id", columns, values),
    },
  ]);
  return rewritten;
}

function ensureTwoMembers(database: DatabaseSync, projectId: string): string[] {
  const members = database.prepare(
    `SELECT m.agent_id AS agentId
     FROM project_memberships m
     WHERE m.project_id=? ORDER BY m.joined_at,m.agent_id`,
  ).all(projectId) as Array<{ agentId: string }>;
  if (members.length === 0) {
    throw new Error(`V7 fixture project ${projectId} has no members`);
  }
  if (members.length === 1) {
    const source = database.prepare(
      `SELECT provider_id AS providerId,model FROM agents WHERE id=?`,
    ).get(members[0]!.agentId) as { model: string; providerId: string };
    const peerId = `${projectId}-fixture-peer`;
    database.prepare(
      `INSERT OR IGNORE INTO agents(
         id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
         can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
         updated_at,review_capable
       ) VALUES (?,?,?,'Fixture peer',?,?,'F','sky',1,0,0,1000,2,1,?,?,0)`,
    ).run(
      peerId,
      "Fixture peer",
      "Fixture",
      source.providerId,
      source.model,
      NOW,
      NOW,
    );
    database.prepare(
      `INSERT OR IGNORE INTO project_memberships(project_id,agent_id,joined_at)
       VALUES (?,?,?)`,
    ).run(projectId, peerId, NOW);
    members.push({ agentId: peerId });
  }
  return members.map(({ agentId }) => agentId);
}

export function initializeMissingMissionHeads(database: DatabaseSync): void {
  const missingMissions = database.prepare(`
    SELECT m.id,m.project_id AS projectId,m.updated_at AS updatedAt
    FROM missions m
    WHERE NOT EXISTS(
      SELECT 1 FROM mission_delivery_heads h
      WHERE h.mission_id=m.id AND h.project_id=m.project_id
    )
  `).all() as Array<{ id: string; projectId: string; updatedAt: string }>;
  for (const mission of missingMissions) {
    seedMissionInitialization(database, {
      missionId: mission.id,
      occurredAt: mission.updatedAt,
      projectId: mission.projectId,
    });
  }
}

function linkFixtureRuns(database: DatabaseSync): void {
  const runs = database.prepare(`
    SELECT r.id,r.project_id AS projectId,r.thread_id AS threadId,r.created_at AS createdAt
    FROM collaboration_runs r
    WHERE NOT EXISTS(
      SELECT 1 FROM collaboration_thread_facts f
      WHERE f.project_id=r.project_id AND f.thread_id=r.thread_id
        AND f.run_id=r.id AND f.type='run_linked'
    )
    ORDER BY r.project_id,r.created_at,r.id
  `).all() as Array<{
    createdAt: string;
    id: string;
    projectId: string;
    threadId: string;
  }>;
  for (const run of runs) {
    const thread = database.prepare(
      `SELECT next_fact_sequence AS factSequence
       FROM collaboration_threads WHERE project_id=? AND id=?`,
    ).get(run.projectId, run.threadId) as { factSequence: number };
    const project = database.prepare(
      `SELECT next_activity_sequence AS activitySequence
       FROM collaboration_project_thread_sequences WHERE project_id=?`,
    ).get(run.projectId) as { activitySequence: number };
    database.prepare(
      `INSERT INTO collaboration_thread_facts(
         id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
         run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
       ) VALUES (?,?,?,?,?,'run_linked','system',NULL,?,NULL,NULL,NULL,?,?)`,
    ).run(
      `fixture-run-link-${run.id}`,
      run.projectId,
      run.threadId,
      thread.factSequence,
      project.activitySequence,
      run.id,
      JSON.stringify({ runId: run.id }),
      run.createdAt,
    );
    database.prepare(
      `UPDATE collaboration_threads
       SET next_fact_sequence=next_fact_sequence+1,last_activity_sequence=?,
           version=version+1,updated_at=?
       WHERE project_id=? AND id=?`,
    ).run(project.activitySequence, run.createdAt, run.projectId, run.threadId);
    database.prepare(
      `UPDATE collaboration_project_thread_sequences
       SET next_activity_sequence=next_activity_sequence+1 WHERE project_id=?`,
    ).run(run.projectId);
  }
}

function linkFixtureChildren(database: DatabaseSync): void {
  const children = database.prepare(`
    SELECT 'message' AS childKind,m.id,m.project_id AS projectId,
           m.thread_id AS threadId,m.run_id AS runId,m.author_type AS actorType,
           m.author_agent_id AS actorId,m.created_at AS createdAt,NULL AS eventType
    FROM collaboration_messages m
    WHERE NOT EXISTS(
      SELECT 1 FROM collaboration_thread_facts f WHERE f.message_id=m.id
    )
    UNION ALL
    SELECT 'event',e.id,e.project_id,e.thread_id,e.run_id,e.actor_type,e.actor_id,
           e.created_at,e.type
    FROM collaboration_events e
    WHERE e.type NOT IN('owner_message','agent_message') AND NOT EXISTS(
      SELECT 1 FROM collaboration_thread_facts f WHERE f.run_event_id=e.id
    )
    ORDER BY createdAt,id
  `).all() as Array<{
    actorId: string | null;
    actorType: string;
    childKind: "event" | "message";
    createdAt: string;
    eventType: string | null;
    id: string;
    projectId: string;
    runId: string | null;
    threadId: string;
  }>;
  for (const child of children) {
    const thread = database.prepare(
      `SELECT next_fact_sequence AS factSequence
       FROM collaboration_threads WHERE project_id=? AND id=?`,
    ).get(child.projectId, child.threadId) as { factSequence: number };
    const project = database.prepare(
      `SELECT next_activity_sequence AS activitySequence
       FROM collaboration_project_thread_sequences WHERE project_id=?`,
    ).get(child.projectId) as { activitySequence: number };
    const factType = child.childKind === "message"
      ? child.actorType === "owner" ? "owner_message" : "agent_message"
      : "run_event";
    database.prepare(
      `INSERT INTO collaboration_thread_facts(
         id,project_id,thread_id,sequence,activity_sequence,type,actor_type,actor_id,
         run_id,message_id,run_event_id,policy_revision_id,payload_json,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `fixture-${child.childKind}-${child.id}`,
      child.projectId,
      child.threadId,
      thread.factSequence,
      project.activitySequence,
      factType,
      child.actorType,
      child.actorId,
      child.runId,
      child.childKind === "message" ? child.id : null,
      child.childKind === "event" ? child.id : null,
      null,
      JSON.stringify(child.childKind === "message"
        ? { messageId: child.id }
        : { eventType: child.eventType }),
      child.createdAt,
    );
    database.prepare(
      `UPDATE collaboration_threads
       SET next_fact_sequence=next_fact_sequence+1,last_activity_sequence=?,
           version=version+1,updated_at=?
       WHERE project_id=? AND id=?`,
    ).run(
      project.activitySequence,
      child.createdAt,
      child.projectId,
      child.threadId,
    );
    database.prepare(
      `UPDATE collaboration_project_thread_sequences
       SET next_activity_sequence=next_activity_sequence+1 WHERE project_id=?`,
    ).run(child.projectId);
  }
}

export function execV7Fixture(
  databasePath: string,
  database: DatabaseSync,
  sql: string,
  options: { validate?: boolean } = {},
): Map<string, string> {
  const statements = splitStatements(sql);
  const firstTuple = statements.findIndex((statement) =>
    /\bINSERT\s+INTO\s+collaboration_runs\b/iu.test(statement)
  );
  if (firstTuple < 0) {
    database.exec(sql);
    return new Map();
  }
  database.exec(statements.slice(0, firstTuple).join(""));
  const projects = database.prepare(
    `SELECT DISTINCT project_id AS projectId
     FROM project_memberships ORDER BY project_id`,
  ).all() as Array<{ projectId: string }>;
  const threads = new Map<string, string>();
  initializeMissingMissionHeads(database);
  for (const { projectId } of projects) {
    const existing = database.prepare(
      `SELECT id FROM collaboration_threads
       WHERE project_id=? ORDER BY created_at,id LIMIT 1`,
    ).get(projectId) as { id: string } | undefined;
    const threadId = existing?.id ?? createThread(databasePath, projectId, {
      memberAgentIds: ensureTwoMembers(database, projectId),
      operationId: crypto.randomUUID(),
      title: "Fixture source thread",
    }).body.thread.id;
    threads.set(projectId, threadId);
  }
  database.exec(
    statements.slice(firstTuple).map(rewriteV7Tuples).join(""),
  );
  linkFixtureRuns(database);
  linkFixtureChildren(database);
  if (options.validate !== false) assertFixtureDatabase(database);
  return threads;
}

export function validateFixtureDatabase(
  database: DatabaseSync,
): "SCHEMA_DRIFT" | "SCHEMA_DATA_INVALID" | null {
  return validateCurrentDataInvariants(database);
}

function assertFixtureDatabase(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  const validation = validateFixtureDatabase(database);
  if (validation !== null) {
    throw new Error(`V${row.user_version} fixture graph is invalid: ${validation}`);
  }
}

export function assertV7Fixture(database: DatabaseSync): void {
  assertFixtureDatabase(database);
}

export function execV7TupleStatements(
  database: DatabaseSync,
  sql: string,
): void {
  database.exec(splitStatements(sql).map(rewriteV7Tuples).join(""));
  linkFixtureRuns(database);
  linkFixtureChildren(database);
  const validation = validateFixtureDatabase(database);
  if (validation !== null) {
    throw new Error(`Fixture tuples are invalid: ${validation}`);
  }
}
