import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProject } from "@/src/adapters/outbound/sqlite/project-workspace/projects";
import { bindWorkspace } from "@/src/adapters/outbound/sqlite/project-workspace/workspace-service";
import * as workspaceBrowseService from "@/src/adapters/outbound/sqlite/project-workspace/workspace-browse-service";
import { createWindowsVerifiedExecutionAdapters } from "@/src/adapters/outbound/workspace/windows-verified-execution-adapter";
import { memoryDatabasePath } from "@/tests/fixtures/sqlite/memory-database";

vi.mock("server-only", () => ({}));

const fileAdapter = createWindowsVerifiedExecutionAdapters().fileAdapter;

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-workspace-browse-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

async function boundProject(root: string): Promise<{ databasePath: string; projectId: string }> {
  const databasePath = memoryDatabasePath();
  const project = createProject("Browse", databasePath);
  await bindWorkspace(databasePath, project.id, {
    confirmRebind: false,
    expectedVersion: 1,
    path: root,
  });
  return { databasePath, projectId: project.id };
}

function listDirectory(databasePath: string, projectId: string, relativePath: string) {
  return workspaceBrowseService.listWorkspaceDirectory(
    databasePath,
    projectId,
    relativePath,
    fileAdapter,
  );
}

function readPreview(databasePath: string, projectId: string, relativePath: string) {
  return workspaceBrowseService.readWorkspaceFilePreview(
    databasePath,
    projectId,
    relativePath,
    fileAdapter,
  );
}

describe("listWorkspaceDirectory", () => {
  it("lists directories first, then files, ordered case-insensitively with stable tie-break", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "beta"));
    mkdirSync(join(root, "Alpha"));
    writeFileSync(join(root, "charlie.txt"), "c");
    writeFileSync(join(root, "Delta.txt"), "dd");
    const { databasePath, projectId } = await boundProject(root);

    const listing = await listDirectory(databasePath, projectId, ".");

    expect(listing).toEqual({
      entries: [
        { kind: "dir", name: "Alpha", sensitive: false },
        { kind: "dir", name: "beta", sensitive: false },
        { kind: "file", name: "charlie.txt", sensitive: false, sizeBytes: 1 },
        { kind: "file", name: "Delta.txt", sensitive: false, sizeBytes: 2 },
      ],
      path: ".",
    });
  });

  it("lists nested directories and empty directories", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "sub", "inner"), { recursive: true });
    writeFileSync(join(root, "sub", "note.txt"), "hello");
    mkdirSync(join(root, "empty"));
    const { databasePath, projectId } = await boundProject(root);

    const nested = await listDirectory(databasePath, projectId, "sub");
    expect(nested).toEqual({
      entries: [
        { kind: "dir", name: "inner", sensitive: false },
        { kind: "file", name: "note.txt", sensitive: false, sizeBytes: 5 },
      ],
      path: "sub",
    });

    const empty = await listDirectory(databasePath, projectId, "empty");
    expect(empty).toEqual({ entries: [], path: "empty" });
  });

  it("flags sensitive entries by name vocabulary without hiding them", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, ".env"), "SECRET=1");
    writeFileSync(join(root, "config.pem"), "pem");
    writeFileSync(join(root, "id_rsa"), "rsa");
    writeFileSync(join(root, "credentials.json"), "{}");
    writeFileSync(join(root, "secrets.txt"), "s");
    writeFileSync(join(root, "normal.txt"), "n");
    const { databasePath, projectId } = await boundProject(root);

    const listing = await listDirectory(databasePath, projectId, ".");
    const flags = new Map(listing.entries.map((entry) => [entry.name, entry.sensitive]));

    expect(flags).toEqual(
      new Map([
        [".env", true],
        ["config.pem", true],
        ["id_rsa", true],
        ["credentials.json", true],
        ["secrets.txt", true],
        ["normal.txt", false],
      ]),
    );
  });

  it.each([
    "../outside",
    "sub/../../outside",
    "/absolute",
    "C:/absolute",
    "sub\\file.txt",
    "a//b",
    "",
  ])("rejects out-of-root or malformed path %j as INVALID_INPUT", async (relativePath) => {
    const root = temporaryRoot();
    const { databasePath, projectId } = await boundProject(root);

    await expect(listDirectory(databasePath, projectId, relativePath)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      fields: [{ field: "path", code: "invalid_format" }],
    });
  });

  it("fails closed when a path segment is a junction that escapes the root", async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    writeFileSync(join(outside, "outside.txt"), "x");
    symlinkSync(outside, join(root, "link"), "junction");
    const { databasePath, projectId } = await boundProject(root);

    await expect(listDirectory(databasePath, projectId, "link")).rejects.toMatchObject({
      code: "WORKSPACE_PATH_REJECTED",
    });
    await expect(
      readPreview(databasePath, projectId, "link/outside.txt"),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_REJECTED" });
  });

  it("fails closed when a listed directory contains a reparse entry", async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    writeFileSync(join(root, "normal.txt"), "n");
    symlinkSync(outside, join(root, "link"), "junction");
    const { databasePath, projectId } = await boundProject(root);

    await expect(listDirectory(databasePath, projectId, ".")).rejects.toMatchObject({
      code: "WORKSPACE_PATH_REJECTED",
    });
  });

  it("rejects listing inside a sensitive-named directory", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "secrets"));
    writeFileSync(join(root, "secrets", "a.txt"), "a");
    const { databasePath, projectId } = await boundProject(root);

    await expect(listDirectory(databasePath, projectId, "secrets")).rejects.toMatchObject({
      code: "WORKSPACE_PATH_REJECTED",
    });
  });

  it("rejects listing a file path", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "note.txt"), "n");
    const { databasePath, projectId } = await boundProject(root);

    await expect(listDirectory(databasePath, projectId, "note.txt")).rejects.toMatchObject({
      code: "WORKSPACE_PATH_REJECTED",
    });
  });

  it("rejects a missing directory as WORKSPACE_ENTRY_NOT_FOUND without leaking host paths", async () => {
    const root = temporaryRoot();
    const { databasePath, projectId } = await boundProject(root);

    const failure = await listDirectory(databasePath, projectId, "missing").catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "WORKSPACE_ENTRY_NOT_FOUND" });
    expect(JSON.stringify(failure)).not.toContain(root);
  });

  it("rejects projects without a ready binding and unknown projects", async () => {
    const root = temporaryRoot();
    const databasePath = memoryDatabasePath();
    const unbound = createProject("Unbound", databasePath);

    await expect(listDirectory(databasePath, unbound.id, ".")).rejects.toMatchObject({
      code: "WORKSPACE_NOT_BOUND",
    });
    await expect(
      listDirectory(databasePath, "00000000-0000-0000-0000-000000000000", "."),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });

    const { databasePath: otherDatabase, projectId: bound } = await boundProject(root);
    await expect(
      readPreview(otherDatabase, "00000000-0000-0000-0000-000000000000", "a.txt"),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(bound).toBeTypeOf("string");
  });
});

describe("readWorkspaceFilePreview", () => {
  it("previews UTF-8 text with size and line metadata", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "hello\nworld\n");
    const { databasePath, projectId } = await boundProject(root);

    await expect(readPreview(databasePath, projectId, "src/index.ts")).resolves.toEqual({
      content: "hello\nworld\n",
      kind: "text",
      lineCount: 2,
      sizeBytes: 12,
      truncated: false,
    });
  });

  it("truncates text beyond 512KiB and marks it truncated", async () => {
    const root = temporaryRoot();
    const content = "x".repeat(600 * 1024);
    writeFileSync(join(root, "big.txt"), content);
    const { databasePath, projectId } = await boundProject(root);

    const preview = await readPreview(databasePath, projectId, "big.txt");

    expect(preview).toMatchObject({ kind: "text", sizeBytes: 600 * 1024, truncated: true });
    if (preview.kind !== "text") throw new Error("expected text preview");
    expect(Buffer.byteLength(preview.content, "utf8")).toBeLessThanOrEqual(512 * 1024);
    expect(preview.content).toBe("x".repeat(512 * 1024));
    expect(preview.lineCount).toBe(1);
  });

  it("trims a multi-byte character split by the truncation boundary", async () => {
    const root = temporaryRoot();
    const prefix = "a".repeat(512 * 1024 - 1);
    const content = `${prefix}\u00e9${"b".repeat(100)}`;
    writeFileSync(join(root, "boundary.txt"), content, "utf8");
    const { databasePath, projectId } = await boundProject(root);

    const preview = await readPreview(databasePath, projectId, "boundary.txt");

    if (preview.kind !== "text") throw new Error("expected text preview");
    expect(preview.truncated).toBe(true);
    expect(preview.content).toBe(prefix);
    expect(preview.content).not.toContain("\ufffd");
  });

  it("treats invalid UTF-8 and NUL-containing content as unsupported binary", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "raw.bin"), Buffer.from([0x41, 0xff, 0xfe, 0x42]));
    writeFileSync(join(root, "with-nul.txt"), Buffer.from("abc\0def", "utf8"));
    const { databasePath, projectId } = await boundProject(root);

    await expect(readPreview(databasePath, projectId, "raw.bin")).resolves.toEqual({
      kind: "binary-unsupported",
    });
    await expect(readPreview(databasePath, projectId, "with-nul.txt")).resolves.toEqual({
      kind: "binary-unsupported",
    });
  });

  it.each([
    {
      bytes: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(32, 7),
      ]),
      contentType: "image/png",
      name: "pixel.png",
    },
    {
      bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 7)]),
      contentType: "image/jpeg",
      name: "photo.jpg",
    },
    {
      bytes: Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(32, 7)]),
      contentType: "image/gif",
      name: "anim.gif",
    },
    {
      bytes: Buffer.concat([
        Buffer.from("RIFF", "ascii"),
        Buffer.from([0x24, 0x00, 0x00, 0x00]),
        Buffer.from("WEBP", "ascii"),
        Buffer.alloc(32, 7),
      ]),
      contentType: "image/webp",
      name: "pic.webp",
    },
  ])("detects $contentType by magic bytes and inlines a dataUrl", async (fixture) => {
    const root = temporaryRoot();
    writeFileSync(join(root, fixture.name), fixture.bytes);
    const { databasePath, projectId } = await boundProject(root);

    const preview = await readPreview(databasePath, projectId, fixture.name);

    expect(preview).toEqual({
      contentType: fixture.contentType,
      dataUrl: `data:${fixture.contentType};base64,${fixture.bytes.toString("base64")}`,
      kind: "image",
      sizeBytes: fixture.bytes.byteLength,
    });
  });

  it("rejects images beyond the 2MiB inline limit", async () => {
    const root = temporaryRoot();
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 9);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    writeFileSync(join(root, "huge.png"), bytes);
    const { databasePath, projectId } = await boundProject(root);

    await expect(readPreview(databasePath, projectId, "huge.png")).rejects.toMatchObject({
      code: "WORKSPACE_FILE_TOO_LARGE",
    });
  });

  it("masks sensitive files without reading or returning content", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, ".env"), "TOKEN=super-secret-value");
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "private.key"), "key-material");
    const { databasePath, projectId } = await boundProject(root);

    const masked = await readPreview(databasePath, projectId, ".env");
    expect(masked).toEqual({ kind: "sensitive-masked" });
    expect(JSON.stringify(masked)).not.toContain("super-secret-value");

    await expect(readPreview(databasePath, projectId, "config/private.key")).resolves.toEqual({
      kind: "sensitive-masked",
    });
    // Mask-first: even a nonexistent sensitive-looking path is masked, never probed.
    await expect(readPreview(databasePath, projectId, ".env.missing")).resolves.toEqual({
      kind: "sensitive-masked",
    });
  });

  it("rejects previewing a directory", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "sub"));
    const { databasePath, projectId } = await boundProject(root);

    await expect(readPreview(databasePath, projectId, "sub")).rejects.toMatchObject({
      code: "WORKSPACE_NOT_PREVIEWABLE",
    });
    await expect(readPreview(databasePath, projectId, ".")).rejects.toMatchObject({
      code: "WORKSPACE_NOT_PREVIEWABLE",
    });
  });

  it("returns WORKSPACE_ENTRY_NOT_FOUND for a missing file without leaking host paths", async () => {
    const root = temporaryRoot();
    const { databasePath, projectId } = await boundProject(root);

    const failure = await readPreview(databasePath, projectId, "missing.txt").catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "WORKSPACE_ENTRY_NOT_FOUND" });
    expect(JSON.stringify(failure)).not.toContain(root);
  });

  it("rejects malformed preview paths as INVALID_INPUT", async () => {
    const root = temporaryRoot();
    const { databasePath, projectId } = await boundProject(root);

    await expect(readPreview(databasePath, projectId, "../x")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      fields: [{ field: "path", code: "invalid_format" }],
    });
  });

  it("rejects projects without a ready binding", async () => {
    const databasePath = memoryDatabasePath();
    const unbound = createProject("Unbound preview", databasePath);

    await expect(readPreview(databasePath, unbound.id, "a.txt")).rejects.toMatchObject({
      code: "WORKSPACE_NOT_BOUND",
    });
  });
});
