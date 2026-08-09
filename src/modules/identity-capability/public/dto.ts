export type {
  AccentToken,
  AgentInput,
  AgentProfile,
  AgentTemplate,
  CreateProviderDraft,
  Provider,
  ProviderConnection,
  ProviderDraft,
  ReplaceProviderDraft,
  RetainProviderDraft,
  Skill,
  SkillInput,
  ToolPermissions,
  UpdateAgentInput,
  UpdateSkillInput,
} from "@/src/shared/team-contracts";

export type CredentialEnvelope = {
  apiKeyCipher: string;
  apiKeyIv: string;
  apiKeyMask: string;
  apiKeyTag: string;
  credentialVersion: 1;
  keyId: string;
};

export type ProviderTokenDraft = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type ExistingProviderTokenDraft = ProviderTokenDraft & {
  credentialGeneration: number;
  mode: "retain" | "replace";
  providerId: string;
  providerVersion: number;
};

export type ProviderDraftVerification = {
  expiresAt: string;
  validationToken: string;
  verifiedModel: string;
};
