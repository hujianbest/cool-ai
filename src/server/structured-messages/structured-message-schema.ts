import { z } from "zod";

import type { StructuredMessageSchema } from "@/src/server/structured-messages/structured-message-codec";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

export function graphemeLength(value: string): number {
  return Array.from(segmenter.segment(value)).length;
}

export function boundedGraphemeText(maximum: number, allowEmpty = false) {
  return z.string().transform((value) => value.trim()).refine((value) => {
    const length = graphemeLength(value);
    return (allowEmpty || length > 0) && length <= maximum;
  });
}

const identifier = boundedGraphemeText(200);
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const proposalBlockSchema = z.object({
  actions: z.tuple([z.literal("accept"), z.literal("reject")]),
  blockRevision: z.literal(1),
  blockSchemaVersion: z.literal(1),
  blockType: z.literal("proposal"),
  body: boundedGraphemeText(5_000),
  logicalBlockId: identifier,
  title: boundedGraphemeText(160),
}).strict();

export const checklistBlockSchema = z.object({
  actions: z.tuple([z.literal("check_item"), z.literal("uncheck_item")]),
  blockRevision: z.literal(1),
  blockSchemaVersion: z.literal(1),
  blockType: z.literal("checklist"),
  items: z.array(z.object({
    id: identifier,
    text: boundedGraphemeText(500),
  }).strict()).min(1).max(50),
  logicalBlockId: identifier,
  title: boundedGraphemeText(160),
}).strict().superRefine((block, context) => {
  const ids = new Set<string>();
  for (const [index, item] of block.items.entries()) {
    if (ids.has(item.id)) {
      context.addIssue({
        code: "custom",
        message: "Checklist item ids must be unique.",
        path: ["items", index, "id"],
      });
    }
    ids.add(item.id);
  }
});

export const diffPreviewInputSchema = z.object({
  blockRevision: z.literal(1),
  blockSchemaVersion: z.literal(1),
  blockType: z.literal("diff_preview"),
  fileReferences: z.array(boundedGraphemeText(500)).max(100).default([]),
  logicalBlockId: identifier,
  observationHash: hash,
  observationId: identifier,
  stagedResultId: identifier,
  title: boundedGraphemeText(160),
}).strict();

export const diffPreviewBlockSchema = diffPreviewInputSchema.extend({
  executionId: identifier,
  preview: boundedGraphemeText(20_000),
  previewHash: hash,
  stagedHash: hash,
}).strict();

export const fileReferenceBlockSchema = z.object({
  artifactHash: hash,
  artifactId: identifier,
  blockRevision: z.literal(1),
  blockSchemaVersion: z.literal(1),
  blockType: z.literal("file_reference"),
  executionId: identifier,
  logicalBlockId: identifier,
  title: boundedGraphemeText(160),
}).strict();

export const handoffCardBlockSchema = z.object({
  blockRevision: z.literal(1),
  blockSchemaVersion: z.literal(1),
  blockType: z.literal("handoff_card"),
  factId: identifier,
  logicalBlockId: identifier,
  title: boundedGraphemeText(160),
  turnId: identifier,
}).strict();

export const agentStructuredBlockSchema = z.discriminatedUnion("blockType", [
  proposalBlockSchema,
  checklistBlockSchema,
  diffPreviewInputSchema,
  fileReferenceBlockSchema,
  handoffCardBlockSchema,
]);

export const persistedStructuredBlockSchema = z.discriminatedUnion("blockType", [
  proposalBlockSchema,
  checklistBlockSchema,
  diffPreviewBlockSchema,
  fileReferenceBlockSchema,
  handoffCardBlockSchema,
]);

export function agentBlockVisibleTexts(
  block: AgentStructuredBlock,
): string[] {
  if (block.blockType === "proposal") return [block.title, block.body];
  if (block.blockType === "checklist") {
    return [block.title, ...block.items.map(({ text }) => text)];
  }
  if (block.blockType === "diff_preview") {
    return [block.title, ...block.fileReferences];
  }
  return [block.title];
}

export const blocksEnvelopeSchema = z.object({
  blocks: z.array(agentStructuredBlockSchema).max(10),
}).strict().superRefine((envelope, context) => {
  const visible = envelope.blocks.flatMap(agentBlockVisibleTexts);
  if (visible.reduce((total, text) => total + graphemeLength(text), 0) > 20_000) {
    context.addIssue({ code: "custom", message: "Visible block text exceeds total limit." });
  }
});

export const persistedBlocksEnvelopeSchema = z.object({
  blocks: z.array(persistedStructuredBlockSchema).max(10),
}).strict().superRefine((envelope, context) => {
  const total = envelope.blocks
    .flatMap((block) => blockCodecSchema.visibleText(block))
    .reduce((sum, text) => sum + graphemeLength(text), 0);
  if (total > 20_000) {
    context.addIssue({ code: "custom", message: "Visible block text exceeds total limit." });
  }
});

export type AgentStructuredBlock = z.infer<typeof agentStructuredBlockSchema>;
export type StructuredBlock = z.infer<typeof persistedStructuredBlockSchema>;

export const blockCodecSchema: StructuredMessageSchema<StructuredBlock> = {
  classify(value) {
    return value
        && typeof value === "object"
        && "blockSchemaVersion" in value
        && value.blockSchemaVersion !== 1
      ? "unknown-schema"
      : "known";
  },
  parse: (value) => persistedStructuredBlockSchema.parse(value),
  visibleText(value) {
    if (value.blockType === "proposal") return [value.title, value.body];
    if (value.blockType === "checklist") {
      return [value.title, ...value.items.map(({ text }) => text)];
    }
    if (value.blockType === "diff_preview") {
      return [value.title, value.preview, ...value.fileReferences];
    }
    return [value.title];
  },
};

export const envelopeCodecSchema: StructuredMessageSchema<{
  blocks: AgentStructuredBlock[];
}> = {
  classify: () => "known",
  parse: (value) => blocksEnvelopeSchema.parse(value),
  visibleText(value) {
    return value.blocks.flatMap(agentBlockVisibleTexts);
  },
};

export const persistedEnvelopeCodecSchema: StructuredMessageSchema<{
  blocks: StructuredBlock[];
}> = {
  classify: () => "known",
  parse: (value) => persistedBlocksEnvelopeSchema.parse(value),
  visibleText: (value) =>
    value.blocks.flatMap((block) => blockCodecSchema.visibleText(block)),
};
