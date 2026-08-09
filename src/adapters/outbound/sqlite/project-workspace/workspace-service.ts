import {
  access as nodeAccess,
  realpath as nodeRealpath,
  stat as nodeStat,
} from "node:fs/promises";
import { appendFileSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { WorkspaceError } from "@/src/modules/project-workspace";
import type {
  WorkspaceFs,
  WorkspaceOperation,
} from "@/src/modules/project-workspace";
import type { WorkspaceState } from "@/src/shared/project-context-contracts";

type ProjectWorkspaceRow = {
  workspacePath: string | null;
  version: number;
};

export function createNodeWorkspaceFs(
  record: (operation: WorkspaceOperation) => void = (operation) => {
    const auditPath = process.env.COCKPIT_WORKSPACE_AUDIT_PATH;
    if (auditPath) {
      appendFileSync(auditPath, `${JSON.stringify({ operation })}\n`, "utf8");
    }
  },
): WorkspaceFs {
  return {
    async realpath(path) {
      record("realpath");
      return nodeRealpath(path);
    },
    async statDirectory(path) {
      record("stat");
      return (await nodeStat(path)).isDirectory();
    },
    async checkReadable(path) {
      record("access");
      await nodeAccess(path, constants.R_OK);
    },
  };
}

type BindWorkspaceInput = {
  path: string;
  expectedVersion: number;
  confirmRebind: boolean;
};

type ProjectBindingRow = ProjectWorkspaceRow & {
  workspaceKey: string | null;
};

function readProject(
  databasePath: string,
  projectId: string,
): ProjectWorkspaceRow | undefined {
  const database = openDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT workspace_path AS workspacePath, version
         FROM projects
         WHERE id = ?`,
      )
      .get(projectId) as ProjectWorkspaceRow | undefined;
  } finally {
    database.close();
  }
}

export function getWorkspace(databasePath: string, projectId: string): WorkspaceState {
  const project = readProject(databasePath, projectId);
  if (!project) {
    throw new WorkspaceError("PROJECT_NOT_FOUND", "Project was not found.");
  }
  return {
    workspace: project.workspacePath
      ? { path: project.workspacePath, status: "ready" }
      : null,
    projectVersion: project.version,
  };
}

async function canonicalDirectory(inputPath: string, workspaceFs: WorkspaceFs): Promise<string> {
  const value = inputPath.trim();
  if (!value || value.length > 32_767 || value.includes("\0") || !isAbsolute(value)) {
    throw new WorkspaceError("WORKSPACE_INVALID", "Workspace path must be an absolute path.");
  }

  let canonicalPath: string;
  try {
    canonicalPath = await workspaceFs.realpath(value);
  } catch {
    throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace directory was not found.");
  }

  let directory: boolean;
  try {
    directory = await workspaceFs.statDirectory(canonicalPath);
  } catch {
    throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace directory was not found.");
  }
  if (!directory) {
    throw new WorkspaceError("WORKSPACE_NOT_DIRECTORY", "Workspace path must be a directory.");
  }

  try {
    await workspaceFs.checkReadable(canonicalPath);
  } catch {
    throw new WorkspaceError("WORKSPACE_NOT_READABLE", "Workspace directory is not readable.");
  }
  return canonicalPath;
}

function workspaceKey(canonicalPath: string): string {
  return process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the typed binding error.
  }
}

export async function bindWorkspace(
  databasePath: string,
  projectId: string,
  input: BindWorkspaceInput,
  workspaceFs: WorkspaceFs = createNodeWorkspaceFs(),
): Promise<WorkspaceState> {
  if (
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    typeof input.confirmRebind !== "boolean"
  ) {
    throw new WorkspaceError(
      "INVALID_INPUT",
      "Workspace input is invalid.",
      [
        {
          field:
            typeof input.confirmRebind !== "boolean"
              ? "confirmRebind"
              : "expectedVersion",
          code:
            typeof input.confirmRebind !== "boolean"
              ? "invalid_type"
              : "invalid_format",
        },
      ],
    );
  }
  const canonicalPath = await canonicalDirectory(input.path, workspaceFs);
  const canonicalKey = workspaceKey(canonicalPath);
  const database = openDatabase(databasePath);

  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const project = database
        .prepare(
          `SELECT workspace_path AS workspacePath, workspace_key AS workspaceKey, version
           FROM projects
           WHERE id = ?`,
        )
        .get(projectId) as ProjectBindingRow | undefined;
      if (!project) {
        throw new WorkspaceError("PROJECT_NOT_FOUND", "Project was not found.");
      }
      if (project.version !== input.expectedVersion) {
        throw new WorkspaceError(
          "RESOURCE_CONFLICT",
          "Project version is stale.",
          undefined,
          project.version,
        );
      }

      const duplicate = database
        .prepare(
          `SELECT 1
           FROM projects
           WHERE workspace_key = ? AND id <> ?
           LIMIT 1`,
        )
        .get(canonicalKey, projectId);
      if (duplicate) {
        throw new WorkspaceError(
          "WORKSPACE_ALREADY_BOUND",
          "Workspace is already bound to another project.",
        );
      }
      if (
        project.workspaceKey &&
        project.workspaceKey !== canonicalKey &&
        !input.confirmRebind
      ) {
        throw new WorkspaceError(
          "REBIND_CONFIRMATION_REQUIRED",
          "Workspace rebind confirmation is required.",
        );
      }

      database
        .prepare(
          `UPDATE projects
           SET workspace_path = ?, workspace_key = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(canonicalPath, canonicalKey, projectId);
      database.exec("COMMIT");
    } catch (error) {
      rollback(database);
      throw error;
    }
    return {
      workspace: { path: canonicalPath, status: "ready" },
      projectVersion: input.expectedVersion + 1,
    };
  } finally {
    database.close();
  }
}
