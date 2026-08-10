import type {
  MembershipState,
  Project,
  ValidationPolicy,
  ValidationPolicyAudit,
  WorkspaceDirectoryListing,
  WorkspaceFilePreview,
  WorkspaceState,
} from "./dto";

export interface ProjectWorkspaceQueries {
  getMembers: (databasePath: string, projectId: string) => MembershipState;
  getValidationPolicy: (databasePath: string, projectId: string) => ValidationPolicy;
  getWorkspace: (databasePath: string, projectId: string) => WorkspaceState;
  listProjects: (databasePath: string) => Project[];
  listWorkspaceDirectory: (
    databasePath: string,
    projectId: string,
    relativePath: string,
  ) => Promise<WorkspaceDirectoryListing>;
  readWorkspaceFilePreview: (
    databasePath: string,
    projectId: string,
    relativePath: string,
  ) => Promise<WorkspaceFilePreview>;
  listValidationPolicyAudits: (
    databasePath: string,
    projectId: string,
  ) => ValidationPolicyAudit[];
  listValidationPolicyRevisions: (
    databasePath: string,
    projectId: string,
  ) => ValidationPolicy[];
}
