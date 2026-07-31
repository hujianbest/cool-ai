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
      "--canvas: #F3EFE7",
      "--surface: #FFFDF8",
      "--surface-muted: #ECE6DB",
      "--text: #28241F",
      "--text-muted: #6B645B",
      "--border: #D7CEC0",
      "--accent: #4E756D",
      "--agent-warm: #A75F49",
      "--success: #3F6A4D",
      "--warning: #86662F",
      "--danger: #A0443F",
      "--text-md: 1rem/1.5rem",
      "--space-4: 1rem",
      "--radius-md: 0.75rem",
      "--shadow-panel: 0 0.625rem 1.875rem rgba(77, 65, 49, 0.10)",
      "--focus-ring: 0 0 0 0.1875rem rgba(78, 117, 109, 0.35)",
      "--sidebar-width: 15.5rem",
      "--context-width: 20rem",
      "--content-min: 30rem",
      "--control-min: 2.75rem",
      "--breakpoint-cockpit: 56.25rem",
    ]) {
      expect(tokens).toContain(declaration);
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
        value.includes("var(") || /^(?:0|auto|none|inherit)$/.test(value),
        `Raw visual value is not tokenized: ${match[0].trim()}`,
      ).toBe(true);
    }
  });
});
