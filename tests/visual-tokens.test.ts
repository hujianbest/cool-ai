import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const tokenPath = join(root, "app", "tokens.css");
const cockpitPath = join(root, "app", "cockpit.css");

describe("visual token discipline", () => {
  it("defines the approved cockpit token source", () => {
    expect(existsSync(tokenPath)).toBe(true);
    const tokens = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8") : "";

    for (const declaration of [
      '--font-sans: "Segoe UI Variable", "Microsoft YaHei UI", system-ui, sans-serif',
      "--surface-sunken: #F3EFE7",
      "--surface-panel: #F7F3EC",
      "--surface-main: #FBF8F2",
      "--surface-card: #FFFDF8",
      "--text-primary: #28241F",
      "--text-secondary: #514B43",
      "--text-subtle: #6B645B",
      "--border-subtle: #948779",
      "--border-strong: #6B6258",
      "--interactive-primary: #3F675F",
      "--interactive-primary-hover: #31554E",
      "--interactive-soft: #E1ECE8",
      "--interactive-soft-hover: #D4E3DE",
      "--status-queued-surface: #FAF3E0",
      "--status-running-surface: #E1ECE8",
      "--status-success-surface: #E2EDE4",
      "--status-danger-surface: #F4E3DC",
      "--shadow-1: 0 0.25rem 0.75rem rgba(77, 65, 49, 0.08)",
      "--shadow-2: 0 0.625rem 1.875rem rgba(77, 65, 49, 0.14)",
      "--focus-ring-color: #3F675F",
      "--canvas: var(--surface-sunken)",
      "--surface: var(--surface-card)",
      "--surface-muted: var(--surface-panel)",
      "--text: var(--text-primary)",
      "--text-muted: var(--text-subtle)",
      "--border: var(--border-subtle)",
      "--accent: var(--interactive-primary)",
      "--shadow-panel: var(--shadow-1)",
      "--agent-warm: #A75F49",
      "--success: #3F6A4D",
      "--warning: #86662F",
      "--danger: #A0443F",
      "--text-md: 1rem/1.5rem",
      "--space-4: 1rem",
      "--radius-md: 0.75rem",
      "--focus-ring: 0 0 0 0.1875rem var(--focus-ring-color)",
      "--sidebar-width: 15.5rem",
      "--context-width: 20rem",
      "--content-min: 30rem",
      "--control-min: 2.75rem",
      "--breakpoint-cockpit: 56.25rem",
    ]) {
      expect(tokens).toContain(declaration);
    }
  });

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
      /grid-template-columns:\s*var\(--sidebar-width\)\s+minmax\(var\(--content-min\),\s*1fr\)\s+var\(--context-width\)/,
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
