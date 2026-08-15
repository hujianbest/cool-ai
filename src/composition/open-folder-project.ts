import { createOpenFolderProjectWorkflow } from "@/src/application/workflows/open-folder-project";
import * as agentService from "@/src/adapters/outbound/sqlite/identity-capability/agent-service";
import * as membershipService from "@/src/adapters/outbound/sqlite/project-workspace/membership-service";
import * as workspaceService from "@/src/adapters/outbound/sqlite/project-workspace/workspace-service";

export function openFolderAsProject(databasePath: string, path: string) {
  return createOpenFolderProjectWorkflow({
    ensureStarterAgents: agentService.ensureStarterAgents,
    getMembers: membershipService.getMembers,
    openWorkspaceAsProject: workspaceService.openWorkspaceAsProject,
    replaceMembers: membershipService.replaceMembers,
  }).execute(databasePath, path);
}
