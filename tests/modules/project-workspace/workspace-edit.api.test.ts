import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { bindWorkspace } from "@/src/adapters/outbound/sqlite/project-workspace/workspace-service";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

vi.mock("server-only", () => ({}));

type CreateRoute = {
  POST(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

type SessionRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string; editId: string }> },
  ): Promise<Response>;
};

const createRouteModules = import.meta.glob<CreateRoute>(
  "../../../app/api/projects/[projectId]/workspace/edits/route.ts",
);
const sessionRouteModules = import.meta.glob<SessionRoute>(
  "../../../app/api/projects/[projectId]/workspace/edits/[editId]/route.ts",
);

async function createRoute(): Promise<CreateRoute> {
  const load = createRouteModules[
    "../../../app/api/projects/[projectId]/workspace/edits/route.ts"
  ];
  expect(load, "the workspace edits route must exist").toBeTypeOf("function");
  return load();
}

async function sessionRoute(): Promise<SessionRoute> {
  const load = sessionRouteModules[
    "../../../app/api/projects/[projectId]/workspace/edits/[editId]/route.ts"
  ];
  expect(load, "the workspace edit session route must exist").toBeTypeOf("function");
  return load();
}

let directory: string;
let workspaceRoot: string;
let editRoot: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-workspace-edit-api-"));
  workspaceRoot = join(directory, "workspace");
  editRoot = join(directory, "edits");
  mkdirSync(workspaceRoot);
  mkdirSync(editRoot);
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
  process.env.COCKPIT_WORKSPACE_EDIT_ROOT = editRoot;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  delete process.env.COCKPIT_WORKSPACE_EDIT_ROOT;
  rmSync(directory, { force: true, recursive: true });
});

async function boundProject(): Promise<string> {
  const project = createProject("Edit API", databasePath);
  await bindWorkspace(databasePath, project.id, {
    confirmRebind: false,
    expectedVersion: 1,
    path: workspaceRoot,
  });
  return project.id;
}

describe("workspace edits route", () => {
  it("creates an editing session for a bound text file", async () => {
    writeFileSync(join(workspaceRoot, "notes.txt"), "hello owner");
    const edits = await createRoute();
    const projectId = await boundProject();

    const created = await edits.POST(
      new Request(`http://localhost/api/projects/${projectId}/workspace/edits`, {
        body: JSON.stringify({ operationId: "op-api-notes", path: "notes.txt" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ projectId }) },
    );

    expect(created.status).toBe(201);
    const session = await created.json() as {
      expectedHash: string;
      path: string;
      sessionId: string;
      status: string;
      version: number;
    };
    expect(session).toEqual({
      expectedHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      path: "notes.txt",
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/iu),
      stagedHash: null,
      status: "editing",
      version: 1,
    });
    expect(JSON.stringify(session)).not.toMatch(/[A-Za-z]:[\\/]/u);

    const sessions = await sessionRoute();
    const loaded = await sessions.GET(
      new Request(
        `http://localhost/api/projects/${projectId}/workspace/edits/${session.sessionId}`,
      ),
      { params: Promise.resolve({ projectId, editId: session.sessionId }) },
    );
    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toEqual(session);
  });

  it("rejects unknown keys and missing fields", async () => {
    const edits = await createRoute();
    const projectId = await boundProject();
    const response = await edits.POST(
      new Request(`http://localhost/api/projects/${projectId}/workspace/edits`, {
        body: JSON.stringify({ extra: true }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [
          { code: "unknown", field: "extra" },
          { code: "required", field: "path" },
          { code: "required", field: "operationId" },
        ],
        message: "Workspace edit input is invalid.",
      },
    });
  });
});
