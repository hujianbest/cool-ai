import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const tokenPath = join(root, "app", "tokens.css");
const tokensCss = readFileSync(tokenPath, "utf8");
const cockpitCss = readFileSync(join(root, "app", "cockpit.css"), "utf8");

const colorTokens = [
  "surface-sunken",
  "surface-panel",
  "surface-main",
  "surface-card",
  "text-primary",
  "text-secondary",
  "text-subtle",
  "border-subtle",
  "border-strong",
  "interactive-primary",
  "interactive-primary-hover",
  "interactive-soft",
  "interactive-soft-hover",
  "status-queued-surface",
  "status-running-surface",
  "status-success-surface",
  "status-danger-surface",
  "agent-warm",
  "success",
  "warning",
  "danger",
  "agent-sage-fg",
  "agent-sage-bg",
  "agent-terracotta-fg",
  "agent-terracotta-bg",
  "agent-gold-fg",
  "agent-gold-bg",
  "agent-slate-fg",
  "agent-slate-bg",
  "agent-rose-fg",
  "agent-rose-bg",
  "agent-olive-fg",
  "agent-olive-bg",
  "focus-ring-color",
] as const;

const effectTokens = [
  "shadow-1",
  "shadow-2",
  "shadow-panel",
  "focus-ring",
] as const;
const requiredThemeTokens = [...colorTokens, ...effectTokens].sort();

function themeBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return tokensCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"))?.[1] ?? "";
}

function declarations(body: string): Map<string, string> {
  return new Map(
    [...body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

const lightBlock = themeBlock(":root");
const darkBlock = themeBlock(':root[data-theme="dark"]');
const light = declarations(lightBlock);
const dark = declarations(darkBlock);

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((value >> 16) & 255) +
    0.7152 * channel((value >> 8) & 255) +
    0.0722 * channel(value & 255)
  );
}

function contrast(left: string, right: string): number {
  const [lighter, darker] = [luminance(left), luminance(right)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function color(theme: Map<string, string>, token: string): string {
  const value = theme.get(token);
  expect(value, `${token} token`).toMatch(/^#[0-9a-f]{6}$/i);
  return value!;
}

function cssFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? cssFiles(path)
      : path.endsWith(".css")
        ? [path]
        : [];
  });
}

describe("light and dark theme tokens", () => {
  it("defines equal complete color, shadow, focus, and color-scheme contracts", () => {
    const lightThemeTokens = requiredThemeTokens.filter((token) => light.has(token));
    const darkThemeTokens = requiredThemeTokens.filter((token) => dark.has(token));

    expect(lightThemeTokens).toEqual(requiredThemeTokens);
    expect(darkThemeTokens).toEqual(requiredThemeTokens);
    expect(darkThemeTokens).toEqual(lightThemeTokens);
    expect(lightBlock).toMatch(/(?:^|;)\s*color-scheme:\s*light\s*;/);
    expect(darkBlock).toMatch(/(?:^|;)\s*color-scheme:\s*dark\s*;/);
  });

  it("keeps color literals confined to tokens.css", () => {
    const offenders = cssFiles(join(root, "app"))
      .filter((path) => path !== tokenPath)
      .flatMap((path) => {
        const css = readFileSync(path, "utf8");
        return [...css.matchAll(/#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)/gi)].map(
          (match) => `${relative(root, path)}: ${match[0]}`,
        );
      });

    expect(offenders).toEqual([]);
  });

  it("meets WCAG thresholds for combinations consumed by cockpit.css", () => {
    for (const contract of [
      /body\s*\{[^}]*background:\s*var\(--surface-sunken\)[^}]*color:\s*var\(--text-primary\)/s,
      /(?:button,\s*input,\s*select,\s*textarea)\s*\{[^}]*border:[^;]*var\(--border-subtle\)[^}]*background:\s*var\(--surface-card\)[^}]*color:\s*var\(--text-primary\)/s,
      /\.button-primary\s*\{[^}]*background:\s*var\(--interactive-primary\)[^}]*color:\s*var\(--surface-card\)/s,
      /\.activity-bar\s*\{[^}]*background:\s*var\(--surface-panel\)[^}]*border-right:[^;]*var\(--border-subtle\)/s,
      /:focus-visible[\s\S]*?\{[^}]*box-shadow:\s*var\(--focus-ring\)/,
      /\.status-label\.status-queued\s*\{[^}]*color:\s*var\(--warning\)[^}]*background:\s*var\(--status-queued-surface\)/s,
      /\.status-label\.status-running\s*\{[^}]*color:\s*var\(--interactive-primary\)[^}]*background:\s*var\(--status-running-surface\)/s,
      /\.status-label\.status-completed\s*\{[^}]*color:\s*var\(--success\)[^}]*background:\s*var\(--status-success-surface\)/s,
      /\.status-label\.status-failed\s*\{[^}]*color:\s*var\(--danger\)[^}]*background:\s*var\(--status-danger-surface\)/s,
    ]) {
      expect(cockpitCss).toMatch(contract);
    }

    const checks: Array<[string, string, string, number]> = [
      ["body text", "text-primary", "surface-sunken", 4.5],
      ["card text", "text-primary", "surface-card", 4.5],
      ["panel secondary text", "text-secondary", "surface-panel", 4.5],
      ["panel subtle text", "text-subtle", "surface-panel", 4.5],
      ["primary button", "surface-card", "interactive-primary", 4.5],
      ["primary button hover", "surface-card", "interactive-primary-hover", 4.5],
      ["form boundary", "border-subtle", "surface-card", 3],
      ["card boundary", "border-subtle", "surface-main", 3],
      ["ActivityBar separator", "border-subtle", "surface-panel", 3],
      ["focus on card", "focus-ring-color", "surface-card", 3],
      ["focus on panel", "focus-ring-color", "surface-panel", 3],
      ["queued status", "warning", "status-queued-surface", 4.5],
      ["running status", "interactive-primary", "status-running-surface", 4.5],
      ["success status", "success", "status-success-surface", 4.5],
      ["danger status", "danger", "status-danger-surface", 4.5],
      ["sage Agent", "agent-sage-fg", "agent-sage-bg", 4.5],
      ["terracotta Agent", "agent-terracotta-fg", "agent-terracotta-bg", 4.5],
      ["gold Agent", "agent-gold-fg", "agent-gold-bg", 4.5],
      ["slate Agent", "agent-slate-fg", "agent-slate-bg", 4.5],
      ["rose Agent", "agent-rose-fg", "agent-rose-bg", 4.5],
      ["olive Agent", "agent-olive-fg", "agent-olive-bg", 4.5],
    ];

    const ratios: string[] = [];
    for (const [themeName, theme] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const [label, foreground, background, threshold] of checks) {
        const ratio = contrast(color(theme, foreground), color(theme, background));
        ratios.push(`${themeName} ${label}: ${ratio.toFixed(2)}:1`);
        expect(
          ratio,
          `${themeName} ${label}: ${foreground} on ${background} = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(threshold);
      }
    }

    console.info(`Theme contrast ratios\n${ratios.join("\n")}`);
  });
});
