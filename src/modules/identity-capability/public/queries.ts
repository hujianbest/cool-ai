import type { AgentProfile, AgentTemplate, Provider, Skill } from "./dto";

export interface IdentityCapabilityQueries {
  getAgentTemplates: () => readonly AgentTemplate[];
  listAgents: (databasePath: string) => AgentProfile[];
  listProviders: (databasePath: string) => Provider[];
  listSkills: (databasePath: string) => Skill[];
}
