import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { canonicalRequestHash } from "@/src/server/collaboration/operation-receipts";
import { completionBlockersTx } from "@/src/server/review/completion-gate";

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

const DELIVERY_LEASE_MS = 120_000;

type DeliveryClock = {
  clock?: () => Date;
  randomUUID?: () => string;
};

type DeliveryFaultPoint = "before_insert" | "after_insert" | "before_head_cas";

export class DeliveryGenerationError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly blockers?: unknown[],
    public readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "DeliveryGenerationError";
  }
}

type DeliveryHeadRow = {
  contextVersion: number;
  currentDeliveryId: string | null;
  currentOperationId: string | null;
  expiresAt: string | null;
  leaseToken: string | null;
  state: "ongoing" | "generating" | "completed" | "owner_terminated";
  version: number;
};

function deliveryHead(
  database: DatabaseSync,
  projectId: string,
  missionId: string,
): DeliveryHeadRow | undefined {
  return database.prepare(`
    SELECT context_version AS contextVersion,current_delivery_id AS currentDeliveryId,
           current_operation_id AS currentOperationId,
           generation_lease_expires_at AS expiresAt,
           generation_lease_token AS leaseToken,state,version
    FROM mission_delivery_heads WHERE project_id=? AND mission_id=?
  `).get(projectId, missionId) as DeliveryHeadRow | undefined;
}

function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the domain or injected fault.
    }
    throw error;
  }
}

function appendDeliveryEventTx(
  database: DatabaseSync,
  input: {
    missionId: string;
    payload: Record<string, unknown>;
    projectId: string;
    type: string;
  },
  dependencies: DeliveryClock = {},
): void {
  const head = database.prepare(`
    SELECT next_event_sequence AS sequence FROM mission_delivery_heads
    WHERE project_id=? AND mission_id=?
  `).get(input.projectId, input.missionId) as { sequence: number } | undefined;
  if (!head) {
    throw new DeliveryGenerationError(
      "DELIVERY_STATE_CONFLICT",
      409,
      "Mission delivery state is not initialized.",
    );
  }
  const now = (dependencies.clock ?? (() => new Date()))().toISOString();
  database.prepare(`
    INSERT INTO review_events(
      id,project_id,mission_id,sequence,type,actor_type,actor_id,payload_json,created_at
    ) VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, ?)
  `).run(
    (dependencies.randomUUID ?? randomUUID)(),
    input.projectId,
    input.missionId,
    head.sequence,
    input.type,
    JSON.stringify(input.payload),
    now,
  );
  const advanced = database.prepare(`
    UPDATE mission_delivery_heads
    SET next_event_sequence=next_event_sequence+1,updated_at=?
    WHERE project_id=? AND mission_id=? AND next_event_sequence=?
  `).run(now, input.projectId, input.missionId, head.sequence);
  if (advanced.changes !== 1) {
    throw new DeliveryGenerationError(
      "DELIVERY_STATE_CONFLICT",
      409,
      "Mission delivery event sequence changed.",
    );
  }
}

function completeDeliveryOperationTx(
  database: DatabaseSync,
  input: {
    body: Record<string, unknown>;
    operationId: string;
    projectId: string;
    status: number;
  },
  now: string,
): void {
  database.prepare(`
    UPDATE review_operations
    SET status='completed',http_status=?,response_json=?,updated_at=?
    WHERE project_id=? AND id=? AND status='pending'
  `).run(
    input.status,
    JSON.stringify(input.body),
    now,
    input.projectId,
    input.operationId,
  );
}

export function acquireDeliveryGeneration(
  database: DatabaseSync,
  input: {
    buildInput: DeliveryBuildInput;
    expectedHeadVersion: number;
    missionId: string;
    operationId: string;
    projectId: string;
  },
  dependencies: DeliveryClock = {},
): {
  bundle: DeliveryBundle;
  headVersion: number;
  leaseToken: string;
  missionId: string;
  operationId: string;
  projectId: string;
  reused: boolean;
} {
  const clock = dependencies.clock ?? (() => new Date());
  const bundle = buildDeliveryBundle(input.buildInput, clock().toISOString());
  if (bundle.blockers.length > 0) {
    throw new DeliveryGenerationError(
      "MISSION_COMPLETION_BLOCKED",
      409,
      "Required delivery evidence is not ready.",
      bundle.blockers,
    );
  }
  if (
    input.buildInput.mission.id !== input.missionId
    || !Number.isInteger(input.expectedHeadVersion)
    || input.expectedHeadVersion < 1
  ) {
    throw new DeliveryGenerationError("DELIVERY_INPUT_INVALID", 400, "Delivery input is invalid.");
  }
  const hasWorkItems = Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_items'
  `).get());
  if (hasWorkItems) {
    const completionBlockers = completionBlockersTx(database, input.missionId);
    if (completionBlockers.length > 0) {
      throw new DeliveryGenerationError(
        "MISSION_COMPLETION_BLOCKED",
        409,
        "Mission has unresolved completion blockers.",
        completionBlockers,
      );
    }
    const mission = database.prepare(`
      SELECT version FROM missions WHERE id=? AND project_id=?
    `).get(input.missionId, input.projectId) as { version: number } | undefined;
    if (!mission || mission.version !== input.buildInput.mission.version) {
      throw new DeliveryGenerationError(
        "DELIVERY_STATE_CONFLICT",
        409,
        "Mission version changed.",
      );
    }
  }
  const requestHash = canonicalRequestHash({
    expectedHeadVersion: input.expectedHeadVersion,
    inputFingerprint: bundle.inputFingerprint,
    missionId: input.missionId,
  });

  return withTransaction(database, () => {
    const prior = database.prepare(`
      SELECT kind,request_hash AS requestHash,status,response_json AS responseJson
      FROM review_operations WHERE project_id=? AND id=?
    `).get(input.projectId, input.operationId) as {
      kind: string;
      requestHash: string;
      responseJson: string | null;
      status: string;
    } | undefined;
    if (prior) {
      if (prior.kind !== "generate_delivery" || prior.requestHash !== requestHash) {
        throw new DeliveryGenerationError(
          "OPERATION_CONFLICT",
          409,
          "Operation id was already used for different delivery input.",
        );
      }
      const current = deliveryHead(database, input.projectId, input.missionId);
      if (
        prior.status === "pending"
        && current?.state === "generating"
        && current.currentOperationId === input.operationId
        && current.leaseToken
      ) {
        return {
          bundle,
          headVersion: current.version,
          leaseToken: current.leaseToken,
          missionId: input.missionId,
          operationId: input.operationId,
          projectId: input.projectId,
          reused: true,
        };
      }
      throw new DeliveryGenerationError(
        "DELIVERY_STATE_CONFLICT",
        409,
        "Delivery operation has already completed.",
      );
    }

    const head = deliveryHead(database, input.projectId, input.missionId);
    if (
      !head
      || head.state !== "ongoing"
      || head.version !== input.expectedHeadVersion
      || head.contextVersion !== input.buildInput.mission.contextVersion
    ) {
      throw new DeliveryGenerationError(
        "DELIVERY_STATE_CONFLICT",
        409,
        "Mission delivery state changed.",
        undefined,
        head?.version,
      );
    }
    const now = clock();
    const timestamp = now.toISOString();
    const leaseToken = (dependencies.randomUUID ?? randomUUID)();
    const expiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString();
    database.prepare(`
      INSERT INTO review_operations(
        id,project_id,kind,parent_id,request_hash,status,http_status,response_json,
        created_at,updated_at
      ) VALUES (?, ?, 'generate_delivery', ?, ?, 'pending', NULL, NULL, ?, ?)
    `).run(
      input.operationId,
      input.projectId,
      input.missionId,
      requestHash,
      timestamp,
      timestamp,
    );
    const acquired = database.prepare(`
      UPDATE mission_delivery_heads
      SET state='generating',current_operation_id=?,generation_lease_token=?,
          generation_lease_expires_at=?,last_error_code=NULL,
          version=version+1,updated_at=?
      WHERE project_id=? AND mission_id=? AND state='ongoing' AND version=?
        AND context_version=?
    `).run(
      input.operationId,
      leaseToken,
      expiresAt,
      timestamp,
      input.projectId,
      input.missionId,
      input.expectedHeadVersion,
      input.buildInput.mission.contextVersion,
    );
    if (acquired.changes !== 1) {
      throw new DeliveryGenerationError(
        "DELIVERY_STATE_CONFLICT",
        409,
        "Mission delivery acquire lost its compare-and-swap.",
      );
    }
    appendDeliveryEventTx(database, {
      missionId: input.missionId,
      payload: {
        inputFingerprint: bundle.inputFingerprint,
        operationId: input.operationId,
      },
      projectId: input.projectId,
      type: "delivery_generation_started",
    }, dependencies);
    return {
      bundle,
      headVersion: input.expectedHeadVersion + 1,
      leaseToken,
      missionId: input.missionId,
      operationId: input.operationId,
      projectId: input.projectId,
      reused: false,
    };
  });
}

function recordDeliveryFailure(
  database: DatabaseSync,
  input: {
    errorCode: string;
    leaseToken: string;
    missionId: string;
    operationId: string;
    projectId: string;
  },
  dependencies: DeliveryClock,
): void {
  withTransaction(database, () => {
    const now = (dependencies.clock ?? (() => new Date()))().toISOString();
    const failed = database.prepare(`
      UPDATE mission_delivery_heads
      SET state='ongoing',current_operation_id=NULL,generation_lease_token=NULL,
          generation_lease_expires_at=NULL,last_error_code=?,
          version=version+1,updated_at=?
      WHERE project_id=? AND mission_id=? AND state='generating'
        AND current_operation_id=? AND generation_lease_token=?
    `).run(
      input.errorCode,
      now,
      input.projectId,
      input.missionId,
      input.operationId,
      input.leaseToken,
    );
    if (failed.changes !== 1) return;
    completeDeliveryOperationTx(database, {
      body: { error: { code: input.errorCode }, ok: false },
      operationId: input.operationId,
      projectId: input.projectId,
      status: 500,
    }, now);
    appendDeliveryEventTx(database, {
      missionId: input.missionId,
      payload: { errorCode: input.errorCode, operationId: input.operationId },
      projectId: input.projectId,
      type: "delivery_generation_failed",
    }, dependencies);
  });
}

export function finalizeDeliveryGeneration(
  database: DatabaseSync,
  input: {
    bundle: DeliveryBundle;
    leaseToken: string;
    missionId: string;
    operationId: string;
    projectId: string;
  },
  dependencies: DeliveryClock & {
    beforeCommitStep?: (
      point: "after_delivery_insert" | "after_head_update" | "before_commit",
    ) => void;
    fault?: (point: DeliveryFaultPoint) => void;
  } = {},
):
  | { deliveryId: string; reused: boolean; state: "completed"; version: number }
  | {
      errorCode: "DELIVERY_GENERATION_FAILED";
      retry: { kind: "explicit-owner-retry" };
      state: "failed";
    } {
  const clock = dependencies.clock ?? (() => new Date());
  try {
    return withTransaction(database, () => {
      const head = deliveryHead(database, input.projectId, input.missionId);
      const now = clock();
      if (
        !head
        || head.state !== "generating"
        || head.currentOperationId !== input.operationId
        || head.leaseToken !== input.leaseToken
        || !head.expiresAt
        || Date.parse(head.expiresAt) <= now.getTime()
      ) {
        throw new DeliveryGenerationError(
          "DELIVERY_STATE_CONFLICT",
          409,
          "Delivery generation lease is no longer current.",
          undefined,
          head?.version,
        );
      }
      dependencies.fault?.("before_insert");
      const existing = database.prepare(`
        SELECT id,version FROM mission_deliveries
        WHERE mission_id=? AND input_fingerprint=?
      `).get(input.missionId, input.bundle.inputFingerprint) as
        | { id: string; version: number }
        | undefined;
      const latest = database.prepare(`
        SELECT id,version FROM mission_deliveries
        WHERE mission_id=? ORDER BY version DESC,id DESC LIMIT 1
      `).get(input.missionId) as { id: string; version: number } | undefined;
      const deliveryId = existing?.id ?? (dependencies.randomUUID ?? randomUUID)();
      const versionNumber = existing?.version ?? (latest?.version ?? 0) + 1;
      if (!existing) {
        database.prepare(`
          INSERT INTO mission_deliveries(
            id,project_id,mission_id,version,input_fingerprint,summary_json,
            evidence_manifest_json,supersedes_delivery_id,created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          deliveryId,
          input.projectId,
          input.missionId,
          versionNumber,
          input.bundle.inputFingerprint,
          JSON.stringify(input.bundle.summary),
          JSON.stringify(input.bundle.manifest),
          latest?.id ?? null,
          now.toISOString(),
        );
      }
      dependencies.fault?.("after_insert");
      dependencies.beforeCommitStep?.("after_delivery_insert");
      dependencies.fault?.("before_head_cas");
      const completed = database.prepare(`
        UPDATE mission_delivery_heads
        SET state='completed',current_delivery_id=?,current_operation_id=NULL,
            generation_lease_token=NULL,generation_lease_expires_at=NULL,
            last_error_code=NULL,version=version+1,updated_at=?
        WHERE project_id=? AND mission_id=? AND state='generating' AND version=?
          AND current_operation_id=? AND generation_lease_token=?
      `).run(
        deliveryId,
        now.toISOString(),
        input.projectId,
        input.missionId,
        head.version,
        input.operationId,
        input.leaseToken,
      );
      if (completed.changes !== 1) {
        throw new DeliveryGenerationError(
          "DELIVERY_STATE_CONFLICT",
          409,
          "Delivery finalize lost its compare-and-swap.",
        );
      }
      dependencies.beforeCommitStep?.("after_head_update");
      const response = { deliveryId, ok: true, reused: Boolean(existing), version: versionNumber };
      completeDeliveryOperationTx(database, {
        body: response,
        operationId: input.operationId,
        projectId: input.projectId,
        status: 200,
      }, now.toISOString());
      appendDeliveryEventTx(database, {
        missionId: input.missionId,
        payload: {
          deliveryId,
          inputFingerprint: input.bundle.inputFingerprint,
          reused: Boolean(existing),
          version: versionNumber,
        },
        projectId: input.projectId,
        type: "delivery_generation_completed",
      }, dependencies);
      dependencies.beforeCommitStep?.("before_commit");
      return {
        deliveryId,
        reused: Boolean(existing),
        state: "completed",
        version: versionNumber,
      };
    });
  } catch (error) {
    if (!(error instanceof DeliveryGenerationError && error.code === "DELIVERY_STATE_CONFLICT")) {
      recordDeliveryFailure(database, {
        errorCode: "DELIVERY_GENERATION_FAILED",
        leaseToken: input.leaseToken,
        missionId: input.missionId,
        operationId: input.operationId,
        projectId: input.projectId,
      }, dependencies);
      return {
        errorCode: "DELIVERY_GENERATION_FAILED",
        retry: { kind: "explicit-owner-retry" },
        state: "failed",
      };
    }
    throw error;
  }
}

export function invalidateMissionContextTx(
  database: DatabaseSync,
  input: { missionId: string; projectId: string; reason: string },
): { discardedAttemptIds: string[]; invalidatedDeliveryId: string | null } {
  const head = deliveryHead(database, input.projectId, input.missionId);
  if (!head) {
    throw new DeliveryGenerationError(
      "DELIVERY_STATE_CONFLICT",
      409,
      "Mission delivery state is not initialized.",
    );
  }
  const now = new Date().toISOString();
  const attempts = database.prepare(`
    SELECT id,work_item_id AS workItemId,operation_id AS operationId FROM review_attempts
    WHERE project_id=? AND mission_id=? AND status IN ('calling','finalizing')
    ORDER BY id
  `).all(input.projectId, input.missionId) as Array<{
    id: string;
    operationId: string;
    workItemId: string;
  }>;
  for (const attempt of attempts) {
    const discarded = database.prepare(`
      UPDATE review_attempts
      SET status='discarded',error_category='stale',finished_at=?
      WHERE id=? AND status IN ('calling','finalizing')
    `).run(now, attempt.id);
    if (discarded.changes !== 1) {
      throw new DeliveryGenerationError(
        "REVIEW_STATE_CONFLICT",
        409,
        "Review attempt invalidation lost its compare-and-swap.",
      );
    }
    database.prepare(`
      UPDATE review_model_calls
      SET status='discarded',error_category='stale',
          finished_at=coalesce(finished_at,?)
      WHERE attempt_id=? AND status='calling'
    `).run(now, attempt.id);
    database.prepare(`
      UPDATE work_item_review_heads
      SET state='pending_review',current_attempt_id=NULL,version=version+1,updated_at=?
      WHERE work_item_id=? AND current_attempt_id=?
    `).run(now, attempt.workItemId, attempt.id);
    completeDeliveryOperationTx(database, {
      body: { error: { code: input.reason }, ok: false },
      operationId: attempt.operationId,
      projectId: input.projectId,
      status: 409,
    }, now);
  }

  if (head.state === "generating" && head.currentOperationId) {
    completeDeliveryOperationTx(database, {
      body: { error: { code: "DELIVERY_CONTEXT_CHANGED" }, ok: false },
      operationId: head.currentOperationId,
      projectId: input.projectId,
      status: 409,
    }, now);
  }
  const changed = database.prepare(`
    UPDATE mission_delivery_heads
    SET context_version=context_version+1,state='ongoing',current_delivery_id=NULL,
        current_operation_id=NULL,generation_lease_token=NULL,
        generation_lease_expires_at=NULL,last_error_code=NULL,
        version=version+1,updated_at=?
    WHERE project_id=? AND mission_id=? AND version=?
  `).run(now, input.projectId, input.missionId, head.version);
  if (changed.changes !== 1) {
    throw new DeliveryGenerationError(
      "DELIVERY_STATE_CONFLICT",
      409,
      "Mission context invalidation lost its compare-and-swap.",
    );
  }
  for (const attempt of attempts) {
    appendDeliveryEventTx(database, {
      missionId: input.missionId,
      payload: { attemptId: attempt.id, reason: input.reason, workItemId: attempt.workItemId },
      projectId: input.projectId,
      type: "review_attempt_discarded",
    });
  }
  if (head.state === "completed" || head.state === "generating") {
    appendDeliveryEventTx(database, {
      missionId: input.missionId,
      payload: {
        deliveryId: head.currentDeliveryId,
        operationId: head.currentOperationId,
        reason: input.reason,
      },
      projectId: input.projectId,
      type: "mission_delivery_invalidated",
    });
  }
  return {
    discardedAttemptIds: attempts.map(({ id }) => id),
    invalidatedDeliveryId: head.currentDeliveryId,
  };
}

export function reconcileDeliveryGeneration(
  database: DatabaseSync,
  input: { missionId: string; projectId: string },
  dependencies: DeliveryClock = {},
): { reconciled: boolean } {
  const clock = dependencies.clock ?? (() => new Date());
  const current = deliveryHead(database, input.projectId, input.missionId);
  if (
    !current
    || current.state !== "generating"
    || !current.expiresAt
    || Date.parse(current.expiresAt) > clock().getTime()
  ) {
    return { reconciled: false };
  }
  return withTransaction(database, () => {
    const head = deliveryHead(database, input.projectId, input.missionId);
    if (
      !head
      || head.state !== "generating"
      || !head.expiresAt
      || Date.parse(head.expiresAt) > clock().getTime()
      || !head.currentOperationId
    ) {
      return { reconciled: false };
    }
    const now = clock().toISOString();
    const changed = database.prepare(`
      UPDATE mission_delivery_heads
      SET state='ongoing',current_operation_id=NULL,generation_lease_token=NULL,
          generation_lease_expires_at=NULL,last_error_code='DELIVERY_GENERATION_INTERRUPTED',
          version=version+1,updated_at=?
      WHERE project_id=? AND mission_id=? AND state='generating' AND version=?
    `).run(now, input.projectId, input.missionId, head.version);
    if (changed.changes !== 1) return { reconciled: false };
    completeDeliveryOperationTx(database, {
      body: { error: { code: "DELIVERY_GENERATION_INTERRUPTED" }, ok: false },
      operationId: head.currentOperationId,
      projectId: input.projectId,
      status: 500,
    }, now);
    appendDeliveryEventTx(database, {
      missionId: input.missionId,
      payload: {
        errorCode: "DELIVERY_GENERATION_INTERRUPTED",
        operationId: head.currentOperationId,
      },
      projectId: input.projectId,
      type: "delivery_generation_interrupted",
    }, dependencies);
    return { reconciled: true };
  });
}

export function reconcileDeliveryGenerations(
  database: DatabaseSync,
  dependencies: DeliveryClock & { build?: () => unknown } = {},
): { reconciledOperationIds: string[] } {
  const rows = database.prepare(`
    SELECT project_id AS projectId,mission_id AS missionId,
           current_operation_id AS operationId
    FROM mission_delivery_heads
    WHERE state='generating'
    ORDER BY mission_id
  `).all() as Array<{ missionId: string; operationId: string; projectId: string }>;
  const reconciledOperationIds: string[] = [];
  for (const row of rows) {
    const result = reconcileDeliveryGeneration(database, {
      missionId: row.missionId,
      projectId: row.projectId,
    }, dependencies);
    if (result.reconciled) reconciledOperationIds.push(row.operationId);
  }
  return { reconciledOperationIds };
}
