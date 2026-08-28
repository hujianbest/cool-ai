import { z } from "zod";

export type RuleInsightSourceType = "agent_prompt" | "skill_instruction";
export type RuleInsightSeverity = "warn" | "block";

export interface RuleInsightPermissions {
  writeFiles: boolean;
  runCommands: boolean;
}

export interface RuleInsightSkill {
  id: string;
  name: string;
  instructions: string;
}

export interface RuleInsightAgentInput {
  id: string;
  name: string;
  systemPrompt: string;
  reviewCapable: boolean;
  permissions: RuleInsightPermissions;
  skills: RuleInsightSkill[];
}

export interface RuleInsightInput {
  agents: RuleInsightAgentInput[];
}

export const ruleInsightAgentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    scope: z.literal("project_member"),
  })
  .strict();

export const ruleInsightFindingSchema = z
  .object({
    agentId: z.string().min(1),
    code: z.string(),
    conflictGroupId: z.string().nullable(),
    excerpt: z.string(),
    id: z.string().min(1),
    reason: z.string(),
    severity: z.enum(["warn", "block"]),
    sourceId: z.string().min(1),
    sourceName: z.string(),
    sourceType: z.enum(["agent_prompt", "skill_instruction"]),
  })
  .strict();

export const ruleInsightSchema = z
  .object({
    agents: z.array(ruleInsightAgentSchema),
    findings: z.array(ruleInsightFindingSchema),
  })
  .strict();

export type RuleInsightAgent = z.infer<typeof ruleInsightAgentSchema>;
export type RuleInsightFinding = z.infer<typeof ruleInsightFindingSchema>;
export type RuleInsight = z.infer<typeof ruleInsightSchema>;
