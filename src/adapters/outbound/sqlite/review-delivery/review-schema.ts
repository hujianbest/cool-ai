import { redactProcessOutput } from "@/src/adapters/outbound/workspace/process-runner";
import {
  reviewOutputSchema,
  type ReviewOutput,
} from "@/src/shared/review-contracts";

const MAX_PUBLIC_OUTPUT_BYTES = 256 * 1024;
const PRIVATE_REASONING =
  /\b(?:chain[-_\s]?of[-_\s]?thought|hidden\s+(?:reasoning|thoughts?)|private\s+reasoning)\b/iu;
const PRODUCT_PRIVATE_TEXT =
  /(?:\b(?:api[-_ ]?key|authorization|bearer|master[-_ ]?key|cipher|validation[-_ ]?token|access[-_ ]?token|auth[-_ ]?token)\b\s*[:=]|\braw\s+(?:provider\s+)?(?:request|response|body|headers?)\b|\b(?:env|environment|home|userprofile|path)\b\s*[:=]|(?:^|[\s"'(])(?:[A-Za-z]:\\|\/(?:Users|home|root|workspace)\/)|\b(?:other|owner)\s+(?:agent\s+)?(?:private\s+)?(?:system\s+)?prompt\b)/iu;

export const REVIEW_OUTPUT_SCHEMA_INSTRUCTIONS = [
  "Return one strict JSON object and no surrounding prose.",
  'Top level: {"publicSummary":string(1..20000 graphemes),"findings":Finding[],"evidenceRefs":EvidenceRef[],"limitations":string(1..5000 graphemes)[],"memoryCandidates":MemoryCandidate[],"decision":Decision}.',
  'Finding: {"title":string(1..5000 graphemes),"detail":string(1..5000 graphemes),"evidenceRefs":EvidenceRef[]}.',
  'EvidenceRef: {"type":"task"|"result"|"review"|"validation"|"artifact","id":non-empty string,"version":non-empty string}.',
  'MemoryCandidate: {"type":"decision"|"fact"|"artifact"|"experience","content":string(1..20000 graphemes),"source":EvidenceRef,"supersedesMemoryId":null|non-empty string}. Do not provide actor fields; the platform binds the selected reviewer.',
  'Decision is exactly one of {"choice":"reject","reworkRequirements":non-empty string(1..5000 graphemes)[]}, {"choice":"escalate","question":string(1..1000 graphemes),"options":unique string[2..8], each 1..500 graphemes}, or {"choice":"pass"}.',
  "Unknown keys are forbidden at every object level. Use only exact source ids and versions supplied in the frozen review material.",
  "Return visible conclusions only. Never include secrets or hidden chain-of-thought.",
].join("\n");

type ReviewProviderPromptInput = {
  material: unknown;
  reviewer: {
    id: string;
    role: string;
    skills: string[];
    systemPrompt: string;
  };
};

export function reviewPublicValueIsSafe(
  value: unknown,
  secretValues: string[] = [],
): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  if (
    PRIVATE_REASONING.test(serialized)
    || PRODUCT_PRIVATE_TEXT.test(serialized)
    || redactProcessOutput(serialized) !== serialized
  ) {
    return false;
  }
  return ![...new Set(secretValues)]
    .filter((secret) => secret.length >= 4)
    .some((secret) => serialized.includes(secret));
}

export function buildReviewProviderRequest(unsafeInput: unknown): {
  messages: Array<{ content: string; role: "system" | "user" }>;
} {
  if (!unsafeInput || typeof unsafeInput !== "object") {
    throw new Error("REVIEW_PROVIDER_CONTEXT_INVALID");
  }
  const input = unsafeInput as Partial<ReviewProviderPromptInput>;
  const reviewer = input.reviewer;
  if (
    !reviewer
    || typeof reviewer.id !== "string"
    || reviewer.id.length === 0
    || typeof reviewer.role !== "string"
    || typeof reviewer.systemPrompt !== "string"
    || !Array.isArray(reviewer.skills)
    || reviewer.skills.some((skill) => typeof skill !== "string")
    || !reviewPublicValueIsSafe(input.material)
  ) {
    throw new Error("REVIEW_PROVIDER_CONTEXT_REDACTED");
  }
  return {
    messages: [
      {
        role: "system",
        content: [
          "You are the independently selected review Agent.",
          "Return only public owner-facing conclusions as strict JSON.",
          "Never reveal hidden chain-of-thought or claim access to omitted material.",
          REVIEW_OUTPUT_SCHEMA_INSTRUCTIONS,
        ].join("\n"),
      },
      {
        role: "system",
        content: JSON.stringify({
          reviewer: {
            id: reviewer.id,
            role: reviewer.role,
            skills: [...reviewer.skills],
            systemPrompt: reviewer.systemPrompt,
          },
        }),
      },
      { role: "system", content: JSON.stringify(input.material) },
      {
        role: "user",
        content: "Review only the frozen public material and return exactly one reject, escalate, or pass decision.",
      },
    ],
  };
}

export type ReviewOutputSource = {
  complete: boolean;
  hasVerifiedContent: boolean;
  ref: {
    id: string;
    type: string;
    version: string;
  };
};

export type ReviewOutputValidationContext = {
  candidateActor: { agentId: string; type: "agent" };
  secretValues?: string[];
  sources: ReviewOutputSource[];
};

export type ValidatedReviewOutput = Omit<ReviewOutput, "memoryCandidates"> & {
  memoryCandidates: Array<ReviewOutput["memoryCandidates"][number] & {
    actor: { agentId: string; type: "agent" };
  }>;
};

export type ReviewOutputValidationResult =
  | { success: true; output: ValidatedReviewOutput; reason: null }
  | {
      success: false;
      output: null;
      reason:
        | "invalid_source_reference"
        | "review_content_incomplete"
        | "structured_output_invalid";
    };

function refKey(ref: { id: string; type: string; version: string }): string {
  return JSON.stringify([ref.type, ref.id, ref.version]);
}

function referencedSources(output: ReviewOutput) {
  return [
    ...output.evidenceRefs,
    ...output.findings.flatMap((finding) => finding.evidenceRefs),
    ...output.memoryCandidates.map((candidate) => candidate.source),
  ];
}

export function parseReviewOutputContent(content: string): ReviewOutput | null {
  if (Buffer.byteLength(content, "utf8") > MAX_PUBLIC_OUTPUT_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = reviewOutputSchema.safeParse(value);
  if (!parsed.success) return null;
  return Buffer.byteLength(JSON.stringify(parsed.data), "utf8") <= MAX_PUBLIC_OUTPUT_BYTES
    ? parsed.data
    : null;
}

export function reviewOutputContainsSensitiveText(
  output: ReviewOutput,
  secretValues: string[] = [],
): boolean {
  return !reviewPublicValueIsSafe(output, secretValues);
}

export function validateReviewOutput(
  output: unknown,
  context: ReviewOutputValidationContext,
): ReviewOutputValidationResult {
  const parsed = reviewOutputSchema.safeParse(output);
  if (
    !parsed.success
    || Buffer.byteLength(JSON.stringify(parsed.success ? parsed.data : null), "utf8")
      > MAX_PUBLIC_OUTPUT_BYTES
    || context.candidateActor.type !== "agent"
    || context.candidateActor.agentId.length === 0
  ) {
    return { success: false, output: null, reason: "structured_output_invalid" };
  }

  const sources = new Map<string, ReviewOutputSource>();
  for (const source of context.sources) {
    const key = refKey(source.ref);
    const existing = sources.get(key);
    if (
      existing
      && (
        existing.complete !== source.complete
        || existing.hasVerifiedContent !== source.hasVerifiedContent
      )
    ) {
      return { success: false, output: null, reason: "invalid_source_reference" };
    }
    sources.set(key, source);
  }
  const referenced = referencedSources(parsed.data);
  if (referenced.some((ref) => !sources.has(refKey(ref)))) {
    return { success: false, output: null, reason: "invalid_source_reference" };
  }
  if (
    parsed.data.decision.choice === "pass"
    && referenced.some((ref) => {
      const source = sources.get(refKey(ref));
      return !source?.complete || !source.hasVerifiedContent;
    })
  ) {
    return { success: false, output: null, reason: "review_content_incomplete" };
  }

  return {
    success: true,
    output: {
      ...parsed.data,
      memoryCandidates: parsed.data.memoryCandidates.map((candidate) => ({
        ...candidate,
        actor: { ...context.candidateActor },
      })),
    },
    reason: null,
  };
}
