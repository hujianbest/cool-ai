import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { bindWorkspace } from "@/src/adapters/outbound/sqlite/project-workspace/workspace-service";
import * as workspaceEditService from "@/src/adapters/outbound/sqlite/project-workspace/workspace-edit-service";
import { createWindowsVerifiedExecutionAdapters } from "@/src/adapters/outbound/workspace/windows-verified-execution-adapter";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

vi.mock("server-only", () => ({}));

const fileAdapter = createWindowsVerifiedExecutionAdapters().fileAdapter;

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-workspace-edit-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

async function boundProject(root: string): Promise<{
  databasePath: string;
  editRoot: string;
  projectId: string;
}> {
  const databasePath = memoryDatabasePath();
  const project = createProject("Edit", databasePath);
  await bindWorkspace(databasePath, project.id, {
    confirmRebind: false,
    expectedVersion: 1,
    path: root,
  });
  return {
    databasePath,
    editRoot: join(temporaryRoot(), "edits"),
    projectId: project.id,
  };
}

describe("createWorkspaceEdit", () => {
  it("copies a bound text file into an isolated sandbox and returns an editing session", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "notes.txt"), "hello owner");
    const { databasePath, editRoot, projectId } = await boundProject(root);

    const session = await workspaceEditService.createWorkspaceEdit(
      databasePath,
      projectId,
      { operationId: "op-create-notes", relativePath: "notes.txt" },
      { editRoot, fs: fileAdapter },
    );

    expect(session).toEqual({
      expectedHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      path: "notes.txt",
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/iu),
      stagedHash: null,
      status: "editing",
      version: 1,
    });
    expect(JSON.stringify(session)).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(JSON.stringify(session)).not.toMatch(/editRoot|workspace-edit/u);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("hello owner");
  });

  it("replays the same operationId without creating a second session", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "notes.txt"), "hello owner");
    const { databasePath, editRoot, projectId } = await boundProject(root);
    const input = { operationId: "op-replay-notes", relativePath: "notes.txt" } as const;
    const runtime = { editRoot, fs: fileAdapter };

    const first = await workspaceEditService.createWorkspaceEdit(
      databasePath,
      projectId,
      input,
      runtime,
    );
    const second = await workspaceEditService.createWorkspaceEdit(
      databasePath,
      projectId,
      input,
      runtime,
    );

    expect(second).toEqual(first);
  });

  it("rejects a second active session for the same project", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "b.txt"), "b");
    const { databasePath, editRoot, projectId } = await boundProject(root);
    const runtime = { editRoot, fs: fileAdapter };

    await workspaceEditService.createWorkspaceEdit(
      databasePath,
      projectId,
      { operationId: "op-a", relativePath: "a.txt" },
      runtime,
    );

    await expect(
      workspaceEditService.createWorkspaceEdit(
        databasePath,
        projectId,
        { operationId: "op-b", relativePath: "b.txt" },
        runtime,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_CONFLICT" });
  });

  it("rejects sensitive, binary, missing, and escaping paths without writing the workspace", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "notes.txt"), "ok");
    writeFileSync(join(root, ".env"), "SECRET=1");
    writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]));
    const { databasePath, editRoot, projectId } = await boundProject(root);
    const runtime = { editRoot, fs: fileAdapter };

    await expect(
      workspaceEditService.createWorkspaceEdit(
        databasePath,
        projectId,
        { operationId: "op-env", relativePath: ".env" },
        runtime,
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });

    await expect(
      workspaceEditService.createWorkspaceEdit(
        databasePath,
        projectId,
        { operationId: "op-bin", relativePath: "blob.bin" },
        runtime,
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_EDITABLE" });

    await expect(
      workspaceEditService.createWorkspaceEdit(
        databasePath,
        projectId,
        { operationId: "op-missing", relativePath: "missing.txt" },
        runtime,
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_ENTRY_NOT_FOUND" });

    await expect(
      workspaceEditService.createWorkspaceEdit(
        databasePath,
        projectId,
        { operationId: "op-escape", relativePath: "../notes.txt" },
        runtime,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("ok");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("SECRET=1");
  });
});

describe("getWorkspaceEdit", () => {
  it("returns the created session by id and 404s unknown ids", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "notes.txt"), "hello owner");
    const { databasePath, editRoot, projectId } = await boundProject(root);
    const created = await workspaceEditService.createWorkspaceEdit(
      databasePath,
      projectId,
      { operationId: "op-get-notes", relativePath: "notes.txt" },
      { editRoot, fs: fileAdapter },
    );

    expect(
      workspaceEditService.getWorkspaceEdit(databasePath, projectId, created.sessionId),
    ).toEqual(created);

    expect(() =>
      workspaceEditService.getWorkspaceEdit(
        databasePath,
        projectId,
        "00000000-0000-4000-8000-000000000000",
      ),
    ).toThrow(expect.objectContaining({ code: "WORKSPACE_EDIT_NOT_FOUND" }));
  });
});

describe("putWorkspaceEditDraft", () => {
  it("writes only the sandbox copy and leaves the canonical file unchanged", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "notes.txt"), "hello owner");
    const { databasePath, editRoot, projectId } = await boundProject(root);
    const runtime = { editRoot, fs: fileAdapter };
    const created = await workspaceEditService.createWorkspaceEdit(
      databasePath,
      projectId,
      { operationId: "op-put-notes", relativePath: "notes.txt" },
      runtime,
    );

    const updated = await workspaceEditService.putWorkspaceEditDraft(
      databasePath,
      projectId,
      created.sessionId,
      {
        content: "hello edited",
        expectedHash: created.expectedHash,
        expectedVersion: created.version,
        operationId: "op-put-body",
      },
      runtime,
    );

    expect(updated).toEqual({
      expectedHash: created.expectedHash,
      path: "notes.txt",
      sessionId: created.sessionId,
      stagedHash: null,
      status: "editing",
      version: 2,
    });
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("hello owner");
  });

  it("rejects stale hash, version conflicts, and NUL content without changing canonical bytes", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "notes.txt"), "hello owner");
    const { databasePath, editRoot, projectId } = await boundProject(root);
    const runtime = { editRoot, fs: fileAdapter };
    const created = await workspaceEditService.createWorkspaceEdit(
      databasePath,
      projectId,
      { operationId: "op-put-reject", relativePath: "notes.txt" },
      runtime,
    );

    await expect(
      workspaceEditService.putWorkspaceEditDraft(
        databasePath,
        projectId,
        created.sessionId,
        {
          content: "nope",
          expectedHash: "0".repeat(64),
          expectedVersion: created.version,
          operationId: "op-stale-hash",
        },
        runtime,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_CONFLICT" });

    await expect(
      workspaceEditService.putWorkspaceEditDraft(
        databasePath,
        projectId,
        created.sessionId,
        {
          content: "nope",
          expectedHash: created.expectedHash,
          expectedVersion: 99,
          operationId: "op-bad-version",
        },
        runtime,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_CONFLICT" });

    await expect(
      workspaceEditService.putWorkspaceEditDraft(
        databasePath,
        projectId,
        created.sessionId,
        {
          content: "bad\0null",
          expectedHash: created.expectedHash,
          expectedVersion: created.version,
          operationId: "op-nul",
        },
        runtime,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("hello owner");
    expect(
      workspaceEditService.getWorkspaceEdit(databasePath, projectId, created.sessionId),
    ).toEqual(created);
  });
});

describe("getWorkspaceEditDiff", () => {
  it("returns ready_to_stage, stale, and conflicted against the canonical file", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "notes.txt"), "hello owner");
    const { databasePath, editRoot, projectId } = await boundProject(root);
    const runtime = { editRoot, fs: fileAdapter };
    const created = await workspaceEditService.createWorkspaceEdit(
      databasePath,
      projectId,
      { operationId: "op-diff-notes", relativePath: "notes.txt" },
      runtime,
    );

    await workspaceEditService.putWorkspaceEditDraft(
      databasePath,
      projectId,
      created.sessionId,
      {
        content: "hello edited",
        expectedHash: created.expectedHash,
        expectedVersion: created.version,
        operationId: "op-diff-put",
      },
      runtime,
    );

    const ready = await workspaceEditService.getWorkspaceEditDiff(
      databasePath,
      projectId,
      created.sessionId,
      runtime,
    );
    expect(ready.status).toBe("ready_to_stage");
    expect(ready.path).toBe("notes.txt");
    expect(ready.diff).toContain("-hello owner");
    expect(ready.diff).toContain("+hello edited");
    expect(JSON.stringify(ready)).not.toMatch(/[A-Za-z]:[\\/]/u);

    writeFileSync(join(root, "notes.txt"), "hello owner");
    const otherRoot = temporaryRoot();
    writeFileSync(join(otherRoot, "notes.txt"), "hello owner");
    const other = await boundProject(otherRoot);
    const staleSession = await workspaceEditService.createWorkspaceEdit(
      other.databasePath,
      other.projectId,
      { operationId: "op-stale-notes", relativePath: "notes.txt" },
      { editRoot: other.editRoot, fs: fileAdapter },
    );
    writeFileSync(join(otherRoot, "notes.txt"), "canonical changed");
    const stale = await workspaceEditService.getWorkspaceEditDiff(
      other.databasePath,
      other.projectId,
      staleSession.sessionId,
      { editRoot: other.editRoot, fs: fileAdapter },
    );
    expect(stale.status).toBe("stale");

    const conflictRoot = temporaryRoot();
    writeFileSync(join(conflictRoot, "notes.txt"), "base line");
    const conflict = await boundProject(conflictRoot);
    const conflictRuntime = { editRoot: conflict.editRoot, fs: fileAdapter };
    const conflictSession = await workspaceEditService.createWorkspaceEdit(
      conflict.databasePath,
      conflict.projectId,
      { operationId: "op-conflict-notes", relativePath: "notes.txt" },
      conflictRuntime,
    );
    await workspaceEditService.putWorkspaceEditDraft(
      conflict.databasePath,
      conflict.projectId,
      conflictSession.sessionId,
      {
        content: "sandbox change",
        expectedHash: conflictSession.expectedHash,
        expectedVersion: conflictSession.version,
        operationId: "op-conflict-put",
      },
      conflictRuntime,
    );
    writeFileSync(join(conflictRoot, "notes.txt"), "canonical change");
    const conflicted = await workspaceEditService.getWorkspaceEditDiff(
      conflict.databasePath,
      conflict.projectId,
      conflictSession.sessionId,
      conflictRuntime,
    );
    expect(conflicted.status).toBe("conflicted");
  });
});

async function stagedSession(root: string, content = "hello edited") {
  writeFileSync(join(root, "notes.txt"), "hello owner");
  const bound = await boundProject(root);
  const runtime = { editRoot: bound.editRoot, fs: fileAdapter };
  const created = await workspaceEditService.createWorkspaceEdit(
    bound.databasePath,
    bound.projectId,
    { operationId: "op-stage-create", relativePath: "notes.txt" },
    runtime,
  );
  const drafted = await workspaceEditService.putWorkspaceEditDraft(
    bound.databasePath,
    bound.projectId,
    created.sessionId,
    {
      content,
      expectedHash: created.expectedHash,
      expectedVersion: created.version,
      operationId: "op-stage-put",
    },
    runtime,
  );
  await workspaceEditService.getWorkspaceEditDiff(
    bound.databasePath,
    bound.projectId,
    created.sessionId,
    runtime,
  );
  const staged = await workspaceEditService.stageWorkspaceEdit(
    bound.databasePath,
    bound.projectId,
    created.sessionId,
    { expectedVersion: drafted.version, operationId: "op-stage" },
    runtime,
  );
  return { ...bound, created, runtime, staged };
}

describe("stage, merge, and abandon", () => {
  it("stages without writing canonical, rejects unapproved merge, then merges after approval", async () => {
    const root = temporaryRoot();
    const { created, databasePath, projectId, runtime, staged } = await stagedSession(root);

    expect(staged.status).toBe("staged");
    expect(staged.stagedHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("hello owner");

    await expect(
      workspaceEditService.mergeWorkspaceEdit(
        databasePath,
        projectId,
        created.sessionId,
        {
          expectedVersion: staged.version,
          operationId: "op-merge-denied",
          stagedHash: staged.stagedHash!,
        },
        runtime,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_CONFLICT" });
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("hello owner");

    workspaceEditService.approveWorkspaceEditMerge(databasePath, projectId, created.sessionId, {
      operationId: "op-approve",
      stagedHash: staged.stagedHash!,
    });
    const merged = await workspaceEditService.mergeWorkspaceEdit(
      databasePath,
      projectId,
      created.sessionId,
      {
        expectedVersion: staged.version,
        operationId: "op-merge",
        stagedHash: staged.stagedHash!,
      },
      runtime,
    );
    expect(merged.status).toBe("merged");
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("hello edited");

    const replay = await workspaceEditService.mergeWorkspaceEdit(
      databasePath,
      projectId,
      created.sessionId,
      {
        expectedVersion: merged.version,
        operationId: "op-merge",
        stagedHash: staged.stagedHash!,
      },
      runtime,
    );
    expect(replay).toEqual(merged);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("hello edited");
  });

  it("fails closed when verified native write is unavailable and leaves canonical unchanged", async () => {
    const root = temporaryRoot();
    const { created, databasePath, projectId, runtime, staged } = await stagedSession(root);
    workspaceEditService.approveWorkspaceEditMerge(databasePath, projectId, created.sessionId, {
      operationId: "op-approve-unverified",
      stagedHash: staged.stagedHash!,
    });
    const { writeNativeVerifiedFile: _omitted, ...fsWithoutNativeWrite } = runtime.fs;

    await expect(
      workspaceEditService.mergeWorkspaceEdit(
        databasePath,
        projectId,
        created.sessionId,
        {
          expectedVersion: staged.version,
          operationId: "op-merge-unverified",
          stagedHash: staged.stagedHash!,
        },
        { editRoot: runtime.editRoot, fs: fsWithoutNativeWrite },
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_BROWSE_UNAVAILABLE" });
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("hello owner");
  });

  it("completes journal when canonical already holds the staged bytes", async () => {
    const root = temporaryRoot();
    const { created, databasePath, projectId, runtime, staged } = await stagedSession(root);
    workspaceEditService.approveWorkspaceEditMerge(databasePath, projectId, created.sessionId, {
      operationId: "op-approve-recovered",
      stagedHash: staged.stagedHash!,
    });
    writeFileSync(join(root, "notes.txt"), "hello edited");

    const merged = await workspaceEditService.mergeWorkspaceEdit(
      databasePath,
      projectId,
      created.sessionId,
      {
        expectedVersion: staged.version,
        operationId: "op-merge-recovered",
        stagedHash: staged.stagedHash!,
      },
      runtime,
    );
    expect(merged.status).toBe("merged");
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("hello edited");
  });

  it("abandons a session without changing the workspace file", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "notes.txt"), "hello owner");
    const { databasePath, editRoot, projectId } = await boundProject(root);
    const runtime = { editRoot, fs: fileAdapter };
    const created = await workspaceEditService.createWorkspaceEdit(
      databasePath,
      projectId,
      { operationId: "op-abandon-create", relativePath: "notes.txt" },
      runtime,
    );
    const abandoned = await workspaceEditService.abandonWorkspaceEdit(
      databasePath,
      projectId,
      created.sessionId,
      { expectedVersion: created.version, operationId: "op-abandon" },
      runtime,
    );
    expect(abandoned.status).toBe("abandoned");
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("hello owner");
  });
});
