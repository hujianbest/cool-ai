import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const tokenPath = join(root, "app", "tokens.css");
const cockpitPath = join(root, "app", "cockpit.css");
const designPath = join(root, "product", "ui", "DESIGN.md");

describe("DESIGN.md visual token discipline", () => {
  it("defines DESIGN.md core color tokens", () => {
    expect(existsSync(tokenPath)).toBe(true);
    expect(existsSync(designPath)).toBe(true);
    const tokens = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8") : "";
    const designMd = existsSync(designPath) ? readFileSync(designPath, "utf8") : "";

    // DESIGN.md color tokens should be present
    for (const declaration of [
      "--color-primary: #3E6B5E",
      "--color-primary-focus: #2F5A4E",
      "--color-primary-on-dark: #82B8A5",
      "--color-ink: #2B251F",
      "--color-body: #2B251F",
      "--color-canvas: #F4EFE5",
      "--color-canvas-parchment: #FBF7EE",
      "--color-surface-pearl: #FFFCF4",
      "--color-surface-black: #0D0B08",
      "--color-on-primary: #FFFFFF",
      "--color-rail: #241F18",
      "--color-rail-ink: #EDE5D8",
      "--color-card-strong: #FFFFFF",
      "--color-ink-muted-80: #6F665A",
      "--color-ink-muted-48: #9C9182",
    ]) {
      expect(tokens).toContain(declaration);
    }

    // DESIGN.md should contain the source values
    expect(designMd).toContain("primary: \"#3E6B5E\"");
    expect(designMd).toContain("ink: \"#2B251F\"");
    expect(designMd).toContain("canvas: \"#F4EFE5\"");
    expect(designMd).toContain("rail: \"#241F18\"");
    expect(designMd).toContain("amber: \"#96691C\"");
    expect(designMd).toContain("green: \"#3F6A4D\"");
    expect(designMd).toContain("terra: \"#A0443F\"");
    expect(designMd).toContain("blue: \"#41607F\"");
  });

  it("defines DESIGN.md typography scale", () => {
    const tokens = readFileSync(tokenPath, "utf8");

    // Font families
    expect(tokens).toContain("--font-display: \"SF Pro Display\", system-ui");
    expect(tokens).toContain("--font-body: \"SF Pro Text\", system-ui");

    // Typography size tokens
    expect(tokens).toContain("--text-hero-display: 56px");
    expect(tokens).toContain("--text-display-lg: 40px");
    expect(tokens).toContain("--text-display-md: 34px");
    expect(tokens).toContain("--text-lead: 28px");
    expect(tokens).toContain("--text-body: 17px");
    expect(tokens).toContain("--text-caption: 14px");
    expect(tokens).toContain("--text-fine-print: 12px");

    // Line heights
    expect(tokens).toContain("--leading-body: 1.47");
    expect(tokens).toContain("--leading-caption: 1.43");

    // Letter spacing (negative for display sizes)
    expect(tokens).toContain("--tracking-body: -0.374px");
    expect(tokens).toContain("--tracking-caption: -0.224px");
  });

  it("defines DESIGN.md spacing scale", () => {
    const tokens = readFileSync(tokenPath, "utf8");

    for (const declaration of [
      "--space-xxs: 4px",
      "--space-xs: 8px",
      "--space-sm: 12px",
      "--space-md: 17px",
      "--space-lg: 24px",
      "--space-xl: 32px",
      "--space-xxl: 48px",
      "--space-section: 80px",
    ]) {
      expect(tokens).toContain(declaration);
    }
  });

  it("defines DESIGN.md rounded scale", () => {
    const tokens = readFileSync(tokenPath, "utf8");

    for (const declaration of [
      "--rounded-none: 0px",
      "--rounded-xs: 5px",
      "--rounded-sm: 8px",
      "--rounded-md: 12px",
      "--rounded-lg: 16px",
      "--rounded-pill: 9999px",
    ]) {
      expect(tokens).toContain(declaration);
    }
  });

  it("defines DESIGN.md shadow tokens", () => {
    const tokens = readFileSync(tokenPath, "utf8");

    expect(tokens).toContain("--shadow-product: rgba(0, 0, 0, 0.22) 3px 5px 30px");
    expect(tokens).toContain("--shadow-panel:");
  });
});

describe("legacy cockpit token compatibility", () => {
  it("maintains legacy semantic tokens for backward compatibility", () => {
    expect(existsSync(tokenPath)).toBe(true);
    const tokens = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8") : "";

    // Legacy semantic surface tokens
    for (const declaration of [
      "--surface-sunken: var(--color-canvas-parchment)",
      "--surface-panel: var(--color-canvas-parchment)",
      "--surface-main: var(--color-canvas)",
      "--surface-card: var(--color-surface-pearl)",
      "--surface-muted: var(--color-canvas-parchment)",
      "--text-primary: var(--color-ink)",
      "--text-secondary: var(--color-ink-muted-80)",
      // AA: DESIGN.md faint (#9C9182 / #786E60) fails 4.5:1 on canvas/panel
      // as UI labels; --text-subtle maps to muted-80 without changing surfaces.
      "--text-subtle: var(--color-ink-muted-80)",
      "--border: var(--color-hairline)",
      "--border-subtle: var(--color-divider-soft)",
      "--border-strong: var(--color-ink-muted-80)",
      "--interactive-primary: var(--color-primary)",
      "--interactive-primary-hover: var(--color-primary-focus)",
      "--interactive-soft: var(--color-canvas-parchment)",
      "--activity-bar-width: 3.5rem",
      "--sidebar-width: 14.75rem",
      "--context-width: 19rem",
      "--control-min: 2.75rem",
    ]) {
      expect(tokens).toContain(declaration);
    }

    // Legacy status tokens
    expect(tokens).toContain("--success:");
    expect(tokens).toContain("--warning:");
    expect(tokens).toContain("--danger:");

    // Legacy spacing
    expect(tokens).toContain("--space-4: 1rem");
    expect(tokens).toContain("--space-8: 2rem");

    // Legacy rounded
    expect(tokens).toContain("--radius-md: 0.75rem");

    // Legacy shadows
    expect(tokens).toContain("--shadow-1:");
    expect(tokens).toContain("--shadow-2:");

    // Legacy focus ring
    expect(tokens).toContain("--focus-ring-color:");
    expect(tokens).toContain("--focus-ring:");
  });

  it("uses a macOS-first font stack led by -apple-system", () => {
    const tokens = readFileSync(tokenPath, "utf8");
    const match = tokens.match(/--font-sans:\s*([^;]+);/);
    const value = match ? match[1].trim() : "";

    expect(value.startsWith("-apple-system")).toBe(true);
    expect(value).toContain("PingFang SC");
    expect(value).toContain("Noto Sans SC");
    expect(value).toContain("Segoe UI Variable");
    expect(value).toContain("Microsoft YaHei UI");
  });
});

describe("visual token discipline", () => {
  it("maps shared cockpit hierarchy to named surfaces and elevation", () => {
    const css = readFileSync(cockpitPath, "utf8");

    expect(css).toMatch(
      /\.collaboration-cockpit\s*\{[^}]*background:\s*var\(--surface-sunken\)/s,
    );
    expect(css).toMatch(
      /\.cockpit-sidebar,\s*\.cockpit-context\s*\{[^}]*background:\s*var\(--surface-panel\)[^}]*border[^;]*var\(--border-subtle\)/s,
    );
    expect(css).toMatch(
      /\.cockpit-flow\s*\{[^}]*background:\s*var\(--surface-main\)/s,
    );
    expect(css).toMatch(
      /\.mission-summary,[\s\S]*?\.mission-status\s*\{[^}]*background:\s*var\(--surface-card\)[^}]*border[^;]*var\(--border-subtle\)/,
    );
    expect(css).toMatch(
      /\.modal-surface\s*\{[^}]*background:\s*var\(--surface-card\)[^}]*box-shadow:\s*var\(--shadow-2\)/s,
    );
  });

  it("defines shared action, navigation, and status class contracts", () => {
    const css = readFileSync(cockpitPath, "utf8");

    expect(css).toMatch(
      /\.button-primary\s*\{[^}]*background:\s*var\(--interactive-primary\)[^}]*color:\s*var\(--surface-card\)/s,
    );
    expect(css).toMatch(
      /\.button-secondary\s*\{[^}]*background:\s*var\(--interactive-soft\)[^}]*border[^;]*var\(--border-strong\)/s,
    );
    expect(css).toMatch(
      /\.button-ghost\s*\{[^}]*background:\s*transparent[^}]*color:\s*var\(--text-secondary\)/s,
    );
    expect(css).toMatch(
      /\.nav-item\[aria-current\]\s*\{[^}]*background:\s*var\(--interactive-soft\)[^}]*color:\s*var\(--interactive-primary\)/s,
    );
    expect(css).toMatch(
      /\.surface-heading\s*\{[^}]*color:\s*var\(--text-primary\)/s,
    );

    for (const [status, surface] of [
      ["queued", "queued"],
      ["running", "running"],
      ["completed", "success"],
      ["failed", "danger"],
    ]) {
      expect(css).toMatch(
        new RegExp(
          `\\.status-label\\.status-${status}\\s*\\{[^}]*background:\\s*var\\(--status-${surface}-surface\\)`,
          "s",
        ),
      );
    }
  });

  it("uses named tokens for desktop layout and 44px controls", () => {
    expect(existsSync(cockpitPath)).toBe(true);
    const css = existsSync(cockpitPath) ? readFileSync(cockpitPath, "utf8") : "";

    expect(css).toMatch(
      /grid-template-columns:\s*var\(--activity-bar-width\)\s+var\(--sidebar-width\)\s+minmax\(0,\s*1fr\)/,
    );
    expect(css).toMatch(
      /(?:button|input)[^{]*\{[^}]*min-height:\s*var\(--control-min\)/s,
    );
  });

  it("keeps raw visual values out of component styles", () => {
    expect(existsSync(cockpitPath)).toBe(true);
    const css = existsSync(cockpitPath) ? readFileSync(cockpitPath, "utf8") : "";
    const componentSource = [
      readFileSync(join(root, "components", "project-panel.tsx"), "utf8"),
      readFileSync(join(root, "components", "task-panel.tsx"), "utf8"),
    ].join("\n");

    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\(/i);
    expect(componentSource).not.toMatch(/style=\{\{/);

    const visualDeclaration =
      /^\s*(?:color|background(?:-color)?|border(?:-color|-radius)?|font(?:-size)?|line-height|gap|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|box-shadow|min-height|min-width|width|grid-template-columns)\s*:\s*([^;]+);/gim;
    for (const match of css.matchAll(visualDeclaration)) {
      const value = match[1].trim();
      expect(
        value.includes("var(") ||
          /^(?:0|auto|none|inherit|transparent)$/.test(value),
        `Raw visual value is not tokenized: ${match[0].trim()}`,
      ).toBe(true);
    }
  });
});
