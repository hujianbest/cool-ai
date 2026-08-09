import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cockpit = readFileSync(resolve("app/cockpit.css"), "utf8");
const accents = ["sage", "terracotta", "gold", "slate", "rose", "olive"] as const;

function declarationsFor(selector: string) {
  const declarations: string[] = [];
  for (const match of cockpit.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].split(",").some((candidate) => candidate.trim() === selector)) {
      declarations.push(match[2]);
    }
  }
  return declarations.join("\n");
}

describe("agent mark accent tokens", () => {
  it.each(accents)("uses %s tokens for direct and inherited accents", (accent) => {
    for (const selector of [
      `.agent-mark[data-accent="${accent}"]`,
      `[data-accent="${accent}"] .agent-mark`,
    ]) {
      const declarations = declarationsFor(selector);
      expect(declarations).toContain(`background: var(--agent-${accent}-bg)`);
      expect(declarations).toContain(`color: var(--agent-${accent}-fg)`);
    }
  });

  it("falls back safely for missing and unknown accents", () => {
    expect(declarationsFor(".agent-mark")).toContain("background: var(--agent-warm)");
    expect(declarationsFor('.agent-mark[data-accent="unknown"]')).toBe("");
    expect(declarationsFor("[data-accent] .agent-mark")).toBe("");
  });

  it("keeps the existing agent avatar token mappings", () => {
    for (const accent of accents) {
      const declarations = declarationsFor(`[data-accent="${accent}"] .agent-avatar`);
      expect(declarations).toContain(`background: var(--agent-${accent}-bg)`);
      expect(declarations).toContain(`color: var(--agent-${accent}-fg)`);
    }
  });
});
