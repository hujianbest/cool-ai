import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { seedCurrentAdvanceFixture as seedV7AdvanceFixture } from "@/tests/fixtures/collaboration/current-advance";
import {
  commitFileReferenceMessage,
  renameFileReferenceSource,
  seedFileReferenceGraph,
  supersedeFileReferenceSource,
  type FileReferenceGraph,
} from "@/tests/fixtures/structured-messages/file-reference";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type AdapterModule = {
  structuredMessageSourcePost: (request: Request, context: {
    params: Promise<Record<string, string>>;
  }) => Promise<Response>;
};

const modules = import.meta.glob<AdapterModule>(
  "../../../app/api/_shared/structured-messages/structured-message-http.ts",
);
async function adapter(): Promise<AdapterModule> {
  const load = modules["../../../app/api/_shared/structured-messages/structured-message-http.ts"];
  expect(load, "strict tuple Structured Message HTTP adapter must exist").toBeTypeOf("function");
  return load();
}

const NOW = "2026-08-09T07:00:00.000Z";
const MASTER_KEY = Buffer.alloc(32, 10).toString("base64url");
const PROVIDER_API_KEY = "sk-source-api-test-key";
const ARTIFACT_NAME = "safe-report.txt";
const ARTIFACT_CONTENT = "safe";
const ARTIFACT_HOST_PATH = "D:\\private\\never-public.txt";
const RENAMED_ARTIFACT = "renamed-report.txt";
const AGENT = { displayName: "Alpha", id: "agent-source-a", type: "agent" as const };

type BaseSetup = {
  missionId: string;
  path: string;
  projectId: string;
  runId: string;
  threadId: string;
};

type FileReferenceSetup = BaseSetup & {
  artifactHash: string;
  artifactId: string;
  blockId: string;
  executionId: string;
  messageId: string;
};

function seedBase(): BaseSetup {
  const path = memoryDatabasePath();
  const projectId = "project-source";
  const runId = "run-source";
  const missionId = "mission-source";
  const threadId = seedV7AdvanceFixture(path, {
    agentId: AGENT.id,
    agentPrompt: "Plan",
    missionId,
    now: NOW,
    ownerMessage: null,
    projectId,
    projectName: "Source",
    providerId: "provider-source",
    runId,
    secondAgentId: "agent-source-b",
    secondAgentPrompt: "Review",
    threadCreateOperationId: "00000000-0000-4000-8000-000000001701",
  });
  const encrypted = createCredentialVault().encrypt("provider-source", PROVIDER_API_KEY);
  const database = openDatabase(path);
  try {
    database.prepare(
      `UPDATE providers
       SET api_key_cipher=?,api_key_iv=?,api_key_tag=?,credential_version=?,
           key_id=?,api_key_mask=?
       WHERE id=?`,
    ).run(
      encrypted.apiKeyCipher,
      encrypted.apiKeyIv,
      encrypted.apiKeyTag,
      encrypted.credentialVersion,
      encrypted.keyId,
      encrypted.apiKeyMask,
      "provider-source",
    );
  } finally {
    database.close();
  }
  return { missionId, path, projectId, runId, threadId };
}

function seedGraph(base: BaseSetup, artifactName: string): FileReferenceGraph {
  return seedFileReferenceGraph(base.path, {
    agentId: AGENT.id,
    artifactContent: ARTIFACT_CONTENT,
    artifactName,
    artifactPath: ARTIFACT_HOST_PATH,
    missionId: base.missionId,
    now: NOW,
    projectId: base.projectId,
    runId: base.runId,
    threadId: base.threadId,
  });
}

function commit(base: BaseSetup, graph: FileReferenceGraph): { blockId: string; messageId: string } {
  return commitFileReferenceMessage(base.path, {
    actor: AGENT,
    graph,
    now: NOW,
    projectId: base.projectId,
    runId: base.runId,
    threadId: base.threadId,
  });
}

function fixture(artifactName = ARTIFACT_NAME): FileReferenceSetup {
  const base = seedBase();
  const graph = seedGraph(base, artifactName);
  const committed = commit(base, graph);
  return {
    ...base,
    artifactHash: graph.artifactHash,
    artifactId: graph.artifactId,
    blockId: committed.blockId,
    executionId: graph.executionId,
    messageId: committed.messageId,
  };
}

function sourceRead(
  api: AdapterModule,
  setup: FileReferenceSetup,
): Promise<Response> {
  return api.structuredMessageSourcePost(
    new Request("http://local/source", {
      body: JSON.stringify({
        source: { id: setup.artifactId, kind: "artifact", version: setup.artifactHash },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    {
      params: Promise.resolve({
        blockId: setup.blockId,
        messageId: setup.messageId,
        projectId: setup.projectId,
        runId: setup.runId,
        threadId: setup.threadId,
      }),
    },
  );
}

function expectNoLeak(bodies: string[]): void {
  for (const body of bodies) {
    expect(body).not.toContain("D:\\");
    expect(body).not.toContain("never-public");
    expect(body).not.toContain(PROVIDER_API_KEY);
    expect(body).not.toContain(RENAMED_ARTIFACT);
  }
}

beforeEach(() => {
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
});

describe("Structured Message Source Public Read frozen File Reference projection", () => {
  it("returns only the frozen redacted name and exact source version after rename, latest version, and process reopen", async () => {
    const api = await adapter();
    const setup = fixture();
    process.env.COCKPIT_DB_PATH = setup.path;
    const bodies: string[] = [];
    const frozen = {
      display: { name: ARTIFACT_NAME },
      navigation: { executionId: setup.executionId, sourceId: setup.artifactId },
      source: { id: setup.artifactId, kind: "artifact", version: setup.artifactHash },
    };

    const initial = await sourceRead(api, setup);
    const initialBody = await initial.text();
    bodies.push(initialBody);
    expect(initial.status).toBe(200);
    expect(JSON.parse(initialBody)).toEqual(frozen);

    renameFileReferenceSource(setup.path, setup.artifactId, RENAMED_ARTIFACT);
    const afterRename = await sourceRead(api, setup);
    const afterRenameBody = await afterRename.text();
    bodies.push(afterRenameBody);
    expect(afterRename.status).toBe(200);
    expect(JSON.parse(afterRenameBody)).toEqual(frozen);

    supersedeFileReferenceSource(setup.path, setup.artifactId, "next-bytes");
    const afterLatest = await sourceRead(api, setup);
    const afterLatestBody = await afterLatest.text();
    bodies.push(afterLatestBody);
    expect(afterLatest.status).toBe(200);
    expect(JSON.parse(afterLatestBody)).toEqual(frozen);

    const reopened = openDatabase(setup.path);
    try {
      expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
    } finally {
      reopened.close();
    }
    const afterReopen = await sourceRead(api, setup);
    const afterReopenBody = await afterReopen.text();
    bodies.push(afterReopenBody);
    expect(afterReopen.status).toBe(200);
    expect(JSON.parse(afterReopenBody)).toEqual(frozen);

    expectNoLeak(bodies);
  });
});

describe("File Reference commit freeze validation", () => {
  it("freezes a name at the grapheme boundary and reads it back unchanged", async () => {
    const api = await adapter();
    const boundaryName = `boundary-${"a".repeat(147)}.txt`;
    expect(Array.from(new Intl.Segmenter("zh-CN", { granularity: "grapheme" })
      .segment(boundaryName)).length).toBe(160);
    const setup = fixture(boundaryName);
    process.env.COCKPIT_DB_PATH = setup.path;

    const response = await sourceRead(api, setup);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      display: { name: boundaryName },
      navigation: { executionId: setup.executionId, sourceId: setup.artifactId },
      source: { id: setup.artifactId, kind: "artifact", version: setup.artifactHash },
    });
    expect(body).not.toContain("D:\\");
  });

  it("rejects a source name one grapheme beyond the boundary without echoing it", () => {
    const base = seedBase();
    const overflowName = `boundary-${"a".repeat(148)}.txt`;
    expect(Array.from(new Intl.Segmenter("zh-CN", { granularity: "grapheme" })
      .segment(overflowName)).length).toBe(161);
    const graph = seedGraph(base, overflowName);

    let thrown: unknown;
    try {
      commit(base, graph);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "INVALID_SCHEMA" });
    expect(String(thrown)).not.toContain(overflowName);
    const reopened = openDatabase(base.path);
    reopened.close();
  });

  it.each([
    ["host-path shaped", "D:\\secret\\report.txt"],
    ["credential-field shaped", "api_key=sk-live-9f8e7d6c5b"],
  ])("rejects a %s source name at commit with a stable redacted error", (_label, name) => {
    const base = seedBase();
    const graph = seedGraph(base, name);

    let thrown: unknown;
    try {
      commit(base, graph);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "CREDENTIAL_CONTENT_REJECTED" });
    expect(String(thrown)).not.toContain(name);
    const reopened = openDatabase(base.path);
    reopened.close();
  });
});
