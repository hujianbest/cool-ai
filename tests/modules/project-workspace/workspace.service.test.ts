import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import * as workspaceService from "@/src/adapters/outbound/sqlite/project-workspace/workspace-service";

type WorkspaceErrorCode =
  | "WORKSPACE_INVALID"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_DIRECTORY"
  | "WORKSPACE_NOT_READABLE"
  | "WORKSPACE_ALREADY_BOUND"
  | "REBIND_CONFIRMATION_REQUIRED"
  | "RESOURCE_CONFLICT";

type WorkspaceFs = {
  realpath(path: string): Promise<string>;
  statDirectory(path: string): Promise<boolean>;
  checkReadable(path: string): Promise<void>;
};

type WorkspaceOperation = "realpath" | "stat" | "access";

const bindWorkspace = workspaceService.bindWorkspace as unknown as (
  databasePath: string,
  projectId: string,
  input: {
    path: string;
    expectedVersion: number;
    confirmRebind: boolean;
  },
  workspaceFs?: WorkspaceFs,
) => ReturnType<typeof workspaceService.bindWorkspace>;
const { getWorkspace } = workspaceService;
const createNodeWorkspaceFs = (
  workspaceService as unknown as {
    createNodeWorkspaceFs?: (
      record: (operation: WorkspaceOperation) => void,
    ) => WorkspaceFs;
  }
).createNodeWorkspaceFs;

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-workspace-service-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function expectWorkspaceError(
  operation: Promise<unknown>,
  code: WorkspaceErrorCode,
  secretPath?: string,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
  if (secretPath) {
    await expect(operation).rejects.toEqual(
      expect.objectContaining({ message: expect.not.stringContaining(secretPath) }),
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("workspace service security boundary", () => {
  it("returns typed, path-sanitized errors for relative, missing, file, and unreadable inputs", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "cockpit.sqlite");
    const project = createProject("Workspace errors", databasePath);
    const missingPath = join(root, "private-missing-directory");
    const filePath = join(root, "private-file.txt");
    writeFileSync(filePath, "not workspace content");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expectWorkspaceError(
      bindWorkspace(databasePath, project.id, {
        confirmRebind: false,
        expectedVersion: 1,
        path: "relative/workspace",
      }),
      "WORKSPACE_INVALID",
    );
    await expectWorkspaceError(
      bindWorkspace(databasePath, project.id, {
        confirmRebind: false,
        expectedVersion: 1,
        path: missingPath,
      }),
      "WORKSPACE_NOT_FOUND",
      missingPath,
    );
    await expectWorkspaceError(
      bindWorkspace(databasePath, project.id, {
        confirmRebind: false,
        expectedVersion: 1,
        path: filePath,
      }),
      "WORKSPACE_NOT_DIRECTORY",
      filePath,
    );

    const unreadableFs: WorkspaceFs = {
      async checkReadable() {
        throw Object.assign(new Error("permission denied at private path"), { code: "EACCES" });
      },
      async realpath(path) {
        return path;
      },
      async statDirectory() {
        return true;
      },
    };
    await expectWorkspaceError(
      bindWorkspace(
        databasePath,
        project.id,
        {
          confirmRebind: false,
          expectedVersion: 1,
          path: root,
        },
        unreadableFs,
      ),
      "WORKSPACE_NOT_READABLE",
      root,
    );

    expect(consoleError).not.toHaveBeenCalled();
    expect(getWorkspace(databasePath, project.id)).toEqual({
      projectVersion: 1,
      workspace: null,
    });
  });

  it("audits only realpath, stat, and access while binding a real directory", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "cockpit.sqlite");
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath);
    const project = createProject("Audited workspace", databasePath);
    const operations: string[] = [];
    expect(createNodeWorkspaceFs).toBeTypeOf("function");
    const workspaceFs = createNodeWorkspaceFs!((operation) => operations.push(operation));

    const state = await bindWorkspace(
      databasePath,
      project.id,
      {
        confirmRebind: false,
        expectedVersion: 1,
        path: workspacePath,
      },
      workspaceFs,
    );

    expect(state).toMatchObject({
      projectVersion: 2,
      workspace: { status: "ready" },
    });
    expect(operations).toEqual(["realpath", "stat", "access"]);
    expect(new Set(operations)).toEqual(new Set(["realpath", "stat", "access"]));
  });

  it("rejects alias and Windows case variants already bound to another project", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "cockpit.sqlite");
    const workspacePath = join(root, "UniqueWorkspace");
    mkdirSync(workspacePath);
    const first = createProject("First", databasePath);
    const alias = createProject("Alias", databasePath);
    const caseVariant = createProject("Case", databasePath);

    const firstState = await bindWorkspace(databasePath, first.id, {
      confirmRebind: false,
      expectedVersion: 1,
      path: workspacePath,
    });
    const canonicalPath = firstState.workspace!.path;
    const aliasPath = join(workspacePath, "..", basename(workspacePath));

    await expectWorkspaceError(
      bindWorkspace(databasePath, alias.id, {
        confirmRebind: false,
        expectedVersion: 1,
        path: aliasPath,
      }),
      "WORKSPACE_ALREADY_BOUND",
      aliasPath,
    );

    const caseFs: WorkspaceFs = {
      async checkReadable() {},
      async realpath() {
        return canonicalPath.toUpperCase();
      },
      async statDirectory() {
        return true;
      },
    };
    await expectWorkspaceError(
      bindWorkspace(
        databasePath,
        caseVariant.id,
        {
          confirmRebind: false,
          expectedVersion: 1,
          path: workspacePath,
        },
        caseFs,
      ),
      "WORKSPACE_ALREADY_BOUND",
      workspacePath,
    );
    expect(getWorkspace(databasePath, alias.id).workspace).toBeNull();
    expect(getWorkspace(databasePath, caseVariant.id).workspace).toBeNull();
  });

  it("requires explicit rebind confirmation and the current expectedVersion", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "cockpit.sqlite");
    const firstPath = join(root, "first");
    const secondPath = join(root, "second");
    mkdirSync(firstPath);
    mkdirSync(secondPath);
    const project = createProject("Rebind", databasePath);

    const initial = await bindWorkspace(databasePath, project.id, {
      confirmRebind: false,
      expectedVersion: 1,
      path: firstPath,
    });

    await expectWorkspaceError(
      bindWorkspace(databasePath, project.id, {
        confirmRebind: false,
        expectedVersion: initial.projectVersion,
        path: secondPath,
      }),
      "REBIND_CONFIRMATION_REQUIRED",
      secondPath,
    );
    await expectWorkspaceError(
      bindWorkspace(databasePath, project.id, {
        confirmRebind: true,
        expectedVersion: 1,
        path: secondPath,
      }),
      "RESOURCE_CONFLICT",
      secondPath,
    );
    expect(getWorkspace(databasePath, project.id)).toEqual(initial);

    const rebound = await bindWorkspace(databasePath, project.id, {
      confirmRebind: true,
      expectedVersion: initial.projectVersion,
      path: secondPath,
    });
    expect(rebound.projectVersion).toBe(3);
    expect(rebound.workspace?.path).not.toBe(initial.workspace?.path);
    expect(getWorkspace(databasePath, project.id)).toEqual(rebound);
  });
});
