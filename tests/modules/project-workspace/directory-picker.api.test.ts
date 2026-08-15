import { afterEach, describe, expect, it } from "vitest";

type DirectoryPickerRoute = {
  POST(request?: Request): Promise<Response>;
};

const routeModules = import.meta.glob<DirectoryPickerRoute>(
  "../../../app/api/directory-picker/route.ts",
);

const previousScripted = process.env.COCKPIT_SCRIPTED_DIRECTORY;
const previousPath = process.env.PATH;

async function loadRoute(): Promise<DirectoryPickerRoute> {
  const load = routeModules["../../../app/api/directory-picker/route.ts"];
  expect(load, "the directory-picker route must exist").toBeTypeOf("function");
  return load();
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
});

describe("POST /api/directory-picker", () => {
  it("returns the scripted path without a request body", async () => {
    const route = await loadRoute();
    process.env.COCKPIT_SCRIPTED_DIRECTORY = "D:\\work\\launch-plan";

    const response = await route.POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: "D:\\work\\launch-plan",
    });
  });

  it("returns a cancelled discriminator when the native picker is dismissed", async () => {
    const route = await loadRoute();
    delete process.env.COCKPIT_SCRIPTED_DIRECTORY;
    if (process.platform === "win32" || process.platform === "darwin") {
      return;
    }
    const { chmodSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = join(tmpdir(), `cool-ai-picker-api-${process.pid}`);
    mkdirSync(directory, { recursive: true });
    const zenity = join(directory, "zenity");
    writeFileSync(zenity, "#!/bin/sh\nexit 1\n", { encoding: "utf8", mode: 0o755 });
    chmodSync(zenity, 0o755);
    process.env.PATH = directory;
    try {
      const response = await route.POST();
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ cancelled: true });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("maps a missing picker to the stable 503 envelope", async () => {
    const route = await loadRoute();
    delete process.env.COCKPIT_SCRIPTED_DIRECTORY;
    if (process.platform === "win32" || process.platform === "darwin") {
      return;
    }
    process.env.PATH = "/var/empty-picker-bin";

    const response = await route.POST();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PICKER_UNAVAILABLE",
        message: "无法打开系统文件夹选择器",
      },
    });
  });
});
