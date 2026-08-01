import { z } from "zod";

export const skillInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(280),
    instructions: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const updateSkillInputSchema = skillInputSchema.extend({
  expectedVersion: z.number().int().min(1),
});

const providerConnectionSchema = {
  allowInsecureHttp: z.boolean(),
  baseUrl: z.string().trim().min(1).max(2_048),
  defaultModel: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(80),
};

export const createProviderDraftSchema = z
  .object({
    ...providerConnectionSchema,
    apiKey: z.string().trim().min(1).max(8_192),
    mode: z.literal("create"),
  })
  .strict();

export const retainProviderDraftSchema = z
  .object({
    ...providerConnectionSchema,
    expectedVersion: z.number().int().min(1),
    mode: z.literal("retain"),
    providerId: z.string().min(1),
  })
  .strict();

export const replaceProviderDraftSchema = z
  .object({
    ...providerConnectionSchema,
    apiKey: z.string().trim().min(1).max(8_192),
    expectedVersion: z.number().int().min(1),
    mode: z.literal("replace"),
    providerId: z.string().min(1),
  })
  .strict();

export const providerDraftSchema = z.discriminatedUnion("mode", [
  createProviderDraftSchema,
  retainProviderDraftSchema,
  replaceProviderDraftSchema,
]);

const accentTokenSchema = z.enum([
  "sage",
  "terracotta",
  "gold",
  "slate",
  "rose",
  "olive",
]);

const boundedInteger = (minimum: number, maximum: number) =>
  z
    .number()
    .min(minimum)
    .max(maximum)
    .refine(Number.isInteger, { message: "not_integer" });

const avatarSegmenter = new Intl.Segmenter("zh-CN", {
  granularity: "grapheme",
});

export const agentInputSchema = z
  .object({
    accentToken: accentTokenSchema,
    avatarText: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => {
          const length = Array.from(avatarSegmenter.segment(value)).length;
          return length >= 1 && length <= 4;
        },
        { message: "out_of_range" },
      ),
    maxHandoffs: boundedInteger(1, 100),
    maxTokens: boundedInteger(1, 1_000_000),
    model: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(80),
    permissions: z
      .object({
        readFiles: z.boolean(),
        runCommands: z.boolean(),
        writeFiles: z.boolean(),
      })
      .strict(),
    providerId: z.string().trim().min(1),
    reviewCapable: z.boolean().default(false),
    role: z.string().trim().min(1).max(160),
    skillIds: z
      .array(z.string().min(1))
      .refine((values) => new Set(values).size === values.length, {
        message: "invalid_reference",
      }),
    systemPrompt: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const updateAgentInputSchema = agentInputSchema.extend({
  expectedVersion: boundedInteger(1, Number.MAX_SAFE_INTEGER),
});
