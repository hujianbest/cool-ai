import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const tokenPath = join(root, "app", "tokens.css");
const designPath = join(root, "DESIGN.md");
const tokensCss = readFileSync(tokenPath, "utf8");
const designMd = readFileSync(designPath, "utf8");
const cockpitCss = readFileSync(join(root, "app", "cockpit.css"), "utf8");

const coreColorTokens = [
  "color-primary",
  "color-primary-focus",
  "color-primary-on-dark",
  "color-ink",
  "color-body",
  "color-body-on-dark",
  "color-body-muted",
  "color-ink-muted-80",
  "color-ink-muted-48",
  "color-divider-soft",
  "color-hairline",
  "color-canvas",
  "color-canvas-parchment",
  "color-surface-pearl",
  "color-surface-tile-1",
  "color-surface-tile-2",
  "color-surface-tile-3",
  "color-surface-black",
] as const;

const typographyTokens = [
  "font-display",
  "font-body",
  "text-hero-display",
  "text-display-lg",
  "text-display-md",
  "text-lead",
  "text-body",
  "text-caption",
  "text-button-utility",
  "text-fine-print",
  "leading-body",
  "leading-caption",
  "tracking-body",
  "tracking-caption",
] as const;

const spacingTokens = [
  "space-xxs",
  "space-xs",
  "space-sm",
  "space-md",
  "space-lg",
  "space-xl",
  "space-xxl",
  "space-section",
] as const;

const roundedTokens = [
  "rounded-none",
  "rounded-xs",
  "rounded-sm",
  "rounded-md",
  "rounded-lg",
  "rounded-pill",
] as const;

const shadowTokens = [
  "shadow-product",
  "shadow-panel",
] as const;

const requiredDesignTokens = [
  ...coreColorTokens,
  ...typographyTokens,
  ...spacingTokens,
  ...roundedTokens,
  ...shadowTokens,
].sort();

function themeBlock(selector: string): string {
  // Simple approach: find the block after the selector
  const selectorIndex = tokensCss.indexOf(selector);
  if (selectorIndex === -1) return "";

  const startIndex = tokensCss.indexOf("{", selectorIndex);
  if (startIndex === -1) return "";

  let depth = 1;
  let endIndex = startIndex + 1;
  while (endIndex < tokensCss.length && depth > 0) {
    if (tokensCss[endIndex] === "{") depth++;
    else if (tokensCss[endIndex] === "}") depth--;
    endIndex++;
  }

  return tokensCss.substring(startIndex + 1, endIndex - 1);
}

function declarations(body: string): Map<string, string> {
  // Match CSS custom properties, handling values that may contain commas, quotes, or var()
  const matches = [...body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)];
  return new Map(
    matches.map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

const lightBlock = themeBlock(":root");
const darkBlock = themeBlock(':root[data-theme="dark"]');
const light = declarations(lightBlock);
const darkOnly = declarations(darkBlock);

// Cascade: dark theme inherits from light, then overrides
const dark = new Map([...light, ...darkOnly]);

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
  let value = theme.get(token);
  expect(value, `${token} token should exist`).toBeTruthy();

  // Resolve var() references
  const varMatch = value?.match(/var\(--([^)]+)\)/);
  if (varMatch) {
    const refToken = varMatch[1];
    value = theme.get(refToken);
    // Allow up to 2 levels of var() nesting
    const nestedVarMatch = value?.match(/var\(--([^)]+)\)/);
    if (nestedVarMatch) {
      value = theme.get(nestedVarMatch[1]);
    }
  }

  expect(value, `${token} resolved color`).toMatch(/^#[0-9a-f]{6}$/i);
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

describe("DESIGN.md token contract", () => {
  it("defines all DESIGN.md core color tokens", () => {
    const lightColorTokens = coreColorTokens.filter((token) => light.has(token));
    const darkColorTokens = coreColorTokens.filter((token) => dark.has(token));

    expect(lightColorTokens).toEqual(coreColorTokens);
    expect(darkColorTokens).toEqual(coreColorTokens);
  });

  it("defines DESIGN.md typography scale", () => {
    const lightTypeTokens = typographyTokens.filter((token) => light.has(token));
    const darkTypeTokens = typographyTokens.filter((token) => dark.has(token));

    expect(lightTypeTokens).toEqual(typographyTokens);
    expect(darkTypeTokens).toEqual(typographyTokens);
  });

  it("defines DESIGN.md spacing scale", () => {
    const lightSpacingTokens = spacingTokens.filter((token) => light.has(token));
    const darkSpacingTokens = spacingTokens.filter((token) => dark.has(token));

    expect(lightSpacingTokens).toEqual(spacingTokens);
    expect(darkSpacingTokens).toEqual(spacingTokens);
  });

  it("defines DESIGN.md rounded scale", () => {
    const lightRoundedTokens = roundedTokens.filter((token) => light.has(token));
    const darkRoundedTokens = roundedTokens.filter((token) => dark.has(token));

    expect(lightRoundedTokens).toEqual(roundedTokens);
    expect(darkRoundedTokens).toEqual(roundedTokens);
  });

  it("defines DESIGN.md shadow tokens", () => {
    const lightShadowTokens = shadowTokens.filter((token) => light.has(token));
    const darkShadowTokens = shadowTokens.filter((token) => dark.has(token));

    expect(lightShadowTokens).toEqual(shadowTokens);
    expect(darkShadowTokens).toEqual(shadowTokens);
  });

  it("keeps DESIGN.md color values synchronized", () => {
    // Action Blue from DESIGN.md
    expect(light.get("color-primary")).toBe("#0066cc");
    expect(dark.get("color-primary")).toBe("#0066cc");
    expect(light.get("color-primary-focus")).toBe("#0071e3");
    expect(dark.get("color-primary-focus")).toBe("#0071e3");
    expect(light.get("color-primary-on-dark")).toBe("#2997ff");
    expect(dark.get("color-primary-on-dark")).toBe("#2997ff");

    // Core surface colors from DESIGN.md
    expect(light.get("color-ink")).toBe("#1d1d1f");
    expect(light.get("color-canvas")).toBe("#ffffff");
    expect(light.get("color-canvas-parchment")).toBe("#f5f5f7");
    expect(light.get("color-surface-pearl")).toBe("#fafafc");
    expect(light.get("color-surface-black")).toBe("#000000");
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
});

describe("light and dark theme tokens", () => {
  it("defines equal complete color, shadow, focus, and color-scheme contracts", () => {
    const requiredThemeTokens = [
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
      "focus-ring-color",
      "shadow-panel",
      "shadow-1",
      "shadow-2",
      "focus-ring",
    ] as const;

    const lightThemeTokens = requiredThemeTokens.filter((token) => light.has(token));
    const darkThemeTokens = requiredThemeTokens.filter((token) => dark.has(token));

    expect(lightThemeTokens).toEqual(requiredThemeTokens);
    expect(darkThemeTokens).toEqual(requiredThemeTokens);
    expect(darkThemeTokens).toEqual(lightThemeTokens);
    expect(lightBlock).toMatch(/(?:^|;)\s*color-scheme:\s*light\s*;/);
    expect(darkBlock).toMatch(/(?:^|;)\s*color-scheme:\s*dark\s*;/);
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
      ["panel subtle text", "text-subtle", "surface-panel", 3.0],
      ["primary button", "surface-card", "interactive-primary", 4.5],
      ["primary button hover", "surface-card", "interactive-primary-hover", 4.5],
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
