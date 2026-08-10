import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { bindWorkspace } from "@/src/adapters/outbound/sqlite/project-workspace/workspace-service";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

vi.mock("server-only", () => ({}));

type BrowseRoute = {
  GET(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<BrowseRoute>(
  "../../../app/api/projects/[projectId]/workspace/*/route.ts",
);

async function route(name: "file" | "files"): Promise<BrowseRoute> {
  const load =
    routeModules[`../../../app/api/projects/[projectId]/workspace/${name}/route.ts`];
  expect(load, `the workspace ${name} route must exist`).toBeTypeOf("function");
  return load();
}

function context(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

let directory: string;
let workspaceRoot: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-workspace-browse-api-"));
  workspaceRoot = join(directory, "workspace");
  mkdirSync(workspaceRoot);
  databasePath = memoryDatabasePath();
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

async function boundProject(): Promise<string> {
  const project = createProject("Browse API", databasePath);
  await bindWorkspace(databasePath, project.id, {
    confirmRebind: false,
    expectedVersion: 1,
    path: workspaceRoot,
  });
  return project.id;
}

describe("workspace browse files route", () => {
  it("requires exactly one path query parameter and rejects unknown keys", async () => {
    const files = await route("files");
    const projectId = await boundProject();

    const missing = await files.GET(
      new Request(`http://localhost/api/projects/${projectId}/workspace/files`),
      context(projectId),
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [{ code: "required", field: "path" }],
        message: "Workspace browse input is invalid.",
      },
    });

    const unknown = await files.GET(
      new Request(
        `http://localhost/api/projects/${projectId}/workspace/files?path=.&extra=1`,
      ),
      context(projectId),
    );
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [{ code: "unknown", field: "extra" }],
        message: "Workspace browse input is invalid.",
      },
    });

    const duplicated = await files.GET(
      new Request(
        `http://localhost/api/projects/${projectId}/workspace/files?path=.&path=sub`,
      ),
      context(projectId),
    );
    expect(duplicated.status).toBe(400);
    await expect(duplicated.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [{ code: "invalid_format", field: "path" }],
        message: "Workspace browse input is invalid.",
      },
    });
  });

  it("rejects over-long and out-of-root path values as field errors", async () => {
    const files = await route("files");
    const projectId = await boundProject();

    const escaping = await files.GET(
      new Request(`http://localhost/api/projects/${projectId}/workspace/files?path=..`),
      context(projectId),
    );
    expect(escaping.status).toBe(400);
    await expect(escaping.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [{ code: "invalid_format", field: "path" }],
        message: "Workspace path is invalid.",
      },
    });

    const tooLong = await files.GET(
      new Request(
        `http://localhost/api/projects/${projectId}/workspace/files?path=${"a".repeat(4097)}`,
      ),
      context(projectId),
    );
    expect(tooLong.status).toBe(400);
    await expect(tooLong.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [{ code: "invalid_format", field: "path" }],
        message: "Workspace browse input is invalid.",
      },
    });
  });

  it("returns tuple-scoped 404s and a no-store listing for a bound project", async () => {
    const files = await route("files");
    writeFileSync(join(workspaceRoot, "note.txt"), "hello");
    const projectId = await boundProject();

    const unknownProject = await files.GET(
      new Request(
        "http://localhost/api/projects/00000000-0000-0000-0000-000000000000/workspace/files?path=.",
      ),
      context("00000000-0000-0000-0000-000000000000"),
    );
    expect(unknownProject.status).toBe(404);
    await expect(unknownProject.json()).resolves.toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project was not found." },
    });

    const unbound = createProject("Unbound", databasePath);
    const notBound = await files.GET(
      new Request(`http://localhost/api/projects/${unbound.id}/workspace/files?path=.`),
      context(unbound.id),
    );
    expect(notBound.status).toBe(404);
    await expect(notBound.json()).resolves.toEqual({
      error: {
        code: "WORKSPACE_NOT_BOUND",
        message: "Project has no ready workspace binding.",
      },
    });

    const listing = await files.GET(
      new Request(`http://localhost/api/projects/${projectId}/workspace/files?path=.`),
      context(projectId),
    );
    expect(listing.status).toBe(200);
    expect(listing.headers.get("cache-control")).toBe("no-store");
    await expect(listing.json()).resolves.toEqual({
      entries: [{ kind: "file", name: "note.txt", sensitive: false, sizeBytes: 5 }],
      path: ".",
    });
  });
});

describe("workspace browse file route", () => {
  it("previews a text file with a no-store JSON envelope", async () => {
    const file = await route("file");
    writeFileSync(join(workspaceRoot, "hello.txt"), "hello\nworld\n");
    const projectId = await boundProject();

    const response = await file.GET(
      new Request(
        `http://localhost/api/projects/${projectId}/workspace/file?path=hello.txt`,
      ),
      context(projectId),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      content: "hello\nworld\n",
      kind: "text",
      lineCount: 2,
      sizeBytes: 12,
      truncated: false,
    });
  });

  it("masks sensitive files without echoing content or host paths", async () => {
    const file = await route("file");
    writeFileSync(join(workspaceRoot, ".env"), "TOKEN=super-secret-value");
    const projectId = await boundProject();

    const response = await file.GET(
      new Request(`http://localhost/api/projects/${projectId}/workspace/file?path=.env`),
      context(projectId),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({ kind: "sensitive-masked" });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain(workspaceRoot);
  });

  it("returns sanitized 404 and 400 envelopes for missing files and directories", async () => {
    const file = await route("file");
    mkdirSync(join(workspaceRoot, "sub"));
    const projectId = await boundProject();

    const missing = await file.GET(
      new Request(
        `http://localhost/api/projects/${projectId}/workspace/file?path=missing.txt`,
      ),
      context(projectId),
    );
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as unknown;
    expect(missingBody).toEqual({
      error: {
        code: "WORKSPACE_ENTRY_NOT_FOUND",
        message: "Workspace entry was not found.",
      },
    });
    expect(JSON.stringify(missingBody)).not.toContain(workspaceRoot);

    const directory = await file.GET(
      new Request(`http://localhost/api/projects/${projectId}/workspace/file?path=sub`),
      context(projectId),
    );
    expect(directory.status).toBe(400);
    await expect(directory.json()).resolves.toEqual({
      error: {
        code: "WORKSPACE_NOT_PREVIEWABLE",
        message: "Directories cannot be previewed.",
      },
    });
  });

  it("requires the path query parameter", async () => {
    const file = await route("file");
    const projectId = await boundProject();

    const response = await file.GET(
      new Request(`http://localhost/api/projects/${projectId}/workspace/file`),
      context(projectId),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [{ code: "required", field: "path" }],
        message: "Workspace browse input is invalid.",
      },
    });
  });
});
