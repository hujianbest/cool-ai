import { describe, expect, it } from "vitest";

import { importEdges, readSource, resolveSpecifier, sourceFiles } from "./helpers";

/**
 * Import boundary rules for the target architecture (product/architecture.md section 7).
 * Hard rules block now (vacuous for not-yet-populated target dirs); ratchets only shrink.
 * T-04 transition exemption: an owner's sqlite adapter may import that same owner's
 * module internal/ until credential-vault gains a public entry and this exemption is removed.
 */
const ALLOWED_MODULE_INTERNAL_EDGES: Record<string, RegExp[]> = {
  "src/adapters/outbound/sqlite/identity-capability": [
    /^src\/modules\/identity-capability\/internal\//u,
  ],
};

// Module 事务内命令 Interface 允许依赖 src/application 的事务协调 Port 类型（product/architecture.md 第 3 节）
const FORBIDDEN_IN_MODULES = [
  /^node:sqlite$/u,
  /^src\/adapters\//u,
  /^src\/composition\//u,
  /^app\//u,
  /^components\//u,
];

const FORBIDDEN_IN_APPLICATION = [
  /^node:sqlite$/u,
  /^src\/adapters\//u,
  /^app\//u,
  /^components\//u,
];

const FORBIDDEN_IN_SHARED = [
  /^node:sqlite$/u,
  /^src\/server\//u,
  /^src\/modules\//u,
  /^src\/adapters\//u,
  /^src\/application\//u,
  /^src\/composition\//u,
  /^app\//u,
  /^components\//u,
];

function violations(
  files: string[],
  forbidden: RegExp[],
  { includeTypeOnly = true }: { includeTypeOnly?: boolean } = {},
): string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const edge of importEdges(file)) {
      if (!includeTypeOnly && edge.typeOnly) continue;
      const resolved = resolveSpecifier(edge.specifier, file) ?? edge.specifier;
      if (forbidden.some((pattern) => pattern.test(resolved))) {
        found.push(`${file} -> ${edge.specifier}`);
      }
    }
  }
  return found;
}

describe("target-layer import boundaries", () => {
  it("keeps src/shared free of any upper-layer or tech dependency", () => {
    const files = sourceFiles("src/shared");
    expect(files.length).toBeGreaterThan(5);
    expect(violations(files, FORBIDDEN_IN_SHARED)).toEqual([]);
  });

  it("keeps domain modules free of sqlite/adapter/application/inbound deps", () => {
    const files = sourceFiles("src/modules");
    expect(violations(files, FORBIDDEN_IN_MODULES)).toEqual([]);
  });

  it("keeps modules from deep-importing another module's internal/ports", () => {
    const files = sourceFiles("src/modules");
    const found: string[] = [];
    for (const file of files) {
      const ownModule = file.match(/^src\/modules\/([^/]+)\//u)?.[1];
      for (const edge of importEdges(file)) {
        const resolved = resolveSpecifier(edge.specifier, file) ?? edge.specifier;
        const otherModule = resolved.match(/^src\/modules\/([^/]+)\//u)?.[1];
        if (otherModule && otherModule !== ownModule) {
          if (/^src\/modules\/[^/]+\/(?:internal|ports)\//u.test(resolved)) {
            found.push(`${file} -> ${edge.specifier}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("keeps application workflows free of sqlite/adapter/inbound deps", () => {
    const files = sourceFiles("src/application");
    expect(violations(files, FORBIDDEN_IN_APPLICATION)).toEqual([]);
  });

  it("keeps outbound adapters out of module internals and other owners' adapters", () => {
    const files = sourceFiles("src/adapters/outbound");
    const found: string[] = [];
    for (const file of files) {
      const ownTech = file.match(/^src\/adapters\/outbound\/([^/]+)\//u)?.[1];
      for (const edge of importEdges(file)) {
        const resolved = resolveSpecifier(edge.specifier, file) ?? edge.specifier;
        if (/^src\/modules\/[^/]+\/internal\//u.test(resolved)) {
          const allowed = Object.entries(ALLOWED_MODULE_INTERNAL_EDGES).some(
            ([dir, patterns]) =>
              file.startsWith(`${dir}/`) && patterns.some((pattern) => pattern.test(resolved)),
          );
          if (!allowed) {
            found.push(`${file} -> ${edge.specifier} (module internal)`);
          }
        }
        if (/^(?:app|components)\//u.test(resolved)) {
          found.push(`${file} -> ${edge.specifier} (inbound)`);
        }
        if (/^src\/composition\//u.test(resolved)) {
          found.push(`${file} -> ${edge.specifier} (composition)`);
        }
        const otherTech = resolved.match(/^src\/adapters\/outbound\/([^/]+)\//u)?.[1];
        if (otherTech && ownTech && otherTech !== ownTech) {
          found.push(`${file} -> ${edge.specifier} (cross-technology adapter)`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("keeps the composition root free of SQL and business writes", () => {
    const files = sourceFiles("src/composition");
    for (const file of files) {
      const source = readSource(file);
      expect(source, `${file} contains SQL`).not.toMatch(
        /\.prepare\(|\b(?:SELECT|INSERT|UPDATE|DELETE)\s/u,
      );
    }
  });

  it("keeps browser components away from sqlite and server/adapter value imports", () => {
    const files = sourceFiles("components");
    const found: string[] = [];
    for (const file of files) {
      for (const edge of importEdges(file)) {
        const resolved = resolveSpecifier(edge.specifier, file) ?? edge.specifier;
        if (/^node:sqlite$/u.test(resolved)) {
          found.push(`${file} -> ${edge.specifier}`);
        }
        if (!edge.typeOnly && /^src\/(?:server|adapters)\//u.test(resolved)) {
          found.push(`${file} -> ${edge.specifier} (value import)`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

describe("transition ratchets (may only shrink)", () => {
  it("ratchets app/ -> src/server imports at the frozen count", () => {
    const files = sourceFiles("app").filter((file) =>
      importEdges(file).some((edge) => {
        const resolved = resolveSpecifier(edge.specifier, file) ?? edge.specifier;
        return /^src\/server\//u.test(resolved);
      }),
    );
    expect(
      files.length,
      `app/ files importing src/server grew to ${files.length} (frozen at 68); migrate callers, don't add new ones`,
    ).toBeLessThanOrEqual(68);
  });

  it("ratchets component type-imports of src/server at the frozen count", () => {
    const found: string[] = [];
    for (const file of sourceFiles("components")) {
      for (const edge of importEdges(file)) {
        const resolved = resolveSpecifier(edge.specifier, file) ?? edge.specifier;
        if (edge.typeOnly && /^src\/server\//u.test(resolved)) {
          found.push(`${file} -> ${edge.specifier}`);
        }
      }
    }
    expect(
      found.length,
      `component -> src/server type imports grew to ${found.length} (frozen at 1)`,
    ).toBeLessThanOrEqual(1);
  });
});