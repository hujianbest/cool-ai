import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type DirectoryPickResult =
  | { kind: "picked"; path: string }
  | { kind: "cancelled" };

type DirectoryPickerModule = {
  DirectoryPickerError: new () => Error & { code: "PICKER_UNAVAILABLE" };
  pickDirectory(): Promise<DirectoryPickResult>;
};

const pickerModules = import.meta.glob<DirectoryPickerModule>(
  "../../../src/adapters/outbound/workspace/directory-picker.ts",
);

const previousScripted = process.env.COCKPIT_SCRIPTED_DIRECTORY;
const previousPath = process.env.PATH;
const fakeBinaries: string[] = [];

async function loadPicker(): Promise<DirectoryPickerModule> {
  const load =
    pickerModules["../../../src/adapters/outbound/workspace/directory-picker.ts"];
  expect(load, "the DirectoryPicker adapter must exist").toBeTypeOf("function");
  return load();
}

function fakeBin(name: string, script: string): string {
  const directory = join(
    tmpdir(),
    `cool-ai-picker-${process.pid}-${fakeBinaries.length}`,
  );
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, script, { encoding: "utf8", mode: 0o755 });
  chmodSync(file, 0o755);
  fakeBinaries.push(directory);
  return directory;
}

afterEach(() => {
  if (previousScripted === undefined) {
    delete process.env.COCKPIT_SCRIPTED_DIRECTORY;
  } else {
    process.env.COCKPIT_SCRIPTED_DIRECTORY = previousScripted;
  }
  if (previousPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previousPath;
  }
  for (const directory of fakeBinaries.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("DirectoryPicker", () => {
  it("returns a trimmed scripted directory without spawning a dialog", async () => {
    const picker = await loadPicker();
    process.env.COCKPIT_SCRIPTED_DIRECTORY = "  /tmp/scripted-workspace  ";
    process.env.PATH = "";

    await expect(picker.pickDirectory()).resolves.toEqual({
      kind: "picked",
      path: "/tmp/scripted-workspace",
    });
  });

  it("treats an empty native selection as cancelled", async () => {
    const picker = await loadPicker();
    delete process.env.COCKPIT_SCRIPTED_DIRECTORY;
    if (process.platform === "win32" || process.platform === "darwin") {
      return;
    }
    process.env.PATH = fakeBin(
      "zenity",
      "#!/bin/sh\nexit 1\n",
    );

    await expect(picker.pickDirectory()).resolves.toEqual({ kind: "cancelled" });
  });

  it("fails closed when no native picker binary can be spawned", async () => {
    const picker = await loadPicker();
    delete process.env.COCKPIT_SCRIPTED_DIRECTORY;
    if (process.platform === "win32" || process.platform === "darwin") {
      return;
    }
    process.env.PATH = fakeBin("not-a-picker", "#!/bin/sh\nexit 0\n");

    await expect(picker.pickDirectory()).rejects.toMatchObject({
      code: "PICKER_UNAVAILABLE",
      message: "无法打开系统文件夹选择器",
      name: "DirectoryPickerError",
    });
  });
});
