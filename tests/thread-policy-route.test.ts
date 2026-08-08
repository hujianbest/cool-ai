import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThread } from "@/src/server/collaboration/thread-service";
import { openDatabase } from "@/src/server/db";

type PolicyRoute = {
  PATCH(
    request: Request,
    context: { params: Promise<{ projectId: string; threadId: string }> },
  ): Promise<Response>;
};

const routes = import.meta.glob<PolicyRoute>(
  "../app/api/projects/[projectId]/threads/[threadId]/policy/route.ts",
);
const NOW = "2026-08-08T08:00:00.000Z";
let directory: string;
let databasePath: string;
let threadId: string;

function seed(): void {
  const database = openDatabase(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO projects(id,name,created_at,workspace_path,workspace_key,version)
         VALUES ('project-a','Project',?,NULL,NULL,1)`,
      )
      .run(NOW);
    database
      .prepare(
        `INSERT INTO providers(
           id,name,base_url,default_model,api_key_cipher,api_key_iv,api_key_tag,
           credential_version,credential_generation,key_id,api_key_mask,verified_at,
           version,created_at,updated_at
         ) VALUES ('provider-a','Provider','http://localhost/v1','model',
           'cipher','iv','tag',1,1,'key','***',?,1,?,?)`,
      )
      .run(NOW, NOW, NOW);
    const insertAgent = database.prepare(
      `INSERT INTO agents(
         id,name,role,system_prompt,provider_id,model,avatar_text,accent_token,
         can_read,can_write,can_execute,max_tokens,max_handoffs,version,created_at,
         updated_at,review_capable
       ) VALUES (?,?,'Peer','Prompt','provider-a','model','A','sage',
         1,1,0,1000,3,1,?,?,0)`,
    );
    const insertMember = database.prepare(
      "INSERT INTO project_memberships(project_id,agent_id,joined_at) VALUES ('project-a',?,?)",
    );
    ["agent-a", "agent-b", "agent-c"].forEach((agentId, index) => {
      insertAgent.run(agentId, agentId, NOW, NOW);
      insertMember.run(agentId, `2026-08-08T08:00:0${index}.000Z`);
    });
  } finally {
    database.close();
  }
  threadId = createThread(databasePath, "project-a", {
    memberAgentIds: ["agent-a", "agent-b"],
    operationId: "00000000-0000-4000-8000-000000000701",
    title: "Policy route",
  }).body.thread.id;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  directory = mkdtempSync(join(tmpdir(), "thread-policy-route-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
  seed();
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  vi.useRealTimers();
  rmSync(directory, { force: true, recursive: true });
});

describe("strict tuple policy PATCH route", () => {
  it("updates only the addressed tuple with the approved strict body", async () => {
    const route = await Object.values(routes)[0]!();
    const response = await route.PATCH(
      new Request(
        `http://localhost/api/projects/project-a/threads/${threadId}/policy`,
        {
          body: JSON.stringify({
            expectedVersion: 1,
            memberAgentIds: ["agent-c", "agent-a"],
            operationId: "00000000-0000-4000-8000-000000000801",
          }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      ),
      { params: Promise.resolve({ projectId: "project-a", threadId }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      fact: {
        projectId: "project-a",
        threadId,
        type: "policy_changed",
      },
      policy: {
        version: 2,
        members: [
          { agentId: "agent-c", position: 0 },
          { agentId: "agent-a", position: 1 },
        ],
      },
      thread: { id: threadId, projectId: "project-a", version: 2 },
    });
  });

  it("fails closed for cross tuple and unknown URL input", async () => {
    const route = await Object.values(routes)[0]!();
    const crossTuple = await route.PATCH(
      new Request(
        `http://localhost/api/projects/other/threads/${threadId}/policy`,
        {
          body: JSON.stringify({
            expectedVersion: 1,
            memberAgentIds: ["agent-a", "agent-b"],
            operationId: "00000000-0000-4000-8000-000000000802",
          }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      ),
      { params: Promise.resolve({ projectId: "other", threadId }) },
    );
    expect(crossTuple.status).toBe(404);
    expect(await crossTuple.json()).toEqual({
      error: { code: "RESOURCE_NOT_FOUND", message: "Thread was not found." },
    });

    const unknownQuery = await route.PATCH(
      new Request(
        `http://localhost/api/projects/project-a/threads/${threadId}/policy?extra=1`,
        {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      ),
      { params: Promise.resolve({ projectId: "project-a", threadId }) },
    );
    expect(unknownQuery.status).toBe(400);
    expect(await unknownQuery.json()).toMatchObject({
      error: { code: "INVALID_INPUT", fields: { extra: "unknown" } },
    });
  });
});
