import { describe, expect, it } from "vitest";

import { importEdges, resolveSpecifier, sourceFiles } from "./helpers";

/**
 * Module dependency graph (product/architecture.md section 3):
 * command graph is workflow-centric; no domain<->domain command edges, no cycles.
 * Domain->domain edges are a transition form (A-104) and ratchet to zero at T-13.
 */

/**
 * T-13 transition exemption: project-context-snapshot 跨 owner 只读组合暂以直接
 * SQL 实现（经 sqlite connection Adapter）；待各 owner 查询能力或
 * Operations Projection 落地后收编。
 */
const TRANSITIONAL_WORKFLOW_EDGES: Array<{ file: string; specifier: string }> = [
  {
    file: "src/application/workflows/project-context-snapshot/workflow.ts",
    specifier: "@/src/adapters/outbound/sqlite/connection",
  },
];

function moduleOf(file: string): string | null {
  return file.match(/^src\/modules\/([^/]+)\//u)?.[1] ?? null;
}

function moduleGraph(): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const file of sourceFiles("src/modules")) {
    const from = moduleOf(file);
    if (!from) continue;
    for (const edge of importEdges(file)) {
      const resolved = resolveSpecifier(edge.specifier, file) ?? edge.specifier;
      const to = moduleOf(resolved);
      if (to && to !== from) {
        const set = graph.get(from) ?? new Set<string>();
        set.add(to);
        graph.set(from, set);
      }
    }
  }
  return graph;
}

describe("module dependency graph", () => {
  it("has no cycles among domain modules", () => {
    const graph = moduleGraph();
    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycle: string[] = [];
    const visit = (node: string, path: string[]): boolean => {
      if (done.has(node)) return false;
      if (visiting.has(node)) {
        cycle.push(...path.slice(path.indexOf(node)), node);
        return true;
      }
      visiting.add(node);
      for (const next of graph.get(node) ?? []) {
        if (visit(next, [...path, next])) return true;
      }
      visiting.delete(node);
      done.add(node);
      return false;
    };
    for (const node of graph.keys()) {
      expect(visit(node, [node]), `cycle among modules: ${cycle.join(" -> ")}`).toBe(false);
    }
  });

  it("blocks domain->domain edges (zero since T-13)", () => {
    const graph = moduleGraph();
    const edges = [...graph.entries()].flatMap(([from, tos]) =>
      [...tos].map((to) => `${from} -> ${to}`),
    );
    // A-104: T-13 提取命名 Workflow 后，模块公开面之间不应再有 import 边；
    // 该计数阻断在 0，新增跨领域事实流必须经 Workflow 编排。
    expect(
      edges.length,
      `domain->domain edges: ${edges.join("; ")}`,
    ).toBeLessThanOrEqual(0);
  });

  it("keeps workflows depending only on module public entries", () => {
    const found: string[] = [];
    for (const file of sourceFiles("src/application/workflows")) {
      for (const edge of importEdges(file)) {
        const resolved = resolveSpecifier(edge.specifier, file) ?? edge.specifier;
        if (
          (/^src\/modules\/[^/]+\/(?:internal|ports)\//u.test(resolved)
            || /^src\/adapters\//u.test(resolved))
          && !TRANSITIONAL_WORKFLOW_EDGES.some(
            (entry) => entry.file === file && entry.specifier === edge.specifier,
          )
        ) {
          found.push(`${file} -> ${edge.specifier}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
