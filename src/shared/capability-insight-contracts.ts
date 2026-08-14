import { z } from "zod";

export const capabilityInsightToolsSchema = z
  .object({
    readFiles: z.boolean(),
    runCommands: z.boolean(),
    writeFiles: z.boolean(),
  })
  .strict();

export const capabilityInsightAgentSchema = z
  .object({
    id: z.string().min(1),
    model: z.string(),
    name: z.string(),
    permissions: capabilityInsightToolsSchema,
    reviewCapable: z.boolean(),
    role: z.string(),
    skillIds: z.array(z.string()),
  })
  .strict();

export const capabilityInsightSkillSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
  })
  .strict();

export const capabilityInsightWorkItemSchema = z
  .object({
    assigneeAgentId: z.string().nullable(),
    description: z.string(),
    id: z.string().min(1),
    status: z.string(),
    title: z.string(),
  })
  .strict();

export const capabilityInsightInputSchema = z
  .object({
    agents: z.array(capabilityInsightAgentSchema),
    skills: z.array(capabilityInsightSkillSchema),
    workItems: z.array(capabilityInsightWorkItemSchema),
  })
  .strict();

export const capabilityPortraitSchema = z
  .object({
    agentId: z.string().min(1),
    evidence: z.array(z.string()),
    model: z.string(),
    name: z.string(),
    reviewCapable: z.boolean(),
    skillNames: z.array(z.string()),
    tools: capabilityInsightToolsSchema,
  })
  .strict();

export const capabilitySuggestionSchema = z
  .object({
    agentId: z.string().min(1),
    reasons: z.array(z.string()),
    score: z.number().int().positive(),
    workItemId: z.string().min(1),
  })
  .strict();

export const capabilityInsightSchema = z
  .object({
    portraits: z.array(capabilityPortraitSchema),
    suggestions: z.array(capabilitySuggestionSchema),
  })
  .strict();

export type CapabilityInsightTools = z.infer<typeof capabilityInsightToolsSchema>;
export type CapabilityInsightAgent = z.infer<typeof capabilityInsightAgentSchema>;
export type CapabilityInsightSkill = z.infer<typeof capabilityInsightSkillSchema>;
export type CapabilityInsightWorkItem = z.infer<
  typeof capabilityInsightWorkItemSchema
>;
export type CapabilityInsightInput = z.infer<typeof capabilityInsightInputSchema>;
export type CapabilityPortrait = z.infer<typeof capabilityPortraitSchema>;
export type CapabilitySuggestion = z.infer<typeof capabilitySuggestionSchema>;
export type CapabilityInsight = z.infer<typeof capabilityInsightSchema>;
