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
      "--color-primary: #9A5F1A",
      "--color-primary-focus: #794819",
      "--color-primary-on-dark: #E4B066",
      "--color-ink: #221E1C",
      "--color-body: #221E1C",
      "--color-canvas: #F4EFE7",
      "--color-canvas-parchment: #FAF6F1",
      "--color-surface-pearl: #FEFBF8",
      "--color-surface-black: #0E0C09",
      "--color-on-primary: #FFFFFF",
      "--color-rail: #EAE4DA",
      "--color-rail-ink: #221E1C",
      "--color-card-strong: #FFFFFF",
      "--color-ink-muted-80: #595451",
      "--color-ink-muted-48: #847F7B",
    ]) {
      expect(tokens).toContain(declaration);
    }

    // DESIGN.md should contain the source values
    expect(designMd).toContain("#9A5F1A");
    expect(designMd).toContain("#221E1C");
    expect(designMd).toContain("#F4EFE7");
    expect(designMd).toContain("#EAE4DA");
    expect(designMd).toContain("暖金");
    expect(designMd).toContain("暖米");
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
    // 17px 漂移定案：正文档与文档基准（DESIGN.md §4 基础 16px）对齐（A-513）。
    expect(tokens).toContain("--text-body: 16px");
    expect(tokens).toContain("--text-caption: 14px");
    expect(tokens).toContain("--text-fine-print: 12px");
    // 密集档（A-513）：元信息 11/16、紧凑 13/20。
    expect(tokens).toContain("--text-label: 11px");
    expect(tokens).toContain("--leading-label: 16px");
    expect(tokens).toContain("--text-compact: 13px");
    expect(tokens).toContain("--leading-compact: 20px");

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
      "--space-md: 16px",
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

    // 三级 elevation（A-513）：卡片 1 / 浮起 2 / overlay 3；旧 --shadow-1/2/panel/product 已删除。
    expect(tokens).toContain("--shadow-elevation-1: rgba(34, 30, 28, 0.05) 0 1px 2px 0");
    expect(tokens).toContain("--shadow-elevation-2: rgba(34, 30, 28, 0.10) 0 4px 12px 0");
    expect(tokens).toContain("--shadow-elevation-3: rgba(34, 30, 28, 0.16) 0 12px 32px 0");
    for (const legacy of ["--shadow-1:", "--shadow-2:", "--shadow-panel:", "--shadow-product:"]) {
      expect(tokens).not.toContain(legacy);
    }
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
      "--activity-bar-width: 3.25rem",
      "--sidebar-width: 15rem",
      "--context-width: 19rem",
      "--control-min: 2.75rem",
    ]) {
      expect(tokens).toContain(declaration);
    }

    // Legacy status tokens
    expect(tokens).toContain("--success:");
    expect(tokens).toContain("--warning:");
    expect(tokens).toContain("--danger:");

    // 单一声明面（A-513）：legacy 双轨 name 已删除，tokens.css 与 cockpit.css 任何残留都会
    // 让 var() 解析失败关闭（未定义令牌使整条声明静默丢弃）。
    const cockpitCss = readFileSync(cockpitPath, "utf8");
    const legacyNames = [
      "--space-1:", "--space-2:", "--space-3:", "--space-4:",
      "--space-5:", "--space-6:", "--space-8:",
      "--radius-sm:", "--radius-md:", "--radius-lg:",
      "--rounded-full:",
      "--shadow-1:", "--shadow-2:", "--shadow-panel:", "--shadow-product:",
      "--text-xs:", "--text-sm:", "--text-md:", "--text-lg:", "--text-xl:",
    ];
    for (const legacy of legacyNames) {
      expect(tokens).not.toContain(legacy);
    }
    for (const legacy of [
      "--space-1\\b", "--space-2\\b", "--space-3\\b", "--space-4\\b",
      "--space-5\\b", "--space-6\\b", "--space-8\\b",
      "--radius-sm\\b", "--radius-md\\b", "--radius-lg\\b", "--rounded-full\\b",
      "--shadow-1\\b", "--shadow-2\\b", "--shadow-panel\\b", "--shadow-product\\b",
      "--text-xs\\b", "--text-sm\\b", "--text-md\\b", "--text-lg\\b", "--text-xl\\b",
    ]) {
      expect(cockpitCss, `cockpit.css must not reference ${legacy}`).not.toMatch(
        new RegExp(legacy),
      );
    }

    // 控制高度分档（A-513）：热区下限不变，视觉高度分档可选。
    expect(tokens).toContain("--control-min: 2.75rem");
    expect(tokens).toContain("--control-h-compact: 2rem");
    expect(tokens).toContain("--control-h-base: 2.25rem");
    expect(tokens).toContain("--control-h-comfortable: 2.5rem");

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
      /\.mission-summary,[\s\S]*?\.work-item-form\s*\{[^}]*background:\s*var\(--surface-card\)[^}]*border[^;]*var\(--border-subtle\)/,
    );
    expect(css).toMatch(
      /\.mission-status\s*\{[^}]*background:\s*var\(--color-canvas-parchment\)/,
    );
    expect(css).toMatch(
      /\.modal-surface\s*\{[^}]*background:\s*var\(--surface-card\)[^}]*box-shadow:\s*var\(--shadow-elevation-3\)/s,
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
      // `!important` is a cascade mechanism, not a visual value; the token
      // discipline only governs the value itself.
      const value = match[1].trim().replace(/\s*!important$/i, "");
      expect(
        value.includes("var(") ||
          /^(?:0|auto|none|inherit|transparent|100%|50%|fit-content)$/.test(value),
        `Raw visual value is not tokenized: ${match[0].trim()}`,
      ).toBe(true);
    }
  });
});
