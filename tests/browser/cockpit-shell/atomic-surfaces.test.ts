import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const cockpitCss = readFileSync(join(root, "app", "cockpit.css"), "utf8");
const designMd = readFileSync(join(root, "product", "ui", "DESIGN.md"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cockpitCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*\\}`, "m"));
  expect(match, `${selector} rule should exist`).not.toBeNull();
  return match![0];
}

describe("atomic surface components (DESIGN.md §6.1)", () => {
  it("documents the five primitives and the nested-chrome ban", () => {
    for (const heading of [
      "status-pill",
      "meta-row",
      "panel-empty",
      "section-header",
      "card（标准卡模板）",
      "卡中卡禁令",
    ]) {
      expect(designMd).toContain(heading);
    }
  });

  it("renders status pills as tinted pills with a count variant", () => {
    const pill = rule(".status-label");
    expect(pill).toMatch(/border-radius:\s*var\(--rounded-pill\)/);
    expect(pill).toMatch(/min-height:\s*var\(--pill-height\)/);
    expect(pill).toMatch(
      /border:\s*var\(--border-width\) solid color-mix\(in srgb, currentColor/,
    );
    expect(pill).toMatch(/font:\s*var\(--text-label\)\/var\(--leading-label\)/);

    // 徽章一律 pill：结构化块的 PROPOSAL 标签与看板计数不得再用方角芯片。
    expect(rule(".block-card-tag")).toMatch(/border-radius:\s*var\(--rounded-pill\)/);
    expect(rule(".kanban-col-count")).toMatch(
      /border-radius:\s*var\(--rounded-pill\)[\s\S]*font-variant-numeric:\s*tabular-nums/,
    );
    expect(rule(".status-label-count")).toMatch(
      /font-variant-numeric:\s*tabular-nums/,
    );
  });

  it("keeps meta rows on the dense meta tier with a right-aligned value", () => {
    const metaRow = rule(".meta-row");
    expect(metaRow).toMatch(/justify-content:\s*space-between/);
    expect(metaRow).toMatch(/font:\s*var\(--text-label\)\/var\(--leading-label\)/);
    expect(cockpitCss).toMatch(
      /\.meta-row\s*>\s*:last-child\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s,
    );
  });

  it("keeps panel-empty cards compact instead of filling the container", () => {
    const empty = rule(".state-message");
    expect(empty).toMatch(/width:\s*fit-content/);
    expect(empty).toMatch(/align-self:\s*start/);
    expect(empty).toMatch(/border:\s*var\(--border-width\) solid var\(--border-subtle\)/);
    expect(empty).toMatch(/font-size:\s*var\(--text-compact\)/);
  });

  it("gives section headers a single right-aligned action slot", () => {
    const header = rule(".section-header");
    expect(header).toMatch(/display:\s*flex/);
    expect(header).toMatch(/justify-content:\s*space-between/);
    expect(cockpitCss).toMatch(
      /\.section-header h2,\s*\.section-header h3,\s*\.section-header h4\s*\{[^}]*font-size:\s*var\(--text-body-strong\)/s,
    );
  });

  it("keeps list chrome single-layered (container vs item)", () => {
    // 容器层（.timeline）与行包装层（.timeline-item）不再承载第二层铬。
    const container = cockpitCss.match(
      /\.composer,\s*\.decision-panel,\s*\.run-detail,\s*\.context-body\s*\{[^}]*\}/s,
    );
    expect(container).not.toBeNull();
    expect(container![0]).not.toContain(".timeline");
    const timelineItem = rule(".timeline-item");
    expect(timelineItem).not.toMatch(/border:/);
    expect(timelineItem).not.toMatch(/background:/);
    // 条目层独占细边 + elevation-1。
    const article = rule(".timeline-item > article");
    expect(article).toMatch(/border:\s*var\(--border-width\) solid var\(--border-subtle\)/);
    expect(article).toMatch(/box-shadow:\s*var\(--shadow-elevation-1\)/);
  });

  it("keeps the compact control tier on a 44px hit area", () => {
    const compact = rule(".button-compact");
    expect(compact).toMatch(/min-height:\s*var\(--control-h-base\)/);
    const overlay = cockpitCss.match(/\.button-compact::after\s*\{[^}]*\}/s);
    expect(overlay).not.toBeNull();
    expect(overlay![0]).toMatch(/min-height:\s*var\(--control-min\)/);
  });
});
