import { describe, expect, it } from "vitest";

import { importEdges, resolveSpecifier, sourceFiles } from "./helpers";

/**
 * Module dependency graph (product/architecture.md section 3):
 * command graph is workflow-centric; no domain<->domain command edges, no cycles.
 * Domain->domain edges are a transition form (A-104) and ratchet to zero at T-13.
 */

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

  it("ratchets domain->domain edges toward zero (blocking at T-13)", () => {
    const graph = moduleGraph();
    const edges = [...graph.entries()].flatMap(([from, tos]) =>
      [...tos].map((to) => `${from} -> ${to}`),
    );
    // A-104: during T-04..T-12 cross-domain facts flow via the other module's public
    // Interface; T-13 extracts named workflows and this count must reach 0.
    expect(
      edges.length,
      `domain->domain edges: ${edges.join("; ")}`,
    ).toBeLessThanOrEqual(12);
  });

  it("keeps workflows depending only on module public entries", () => {
    const found: string[] = [];
    for (const file of sourceFiles("src/application/workflows")) {
      for (const edge of importEdges(file)) {
        const resolved = resolveSpecifier(edge.specifier, file) ?? edge.specifier;
        if (
          /^src\/modules\/[^/]+\/(?:internal|ports)\//u.test(resolved) ||
          /^src\/adapters\//u.test(resolved)
        ) {
          found.push(`${file} -> ${edge.specifier}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
