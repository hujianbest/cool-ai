import type {
  AgentInput,
  AgentProfile,
  CredentialEnvelope,
  ExistingProviderTokenDraft,
  Provider,
  ProviderDraftVerification,
  ProviderTokenDraft,
  Skill,
  SkillInput,
  UpdateAgentInput,
  UpdateSkillInput,
} from "./dto";

export type CredentialVault = {
  decrypt: (providerId: string, envelope: CredentialEnvelope) => string;
  encrypt: (providerId: string, apiKey: string) => CredentialEnvelope;
  fingerprint: (apiKey: string) => string;
  issueCreateToken: (draft: ProviderTokenDraft) => string;
  issueExistingToken: (draft: ExistingProviderTokenDraft) => string;
  keyId: string;
  mask: (apiKey: string) => string;
  verifyCreateToken: (token: string, draft: ProviderTokenDraft) => unknown;
  verifyExistingToken: (token: string, draft: ExistingProviderTokenDraft) => unknown;
};

export interface IdentityCapabilityCommands {
  createAgent: (input: AgentInput, databasePath: string) => AgentProfile;
  ensureStarterAgents: (databasePath: string) => AgentProfile[];
  createCredentialVault: () => CredentialVault;
  createProvider: (
    input: unknown,
    validationToken: string | undefined,
    databasePath: string,
  ) => Provider;
  createSkill: (input: SkillInput, databasePath: string) => Skill;
  deleteAgent: (agentId: string, databasePath: string) => void;
  deleteProvider: (providerId: string, databasePath: string) => void;
  updateAgent: (agentId: string, input: UpdateAgentInput, databasePath: string) => AgentProfile;
  updateProvider: (
    providerId: string,
    input: unknown,
    validationToken: string | undefined,
    databasePath: string,
  ) => Provider;
  updateSkill: (skillId: string, input: UpdateSkillInput, databasePath: string) => Skill;
  verifyProviderDraft: (
    input: unknown,
    databasePath: string,
  ) => Promise<ProviderDraftVerification>;
}
