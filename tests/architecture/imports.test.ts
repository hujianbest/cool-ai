import { describe, expect, it } from "vitest";

import { importEdges, readSource, resolveSpecifier, sourceFiles } from "./helpers";

/**
 * Import boundary rules for the target architecture (product/architecture.md section 7).
 * Hard rules block now (vacuous for not-yet-populated target dirs); ratchets only shrink.
 * T-04 transition exemption: an owner's sqlite adapter may import that same owner's
 * module internal/ until credential-vault gains a public entry and this exemption is removed.
 * T-09 transition exemption: safe-execution's own adapters import its internal/ pure
 * policies (command-policy/action-schema/prompt-builder); project-workspace's
 * validation-policy-service keeps its registered cross-domain read of command-policy
 * (feature architecture "分类逻辑留 safe-execution"; T-13 收编).
 * T-10 transition exemption: public-collaboration's own adapters import its internal/
 * pure logic (agent-turn-schema/structured-repair/structured-message-codec/
 * structured-message-schema/public-text-credential-classifier pure core) and keep the
 * registered cross-owner read of identity-capability's credential-vault (T-13 收编);
 * the sqlite lifecycle invariants validator keeps its registered read of the pure
 * codec/schema to check structured_message_* data invariants (T-16 收编).
 * T-11 transition exemption: review-delivery's sqlite adapters keep the registered
 * cross-owner read of identity-capability's credential-vault (reviewer 凭据解密);
 * T-13 收编.
 * T-12 transition exemption: model-runtime outbound Adapter（provider-verifier/
 * openai-chat-client）落地后，sqlite 各 owner Adapter 对其形成跨技术读，
 * public-collaboration 的 structured-repair 仍直调该 Adapter（迁移前经 src/server
 * legacy 路径引用同一客户端）；T-13 收编为显式 Port/能力后移除。
 */
const ALLOWED_MODULE_INTERNAL_EDGES: Record<string, RegExp[]> = {
  "src/adapters/outbound/sqlite/identity-capability": [
    /^src\/modules\/identity-capability\/internal\//u,
  ],
  "src/adapters/outbound/sqlite/safe-execution": [
    /^src\/modules\/safe-execution\/internal\//u,
    // T-09 transition: model 调用经 credential-vault 解密 provider 凭据；
    // 跨 owner internal 读在 T-13 Workflow 提取时收编。
    /^src\/modules\/identity-capability\/internal\/credential-vault$/u,
  ],
  "src/adapters/outbound/sqlite/project-workspace": [
    /^src\/modules\/safe-execution\/internal\/command-policy$/u,
  ],
  "src/adapters/outbound/sqlite/public-collaboration": [
    /^src\/modules\/public-collaboration\/internal\//u,
    // T-10 transition: 与 T-09 相同的 credential-vault 跨 owner internal 读
    //（run/thread/advance/classifier 解密 provider 凭据做公开文本凭据分类）；T-13 收编。
    /^src\/modules\/identity-capability\/internal\/credential-vault$/u,
  ],
  "src/adapters/outbound/sqlite/review-delivery": [
    // T-11 transition: 与 T-09/T-10 相同的 credential-vault 跨 owner internal 读
    //（review-slice/review-application 解密 reviewer 的 provider 凭据）；T-13 收编。
    /^src\/modules\/identity-capability\/internal\/credential-vault$/u,
  ],
  "src/adapters/outbound/sqlite": [
    // T-10 transition: current-data-invariants 校验 structured_message_* 数据不变量
    // 需要纯 codec/schema（零 SQL）；T-16 收敛末期随 src/server 删除一并收编。
    /^src\/modules\/public-collaboration\/internal\/structured-message-(codec|schema)$/u,
  ],
};

/**
 * T-09: safe-execution has two legal adapter dirs (write-ownership manifest):
 * sqlite/safe-execution (SQL domain services) and workspace (verified-handle/fs/process).
 * Same-owner edges between them are the target form, not cross-owner leakage.
 */
function isSafeExecutionSameOwnerEdge(file: string, resolved: string): boolean {
  const sqliteDir = /^src\/adapters\/outbound\/sqlite\/safe-execution\//u;
  const workspaceDir = /^src\/adapters\/outbound\/workspace\//u;
  return (sqliteDir.test(file) && workspaceDir.test(resolved))
    || (workspaceDir.test(file) && sqliteDir.test(resolved));
}

/**
 * T-09 transition: sandbox-executor 直开 sqlite connection 写 execution 表
 *（writers.test.ts 已登记 workspace/ 为 safe-execution 合法 writer 目录）；
 * T-13/T-14 收编为事务协调 Port 形态后移除。
 * T-11 transition: review-delivery 的 review-material/review-schema 复用
 * safe-execution workspace adapter 的 redactProcessOutput 做公开文本脱敏判定
 *（sqlite→workspace 跨技术读）；T-13 收编为显式能力后移除。
 */
const TRANSITIONAL_ADAPTER_EDGES: Array<{ file: string; specifier: string }> = [
  {
    file: "src/adapters/outbound/workspace/sandbox-executor.ts",
    specifier: "@/src/adapters/outbound/sqlite/connection",
  },
  {
    file: "src/adapters/outbound/sqlite/review-delivery/review-material.ts",
    specifier: "@/src/adapters/outbound/workspace/process-runner",
  },
  {
    file: "src/adapters/outbound/sqlite/review-delivery/review-schema.ts",
    specifier: "@/src/adapters/outbound/workspace/process-runner",
  },
  // T-12 transition: sqlite 各 owner Adapter 跨技术读 model-runtime 的
  // provider-verifier/openai-chat-client（迁移前同经 src/server legacy 路径）；
  // T-13 收编为显式能力后移除。
  {
    file: "src/adapters/outbound/sqlite/identity-capability/provider-service.ts",
    specifier: "@/src/adapters/outbound/model-runtime/provider-verifier",
  },
  {
    file: "src/adapters/outbound/sqlite/review-delivery/review-slice-service.ts",
    specifier: "@/src/adapters/outbound/model-runtime/openai-chat-client",
  },
  {
    file: "src/adapters/outbound/sqlite/review-delivery/review-orchestrator.ts",
    specifier: "@/src/adapters/outbound/model-runtime/openai-chat-client",
  },
  {
    file: "src/adapters/outbound/sqlite/review-delivery/review-structured-repair.ts",
    specifier: "@/src/adapters/outbound/model-runtime/openai-chat-client",
  },
  {
    file: "src/adapters/outbound/sqlite/safe-execution/action-orchestrator.ts",
    specifier: "@/src/adapters/outbound/model-runtime/openai-chat-client",
  },
  {
    file: "src/adapters/outbound/sqlite/safe-execution/execution-structured-repair.ts",
    specifier: "@/src/adapters/outbound/model-runtime/openai-chat-client",
  },
];

/**
 * T-12 transition: public-collaboration 的 structured-repair 仍直调 model-runtime
 * outbound Adapter（迁移前经 src/server legacy 路径引用同一客户端，当时
 * src/server 不在 FORBIDDEN_IN_MODULES 内）；T-13 收编为显式 Port 注入后移除。
 */
const TRANSITIONAL_MODULE_ADAPTER_EDGES: Array<{ file: string; specifier: string }> = [
  {
    file: "src/modules/public-collaboration/internal/structured-repair.ts",
    specifier: "@/src/adapters/outbound/model-runtime/openai-chat-client",
  },
];

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
    const found = violations(files, FORBIDDEN_IN_MODULES).filter(
      (entry) =>
        !TRANSITIONAL_MODULE_ADAPTER_EDGES.some(
          (edge) => entry === `${edge.file} -> ${edge.specifier}`,
        ),
    );
    expect(found).toEqual([]);
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
        if (
          otherTech && ownTech && otherTech !== ownTech
          && !isSafeExecutionSameOwnerEdge(file, resolved)
          && !TRANSITIONAL_ADAPTER_EDGES.some(
            (entry) => entry.file === file && entry.specifier === edge.specifier,
          )
        ) {
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