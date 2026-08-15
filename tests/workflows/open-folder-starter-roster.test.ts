import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCredentialVault } from "@/src/modules/identity-capability/internal/credential-vault";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

type ProjectsRoute = {
  POST(request: Request): Promise<Response>;
};

type MembersRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const projectRoutes = import.meta.glob<ProjectsRoute>(
  "../../app/api/projects/route.ts",
);
const memberRoutes = import.meta.glob<MembersRoute>(
  "../../app/api/projects/[projectId]/members/route.ts",
);

const MASTER_KEY = Buffer.alloc(32, 23).toString("base64url");
const temporaryDirectories: string[] = [];
let databasePath: string;

async function loadProjects(): Promise<ProjectsRoute> {
  const load = projectRoutes["../../app/api/projects/route.ts"];
  expect(load, "the projects route must exist").toBeTypeOf("function");
  return load();
}

async function loadMembers(): Promise<MembersRoute> {
  const load = memberRoutes["../../app/api/projects/[projectId]/members/route.ts"];
  expect(load, "the members route must exist").toBeTypeOf("function");
  return load();
}

function insertProvider(): void {
  const database = openDatabase(databasePath);
  const vault = createCredentialVault();
  const envelope = vault.encrypt("provider-1", "test-provider-key");
  const timestamp = "2026-07-29T00:00:00.000Z";
  database
    .prepare(`
      INSERT INTO providers (
        id, name, base_url, default_model,
        api_key_cipher, api_key_iv, api_key_tag, credential_version,
        credential_generation, key_id, api_key_mask, verified_at,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "provider-1",
      "Local provider",
      "https://provider.example/v1",
      "model-a",
      envelope.apiKeyCipher,
      envelope.apiKeyIv,
      envelope.apiKeyTag,
      envelope.credentialVersion,
      1,
      envelope.keyId,
      envelope.apiKeyMask,
      timestamp,
      1,
      timestamp,
      timestamp,
    );
  database.close();
}

function temporaryWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "cool-ai-open-folder-roster-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function openProject(path: string): Promise<{ id: string; status: number }> {
  const projects = await loadProjects();
  const response = await projects.POST(
    new Request("http://localhost/api/projects", {
      body: JSON.stringify({ path }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  const payload = (await response.json()) as { project?: { id: string } };
  expect(payload.project, "opened project must be returned").toEqual(
    expect.objectContaining({ id: expect.any(String) }),
  );
  return { id: payload.project!.id, status: response.status };
}

async function memberIds(projectId: string): Promise<string[]> {
  const members = await loadMembers();
  const response = await members.GET(
    new Request(`http://localhost/api/projects/${projectId}/members`),
    { params: Promise.resolve({ projectId }) },
  );
  const payload = (await response.json()) as {
    members: Array<{ agentId: string }>;
  };
  return payload.members.map(({ agentId }) => agentId).sort();
}

beforeEach(() => {
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_MASTER_KEY = MASTER_KEY;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_MASTER_KEY;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("open folder starter roster", () => {
  it("adds the three starter agents when a verified provider exists", async () => {
    insertProvider();
    const opened = await openProject(temporaryWorkspace());

    expect(opened.status).toBe(201);
    expect(await memberIds(opened.id)).toEqual([
      "starter-builder",
      "starter-planner",
      "starter-reviewer",
    ]);
  });

  it("does not duplicate members when the same folder is resumed", async () => {
    insertProvider();
    const workspacePath = temporaryWorkspace();
    const created = await openProject(workspacePath);
    const resumed = await openProject(workspacePath);

    expect(resumed.status).toBe(200);
    expect(resumed.id).toBe(created.id);
    expect(await memberIds(resumed.id)).toEqual([
      "starter-builder",
      "starter-planner",
      "starter-reviewer",
    ]);
  });

  it("still opens a folder project with an empty roster when no provider exists", async () => {
    const opened = await openProject(temporaryWorkspace());

    expect(opened.status).toBe(201);
    expect(await memberIds(opened.id)).toEqual([]);
  });
});
