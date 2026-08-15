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
const previousAllow = process.env.COCKPIT_ALLOW_SCRIPTED_PICKER;
const previousPath = process.env.PATH;
const previousNodeEnv = process.env.NODE_ENV;
const previousDisplay = process.env.DISPLAY;
const previousWayland = process.env.WAYLAND_DISPLAY;
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

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  Reflect.set(process.env, name, previous);
}

function setEnv(name: string, value: string): void {
  Reflect.set(process.env, name, value);
}

afterEach(() => {
  restoreEnv("COCKPIT_SCRIPTED_DIRECTORY", previousScripted);
  restoreEnv("COCKPIT_ALLOW_SCRIPTED_PICKER", previousAllow);
  restoreEnv("PATH", previousPath);
  restoreEnv("NODE_ENV", previousNodeEnv);
  restoreEnv("DISPLAY", previousDisplay);
  restoreEnv("WAYLAND_DISPLAY", previousWayland);
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

  it("ignores scripted directory in production unless explicitly allowed", async () => {
    const picker = await loadPicker();
    setEnv("NODE_ENV", "production");
    delete process.env.COCKPIT_ALLOW_SCRIPTED_PICKER;
    process.env.COCKPIT_SCRIPTED_DIRECTORY = "/tmp/must-not-be-used";
    if (process.platform === "win32" || process.platform === "darwin") {
      return;
    }
    process.env.PATH = "";

    await expect(picker.pickDirectory()).rejects.toMatchObject({
      code: "PICKER_UNAVAILABLE",
      message: "无法打开系统文件夹选择器",
      name: "DirectoryPickerError",
    });
  });

  it("honors an explicit scripted picker allow switch outside test env", async () => {
    const picker = await loadPicker();
    setEnv("NODE_ENV", "production");
    process.env.COCKPIT_ALLOW_SCRIPTED_PICKER = "1";
    process.env.COCKPIT_SCRIPTED_DIRECTORY = "/tmp/allowed-scripted";
    process.env.PATH = "";

    await expect(picker.pickDirectory()).resolves.toEqual({
      kind: "picked",
      path: "/tmp/allowed-scripted",
    });
  });

  it("treats an empty native selection as cancelled", async () => {
    const picker = await loadPicker();
    delete process.env.COCKPIT_SCRIPTED_DIRECTORY;
    delete process.env.COCKPIT_ALLOW_SCRIPTED_PICKER;
    if (process.platform === "win32" || process.platform === "darwin") {
      return;
    }
    process.env.DISPLAY = ":99";
    delete process.env.WAYLAND_DISPLAY;
    process.env.PATH = fakeBin(
      "zenity",
      "#!/bin/sh\nexit 1\n",
    );

    await expect(picker.pickDirectory()).resolves.toEqual({ kind: "cancelled" });
  });

  it("fails closed when zenity exits without a display", async () => {
    const picker = await loadPicker();
    delete process.env.COCKPIT_SCRIPTED_DIRECTORY;
    delete process.env.COCKPIT_ALLOW_SCRIPTED_PICKER;
    if (process.platform === "win32" || process.platform === "darwin") {
      return;
    }
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    process.env.PATH = fakeBin(
      "zenity",
      "#!/bin/sh\nexit 1\n",
    );

    await expect(picker.pickDirectory()).rejects.toMatchObject({
      code: "PICKER_UNAVAILABLE",
      message: "无法打开系统文件夹选择器",
      name: "DirectoryPickerError",
    });
  });

  it("fails closed when no native picker binary can be spawned", async () => {
    const picker = await loadPicker();
    delete process.env.COCKPIT_SCRIPTED_DIRECTORY;
    delete process.env.COCKPIT_ALLOW_SCRIPTED_PICKER;
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
