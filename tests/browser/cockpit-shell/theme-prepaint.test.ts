import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import RootLayout from "@/app/layout";

const root = process.cwd();
const bootstrapPath = join(root, "public", "theme-prepaint.js");
const layoutPath = join(root, "app", "layout.tsx");
const themeKey = "cool-ai:theme:v1";

type BootstrapRecord = {
  themeAtBootstrap: "light" | "dark";
  timestamp: number;
};

type BootstrapWindow = {
  localStorage?: {
    getItem(key: string): string | null;
  };
  __COOL_THEME_BOOTSTRAP__?: BootstrapRecord;
};

function validPreference(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    theme: "dark",
    revision: 3,
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  });
}

function runBootstrap(options: {
  stored?: string | null;
  storage?: BootstrapWindow["localStorage"];
  now?: number;
} = {}) {
  const source = readFileSync(bootstrapPath, "utf8");
  const documentElement = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
  };
  const windowObject: BootstrapWindow = {};

  if (options.storage) {
    windowObject.localStorage = options.storage;
  } else {
    windowObject.localStorage = {
      getItem: vi.fn((key: string) => {
        expect(key).toBe(themeKey);
        return options.stored ?? null;
      }),
    };
  }

  const execute = new Function("window", "document", "performance", source);
  execute(
    windowObject,
    { documentElement },
    { now: () => options.now ?? 4 },
  );

  return {
    bootstrap: windowObject.__COOL_THEME_BOOTSTRAP__,
    documentElement,
    source,
  };
}

function childElements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) {
    return [];
  }

  const element = node as ReactElement<{ children?: ReactNode }>;
  return [
    element,
    ...Children.toArray(element.props.children).flatMap(childElements),
  ];
}

describe("external theme prepaint bootstrap", () => {
  it("parser-blocks from head with a same-origin external script and no inline code", () => {
    const layout = RootLayout({ children: null });
    const elements = childElements(layout);
    const head = elements.find((element) => element.type === "head");
    const headChildren = Children.toArray(
      (head?.props as { children?: ReactNode } | undefined)?.children,
    ).filter(isValidElement);
    const bootstrap = headChildren.find(
      (element) =>
        element.type === "script" &&
        (element.props as { src?: string }).src === "/theme-prepaint.js",
    );
    const titleIndex = headChildren.findIndex((element) => element.type === "title");
    const bootstrapIndex = headChildren.indexOf(bootstrap!);
    const layoutSource = readFileSync(layoutPath, "utf8");

    expect(bootstrap).toBeDefined();
    expect(bootstrap?.props).toMatchObject({
      src: "/theme-prepaint.js",
    });
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeLessThan(titleIndex);
    expect(bootstrap?.props).not.toHaveProperty("async");
    expect(bootstrap?.props).not.toHaveProperty("defer");
    expect(bootstrap?.props).not.toHaveProperty("children");
    expect(bootstrap?.props).not.toHaveProperty("dangerouslySetInnerHTML");
    expect(layoutSource).not.toMatch(/from ["']next\/script["']/);
    expect(layoutSource).not.toMatch(/localStorage|cool-ai:theme:v1/);
  });

  it("uses a CSP self-compatible static script and never constructs executable content", () => {
    const { source } = runBootstrap();

    expect(source).not.toMatch(
      /\beval\s*\(|\bnew\s+Function\b|createElement\s*\(\s*["']script["']|innerHTML|document\.write/,
    );
    expect(source).not.toContain("</script>");
  });

  it("accepts only an exact versioned canonical envelope", () => {
    const accepted = runBootstrap({ stored: validPreference(), now: 7 });

    expect(accepted.documentElement.dataset.theme).toBe("dark");
    expect(accepted.documentElement.style.colorScheme).toBe("dark");
    expect(accepted.bootstrap).toEqual({
      themeAtBootstrap: "dark",
      timestamp: 7,
    });

    for (const stored of [
      "null",
      validPreference({ version: 0 }),
      validPreference({ theme: "sepia" }),
      validPreference({ revision: -1 }),
      validPreference({ revision: Number.MAX_SAFE_INTEGER + 1 }),
      validPreference({ revision: 1.5 }),
      validPreference({ updatedAt: "2026-08-08" }),
      validPreference({ updatedAt: "not-a-date" }),
      validPreference({ extra: true }),
      JSON.stringify({
        version: 1,
        theme: "</script><script>alert(1)</script>",
        revision: 3,
        updatedAt: "2026-08-08T00:00:00.000Z",
      }),
    ]) {
      const rejected = runBootstrap({ stored });
      expect(rejected.documentElement.dataset.theme, stored).toBe("light");
      expect(rejected.documentElement.style.colorScheme, stored).toBe("light");
      expect(rejected.bootstrap?.themeAtBootstrap, stored).toBe("light");
    }
  });

  it("falls back to light when storage is missing or access throws", () => {
    const missing = runBootstrap({ stored: null });
    expect(missing.documentElement.dataset.theme).toBe("light");

    const getterWindow: BootstrapWindow = {};
    Object.defineProperty(getterWindow, "localStorage", {
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const source = readFileSync(bootstrapPath, "utf8");
    const getterRoot = { dataset: {}, style: {} };
    new Function("window", "document", "performance", source)(
      getterWindow,
      { documentElement: getterRoot },
      { now: () => 5 },
    );
    expect(getterRoot).toEqual({
      dataset: { theme: "light" },
      style: { colorScheme: "light" },
    });

    const throwingRead = runBootstrap({
      storage: {
        getItem() {
          throw new DOMException("denied", "SecurityError");
        },
      },
    });
    expect(throwingRead.documentElement.dataset.theme).toBe("light");
  });

  it("records bootstrap before simulated FCP and scopes hydration suppression to html", () => {
    const simulatedFcp = 9;
    const result = runBootstrap({ stored: validPreference(), now: 4 });
    const layout = RootLayout({ children: null });
    const suppressions = childElements(layout).filter(
      (element) =>
        (element.props as { suppressHydrationWarning?: boolean })
          .suppressHydrationWarning,
    );

    expect(result.bootstrap?.timestamp).toBeLessThanOrEqual(simulatedFcp);
    expect(layout.props).toMatchObject({
      "data-theme": "light",
      lang: "zh-CN",
      style: { colorScheme: "light" },
      suppressHydrationWarning: true,
    });
    expect(suppressions).toEqual([layout]);
  });
});
