import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ingestStructuredBlocks,
  materializeStructuredBlocks,
} from "@/src/server/structured-messages/structured-message-store";

type ResolverModule = {
  resolveVerifiedSource: (
    database: DatabaseSync,
    tuple: { projectId: string; runId: string; threadId: string },
    input: unknown,
  ) => unknown;
};

const modules = import.meta.glob<ResolverModule>(
  "../src/server/structured-messages/verified-source-projection.ts",
);
let database: DatabaseSync;

async function resolver(): Promise<ResolverModule> {
  const load = modules["../src/server/structured-messages/verified-source-projection.ts"];
  expect(load, "verified source projection seam must exist").toBeTypeOf("function");
  return load();
}

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE executions(
      id TEXT PRIMARY KEY,project_id TEXT,source_collaboration_thread_id TEXT,
      source_collaboration_run_id TEXT
    );
    CREATE TABLE execution_staged_results(
      id TEXT PRIMARY KEY,project_id TEXT,execution_id TEXT,staged_hash TEXT
    );
    CREATE TABLE execution_staged_observations(
      id TEXT PRIMARY KEY,staged_result_id TEXT,observed_hash TEXT,diff_text TEXT
    );
    CREATE TABLE execution_artifacts(
      id TEXT PRIMARY KEY,project_id TEXT,execution_id TEXT,name TEXT,path TEXT,sha256 TEXT
    );
    CREATE TABLE collaboration_thread_facts(
      id TEXT PRIMARY KEY,project_id TEXT,thread_id TEXT,run_id TEXT,run_event_id TEXT,type TEXT
    );
    CREATE TABLE collaboration_events(
      id TEXT PRIMARY KEY,project_id TEXT,thread_id TEXT,run_id TEXT,type TEXT,payload_json TEXT,
      actor_type TEXT,actor_id TEXT
    );
    CREATE TABLE collaboration_turns(
      id TEXT PRIMARY KEY,project_id TEXT,thread_id TEXT,run_id TEXT,message_id TEXT
    );
    CREATE TABLE collaboration_messages(
      id TEXT PRIMARY KEY,project_id TEXT,thread_id TEXT,run_id TEXT,author_display_name TEXT
    );
    INSERT INTO executions VALUES ('execution','project','thread','run');
    INSERT INTO execution_staged_results VALUES (
      'staged','project','execution','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    INSERT INTO execution_staged_observations VALUES (
      'observation','staged','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'safe public diff'
    );
    INSERT INTO execution_artifacts VALUES (
      'artifact','project','execution','report.txt','D:\\secret\\report.txt',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    );
    INSERT INTO collaboration_messages VALUES ('message','project','thread','run','Agent A');
    INSERT INTO collaboration_turns VALUES ('turn','project','thread','run','message');
    INSERT INTO collaboration_events VALUES (
      'handoff-event','project','thread','run','handoff',
      '{"fromAgentId":"a","toAgentId":"b","summary":"Continue","turnId":"turn"}','agent','a'
    );
    INSERT INTO collaboration_thread_facts VALUES (
      'handoff-fact','project','thread','run','handoff-event','run_event'
    );
  `);
});

afterEach(() => database.close());

describe("verified structured-message source projection", () => {
  it("resolves only exact tuple persisted diff, artifact, and handoff identities without host paths", async () => {
    const { resolveVerifiedSource } = await resolver();
    const tuple = { projectId: "project", runId: "run", threadId: "thread" };

    expect(resolveVerifiedSource(database, tuple, {
      kind: "diff",
      observationHash: "b".repeat(64),
      observationId: "observation",
      stagedResultId: "staged",
    })).toEqual({
      display: { preview: "safe public diff" },
      identity: { id: "observation", kind: "execution", version: "b".repeat(64) },
      navigation: { executionId: "execution", sourceId: "observation" },
      snapshotHash: "a45965d72701c6f0cb727eeeb2686fae881fbf74d3cbb6a189b371fcb81afb2a",
      stagedHash: "a".repeat(64),
    });
    expect(resolveVerifiedSource(database, tuple, {
      artifactHash: "c".repeat(64),
      artifactId: "artifact",
      executionId: "execution",
      kind: "file",
    })).toEqual({
      display: { name: "report.txt" },
      identity: { id: "artifact", kind: "artifact", version: "c".repeat(64) },
      navigation: { executionId: "execution", sourceId: "artifact" },
    });
    expect(resolveVerifiedSource(database, tuple, {
      factId: "handoff-fact",
      kind: "handoff",
      turnId: "turn",
    })).toEqual({
      actor: { displayName: "Agent A", id: "a", type: "agent" },
      display: { fromAgentId: "a", summary: "Continue", toAgentId: "b" },
      identity: { id: "handoff-fact", kind: "handoff", version: "handoff-event" },
      navigation: { runId: "run", sourceId: "handoff-fact" },
    });
  });

  it("fails closed for cross tuple, stale hash, latest, and host-path shaped input", async () => {
    const { resolveVerifiedSource } = await resolver();
    const tuple = { projectId: "project", runId: "run", threadId: "other-thread" };
    for (const input of [
      {
        kind: "diff",
        observationHash: "b".repeat(64),
        observationId: "observation",
        stagedResultId: "staged",
      },
      {
        artifactHash: "d".repeat(64),
        artifactId: "artifact",
        executionId: "execution",
        kind: "file",
      },
      { kind: "file", latest: true, path: "D:\\secret\\report.txt" },
    ]) {
      expect(() => resolveVerifiedSource(database, tuple, input)).toThrow();
    }
  });

  it("freezes a bounded public diff snapshot and rejects sensitive source text", () => {
    const tuple = { projectId: "project", runId: "run", threadId: "thread" };
    const proposed = ingestStructuredBlocks(JSON.stringify({
      blocks: [{
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "diff_preview",
        fileReferences: ["src/public.ts"],
        logicalBlockId: "diff",
        observationHash: "b".repeat(64),
        observationId: "observation",
        stagedResultId: "staged",
        title: "Public diff",
      }],
    }));
    const frozen = materializeStructuredBlocks(
      database,
      tuple,
      { displayName: "Agent A", id: "a", type: "agent" },
      proposed,
    );
    expect(frozen.blocks[0]).toMatchObject({
      blockType: "diff_preview",
      preview: "safe public diff",
      previewHash: "a45965d72701c6f0cb727eeeb2686fae881fbf74d3cbb6a189b371fcb81afb2a",
      stagedHash: "a".repeat(64),
    });
    database.prepare(
      "UPDATE execution_staged_observations SET diff_text='changed private source' WHERE id='observation'",
    ).run();
    expect(frozen.blocks[0]).toMatchObject({ preview: "safe public diff" });

    database.prepare(
      "UPDATE execution_staged_observations SET diff_text=? WHERE id='observation'",
    ).run("Authorization: Bearer secret-value");
    expect(() => materializeStructuredBlocks(
      database,
      tuple,
      { displayName: "Agent A", id: "a", type: "agent" },
      proposed,
    )).toThrowError(expect.objectContaining({ code: "CREDENTIAL_CONTENT_REJECTED" }));
  });

  it("binds a Handoff Card to the immutable originating actor snapshot", () => {
    const proposed = ingestStructuredBlocks(JSON.stringify({
      blocks: [{
        blockRevision: 1,
        blockSchemaVersion: 1,
        blockType: "handoff_card",
        factId: "handoff-fact",
        logicalBlockId: "handoff",
        title: "Continue",
        turnId: "turn",
      }],
    }));
    const tuple = { projectId: "project", runId: "run", threadId: "thread" };
    expect(materializeStructuredBlocks(
      database,
      tuple,
      { displayName: "Agent A", id: "a", type: "agent" },
      proposed,
    ).blocks).toHaveLength(1);
    for (const actor of [
      { displayName: "Agent B", id: "b", type: "agent" as const },
      { displayName: "Renamed A", id: "a", type: "agent" as const },
    ]) {
      expect(() => materializeStructuredBlocks(database, tuple, actor, proposed)).toThrow();
    }
    database.prepare(
      "UPDATE collaboration_events SET actor_id='b' WHERE id='handoff-event'",
    ).run();
    expect(() => materializeStructuredBlocks(
      database,
      tuple,
      { displayName: "Agent A", id: "a", type: "agent" },
      proposed,
    )).toThrow();
  });
});
