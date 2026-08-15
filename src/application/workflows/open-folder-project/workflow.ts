import type { AgentProfile, IdentityCapabilityCommands } from "@/src/modules/identity-capability";
import type {
  Project,
  ProjectWorkspaceCommands,
  ProjectWorkspaceQueries,
} from "@/src/modules/project-workspace";

export type OpenFolderProjectResult = {
  created: boolean;
  project: Project;
};

export type OpenFolderProjectWorkflow = {
  execute(databasePath: string, path: string): Promise<OpenFolderProjectResult>;
};

export function createOpenFolderProjectWorkflow(dependencies: {
  ensureStarterAgents: IdentityCapabilityCommands["ensureStarterAgents"];
  getMembers: ProjectWorkspaceQueries["getMembers"];
  openWorkspaceAsProject: ProjectWorkspaceCommands["openWorkspaceAsProject"];
  replaceMembers: ProjectWorkspaceCommands["replaceMembers"];
}): OpenFolderProjectWorkflow {
  return {
    async execute(databasePath, path) {
      const opened = await dependencies.openWorkspaceAsProject(databasePath, path);
      const starters: AgentProfile[] = dependencies.ensureStarterAgents(databasePath);
      if (starters.length >= 2) {
        const membership = dependencies.getMembers(databasePath, opened.project.id);
        if (membership.members.length === 0) {
          dependencies.replaceMembers(databasePath, opened.project.id, {
            agentIds: starters.map((agent) => agent.id),
            expectedProjectVersion: membership.projectVersion,
          });
        }
      }
      return opened;
    },
  };
}
