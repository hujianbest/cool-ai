export type WorkspaceBinding = {
  path: string;
  status: "ready";
};

export type WorkspaceState = {
  workspace: WorkspaceBinding | null;
  projectVersion: number;
};

export type ProjectMember = {
  agentId: string;
  joinedAt: string;
  name: string;
  role: string;
  model: string;
  avatarText: string;
  accentToken: string;
  skillNames: string[];
  permissions: {
    readFiles: boolean;
    writeFiles: boolean;
    runCommands: boolean;
  };
};

export type MembershipState = {
  members: ProjectMember[];
  projectVersion: number;
};

export type Mission = {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkItemStatus = "todo" | "in_progress" | "blocked" | "done";

export type WorkItemLease = {
  token: string;
  holderAgentId: string;
  expiresAt: string;
  lastHeartbeatAt: string;
  expired: boolean;
};

export type WorkItem = {
  id: string;
  missionId: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  assigneeAgentId: string | null;
  dependencyIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  lease?: WorkItemLease | null;
};

export type MissionState = {
  mission: Mission | null;
  workItems: WorkItem[];
};

export type MemoryEntry = {
  id: string;
  projectId: string;
  type: "goal" | "decision" | "fact" | "artifact";
  content: string;
  sourceType: "owner_input" | "work_item" | "artifact_path";
  sourceRef: string;
  createdBy: "owner";
  supersedesId: string | null;
  active: boolean;
  createdAt: string;
};

export type ProjectContextSnapshot = {
  schemaVersion: 1;
  shared: {
    // 个人对话（未绑定工作区、单成员）没有工作区与使命：这两个槽位如实为 null，
    // 由消费方呈现空态，而不是伪造占位事实。
    project: { id: string; name: string; workspacePath: string | null };
    roster: ProjectMember[];
    mission: Mission | null;
    workItems: WorkItem[];
    memories: MemoryEntry[];
  };
  currentAgent: {
    id: string;
    name: string;
    role: string;
    systemPrompt: string;
    skills: Array<{ id: string; name: string; instructions: string }>;
    permissions: {
      readFiles: boolean;
      writeFiles: boolean;
      runCommands: boolean;
    };
  };
};
