import { z } from "zod";

import {
  agentStructuredBlockSchema,
  type AgentStructuredBlock,
} from "@/src/modules/public-collaboration/internal/structured-message-schema";
import {
  ingestStructuredJson,
  type StructuredMessageSchema,
} from "@/src/modules/public-collaboration/internal/structured-message-codec";

import {
  agentBlockVisibleTexts,
  graphemeLength,
} from "@/src/modules/public-collaboration/internal/structured-message-schema";

function boundedText(maximum: number, allowEmpty = false) {
  return z
    .string()
    .transform((value) => value.trim())
    .refine(
      (value) =>
        (allowEmpty || graphemeLength(value) >= 1) &&
        graphemeLength(value) <= maximum,
    );
}

const clientKeySchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/));

const proposedTaskSchema = z
  .object({
    clientKey: clientKeySchema,
    title: boundedText(160),
    description: boundedText(5_000, true),
    dependsOnKeys: z.array(clientKeySchema).max(20),
  })
  .strict();

const existingClaimSchema = z
  .object({
    source: z.literal("existing"),
    workItemId: z.string().trim().min(1),
  })
  .strict();

const proposedClaimSchema = z
  .object({
    source: z.literal("proposed"),
    clientKey: clientKeySchema,
  })
  .strict();

const handoffDispositionSchema = z
  .object({
    type: z.literal("handoff"),
    targetAgentId: z.string().trim().min(1),
    summary: boundedText(5_000),
    reason: boundedText(5_000),
  })
  .strict();

const decisionRequestDispositionSchema = z
  .object({
    type: z.literal("decision_request"),
    question: boundedText(1_000),
    options: z
      .array(boundedText(500))
      .min(2)
      .max(8)
      .refine((options) => new Set(options).size === options.length),
  })
  .strict();

const planReadyDispositionSchema = z
  .object({
    type: z.literal("plan_ready"),
  })
  .strict();

export const agentTurnSchema = z
  .object({
    message: boundedText(20_000),
    blocks: z.array(agentStructuredBlockSchema).max(10).default([]),
    tasks: z.array(proposedTaskSchema).max(20),
    claim: z
      .discriminatedUnion("source", [existingClaimSchema, proposedClaimSchema])
      .nullable(),
    disposition: z.discriminatedUnion("type", [
      handoffDispositionSchema,
      decisionRequestDispositionSchema,
      planReadyDispositionSchema,
    ]),
  })
  .strict()
  .superRefine((turn, context) => {
    const blockTextTotal = turn.blocks
      .flatMap(agentBlockVisibleTexts)
      .reduce((total, text) => total + graphemeLength(text), 0);
    if (blockTextTotal > 20_000) {
      context.addIssue({
        code: "custom",
        message: "Visible block text exceeds total limit.",
        path: ["blocks"],
      });
    }
    if (
      turn.disposition.type === "decision_request" &&
      (turn.tasks.length !== 0 || turn.claim !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A decision request cannot create or claim tasks.",
        path: ["disposition"],
      });
    }
  });

export type ProposedTask = z.infer<typeof proposedTaskSchema>;
type ParsedAgentTurn = z.infer<typeof agentTurnSchema>;
export type AgentTurn = Omit<ParsedAgentTurn, "blocks"> & {
  blocks?: AgentStructuredBlock[];
};
export type { AgentStructuredBlock };

export type AgentTurnParseResult =
  | { success: true; turn: AgentTurn }
  | { success: false; turn: null };

export const AGENT_TURN_SCHEMA_INSTRUCTIONS = [
  "Return one strict JSON object and no surrounding prose.",
  'Top level: {"message":string(1..20000 graphemes),"blocks":StructuredBlock[0..10] (optional; defaults []),"tasks":ProposedTask[0..20],"claim":null|ExistingClaim|ProposedClaim,"disposition":Disposition}.',
  'ProposedTask: {"clientKey":string(1..64, /^[A-Za-z0-9_-]+$/),"title":string(1..160 graphemes),"description":string(0..5000 graphemes),"dependsOnKeys":clientKey[0..20]}.',
  'ExistingClaim: {"source":"existing","workItemId":non-empty string}.',
  'ProposedClaim: {"source":"proposed","clientKey":clientKey}.',
  'Disposition is exactly one of {"type":"handoff","targetAgentId":non-empty string,"summary":string(1..5000 graphemes),"reason":string(1..5000 graphemes)}, {"type":"decision_request","question":string(1..1000 graphemes),"options":unique trimmed string[2..8], each 1..500 graphemes}, or {"type":"plan_ready"}.',
  "For decision_request, tasks must be [] and claim must be null.",
  "Unknown keys are forbidden at every object level.",
].join("\n");

export function parseAgentTurnContent(content: string): AgentTurnParseResult {
  try {
    const schema: StructuredMessageSchema<AgentTurn> = {
      classify: () => "known",
      parse(value) {
        return agentTurnSchema.parse(value);
      },
      visibleText: () => [],
    };
    const result = ingestStructuredJson(content, {
      maxCanonicalBytes: 1024 * 1024,
      maxWireBytes: 1024 * 1024,
      schema,
    });
    return { success: true, turn: result.value };
  } catch {
    return { success: false, turn: null };
  }
}
