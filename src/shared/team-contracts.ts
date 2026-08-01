export type Skill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type SkillInput = {
  name: string;
  description: string;
  instructions: string;
};

export type UpdateSkillInput = SkillInput & {
  expectedVersion: number;
};

export type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  apiKeyMask: string;
  status: "verified" | "key_unavailable" | "key_corrupt";
  verifiedAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ProviderConnection = {
  baseUrl: string;
  defaultModel: string;
  allowInsecureHttp: boolean;
};

export type CreateProviderDraft = ProviderConnection & {
  mode: "create";
  name: string;
  apiKey: string;
};

export type RetainProviderDraft = ProviderConnection & {
  mode: "retain";
  providerId: string;
  expectedVersion: number;
  name: string;
};

export type ReplaceProviderDraft = ProviderConnection & {
  mode: "replace";
  providerId: string;
  expectedVersion: number;
  name: string;
  apiKey: string;
};

export type ProviderDraft =
  | CreateProviderDraft
  | RetainProviderDraft
  | ReplaceProviderDraft;

export type ToolPermissions = {
  readFiles: boolean;
  writeFiles: boolean;
  runCommands: boolean;
};

export type AccentToken =
  | "sage"
  | "terracotta"
  | "gold"
  | "slate"
  | "rose"
  | "olive";

export type AgentInput = {
  name: string;
  role: string;
  systemPrompt: string;
  reviewCapable?: boolean;
  providerId: string;
  model: string;
  skillIds: string[];
  permissions: ToolPermissions;
  maxTokens: number;
  maxHandoffs: number;
  avatarText: string;
  accentToken: AccentToken;
};

export type UpdateAgentInput = AgentInput & {
  expectedVersion: number;
};

export type AgentProfile = Omit<AgentInput, "reviewCapable"> & {
  id: string;
  reviewCapable: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentTemplate = Pick<
  AgentInput,
  "name" | "role" | "systemPrompt" | "avatarText" | "accentToken"
> & {
  id: "planner" | "builder" | "reviewer";
  reviewCapable: boolean;
};
