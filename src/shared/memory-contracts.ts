import { z } from "zod";

export const memoryTypeSchema = z.enum([
  "goal",
  "decision",
  "fact",
  "artifact",
  "experience",
]);

export const memorySourceTypeSchema = z.enum([
  "owner_input",
  "work_item",
  "artifact_path",
  "task",
  "result",
  "review",
  "validation",
  "artifact",
]);

export const memorySourceSchema = z.object({
  href: z.string().min(1).nullable(),
  id: z.string().min(1),
  type: memorySourceTypeSchema,
  version: z.string().min(1).nullable(),
}).strict();

const proposerAgentSchema = z.object({
  accentToken: z.string().min(1),
  avatarText: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
}).strict();

const ownerActorSchema = z.object({
  confirmer: z.null(),
  persistedBy: z.literal("platform"),
  proposerAgent: z.null(),
  proposerType: z.literal("owner"),
}).strict();

const agentActorSchema = z.object({
  confirmer: z.object({
    decisionId: z.string().min(1),
    reviewAttemptId: z.string().min(1),
  }).strict(),
  persistedBy: z.literal("platform"),
  proposerAgent: proposerAgentSchema,
  proposerType: z.literal("agent"),
}).strict();

export const memoryEntryV6Schema = z.object({
  active: z.boolean(),
  actor: z.discriminatedUnion("proposerType", [
    ownerActorSchema,
    agentActorSchema,
  ]),
  chainId: z.string().min(1),
  content: z.string().min(1),
  createdBy: z.literal("owner").optional(),
  createdAt: z.string().min(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  source: memorySourceSchema,
  sourceRef: z.string().min(1).optional(),
  sourceType: z.enum(["owner_input", "work_item", "artifact_path"]).optional(),
  supersedesId: z.string().min(1).nullable(),
  type: memoryTypeSchema,
  version: z.number().int().min(1),
}).strict().superRefine((memory, context) => {
  const legacySource = ["owner_input", "work_item", "artifact_path"]
    .includes(memory.source.type);
  if (
    memory.actor.proposerType === "owner"
    && (!legacySource || memory.source.version !== null || memory.source.href !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: "Owner memory must preserve legacy source semantics.",
      path: ["source"],
    });
  }
  if (
    memory.actor.proposerType === "owner"
    && (
      memory.createdBy !== undefined
      && (
        memory.sourceRef !== memory.source.id
        || memory.sourceType !== memory.source.type
      )
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Owner compatibility fields must match the v6 source.",
      path: ["source"],
    });
  }
  if (
    memory.actor.proposerType === "agent"
    && (
      legacySource
      || memory.source.version === null
      || memory.source.href === null
      || memory.createdBy !== undefined
      || memory.sourceRef !== undefined
      || memory.sourceType !== undefined
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Agent memory requires an exact navigable source.",
      path: ["source"],
    });
  }
});

export const memoryListResponseSchema = z.object({
  memories: z.array(memoryEntryV6Schema),
}).strict();

export const memoryCreateResponseSchema = z.object({
  memory: memoryEntryV6Schema,
}).strict();

export const memorySearchHitSchema = z.object({
  memory: memoryEntryV6Schema,
  snippet: z.string().min(1),
}).strict();

export const memorySearchResponseSchema = z.object({
  results: z.array(memorySearchHitSchema),
}).strict();

export type MemoryEntryV6 = z.infer<typeof memoryEntryV6Schema>;
export type MemorySource = z.infer<typeof memorySourceSchema>;
export type MemorySourceType = z.infer<typeof memorySourceTypeSchema>;
export type MemoryType = z.infer<typeof memoryTypeSchema>;
