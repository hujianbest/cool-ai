import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const tokens = readFileSync(join(root, "app", "tokens.css"), "utf8");
const cockpit = readFileSync(join(root, "app", "cockpit.css"), "utf8");
const browserSmoke = readFileSync(join(root, "tests", "browser-smoke.mjs"), "utf8");
const teamBrowserSmoke = readFileSync(
  join(root, "tests", "team-browser-smoke.mjs"),
  "utf8",
);

describe("narrow cockpit layout guard", () => {
  it("fills the dynamic viewport without allowing page-level overflow", () => {
    expect(tokens).toMatch(/--viewport-height:\s*100dvh/);
    expect(cockpit).toMatch(
      /\.collaboration-cockpit\s*\{[^}]*min-height:\s*var\(--viewport-height\)[^}]*max-width:\s*var\(--full-width\)/s,
    );
    expect(cockpit).toMatch(
      /html,\s*body\s*\{[^}]*min-height:\s*var\(--viewport-height\)[^}]*max-width:\s*var\(--full-width\)[^}]*overflow-x:\s*hidden/s,
    );
  });

  it("keeps the breakpoint literal in the named token responsive section", () => {
    expect(tokens).toMatch(
      /\/\*\s*responsive-cockpit\s*\*\/[\s\S]*@media\s*\(max-width:\s*56\.25rem\)/,
    );
  });

  it("collapses the grid while keeping the ActivityBar as a persistent first column", () => {
    expect(cockpit).toMatch(/body\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(tokens).toMatch(
      /@media\s*\(max-width:\s*56\.25rem\)[\s\S]*\.collaboration-cockpit\s*\{[^}]*grid-template-columns:\s*var\(--activity-bar-width\)\s+minmax\(0,\s*1fr\)/,
    );
    expect(tokens).toMatch(
      /@media\s*\(max-width:\s*56\.25rem\)[\s\S]*\.cockpit-flow\s*\{[^}]*min-width:\s*0/,
    );
  });

  it("lays out the cockpit as a four-column grid on wide screens", () => {
    expect(cockpit).toMatch(
      /\.collaboration-cockpit\s*\{[^}]*grid-template-columns:\s*var\(--activity-bar-width\)\s+var\(--sidebar-width\)\s+minmax\(var\(--content-min\),\s*1fr\)\s+var\(--context-width\)/s,
    );
  });

  it("defines explicit narrow-screen drawer and toolbar states", () => {
    expect(tokens).toMatch(/\.mobile-toolbar\s*\{[^}]*display:\s*flex/s);
    expect(tokens).toMatch(
      /\.cockpit-sidebar\[data-open="true"\][\s\S]*\.cockpit-context\[data-open="true"\]/,
    );
    expect(tokens).toMatch(
      /\.collaboration-cockpit\s*>\s*\.cockpit-flow\[role="tabpanel"\]\s*\{[^}]*display:\s*flex[^}]*position:\s*static[^}]*block-size:\s*auto/s,
    );
  });

  it("keeps narrow fixed surfaces inside device safe areas", () => {
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(tokens).toMatch(
        new RegExp(`--safe-area-${edge}:\\s*max\\([^;]*env\\(safe-area-inset-${edge}\\)`),
      );
    }
    expect(tokens).toMatch(
      /@media\s*\(max-width:\s*56\.25rem\)[\s\S]*\.mobile-toolbar\s*\{[^}]*padding:[^;]*var\(--safe-area-top\)[^;]*var\(--safe-area-right\)[^;]*var\(--safe-area-left\)/,
    );
    expect(tokens).toMatch(
      /\.cockpit-sidebar,\s*\.cockpit-flow,\s*\.cockpit-context\s*\{[^}]*position:\s*fixed[^}]*block-size:\s*var\(--viewport-height\)[^}]*padding-block:\s*var\(--safe-area-top\)\s+var\(--safe-area-bottom\)[^}]*padding-inline:\s*var\(--safe-area-left\)\s+var\(--safe-area-right\)/s,
    );
  });

  it("captures a current narrow workbench with the editor visibly open", () => {
    expect(browserSmoke).toContain("008-ui-design-refresh");
    expect(browserSmoke).toContain("smoke-workbench-current-desktop.png");
    expect(browserSmoke).toContain("smoke-workbench-current-narrow.png");
    expect(browserSmoke).toContain("demo-workbench-current-desktop.png");
    expect(browserSmoke).toContain("demo-workbench-current-narrow.png");
    expect(browserSmoke).toMatch(
      /getByRole\("button",\s*\{\s*name:\s*"打开编辑"\s*\}\)\.click\(\)[\s\S]*page\.screenshot\(\{\s*path:\s*currentNarrowScreenshot/,
    );
    expect(browserSmoke).toMatch(
      /page\.screenshot\(\{\s*path:\s*currentDesktopDemoScreenshot,\s*fullPage:\s*true\s*\}\)/,
    );
    expect(browserSmoke).toMatch(
      /page\.screenshot\(\{\s*path:\s*currentNarrowDemoScreenshot,\s*fullPage:\s*true\s*\}\)/,
    );
    expect(teamBrowserSmoke).toContain("008-ui-design-refresh");
    expect(teamBrowserSmoke).toContain("smoke-team-current-desktop.png");
    expect(teamBrowserSmoke).toContain("smoke-team-current-narrow.png");
    expect(teamBrowserSmoke).toContain("demo-team-current-desktop.png");
    expect(teamBrowserSmoke).toContain("demo-team-current-narrow.png");
    expect(teamBrowserSmoke).toMatch(
      /page\.screenshot\(\{\s*fullPage:\s*true,\s*path:\s*currentDesktopDemoScreenshot\s*\}\)/,
    );
    expect(teamBrowserSmoke).toMatch(
      /page\.screenshot\(\{\s*fullPage:\s*true,\s*path:\s*currentNarrowDemoScreenshot\s*\}\)/,
    );
    expect(`${browserSmoke}\n${teamBrowserSmoke}`).not.toContain("copyFileSync");
  });
});
