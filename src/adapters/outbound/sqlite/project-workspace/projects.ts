import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import type { Project } from "@/src/shared/contracts";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { appendProjectCreatedAuditOutboxRow } from "@/src/adapters/outbound/sqlite/project-workspace/audit-event-outbox";
import { initializeValidationPolicy } from "@/src/adapters/outbound/sqlite/project-workspace/validation-policy-service";

type ProjectRow = {
  id: string;
  name: string;
  createdAt: string;
};

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
  };
}

export function createProject(name: string, databasePath: string): Project {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Project name is required.");
  }

  const project: Project = {
    id: randomUUID(),
    name: trimmedName,
    createdAt: new Date().toISOString(),
  };
  const database = openDatabase(databasePath);

  try {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)")
      .run(project.id, project.name, project.createdAt);
    initializeValidationPolicy(database, project.id, project.createdAt);
    appendProjectCreatedAuditOutboxRow(database, {
      occurredAt: project.createdAt,
      projectId: project.id,
      projectName: project.name,
    });
    database.exec("COMMIT");
    return project;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original creation failure.
    }
    throw error;
  } finally {
    database.close();
  }
}

function selectDirectProject(database: DatabaseSync): Project | null {
  const existing = database
    .prepare(
      `SELECT id, name, created_at AS createdAt
       FROM projects
       WHERE name = '个人对话' AND workspace_path IS NULL
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    )
    .get() as ProjectRow | undefined;
  return existing ? toProject(existing) : null;
}

export function findDirectProject(databasePath: string): Project | null {
  const database = openDatabase(databasePath);
  try {
    return selectDirectProject(database);
  } finally {
    database.close();
  }
}

export function ensureDirectProject(databasePath: string): Project {
  return findDirectProject(databasePath) ?? createProject("个人对话", databasePath);
}

export function listProjects(databasePath: string): Project[] {
  const database = openDatabase(databasePath);

  try {
    const rows = database
      .prepare(
        "SELECT id, name, created_at AS createdAt FROM projects ORDER BY created_at ASC, id ASC",
      )
      .all() as ProjectRow[];
    return rows.map(toProject);
  } finally {
    database.close();
  }
}
