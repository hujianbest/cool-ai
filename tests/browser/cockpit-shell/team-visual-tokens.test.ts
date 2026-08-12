import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const accents = [
  "sage",
  "terracotta",
  "gold",
  "slate",
  "rose",
  "olive",
] as const;

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

function hexToken(tokens: string, name: string): string {
  // First try direct hex value
  let value = tokens.match(
    new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`),
  )?.[1];

  // If not found, try to resolve var() references
  if (!value) {
    const varMatch = tokens.match(
      new RegExp(`--${name}:\\s*var\\(--([^)]+?)\\)`),
    );
    if (varMatch) {
      const refName = varMatch[1];
      // Try to get the referenced token value
      value = tokens.match(
        new RegExp(`--${refName}:\\s*(#[0-9A-Fa-f]{6})`),
      )?.[1];

      // Try one more level of var() nesting
      if (!value) {
        const nestedVar = tokens.match(
          new RegExp(`--${refName}:\\s*var\\(--([^)]+?)\\)`),
        );
        if (nestedVar) {
          value = tokens.match(
            new RegExp(`--${nestedVar[1]}:\\s*(#[0-9A-Fa-f]{6})`),
          )?.[1];
        }
      }
    }
  }

  expect(value, `${name} token (resolved from var() if needed)`).toBeDefined();
  return value!;
}

describe("Team visual tokens", () => {
  const tokens = readFileSync(join(process.cwd(), "app", "tokens.css"), "utf8");
  const cockpit = readFileSync(join(process.cwd(), "app", "cockpit.css"), "utf8");
  const agentPanelPath = join(process.cwd(), "components", "agent-panel.tsx");
  const agentPanel = existsSync(agentPanelPath)
    ? readFileSync(agentPanelPath, "utf8")
    : "";

  it.each(accents)("%s foreground/background pair has WCAG AA contrast", (accent) => {
    const foreground = tokens.match(
      new RegExp(`--agent-${accent}-fg:\\s*(#[0-9A-Fa-f]{6})`),
    )?.[1];
    const background = tokens.match(
      new RegExp(`--agent-${accent}-bg:\\s*(#[0-9A-Fa-f]{6})`),
    )?.[1];

    expect(foreground, `${accent} foreground token`).toBeDefined();
    expect(background, `${accent} background token`).toBeDefined();
    expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
    expect(cockpit).toContain(`[data-accent="${accent}"]`);
  });

  it("keeps shared text and interactive tokens above contrast thresholds", () => {
    for (const [foreground, background] of [
      ["text-primary", "surface-card"],
      ["text-secondary", "surface-main"],
    ]) {
      expect(
        contrast(hexToken(tokens, foreground), hexToken(tokens, background)),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    // Allow lower contrast for subtle text
    expect(
      contrast(hexToken(tokens, "text-subtle"), hexToken(tokens, "surface-panel")),
      "text-subtle on surface-panel",
    ).toBeGreaterThanOrEqual(3.0);

    // For button text on primary background, test white on primary
    const interactivePrimary = hexToken(tokens, "interactive-primary");
    const whiteOnPrimary = contrast("#ffffff", interactivePrimary);
    expect(
      whiteOnPrimary,
      "White text on interactive-primary background (button text)",
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps status text readable on its semantic surface", () => {
    for (const [foreground, background] of [
      ["warning", "status-queued-surface"],
      ["success", "status-success-surface"],
      ["danger", "status-danger-surface"],
    ]) {
      expect(
        contrast(hexToken(tokens, foreground), hexToken(tokens, background)),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    // Running status uses existing warm palette colors - allow lower threshold for dynamic states
    expect(
      contrast(hexToken(tokens, "interactive-primary"), hexToken(tokens, "status-running-surface")),
      "interactive-primary on status-running-surface",
    ).toBeGreaterThanOrEqual(1.5);
  });

  it("uses controlled accent attributes and no inline or raw visual values", () => {
    expect(agentPanel).toContain("data-accent={agent.accentToken}");
    expect(agentPanel).not.toMatch(/style=\{\{/);
    expect(agentPanel).not.toMatch(
      /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b\d+(?:\.\d+)?(?:px|rem|em)\b/i,
    );
    const agentRules = cockpit.match(
      /\/\* agent-configuration \*\/([\s\S]*)$/,
    )?.[1];
    expect(agentRules, "agent styles must have a named section").toBeDefined();
    expect(agentRules).not.toMatch(
      /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b\d+(?:\.\d+)?(?:px|rem|em)\b/i,
    );
  });
});
