import { createHash } from "node:crypto";

import { z } from "zod";

const MAX_DELIVERY_BYTES = 256 * 1024;
const HASH = z.string().regex(/^[0-9a-f]{64}$/u);
const SAFE_PUBLIC_TEXT =
  /(?:(?:^|[\s"'(])(?:[A-Za-z]:\\|\/(?:Users|home|root|workspace)\/)|chain[-_\s]?of[-_\s]?thought|hidden\s+(?:reasoning|thoughts?)|private\s+(?:prompt|reasoning)|(?:api[-_ ]?key|authorization|bearer)\s*[:=])/iu;

export type DeliveryContentStatus =
  | "complete"
  | "failed"
  | "truncated"
  | "stale"
  | "missing"
  | "unreadable";

export type DeliveryEvidenceStatus =
  | "passed"
  | "available"
  | "failed"
  | "truncated"
  | "stale"
  | "missing"
  | "unreadable";

export type DeliveryEvidenceKind =
  | "result"
  | "review"
  | "diff"
  | "validation"
  | "artifact"
  | "execution_event"
  | "memory";

const publicText = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => !SAFE_PUBLIC_TEXT.test(value), "Private material is not allowed.");
const identifier = z.string().min(1).max(1_000);
const version = z.string().min(1).max(1_000);
const href = z.string().min(1).max(8_192).refine((value) => {
  if (!value.startsWith("/") || value.startsWith("//") || SAFE_PUBLIC_TEXT.test(value)) return false;
  try {
    const parsed = new URL(value, "https://delivery.invalid");
    return parsed.origin === "https://delivery.invalid" && parsed.searchParams.has("version");
  } catch {
    return false;
  }
}, "Evidence href must be a safe versioned product-relative URL.");
const contentStatus = z.enum([
  "complete",
  "failed",
  "truncated",
  "stale",
  "missing",
  "unreadable",
]);
const evidenceBase = {
  contentStatus,
  href,
  id: identifier,
  sha256: HASH.nullable(),
  version,
};
const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({ ...evidenceBase, kind: z.literal("result") }).strict(),
  z.object({ ...evidenceBase, kind: z.literal("review") }).strict(),
  z.object({ ...evidenceBase, kind: z.literal("diff") }).strict(),
  z.object({
    ...evidenceBase,
    kind: z.literal("validation"),
    policyRequired: z.boolean(),
    succeeded: z.boolean(),
  }).strict(),
  z.object({
    ...evidenceBase,
    kind: z.literal("artifact"),
    referencedByDecisionOrMemory: z.boolean(),
  }).strict(),
  z.object({
    ...evidenceBase,
    kind: z.literal("execution_event"),
    referencedByDecision: z.boolean(),
  }).strict(),
  z.object({
    associationCurrent: z.boolean(),
    href,
    id: identifier,
    kind: z.literal("memory"),
    sha256: HASH.nullable(),
    version,
  }).strict(),
]);

export const deliveryBuildInputSchema = z.object({
  schemaVersion: z.literal(1),
  mission: z.object({
    contextVersion: z.number().int().min(1),
    goal: publicText(20_000),
    id: identifier,
    title: publicText(5_000),
    version: z.number().int().min(1),
  }).strict(),
  tasks: z.array(z.object({
    decision: z.object({
      choice: z.literal("pass"),
      id: identifier,
      limitations: z.array(publicText(5_000)),
      publicSummary: publicText(20_000),
    }).strict(),
    evidence: z.array(evidenceSchema),
    execution: z.object({
      id: identifier,
      mergeFileCount: z.number().int().min(0),
      mergeFinalBytes: z.number().int().min(0),
      stagedHash: HASH,
    }).strict(),
    executor: z.object({ agentId: identifier, name: publicText(5_000) }).strict(),
    result: z.object({ id: identifier, version: z.number().int().min(1) }).strict(),
    review: z.object({
      attemptId: identifier,
      reviewerAgentId: identifier,
    }).strict(),
    reviewer: z.object({ agentId: identifier, name: publicText(5_000) }).strict(),
    workItem: z.object({
      id: identifier,
      title: publicText(5_000),
      version: z.number().int().min(1),
    }).strict(),
  }).strict()).min(1),
}).strict();

export type DeliveryBuildInput = z.input<typeof deliveryBuildInputSchema>;

export type DeliveryManifestEntry = {
  href: string;
  id: string;
  kind: DeliveryEvidenceKind;
  required: boolean;
  sha256: string | null;
  status: DeliveryEvidenceStatus;
  version: string;
};

export type DeliveryBlocker = {
  code: "MISSION_COMPLETION_BLOCKED";
  id: string;
  kind: DeliveryEvidenceKind;
  status: Exclude<DeliveryEvidenceStatus, "passed" | "available">;
  version: string;
};

export type DeliveryBundle = {
  blockers: DeliveryBlocker[];
  inputFingerprint: string;
  manifest: {
    entries: DeliveryManifestEntry[];
    inputFingerprint: string;
    schemaVersion: 1;
  };
  summary: {
    mission: {
      completedAt: string;
      conclusion: "completed";
      goal: string;
      id: string;
      title: string;
    };
    tasks: Array<{
      artifacts: Array<{ href: string; id: string; version: string }>;
      changes: { mergeFileCount: number; mergeFinalBytes: number; stagedHash: string };
      decision: { choice: "pass"; id: string; publicSummary: string };
      executor: { agentId: string; name: string };
      limitations: string[];
      memories: Array<{ href: string; id: string; version: string }>;
      result: { href: string; id: string; version: number };
      reviewer: { agentId: string; name: string };
      validations: {
        passedCount: number;
        refs: Array<{ href: string; id: string; version: string }>;
        requiredCount: number;
      };
      workItem: { id: string; title: string };
    }>;
  };
};

export class DeliveryManifestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeliveryManifestError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function required(entry: z.output<typeof evidenceSchema>): boolean {
  switch (entry.kind) {
    case "validation":
      return entry.policyRequired;
    case "artifact":
      return entry.referencedByDecisionOrMemory;
    case "execution_event":
      return entry.referencedByDecision;
    case "result":
    case "review":
    case "diff":
    case "memory":
      return true;
  }
}

function status(entry: z.output<typeof evidenceSchema>): DeliveryEvidenceStatus {
  if (entry.kind === "memory") return entry.associationCurrent ? "available" : "stale";
  if (entry.contentStatus !== "complete") return entry.contentStatus;
  if (entry.kind === "review") return "passed";
  if (entry.kind === "validation") return entry.succeeded ? "passed" : "failed";
  return "available";
}

function evidenceOrder(left: DeliveryManifestEntry, right: DeliveryManifestEntry): number {
  const kinds: Record<DeliveryEvidenceKind, number> = {
    result: 0,
    review: 1,
    diff: 2,
    validation: 3,
    artifact: 4,
    execution_event: 5,
    memory: 6,
  };
  return kinds[left.kind] - kinds[right.kind]
    || compareUtf8(left.id, right.id)
    || compareUtf8(left.version, right.version);
}

function fingerprintInput(input: z.output<typeof deliveryBuildInputSchema>) {
  return {
    mission: {
      contextVersion: input.mission.contextVersion,
      id: input.mission.id,
      version: input.mission.version,
    },
    schemaVersion: 1,
    tasks: [...input.tasks]
      .sort((left, right) => compareUtf8(left.workItem.id, right.workItem.id))
      .map((task) => ({
        artifactRefs: task.evidence
          .filter((entry) => entry.kind === "artifact")
          .map(({ id, version: sourceVersion }) => ({ id, version: sourceVersion }))
          .sort((left, right) => compareUtf8(left.id, right.id)),
        decisionId: task.decision.id,
        evidenceRefs: task.evidence
          .map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            required: required(entry),
            status: status(entry),
            version: entry.version,
          }))
          .sort((left, right) =>
            compareUtf8(left.kind, right.kind)
            || compareUtf8(left.id, right.id)
            || compareUtf8(left.version, right.version)
          ),
        executionId: task.execution.id,
        memoryRefs: task.evidence
          .filter((entry) => entry.kind === "memory")
          .map(({ id, version: sourceVersion }) => ({ id, version: sourceVersion }))
          .sort((left, right) => compareUtf8(left.id, right.id)),
        resultId: task.result.id,
        resultVersion: task.result.version,
        reviewAttemptId: task.review.attemptId,
        reviewerAgentId: task.review.reviewerAgentId,
        validationRefs: task.evidence
          .filter((entry) => entry.kind === "validation")
          .map(({ id, version: sourceVersion }) => ({ id, version: sourceVersion }))
          .sort((left, right) => compareUtf8(left.id, right.id)),
        workItemId: task.workItem.id,
        workItemVersion: task.workItem.version,
      })),
  };
}

export function buildDeliveryBundle(
  unsafeInput: DeliveryBuildInput,
  completedAt: string,
): DeliveryBundle {
  const parsed = deliveryBuildInputSchema.safeParse(unsafeInput);
  if (!parsed.success || !Number.isFinite(Date.parse(completedAt))) {
    throw new DeliveryManifestError("DELIVERY_INPUT_INVALID", "Delivery input is invalid.");
  }
  const input = parsed.data;
  if (input.tasks.some((task) => task.evidence.some((entry) => {
    const sourceVersion = new URL(entry.href, "https://delivery.invalid").searchParams.get("version");
    return sourceVersion !== entry.version;
  }))) {
    throw new DeliveryManifestError(
      "DELIVERY_INPUT_INVALID",
      "Evidence href does not bind the declared source version.",
    );
  }
  const inputFingerprint = createHash("sha256")
    .update(canonicalJson(fingerprintInput(input)), "utf8")
    .digest("hex");
  const entries = input.tasks
    .flatMap((task) => task.evidence)
    .map((entry): DeliveryManifestEntry => ({
      href: entry.href,
      id: entry.id,
      kind: entry.kind,
      required: required(entry),
      sha256: entry.sha256,
      status: status(entry),
      version: entry.version,
    }))
    .sort(evidenceOrder);
  const blockers = entries
    .filter((entry): entry is DeliveryManifestEntry & {
      status: Exclude<DeliveryEvidenceStatus, "passed" | "available">;
    } => entry.required && !["passed", "available"].includes(entry.status))
    .map((entry): DeliveryBlocker => ({
      code: "MISSION_COMPLETION_BLOCKED",
      id: entry.id,
      kind: entry.kind,
      status: entry.status,
      version: entry.version,
    }));
  const summary: DeliveryBundle["summary"] = {
    mission: {
      completedAt,
      conclusion: "completed",
      goal: input.mission.goal,
      id: input.mission.id,
      title: input.mission.title,
    },
    tasks: [...input.tasks]
      .sort((left, right) => compareUtf8(left.workItem.id, right.workItem.id))
      .map((task) => ({
        artifacts: task.evidence
          .filter((entry) => entry.kind === "artifact")
          .map(({ href: sourceHref, id, version: sourceVersion }) => ({
            href: sourceHref,
            id,
            version: sourceVersion,
          })),
        changes: {
          mergeFileCount: task.execution.mergeFileCount,
          mergeFinalBytes: task.execution.mergeFinalBytes,
          stagedHash: task.execution.stagedHash,
        },
        decision: {
          choice: task.decision.choice,
          id: task.decision.id,
          publicSummary: task.decision.publicSummary,
        },
        executor: task.executor,
        limitations: task.decision.limitations,
        memories: task.evidence
          .filter((entry) => entry.kind === "memory")
          .map(({ href: sourceHref, id, version: sourceVersion }) => ({
            href: sourceHref,
            id,
            version: sourceVersion,
          })),
        result: {
          href: task.evidence.find((entry) =>
            entry.kind === "result"
            && entry.id === task.result.id
            && entry.version === String(task.result.version)
          )?.href ?? (() => {
            throw new DeliveryManifestError(
              "DELIVERY_INPUT_INVALID",
              "Current result is missing its exact versioned evidence reference.",
            );
          })(),
          id: task.result.id,
          version: task.result.version,
        },
        reviewer: task.reviewer,
        validations: {
          passedCount: task.evidence.filter((entry) =>
            entry.kind === "validation" && status(entry) === "passed"
          ).length,
          refs: task.evidence
            .filter((entry) => entry.kind === "validation")
            .map(({ href: sourceHref, id, version: sourceVersion }) => ({
              href: sourceHref,
              id,
              version: sourceVersion,
            })),
          requiredCount: task.evidence.filter((entry) =>
            entry.kind === "validation" && entry.policyRequired
          ).length,
        },
        workItem: { id: task.workItem.id, title: task.workItem.title },
      })),
  };
  const manifest: DeliveryBundle["manifest"] = {
    entries,
    inputFingerprint,
    schemaVersion: 1,
  };
  if (Buffer.byteLength(canonicalJson({ manifest, summary }), "utf8") > MAX_DELIVERY_BYTES) {
    throw new DeliveryManifestError(
      "DELIVERY_RESPONSE_LIMIT_EXCEEDED",
      "Delivery summary and manifest exceed the public response limit.",
    );
  }
  return { blockers, inputFingerprint, manifest, summary };
}
