import { describe, expect, it } from "vitest";

import {
  DeliveryManifestError,
  buildDeliveryBundle,
  type DeliveryBuildInput,
} from "@/src/adapters/outbound/sqlite/review-delivery/delivery-service";

const HASH = "a".repeat(64);

function input(): DeliveryBuildInput {
  return {
    schemaVersion: 1,
    mission: {
      contextVersion: 4,
      goal: "Ship reviewed work",
      id: "mission",
      title: "Mission",
      version: 3,
    },
    tasks: [{
      decision: {
        choice: "pass",
        id: "decision",
        limitations: ["Optional trace was unavailable."],
        publicSummary: "The reviewed change is complete.",
      },
      evidence: [
        {
          contentStatus: "complete",
          href: "/projects/project/results/result?version=2",
          id: "result",
          kind: "result",
          sha256: HASH,
          version: "2",
        },
        {
          contentStatus: "complete",
          href: "/projects/project/reviews/attempt?version=checkpoint",
          id: "attempt",
          kind: "review",
          sha256: HASH,
          version: "checkpoint",
        },
        {
          contentStatus: "complete",
          href: "/projects/project/executions/execution/diffs/change?version=2",
          id: "change",
          kind: "diff",
          sha256: HASH,
          version: "2",
        },
        {
          contentStatus: "complete",
          href: "/projects/project/executions/execution/validations/required?version=v1",
          id: "required",
          kind: "validation",
          policyRequired: true,
          sha256: HASH,
          succeeded: true,
          version: "v1",
        },
        {
          contentStatus: "missing",
          href: "/projects/project/executions/execution/validations/optional?version=v1",
          id: "optional",
          kind: "validation",
          policyRequired: false,
          sha256: null,
          succeeded: false,
          version: "v1",
        },
        {
          contentStatus: "unreadable",
          href: "/projects/project/executions/execution/artifacts/log?version=v2",
          id: "log",
          kind: "artifact",
          referencedByDecisionOrMemory: false,
          sha256: HASH,
          version: "v2",
        },
        {
          contentStatus: "truncated",
          href: "/projects/project/executions/execution/events/event?version=7",
          id: "event",
          kind: "execution_event",
          referencedByDecision: false,
          sha256: HASH,
          version: "7",
        },
        {
          associationCurrent: true,
          href: "/projects/project/memory/memory?version=1",
          id: "memory",
          kind: "memory",
          sha256: null,
          version: "1",
        },
      ],
      execution: {
        id: "execution",
        mergeFileCount: 1,
        mergeFinalBytes: 42,
        sourceCollaborationThreadId: "thread-a",
        sourceCollaborationRunId: "run",
        sourceHref: "/projects/project?thread=thread-a&run=run",
        stagedHash: HASH,
      },
      executor: { agentId: "executor", name: "Executor" },
      result: { id: "result", version: 2 },
      review: { attemptId: "attempt", reviewerAgentId: "reviewer" },
      reviewer: { agentId: "reviewer", name: "Reviewer" },
      workItem: { id: "work", title: "Work", version: 5 },
    }],
  };
}

describe("delivery manifest", () => {
  it("classifies every evidence kind consistently and exposes optional failures without blocking", () => {
    const bundle = buildDeliveryBundle(input(), "2026-08-01T06:00:00.000Z");

    expect(bundle.blockers).toEqual([]);
    expect(bundle.manifest.entries.map(({ id, required, status }) => ({ id, required, status }))).toEqual([
      { id: "result", required: true, status: "available" },
      { id: "attempt", required: true, status: "passed" },
      { id: "change", required: true, status: "available" },
      { id: "optional", required: false, status: "missing" },
      { id: "required", required: true, status: "passed" },
      { id: "log", required: false, status: "unreadable" },
      { id: "event", required: false, status: "truncated" },
      { id: "memory", required: true, status: "available" },
    ]);
  });

  it.each(["failed", "truncated", "missing", "unreadable", "stale"] as const)(
    "returns a stable blocker when required evidence is %s",
    (contentStatus) => {
      const draft = input();
      const required = draft.tasks[0]!.evidence.find((entry) => entry.id === "required")!;
      if (required.kind !== "validation") throw new Error("Fixture validation is missing.");
      required.contentStatus = contentStatus;
      const first = buildDeliveryBundle(draft, "2026-08-01T06:00:00.000Z");
      const second = buildDeliveryBundle(draft, "2026-08-01T06:00:00.000Z");

      expect(first.blockers).toEqual([{
        code: "MISSION_COMPLETION_BLOCKED",
        id: "required",
        kind: "validation",
        status: contentStatus,
        version: "v1",
      }]);
      expect(second.blockers).toEqual(first.blockers);
    },
  );

  it("promotes referenced artifacts and events to required evidence", () => {
    const draft = input();
    const artifact = draft.tasks[0]!.evidence.find((entry) => entry.id === "log")!;
    const event = draft.tasks[0]!.evidence.find((entry) => entry.id === "event")!;
    if (artifact.kind !== "artifact" || event.kind !== "execution_event") {
      throw new Error("Fixture evidence is missing.");
    }
    artifact.referencedByDecisionOrMemory = true;
    event.referencedByDecision = true;

    expect(buildDeliveryBundle(draft, "2026-08-01T06:00:00.000Z").blockers).toEqual([
      {
        code: "MISSION_COMPLETION_BLOCKED",
        id: "log",
        kind: "artifact",
        status: "unreadable",
        version: "v2",
      },
      {
        code: "MISSION_COMPLETION_BLOCKED",
        id: "event",
        kind: "execution_event",
        status: "truncated",
        version: "7",
      },
    ]);
  });

  it("fingerprints mission and context versions plus every current passed version", () => {
    const original = buildDeliveryBundle(input(), "2026-08-01T06:00:00.000Z").inputFingerprint;
    const mutations: Array<(draft: DeliveryBuildInput) => void> = [
      (draft) => { draft.mission.version += 1; },
      (draft) => { draft.mission.contextVersion += 1; },
      (draft) => { draft.tasks[0]!.workItem.version += 1; },
      (draft) => {
        draft.tasks[0]!.result.version += 1;
        const result = draft.tasks[0]!.evidence.find((entry) => entry.kind === "result")!;
        result.version = "3";
        result.href = "/projects/project/results/result?version=3";
      },
      (draft) => { draft.tasks[0]!.review.attemptId = "attempt-v2"; },
      (draft) => { draft.tasks[0]!.decision.id = "decision-v2"; },
      (draft) => {
        draft.tasks[0]!.execution.sourceCollaborationThreadId = "thread-b";
        draft.tasks[0]!.execution.sourceHref = "/projects/project?thread=thread-b&run=run";
      },
      (draft) => {
        const optional = draft.tasks[0]!.evidence.find((entry) => entry.id === "optional")!;
        optional.version = "v2";
        optional.href = "/projects/project/executions/execution/validations/optional?version=v2";
      },
    ];

    for (const mutate of mutations) {
      const draft = input();
      mutate(draft);
      expect(buildDeliveryBundle(draft, "2026-08-01T06:00:00.000Z").inputFingerprint)
        .not.toBe(original);
    }
  });

  it("keeps the exact frozen collaboration tuple in source metadata and navigation", () => {
    const first = buildDeliveryBundle(input(), "2026-08-01T06:00:00.000Z");
    const second = buildDeliveryBundle(input(), "2026-08-01T06:00:00.000Z");

    expect(first.inputFingerprint).toBe(second.inputFingerprint);
    expect(first.summary.tasks[0]!.execution).toEqual({
      id: "execution",
      sourceCollaborationRunId: "run",
      sourceCollaborationThreadId: "thread-a",
      sourceHref: "/projects/project?thread=thread-a&run=run",
    });
    const sourceUrl = new URL(
      first.summary.tasks[0]!.execution.sourceHref,
      "https://delivery.invalid",
    );
    expect(sourceUrl.pathname).toBe("/projects/project");
    expect(sourceUrl.searchParams.getAll("thread")).toEqual(["thread-a"]);
    expect(sourceUrl.searchParams.getAll("run")).toEqual(["run"]);
  });

  it("builds bounded public-fact-only strict DTOs with versioned hrefs", () => {
    const bundle = buildDeliveryBundle(input(), "2026-08-01T06:00:00.000Z");
    const serialized = JSON.stringify({ manifest: bundle.manifest, summary: bundle.summary });

    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(256 * 1024);
    expect(bundle.summary.tasks[0]!.decision.publicSummary).toBe("The reviewed change is complete.");
    expect(bundle.manifest.entries.every((entry) =>
      entry.href.startsWith("/") && entry.href.includes(`version=${encodeURIComponent(entry.version)}`)
    )).toBe(true);
    expect(serialized).not.toMatch(/raw|chain.of.thought|[A-Z]:\\/iu);

    const unknown = input() as DeliveryBuildInput & { raw: string };
    unknown.raw = "provider body";
    expect(() => buildDeliveryBundle(unknown, "2026-08-01T06:00:00.000Z"))
      .toThrow(DeliveryManifestError);

    const privateDraft = input();
    privateDraft.tasks[0]!.decision.publicSummary = "chain-of-thought";
    expect(() => buildDeliveryBundle(privateDraft, "2026-08-01T06:00:00.000Z"))
      .toThrow(DeliveryManifestError);

    const oversized = input();
    oversized.tasks[0]!.decision.limitations = Array.from(
      { length: 70 },
      (_, index) => `${index}:${"x".repeat(4_000)}`,
    );
    expect(() => buildDeliveryBundle(oversized, "2026-08-01T06:00:00.000Z"))
      .toThrowError(expect.objectContaining({ code: "DELIVERY_RESPONSE_LIMIT_EXCEEDED" }));
  });
});
