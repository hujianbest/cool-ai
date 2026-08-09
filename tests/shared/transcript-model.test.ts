import { describe, expect, it } from "vitest";

import { reduceTranscript } from "@/src/shared/transcript-model";

const targetKey = "project-1|thread-1|run-1";

function block(
  id: string,
  position: number,
  payload: Record<string, unknown>,
  state: Record<string, unknown>,
) {
  return {
    actor: { displayName: "Alpha", id: "agent-a", type: "agent" },
    blockRevision: 1,
    blockSchemaVersion: 1,
    blockType: payload.blockType,
    id,
    kind: "known",
    logicalBlockId: `logical-${id}`,
    payload,
    position,
    source: {
      entityVersion: payload.blockType === "proposal" ? null : `source-v-${id}`,
      id: payload.blockType === "proposal" ? "message-1" : `source-${id}`,
      kind: payload.blockType === "proposal" ? "message" : "execution",
      messageId: "message-1",
      projectId: "project-1",
      runId: "run-1",
      threadId: "thread-1",
    },
    state: { ...state, stateVersion: 1 },
  };
}

function messageFact(blocks: unknown[]) {
  return {
    activitySequence: 2,
    actorId: "agent-a",
    actorType: "agent",
    createdAt: "2026-08-09T00:00:00.000Z",
    id: "fact-message",
    message: {
      authorAgentId: "agent-a",
      authorDisplayName: "Alpha",
      authorType: "agent",
      blocks,
      content: "Frozen plain text",
      createdAt: "2026-08-09T00:00:00.000Z",
      id: "message-1",
      mentionAgentId: null,
      mentionDisplayName: null,
      mentionMemberStatus: null,
      projectId: "project-1",
      runId: "run-1",
      sequence: 1,
      threadId: "thread-1",
    },
    messageId: "message-1",
    payload: { messageId: "message-1" },
    policyRevisionId: null,
    projectId: "project-1",
    runEventId: null,
    runId: "run-1",
    sequence: 2,
    threadId: "thread-1",
    type: "agent_message",
  };
}

describe("fact-only Transcript Model public seam", () => {
  it("preserves plain text and all five known blocks in fact/message/block order", () => {
    const blocks = [
      block("proposal", 0, {
        actions: ["accept", "reject"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        body: "Choose the safe path.",
        logicalBlockId: "logical-proposal",
        title: "Proposal title",
      }, { status: "pending" }),
      block("checklist", 1, {
        actions: ["check_item", "uncheck_item"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "checklist",
        items: [{ id: "item-1", text: "Verify source" }],
        logicalBlockId: "logical-checklist",
        title: "Checklist title",
      }, { items: [{ checked: false, id: "item-1" }] }),
      block("diff", 2, {
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "diff_preview",
        logicalBlockId: "logical-diff",
        observationHash: "a".repeat(64),
        observationId: "observation-1",
        stagedResultId: "staged-1",
        title: "Diff title",
      }, { status: "read_only" }),
      block("file", 3, {
        artifactHash: "b".repeat(64),
        artifactId: "artifact-1",
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "file_reference",
        executionId: "execution-1",
        logicalBlockId: "logical-file",
        publicName: "frozen-report.txt",
        title: "File title",
      }, { status: "read_only" }),
      block("handoff", 4, {
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "handoff_card",
        factId: "handoff-fact",
        logicalBlockId: "logical-handoff",
        title: "Handoff title",
        turnId: "turn-1",
      }, { status: "read_only" }),
    ];

    const result = reduceTranscript({
      currentTargetKey: targetKey,
      pages: [{ items: [messageFact(blocks)], nextAfter: null }],
      targetKey,
    });

    expect(result).toMatchObject({
      kind: "ready",
      entries: [{
        actorLabel: "Alpha",
        factId: "fact-message",
        messageId: "message-1",
        text: "Frozen plain text",
      }],
    });
    if (result.kind !== "ready") throw new Error("Expected ready transcript.");
    expect(result.entries[0]).toMatchObject({
      blocks: [
        { id: "proposal", kind: "proposal", title: "Proposal title" },
        { id: "checklist", kind: "checklist", title: "Checklist title" },
        { id: "diff", kind: "diff_preview", title: "Diff title" },
        { id: "file", fileName: "frozen-report.txt", kind: "file_reference", title: "File title" },
        { id: "handoff", kind: "handoff_card", title: "Handoff title" },
      ],
    });
  });

  it("deduplicates overlapping pages and fails closed on changed fact or block identity", () => {
    const proposal = block("proposal", 0, {
      actions: ["accept", "reject"],
      blockRevision: 1,
      blockSchemaVersion: 1,
      blockType: "proposal",
      body: "Body",
      logicalBlockId: "logical-proposal",
      title: "Original",
    }, { status: "pending" });
    const fact = messageFact([proposal]);
    const duplicate = reduceTranscript({
      currentTargetKey: targetKey,
      pages: [
        { items: [fact], nextAfter: 2 },
        { items: [fact], nextAfter: null },
      ],
      targetKey,
    });
    expect(duplicate).toMatchObject({ kind: "ready", entries: [{ factId: "fact-message" }] });
    if (duplicate.kind !== "ready") throw new Error("Expected ready transcript.");
    expect(duplicate.entries).toHaveLength(1);

    const changedBlock = messageFact([{
      ...proposal,
      payload: { ...proposal.payload, title: "Changed" },
    }]);
    expect(reduceTranscript({
      currentTargetKey: targetKey,
      pages: [
        { items: [fact], nextAfter: 2 },
        { items: [changedBlock], nextAfter: null },
      ],
      targetKey,
    })).toMatchObject({ kind: "invalid" });
  });

  it("keeps an unknown schema as a minimal non-executable placeholder", () => {
    const unknown = {
      actor: { displayName: "Future Agent", id: "agent-future", type: "agent" },
      blockRevision: 3,
      blockSchemaVersion: 9,
      blockType: "future_widget",
      id: "future-block",
      kind: "unknown-schema",
      logicalBlockId: "future-logical",
      position: 0,
      source: {
        entityVersion: "future-v1",
        id: "future-source",
        kind: "execution",
        messageId: "message-1",
        projectId: "project-1",
        runId: "run-1",
        threadId: "thread-1",
      },
      stateVersion: 4,
    };
    const result = reduceTranscript({
      currentTargetKey: targetKey,
      pages: [{ items: [messageFact([unknown, block("proposal", 1, {
        actions: ["accept", "reject"],
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "proposal",
        body: "Still readable.",
        logicalBlockId: "known-after-unknown",
        title: "Known after unknown",
      }, { status: "pending" })])], nextAfter: null }],
      targetKey,
    });

    expect(result).toMatchObject({
      kind: "ready",
      entries: [{
        blocks: [
          {
            actorLabel: "Future Agent",
            blockRevision: 3,
            blockSchemaVersion: 9,
            executable: false,
            id: "future-block",
            kind: "unknown",
            sourceLabel: "execution · future-source · future-v1",
            stateVersion: 4,
          },
          { id: "proposal", kind: "proposal" },
        ],
      }],
    });
    expect(JSON.stringify(result)).not.toContain("future_widget");
  });

  it("returns stale without reducing aborted or superseded target responses", () => {
    expect(reduceTranscript({
      currentTargetKey: "project-1|thread-2|run-2",
      pages: [{ items: [messageFact([])], nextAfter: null }],
      targetKey,
    })).toEqual({ kind: "stale", targetKey });
    expect(reduceTranscript({
      aborted: true,
      currentTargetKey: targetKey,
      pages: [{ items: [messageFact([])], nextAfter: null }],
      targetKey,
    })).toEqual({ kind: "stale", targetKey });
  });
});
