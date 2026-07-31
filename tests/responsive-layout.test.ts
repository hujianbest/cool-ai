import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const tokens = readFileSync(join(root, "app", "tokens.css"), "utf8");
const cockpit = readFileSync(join(root, "app", "cockpit.css"), "utf8");

describe("narrow cockpit layout guard", () => {
  it("keeps the breakpoint literal in the named token responsive section", () => {
    expect(tokens).toMatch(
      /\/\*\s*responsive-cockpit\s*\*\/[\s\S]*@media\s*\(max-width:\s*56\.25rem\)/,
    );
  });

  it("collapses the grid and guards against horizontal overflow", () => {
    expect(cockpit).toMatch(/body\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(tokens).toMatch(
      /@media\s*\(max-width:\s*56\.25rem\)[\s\S]*\.collaboration-cockpit\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(tokens).toMatch(
      /@media\s*\(max-width:\s*56\.25rem\)[\s\S]*\.cockpit-flow\s*\{[^}]*min-width:\s*0/,
    );
  });

  it("defines explicit narrow-screen drawer and toolbar states", () => {
    expect(tokens).toMatch(/\.mobile-toolbar\s*\{[^}]*display:\s*flex/s);
    expect(tokens).toMatch(
      /\.cockpit-sidebar\[data-open="true"\][\s\S]*\.cockpit-context\[data-open="true"\]/,
    );
  });
});
