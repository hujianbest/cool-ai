import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  assertReviewMaterialPassable,
  freezeReviewMaterial,
  reviewMaterialIsCurrent,
} from "@/src/server/review/review-material";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

type Fixture = {
  artifactBody?: string | null;
  artifactVersion?: string;
  eventPayload?: Record<string, unknown>;
  frozenSource?: Partial<{
    projectId: string;
    runId: string;
    threadId: string;
  }> | null;
  legacySourceRunId?: string | null;
  latestRunId?: string;
  missionVersion?: number;
  optionalArtifact?: boolean;
  sourceContextHash?: string;
  sourceRunId?: string;
  sourceThreadId?: string;
  taskVersion?: number;
  validationRequired?: boolean;
};

function databaseFixture(overrides: Fixture = {}): DatabaseSync {
  const diff = `${"d".repeat(65_536)}tail`;
  const stdout = "validation passed";
  const artifactBody = overrides.artifactBody === undefined ? "artifact body" : overrides.artifactBody;
  const eventPayload = overrides.eventPayload ?? {
    journalId: "journal",
    resultId: "result",
    stagedHash: "9".repeat(64),
  };
  const rows = {
    artifactBody,
    artifactVersion: overrides.artifactVersion ?? (artifactBody === null ? "a".repeat(64) : sha256(artifactBody)),
    diff,
    eventPayload,
    frozenSource: overrides.frozenSource === undefined
      ? { projectId: "project", runId: "run-a", threadId: "thread-a" }
      : overrides.frozenSource,
    latestRunId: overrides.latestRunId ?? "run-newest",
    legacySourceRunId: overrides.legacySourceRunId === undefined
      ? (overrides.sourceRunId ?? "run-a")
      : overrides.legacySourceRunId,
    missionVersion: overrides.missionVersion ?? 3,
    optionalArtifact: overrides.optionalArtifact ?? true,
    sourceContextHash: overrides.sourceContextHash ?? "c".repeat(64),
    sourceRunId: overrides.sourceRunId ?? "run-a",
    sourceThreadId: overrides.sourceThreadId ?? "thread-a",
    stdout,
    taskVersion: overrides.taskVersion ?? 7,
    validationRequired: overrides.validationRequired ?? true,
  };
  const prepare = (sql: string) => ({
    all: (...parameters: unknown[]) => {
      if (sql.includes("FROM work_item_dependencies")) return [];
      if (sql.includes("FROM execution_staged_observations")) {
        return [{
          baselineHash: "1".repeat(64),
          diffBytes: Buffer.byteLength(rows.diff),
          diffText: rows.diff,
          diffTruncated: 0,
          finalSize: 4,
          id: "observation",
          kind: "modified",
          observedHash: "2".repeat(64),
          path: "src/a.ts",
          position: 0,
        }];
      }
      if (sql.includes("FROM execution_staged_blockers")) return [];
      if (sql.includes("FROM execution_validation_results")) {
        return [{
          afterLastWrite: 1,
          exitCode: 0,
          finishedAt: "2026-08-01T00:00:00.000Z",
          id: "validation",
          policyEntryId: "policy-entry",
          required: rows.validationRequired ? 1 : 0,
          stderrBytes: 0,
          stderrSha256: sha256(""),
          stderrTruncated: 0,
          stdoutBytes: Buffer.byteLength(rows.stdout),
          stdoutSha256: sha256(rows.stdout),
          stdoutTruncated: 0,
          succeeded: 1,
          version: "manifest-v1",
        }];
      }
      if (sql.includes("FROM execution_validation_output_chunks")) {
        return parameters[1] === "stderr"
          ? []
          : [{
              byteLength: Buffer.byteLength(rows.stdout),
              byteOffset: 0,
              sha256: sha256(rows.stdout),
              text: rows.stdout,
            }];
      }
      if (sql.includes("FROM execution_artifacts")) {
        return [{
          contentBytes: rows.artifactBody === null ? 13 : Buffer.byteLength(rows.artifactBody),
          createdAt: "2026-08-01T00:00:00.000Z",
          id: "artifact",
          name: "report",
          path: "reports/result.txt",
          sha256: rows.artifactVersion,
          truncated: 0,
        }];
      }
      if (sql.includes("FROM execution_artifact_chunks")) {
        return rows.artifactBody === null
          ? []
          : [{
              byteLength: Buffer.byteLength(rows.artifactBody),
              byteOffset: 0,
              sha256: sha256(rows.artifactBody),
              text: rows.artifactBody,
            }];
      }
      if (sql.includes("FROM execution_events")) {
        return [{
          actorId: null,
          actorType: "system",
          attemptNo: 1,
          createdAt: "2026-08-01T00:00:00.000Z",
          id: "event",
          payloadJson: JSON.stringify(rows.eventPayload),
          sequence: 12,
          type: "merged",
        }];
      }
      if (sql.includes("FROM memory_entries")) return [];
      if (sql.includes("FROM review_escalations escalation")) return [];
      throw new Error(`Unexpected all query: ${sql}`);
    },
    get: () => {
      if (sql.includes("FROM work_item_result_versions")) {
        return {
          createdAt: "2026-08-01T00:00:00.000Z",
          executionId: "execution",
          frozenSourceProjectId: rows.frozenSource?.projectId ?? null,
          frozenSourceRunId: rows.frozenSource?.runId ?? null,
          frozenSourceThreadId: rows.frozenSource?.threadId ?? null,
          legacySourceRunId: rows.legacySourceRunId,
          id: "result",
          mergeJournalId: "journal",
          sourceContextHash: rows.sourceContextHash,
          sourceProjectId: "project",
          sourceRunId: rows.sourceRunId,
          sourceThreadId: rows.sourceThreadId,
          stagedContextHash: rows.sourceContextHash,
          stagedResultId: "staged",
          version: 2,
        };
      }
      if (sql.includes("FROM projects")) return { id: "project", name: "Project" };
      if (sql.includes("FROM missions")) {
        return {
          contextVersion: 5,
          goal: "Goal",
          id: "mission",
          title: "Mission",
          version: rows.missionVersion,
        };
      }
      if (sql.includes("FROM work_items")) {
        return {
          assigneeAgentId: "executor",
          boardStatus: "in_progress",
          description: "Implement safely",
          id: "work",
          title: "Work",
          version: rows.taskVersion,
        };
      }
      if (sql.includes("FROM agents")) return { agentId: "executor", name: "Executor" };
      if (sql.includes("FROM execution_staged_results")) {
        return {
          classification: "auto_eligible",
          mergeFileCount: 1,
          mergeFinalBytes: 4,
          observedFinalBytes: 4,
          observedPathCount: 1,
          stagedHash: "9".repeat(64),
        };
      }
      throw new Error(`Unexpected get query: ${sql}`);
    },
  });
  return { prepare } as unknown as DatabaseSync;
}

const head = {
  missionId: "mission",
  projectId: "project",
  resultId: "result",
  resultVersion: 2,
  workItemId: "work",
};

describe("frozen review material", () => {
  it("embeds exact versioned diff, validation, artifact and typed event chunks deterministically", () => {
    const database = databaseFixture();
    const first = freezeReviewMaterial(database, head, "attempt");
    const second = freezeReviewMaterial(database, head, "attempt");

    expect(second).toEqual(first);
    expect(Buffer.byteLength(first.json)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(first.material.changes.observations[0]?.publicDiff).toMatchObject({
      includedBytes: 65_540,
      source: { id: "observation", type: "result", version: "2" },
      status: "complete",
    });
    expect(first.material.changes.observations[0]?.publicDiff.chunks).toHaveLength(2);
    expect(first.material.changes.observations[0]?.publicDiff.chunks[0]?.bytes).toBe(65_536);
    expect(first.material.validations[0]?.stdout).toMatchObject({
      sha256: sha256("validation passed"),
      status: "complete",
    });
    expect(first.material.artifacts[0]?.content.chunks[0]?.text).toBe("artifact body");
    expect(first.material.auditEvents[0]?.payload.chunks[0]?.text).toBe(
      JSON.stringify({ journalId: "journal", resultId: "result", stagedHash: "9".repeat(64) }),
    );
    expect(first.material.sourceRefs).toEqual(expect.arrayContaining([
      { id: "validation", type: "validation", version: "manifest-v1" },
      { id: "artifact", type: "artifact", version: sha256("artifact body") },
      { id: "event", type: "execution", version: "12" },
    ]));
    expect(first.material.result.source).toEqual({
      contextHash: "c".repeat(64),
      projectId: "project",
      runId: "run-a",
      threadId: "thread-a",
    });
    expect(first.json).not.toMatch(/[A-Z]:\\|private prompt|authorization|api[_-]?key|chain.of.thought/iu);
  });

  it("uses the result execution frozen tuple and remains stable after newer runs appear", () => {
    const original = freezeReviewMaterial(databaseFixture({
      latestRunId: "run-b",
    }), head, "attempt");
    const afterLaterRuns = freezeReviewMaterial(databaseFixture({
      latestRunId: "run-c",
    }), head, "attempt");

    expect(afterLaterRuns.hash).toBe(original.hash);
    expect(afterLaterRuns.material.result.source).toMatchObject({
      runId: "run-a",
      threadId: "thread-a",
    });
  });

  it("restores a v6 frozen package without source fields from its validated execution tuple", () => {
    const legacy = freezeReviewMaterial(databaseFixture({
      frozenSource: null,
      latestRunId: "run-newest-must-not-be-used",
      legacySourceRunId: "legacy-run",
      sourceRunId: "legacy-run",
      sourceThreadId: "legacy-thread-project-hash",
    }), head, "legacy-attempt");

    expect(legacy.material.result.source).toEqual({
      contextHash: "c".repeat(64),
      projectId: "project",
      runId: "legacy-run",
      threadId: "legacy-thread-project-hash",
    });
  });

  it.each([
    ["missing legacy run identity", null, null],
    ["conflicting legacy run identity", null, "run-other"],
    ["partial source tuple", { projectId: "project", runId: "run-a" }, "run-a"],
    ["explicit tuple with conflicting legacy run", {
      projectId: "project",
      runId: "run-a",
      threadId: "thread-a",
    }, "run-other"],
  ])("fails closed for %s", (_case, frozenSource, legacySourceRunId) => {
    expect(() => freezeReviewMaterial(databaseFixture({
      frozenSource,
      legacySourceRunId,
    }), head, "attempt")).toThrow(expect.objectContaining({
      code: "REVIEW_MATERIAL_INVALID",
    }));
  });

  it.each([
    ["cross-thread frozen source", {
      projectId: "project",
      runId: "run-a",
      threadId: "thread-b",
    }],
    ["cross-run frozen source", {
      projectId: "project",
      runId: "run-b",
      threadId: "thread-a",
    }],
  ])("fails closed for %s", (_case, frozenSource) => {
    expect(() => freezeReviewMaterial(databaseFixture({
      frozenSource,
    }), head, "attempt")).toThrow(expect.objectContaining({
      code: "REVIEW_MATERIAL_INVALID",
      message: "公开复核材料无效",
    }));
  });

  it("uses each rework result execution's own frozen tuple", () => {
    const rework = freezeReviewMaterial(databaseFixture({
      frozenSource: {
        projectId: "project",
        runId: "run-rework",
        threadId: "thread-rework",
      },
      sourceContextHash: "d".repeat(64),
      sourceRunId: "run-rework",
      sourceThreadId: "thread-rework",
    }), head, "attempt-rework");

    expect(rework.material.result.source).toEqual({
      contextHash: "d".repeat(64),
      projectId: "project",
      runId: "run-rework",
      threadId: "thread-rework",
    });
  });

  it("preserves migrated legacy execution provenance", () => {
    const legacy = freezeReviewMaterial(databaseFixture({
      frozenSource: {
        projectId: "project",
        runId: "legacy-run",
        threadId: "legacy-thread-project-hash",
      },
      sourceRunId: "legacy-run",
      sourceThreadId: "legacy-thread-project-hash",
    }), head, "legacy-attempt");

    expect(legacy.material.result.source).toMatchObject({
      projectId: "project",
      runId: "legacy-run",
      threadId: "legacy-thread-project-hash",
    });
  });

  it("fails closed for header-only required content while optional missing content remains limited", () => {
    const requiredMissing = freezeReviewMaterial(
      databaseFixture({ artifactBody: null, optionalArtifact: false }),
      head,
      "attempt",
      { requiredArtifactIds: new Set(["artifact"]) },
    );
    expect(() => assertReviewMaterialPassable(requiredMissing.material, []))
      .toThrowError(/REVIEW_CONTENT_INCOMPLETE/u);

    const optionalMissing = freezeReviewMaterial(
      databaseFixture({ artifactBody: null, optionalArtifact: true }),
      head,
      "attempt",
    );
    expect(optionalMissing.material.artifacts[0]?.content.status).toBe("missing");
    expect(() => assertReviewMaterialPassable(optionalMissing.material, [
      "artifact artifact is missing",
    ])).not.toThrow();
  });

  it("uses the shared 2 MiB prompt budget and never truncates required content", () => {
    const huge = "x".repeat(2 * 1024 * 1024);
    expect(() => freezeReviewMaterial(
      databaseFixture({ artifactBody: huge }),
      head,
      "attempt",
      { requiredArtifactIds: new Set(["artifact"]) },
    )).toThrowError(/REVIEW_MATERIAL_LIMIT_EXCEEDED/u);

    const optional = freezeReviewMaterial(databaseFixture({ artifactBody: huge }), head, "attempt");
    expect(Buffer.byteLength(optional.json)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(optional.material.artifacts[0]?.content).toMatchObject({
      reasonCode: "MATERIAL_BUDGET_EXHAUSTED",
      status: "truncated",
    });
  });

  it("marks any related task, mission or source version change stale", () => {
    const frozen = freezeReviewMaterial(databaseFixture(), head, "attempt");
    expect(reviewMaterialIsCurrent(databaseFixture(), head, frozen.hash, "attempt")).toBe(true);
    expect(reviewMaterialIsCurrent(
      databaseFixture({ taskVersion: 8 }),
      head,
      frozen.hash,
      "attempt",
    )).toBe(false);
    expect(reviewMaterialIsCurrent(
      databaseFixture({ artifactVersion: "f".repeat(64) }),
      head,
      frozen.hash,
      "attempt",
    )).toBe(false);
  });
});
