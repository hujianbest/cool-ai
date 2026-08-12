import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const previewPath = join(root, "app", "preview.html");
const previewDarkPath = join(root, "app", "preview-dark.html");

describe("DESIGN.md preview pages", () => {
  it("creates preview.html with design token catalog", () => {
    expect(existsSync(previewPath)).toBe(true);
    const preview = existsSync(previewPath) ? readFileSync(previewPath, "utf8") : "";

    // Check for key DESIGN.md tokens
    for (const token of [
      "color-primary",
      "color-ink",
      "color-canvas",
      "color-canvas-parchment",
      "text-display-lg",
      "text-body",
      "space-md",
      "rounded-pill",
    ]) {
      expect(preview).toContain(`var(--${token})`);
    }

    // Check for component examples
    expect(preview).toContain("button-primary");
    expect(preview).toContain("status-label");
    expect(preview).toContain("Action Blue");
    expect(preview).toContain("DESIGN.md");
  });

  it("creates preview-dark.html with dark theme tokens", () => {
    expect(existsSync(previewDarkPath)).toBe(true);
    const previewDark = existsSync(previewDarkPath) ? readFileSync(previewDarkPath, "utf8") : "";

    // Check for dark theme specific tokens
    expect(previewDark).toContain("Dark Theme");
    expect(previewDark).toContain("color-primary-on-dark");
    expect(previewDark).toContain("color-surface-tile-1");
    expect(previewDark).toContain("color-surface-tile-2");
    expect(previewDark).toContain("color-surface-tile-3");

    // Check for component examples in dark theme
    expect(previewDark).toContain("button-primary");
    expect(previewDark).toContain("status-label");
  });

  it("includes typography scale from DESIGN.md", () => {
    const preview = readFileSync(previewPath, "utf8");

    // Check for DESIGN.md typography scale
    expect(preview).toContain("Hero Display");
    expect(preview).toContain("56px");
    expect(preview).toContain("Display Large");
    expect(preview).toContain("40px");
    expect(preview).toContain("Body text 17px");
    expect(preview).toContain("Caption 14px");
  });

  it("includes rounded and spacing scales from DESIGN.md", () => {
    const preview = readFileSync(previewPath, "utf8");

    // Check for DESIGN.md spacing scale in the token list section
    expect(preview).toContain("Spacing & Rounded Scale");
    expect(preview).toContain("--space-xxs");
    expect(preview).toContain("4px");
    expect(preview).toContain("--space-xs");
    expect(preview).toContain("8px");
    expect(preview).toContain("--space-md");
    expect(preview).toContain("17px");
    expect(preview).toContain("--space-section");
    expect(preview).toContain("80px");

    // Check for DESIGN.md rounded scale
    expect(preview).toContain("--rounded-none");
    expect(preview).toContain("0px");
    expect(preview).toContain("--rounded-sm");
    expect(preview).toContain("--rounded-pill");
    expect(preview).toContain("9999px");
  });
});
