import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

type NavigationModule = {
  SETTINGS_SECTIONS?: readonly {
    id: string;
    label: string;
    purpose: string;
    keywords: readonly string[];
    available: boolean;
  }[];
  parseSingleParam?: (value: string | string[] | undefined) => string | null;
  parseSettingsSection?: (
    value: string | string[] | undefined,
  ) => "skills" | "providers" | "agents";
  parseReturnTo?: (
    value: string | string[] | undefined,
  ) => "/" | `/projects/${string}`;
  reconcileReturnTo?: (
    value: string | string[] | undefined,
    tupleExists: (
      projectId: string,
      threadId: string,
      runId: string | null,
    ) => boolean | Promise<boolean>,
  ) => Promise<"/" | `/projects/${string}`>;
  buildSettingsHref?: (
    section: "skills" | "providers" | "agents",
    returnTo: string,
  ) => string;
};

const modulePath = pathToFileURL(
  join(process.cwd(), "components", "settings-navigation.ts"),
).href;
const navigation = await import(/* @vite-ignore */ modulePath)
  .then((loaded) => loaded as NavigationModule)
  .catch(() => ({} as NavigationModule));

describe("settings navigation contract", () => {
  it("defines searchable metadata for every available section", () => {
    expect(navigation.SETTINGS_SECTIONS).toEqual([
      {
        id: "skills",
        label: "技能",
        purpose: "管理可复用技能",
        keywords: ["skill", "skills", "技能"],
        available: true,
      },
      {
        id: "providers",
        label: "模型服务",
        purpose: "管理模型服务连接",
        keywords: ["provider", "providers", "model", "模型", "模型服务"],
        available: true,
      },
      {
        id: "agents",
        label: "Agent",
        purpose: "管理 Agent 成员与职责",
        keywords: ["agent", "agents", "成员", "智能体"],
        available: true,
      },
    ]);
  });

  it("accepts one parameter and rejects repeated values", () => {
    expect(navigation.parseSingleParam?.("skills")).toBe("skills");
    expect(navigation.parseSingleParam?.(undefined)).toBeNull();
    expect(navigation.parseSingleParam?.(["skills"])).toBeNull();
    expect(navigation.parseSingleParam?.(["skills", "agents"])).toBeNull();
  });

  it("parses known sections and falls back safely", () => {
    expect(navigation.parseSettingsSection?.("providers")).toBe("providers");
    expect(navigation.parseSettingsSection?.("agents")).toBe("agents");
    expect(navigation.parseSettingsSection?.("skills")).toBe("skills");
    expect(navigation.parseSettingsSection?.("unknown")).toBe("skills");
    expect(navigation.parseSettingsSection?.(undefined)).toBe("skills");
    expect(navigation.parseSettingsSection?.(["providers", "agents"])).toBe(
      "skills",
    );
  });

  it.each([
    "/",
    "/projects/project-1",
    "/projects/Project_123",
    "/projects/a",
    "/projects/project-1?thread=thread-1",
    "/projects/project-1?thread=thread%3A1",
    "/projects/project-1?thread=thread-1&run=run_1",
  ])("accepts the strict return path %s", (value) => {
    expect(navigation.parseReturnTo?.(value)).toBe(value);
  });

  it("canonicalizes valid encoded selections without double encoding", () => {
    expect(
      navigation.parseReturnTo?.(
        "/projects/project%3A1?run=run%3A1&thread=thread%3A1",
      ),
    ).toBe("/projects/project%3A1?thread=thread%3A1&run=run%3A1");
    expect(
      navigation.buildSettingsHref?.(
        "agents",
        "/projects/project%3A1?thread=thread%3A1&run=run%3A1",
      ),
    ).toBe(
      "/team?section=agents&returnTo=%2Fprojects%2Fproject%253A1%3Fthread%3Dthread%253A1%26run%3Drun%253A1",
    );
  });

  it.each([
    undefined,
    "",
    "/projects",
    "/projects/",
    "/projects/a/b",
    "/projects//a",
    "/projects/.",
    "/projects/..",
    "/projects/%2e",
    "/projects/%2E%2E",
    "/projects%2Fa",
    "%2Fprojects%2Fa",
    "/projects\\a",
    "\\projects\\a",
    "/projects/a?tab=1",
    "/projects/a?thread=thread-1&thread=thread-2",
    "/projects/a?thread=thread-1&run=run-1&run=run-2",
    "/projects/a?thread=thread-1&unknown=value",
    "/projects/a?run=run-1",
    "/projects/a?thread=",
    "/projects/a?thread=bad%2Fid",
    "/projects/a?thread=bad%5Cid",
    "/projects/a?thread=bad%00id",
    "/projects/a?thread=thread%253A1",
    "/projects/a#details",
    "/projects/a?thread=thread-1#details",
    "https://example.com/projects/a",
    "//example.com/projects/a",
    "javascript:alert(1)",
    "/projects/a%00",
    "/projects/a%25",
    ["projects", "a"],
    ["/projects/a"],
  ])("rejects unsafe return path %#", (value) => {
    expect(navigation.parseReturnTo?.(value)).toBe("/");
  });

  it("builds a structured href while preserving a legal return path", () => {
    const href = navigation.buildSettingsHref?.(
      "providers",
      "/projects/Project_1",
    );
    expect(href).toBe(
      "/team?section=providers&returnTo=%2Fprojects%2FProject_1",
    );
    expect(new URL(href!, "https://cool-ai.test").searchParams.get("returnTo")).toBe(
      "/projects/Project_1",
    );
  });

  it("falls back to the safe project when tuple reconciliation fails", async () => {
    const exists = vi.fn().mockResolvedValue(false);
    await expect(
      navigation.reconcileReturnTo?.(
        "/projects/project-1?thread=thread-1&run=run-1",
        exists,
      ),
    ).resolves.toBe("/projects/project-1");
    expect(exists).toHaveBeenCalledWith("project-1", "thread-1", "run-1");
  });

  it("preserves the exact canonical selection after tuple reconciliation", async () => {
    await expect(
      navigation.reconcileReturnTo?.(
        "/projects/project%3A1?run=run%3A1&thread=thread%3A1",
        () => true,
      ),
    ).resolves.toBe(
      "/projects/project%3A1?thread=thread%3A1&run=run%3A1",
    );
  });
});
