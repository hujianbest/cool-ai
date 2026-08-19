import type {
  BindWorkspaceInput,
  CreateWorkspaceEditInput,
  MembershipState,
  Project,
  PutWorkspaceEditDraftInput,
  ReplaceMembersInput,
  ResolvedExecutable,
  SaveValidationPolicyInput,
  SaveValidationPolicyResult,
  WorkspaceEditSession,
  WorkspaceFs,
  WorkspaceOperation,
  WorkspaceState,
} from "./dto";

export interface ProjectWorkspaceCommands {
  bindWorkspace: (
    databasePath: string,
    projectId: string,
    input: BindWorkspaceInput,
    workspaceFs?: WorkspaceFs,
  ) => Promise<WorkspaceState>;
  createNodeWorkspaceFs: (record?: (operation: WorkspaceOperation) => void) => WorkspaceFs;
  createProject: (name: string, databasePath: string) => Project;
  ensureDirectProject: (databasePath: string) => Project;
  openWorkspaceAsProject: (
    databasePath: string,
    path: string,
    workspaceFs?: WorkspaceFs,
  ) => Promise<{ created: boolean; project: Project }>;
  replaceMembers: (
    databasePath: string,
    projectId: string,
    input: ReplaceMembersInput,
  ) => MembershipState;
  setDirectChatAgent: (
    databasePath: string,
    projectId: string,
    agentId: string,
    expectedVersion: number,
  ) => MembershipState;
  saveValidationPolicy: (
    databasePath: string,
    projectId: string,
    input: SaveValidationPolicyInput,
    options?: { resolveExecutable?: (executable: string) => ResolvedExecutable },
  ) => SaveValidationPolicyResult;
  createWorkspaceEdit: (
    databasePath: string,
    projectId: string,
    input: CreateWorkspaceEditInput,
  ) => Promise<WorkspaceEditSession>;
  putWorkspaceEditDraft: (
    databasePath: string,
    projectId: string,
    sessionId: string,
    input: PutWorkspaceEditDraftInput,
  ) => Promise<WorkspaceEditSession>;
}
