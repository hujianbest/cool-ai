import { afterEach, describe, expect, it } from "vitest";

type DirectoryPickerRoute = {
  POST(request: Request): Promise<Response>;
};

const routeModules = import.meta.glob<DirectoryPickerRoute>(
  "../../../app/api/directory-picker/route.ts",
);

const previousScripted = process.env.COCKPIT_SCRIPTED_DIRECTORY;
const previousAllow = process.env.COCKPIT_ALLOW_SCRIPTED_PICKER;
const previousPath = process.env.PATH;
const previousDisplay = process.env.DISPLAY;
const previousWayland = process.env.WAYLAND_DISPLAY;

async function loadRoute(): Promise<DirectoryPickerRoute> {
  const load = routeModules["../../../app/api/directory-picker/route.ts"];
  expect(load, "the directory-picker route must exist").toBeTypeOf("function");
  return load();
}

function emptyPickerRequest(): Request {
  return new Request("http://localhost/api/directory-picker", { method: "POST" });
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

afterEach(() => {
  restoreEnv("COCKPIT_SCRIPTED_DIRECTORY", previousScripted);
  restoreEnv("COCKPIT_ALLOW_SCRIPTED_PICKER", previousAllow);
  restoreEnv("PATH", previousPath);
  restoreEnv("DISPLAY", previousDisplay);
  restoreEnv("WAYLAND_DISPLAY", previousWayland);
});

describe("POST /api/directory-picker", () => {
  it("returns the scripted path without a request body", async () => {
    const route = await loadRoute();
    process.env.COCKPIT_SCRIPTED_DIRECTORY = "D:\\work\\launch-plan";

    const response = await route.POST(emptyPickerRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: "D:\\work\\launch-plan",
    });
  });

  it("rejects a request body instead of reading a path from it", async () => {
    const route = await loadRoute();
    process.env.COCKPIT_SCRIPTED_DIRECTORY = "D:\\work\\launch-plan";

    const response = await route.POST(
      new Request("http://localhost/api/directory-picker", {
        body: JSON.stringify({ path: "C:\\\\injected" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "Directory picker does not accept a request body.",
      },
    });
  });

  it("returns a cancelled discriminator when the native picker is dismissed", async () => {
    const route = await loadRoute();
    delete process.env.COCKPIT_SCRIPTED_DIRECTORY;
    delete process.env.COCKPIT_ALLOW_SCRIPTED_PICKER;
    if (process.platform === "win32" || process.platform === "darwin") {
      return;
    }
    process.env.DISPLAY = ":99";
    delete process.env.WAYLAND_DISPLAY;
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
      const response = await route.POST(emptyPickerRequest());
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ cancelled: true });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("maps a missing picker to the stable 503 envelope", async () => {
    const route = await loadRoute();
    delete process.env.COCKPIT_SCRIPTED_DIRECTORY;
    delete process.env.COCKPIT_ALLOW_SCRIPTED_PICKER;
    if (process.platform === "win32" || process.platform === "darwin") {
      return;
    }
    process.env.PATH = "/var/empty-picker-bin";

    const response = await route.POST(emptyPickerRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PICKER_UNAVAILABLE",
        message: "无法打开系统文件夹选择器",
      },
    });
  });
});
