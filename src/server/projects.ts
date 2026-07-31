import { randomUUID } from "node:crypto";

import type { Project } from "@/src/shared/contracts";
import { openDatabase } from "@/src/server/db";
import { initializeValidationPolicy } from "@/src/server/execution/validation-policy-service";

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
