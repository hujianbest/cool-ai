import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import {
  listWorkspaceEntries,
  readWorkspacePreview,
  type SandboxFileHandleAdapter,
} from "@/src/adapters/outbound/workspace/workspace-browse-adapter";
import { WorkspaceError } from "@/src/modules/project-workspace";
import type {
  WorkspaceDirectoryListing,
  WorkspaceFilePreview,
} from "@/src/modules/project-workspace";

function boundWorkspaceRoot(databasePath: string, projectId: string): string {
  const database = openDatabase(databasePath);
  try {
    const project = database
      .prepare("SELECT workspace_path AS workspacePath FROM projects WHERE id = ?")
      .get(projectId) as { workspacePath: string | null } | undefined;
    if (!project) {
      throw new WorkspaceError("PROJECT_NOT_FOUND", "Project was not found.");
    }
    if (!project.workspacePath) {
      throw new WorkspaceError(
        "WORKSPACE_NOT_BOUND",
        "Project has no ready workspace binding.",
      );
    }
    return project.workspacePath;
  } finally {
    database.close();
  }
}

export async function listWorkspaceDirectory<Handle>(
  databasePath: string,
  projectId: string,
  relativePath: string,
  fs: SandboxFileHandleAdapter<Handle>,
): Promise<WorkspaceDirectoryListing> {
  const workspaceRoot = boundWorkspaceRoot(databasePath, projectId);
  return listWorkspaceEntries({ fs, relativePath, workspaceRoot });
}

export async function readWorkspaceFilePreview<Handle>(
  databasePath: string,
  projectId: string,
  relativePath: string,
  fs: SandboxFileHandleAdapter<Handle>,
): Promise<WorkspaceFilePreview> {
  const workspaceRoot = boundWorkspaceRoot(databasePath, projectId);
  return readWorkspacePreview({ fs, relativePath, workspaceRoot });
}
