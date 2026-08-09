import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";

type WorkspaceRoute = {
  PUT(
    request: Request,
    context: { params: Promise<{ projectId: string }> },
  ): Promise<Response>;
};

const routeModules = import.meta.glob<WorkspaceRoute>(
  "../../../app/api/projects/[projectId]/workspace/route.ts",
);

let directory: string;
let databasePath: string;

async function route(): Promise<WorkspaceRoute> {
  const load =
    routeModules["../../../app/api/projects/[projectId]/workspace/route.ts"];
  expect(load, "the workspace route must exist").toBeTypeOf("function");
  return load();
}

function context(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function put(projectId: string, body: BodyInit) {
  return new Request(`http://localhost/api/projects/${projectId}/workspace`, {
    body,
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-workspace-api-"));
  databasePath = join(directory, "cockpit.sqlite");
  process.env.COCKPIT_DB_PATH = databasePath;
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  rmSync(directory, { force: true, recursive: true });
});

describe("workspace API error contract", () => {
  it("returns exact JSON and field errors for malformed, missing and typed input", async () => {
    const workspaceRoute = await route();
    const project = createProject("Workspace API", databasePath);

    const malformed = await workspaceRoute.PUT(
      put(project.id, '{"path":'),
      context(project.id),
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: {
        code: "INVALID_JSON",
        message: "Request body must be valid JSON.",
      },
    });

    const missing = await workspaceRoute.PUT(
      put(project.id, "{}"),
      context(project.id),
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [
          { code: "required", field: "path" },
          { code: "required", field: "expectedVersion" },
          { code: "required", field: "confirmRebind" },
        ],
        message: "Workspace input is invalid.",
      },
    });

    const typed = await workspaceRoute.PUT(
      put(
        project.id,
        JSON.stringify({
          path: 42,
          expectedVersion: "1",
          confirmRebind: "yes",
        }),
      ),
      context(project.id),
    );
    expect(typed.status).toBe(400);
    await expect(typed.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        fields: [
          { code: "invalid_type", field: "path" },
          { code: "invalid_type", field: "expectedVersion" },
          { code: "invalid_type", field: "confirmRebind" },
        ],
        message: "Workspace input is invalid.",
      },
    });
  });

  it.each([0, -1, 1.5])(
    "rejects invalid expectedVersion %s with an exact field error",
    async (expectedVersion) => {
      const workspaceRoute = await route();
      const project = createProject("Workspace version", databasePath);
      const response = await workspaceRoute.PUT(
        put(
          project.id,
          JSON.stringify({
            path: directory,
            expectedVersion,
            confirmRebind: false,
          }),
        ),
        context(project.id),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "INVALID_INPUT",
          fields: [{ code: "invalid_format", field: "expectedVersion" }],
          message: "Workspace input is invalid.",
        },
      });
    },
  );

  it("includes the current project version for a stale workspace write", async () => {
    const workspaceRoute = await route();
    const project = createProject("Workspace stale", databasePath);
    const first = await workspaceRoute.PUT(
      put(
        project.id,
        JSON.stringify({
          path: directory,
          expectedVersion: 1,
          confirmRebind: false,
        }),
      ),
      context(project.id),
    );
    expect(first.status).toBe(200);

    const stale = await workspaceRoute.PUT(
      put(
        project.id,
        JSON.stringify({
          path: directory,
          expectedVersion: 1,
          confirmRebind: false,
        }),
      ),
      context(project.id),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: {
        code: "RESOURCE_CONFLICT",
        currentVersion: 2,
        message: "Project version is stale.",
      },
    });
  });
});
