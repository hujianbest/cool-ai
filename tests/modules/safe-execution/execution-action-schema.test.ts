import { describe, expect, it } from "vitest";

type Permissions = { read: boolean; write: boolean; execute: boolean };
type ParseResult =
  | { success: true; action: { summary: string; action: { type: string } } }
  | {
      success: false;
      action: null;
      reason: "invalid_schema" | "permission_denied";
      permission: "read" | "write" | "execute" | null;
    };
type SchemaModule = {
  parseExecutionActionContent(content: string, permissions: Permissions): ParseResult;
};

const schemaModules = import.meta.glob<SchemaModule>(
  "../../../src/modules/safe-execution/internal/execution-action-schema.ts",
);
const allPermissions = { read: true, write: true, execute: true };
const hash = "a".repeat(64);

async function loadSchema(): Promise<SchemaModule> {
  const load = schemaModules["../../../src/modules/safe-execution/internal/execution-action-schema.ts"];
  expect(load, "the strict execution action schema must exist").toBeTypeOf("function");
  return load();
}

async function parse(
  action: unknown,
  permissions: Permissions = allPermissions,
): Promise<ParseResult> {
  const { parseExecutionActionContent } = await loadSchema();
  return parseExecutionActionContent(JSON.stringify(action), permissions);
}

function envelope(action: unknown, summary = "Visible result"): unknown {
  return { summary, action };
}

describe("strict execution action schema", () => {
  it("accepts exactly one list, read, write, command, or staged action", async () => {
    const actions = [
      { type: "list", path: "." },
      { type: "read", path: "src/index.ts" },
      { type: "write", path: "src/index.ts", content: "", expectedHash: null },
      { type: "write", path: "src/index.ts", content: "next", expectedHash: hash },
      {
        type: "command",
        executable: "node",
        args: ["--version"],
        workdir: ".",
        expectedEffect: "Print the runtime version.",
      },
      { type: "staged" },
    ];

    for (const action of actions) {
      await expect(parse(envelope(action))).resolves.toMatchObject({
        success: true,
        action: { summary: "Visible result", action },
      });
    }
  });

  it("rejects unknown, missing, mixed, and malformed fields at every depth", async () => {
    const invalid = [
      { ...envelope({ type: "staged" }) as object, hiddenThoughts: "no" },
      envelope({ type: "list", path: ".", recursive: true }),
      envelope({ type: "read", path: ".", content: "mixed" }),
      envelope({ type: "write", path: "a", content: "x" }),
      envelope({ type: "write", path: "a", content: "x", expectedHash: "A".repeat(64) }),
      envelope({ type: "command", executable: "node", args: [], workdir: ".", expectedEffect: "ok", shell: true }),
      envelope({ type: "staged", path: "." }),
      envelope({ type: "other" }),
      { summary: "missing action" },
      { action: { type: "staged" } },
    ];

    for (const value of invalid) {
      await expect(parse(value)).resolves.toMatchObject({
        success: false,
        action: null,
        reason: "invalid_schema",
      });
    }
    const { parseExecutionActionContent } = await loadSchema();
    expect(parseExecutionActionContent("not-json", allPermissions)).toEqual({
      success: false,
      action: null,
      reason: "invalid_schema",
      permission: null,
    });
  });

  it("enforces visible summary, path, write, and command bounds exactly", async () => {
    await expect(parse(envelope({ type: "staged" }, "x".repeat(2_000)))).resolves.toMatchObject({ success: true });
    await expect(parse(envelope({ type: "staged" }, "x".repeat(2_001)))).resolves.toMatchObject({ success: false });
    await expect(parse(envelope({ type: "staged" }, "   "))).resolves.toMatchObject({ success: false });

    await expect(parse(envelope({ type: "read", path: "x".repeat(4_096) }))).resolves.toMatchObject({ success: true });
    await expect(parse(envelope({ type: "read", path: "x".repeat(4_097) }))).resolves.toMatchObject({ success: false });
    await expect(parse(envelope({ type: "read", path: "" }))).resolves.toMatchObject({ success: false });

    await expect(parse(envelope({
      type: "write",
      path: "a",
      content: "x".repeat(1_048_576),
      expectedHash: null,
    }))).resolves.toMatchObject({ success: true });
    await expect(parse(envelope({
      type: "write",
      path: "a",
      content: "x".repeat(1_048_577),
      expectedHash: null,
    }))).resolves.toMatchObject({ success: false });
    await expect(parse(envelope({
      type: "write",
      path: "a",
      content: "before\u0000after",
      expectedHash: null,
    }))).resolves.toMatchObject({ success: false });

    const command = {
      type: "command",
      executable: "x".repeat(4_096),
      args: Array.from({ length: 64 }, () => "x".repeat(512)),
      workdir: "x".repeat(4_096),
      expectedEffect: "x".repeat(2_000),
    };
    await expect(parse(envelope(command))).resolves.toMatchObject({ success: true });
    await expect(parse(envelope({ ...command, args: [...command.args, ""] }))).resolves.toMatchObject({ success: false });
    await expect(parse(envelope({ ...command, args: ["x".repeat(4_097)] }))).resolves.toMatchObject({ success: false });
    await expect(parse(envelope({ ...command, args: ["é".repeat(16_385)] }))).resolves.toMatchObject({ success: false });
    await expect(parse(envelope({ ...command, expectedEffect: "" }))).resolves.toMatchObject({ success: false });
    await expect(parse(envelope({ ...command, expectedEffect: "x".repeat(2_001) }))).resolves.toMatchObject({ success: false });
  });

  it("binds read, write, and command actions to the exact Agent capability", async () => {
    const cases = [
      [{ type: "list", path: "." }, "read"],
      [{ type: "read", path: "a" }, "read"],
      [{ type: "write", path: "a", content: "x", expectedHash: null }, "write"],
      [{ type: "command", executable: "node", args: [], workdir: ".", expectedEffect: "test" }, "execute"],
    ] as const;

    for (const [action, permission] of cases) {
      const permissions = { ...allPermissions, [permission]: false };
      await expect(parse(envelope(action), permissions)).resolves.toEqual({
        success: false,
        action: null,
        reason: "permission_denied",
        permission,
      });
    }
    await expect(parse(envelope({ type: "staged" }), {
      read: false,
      write: false,
      execute: false,
    })).resolves.toMatchObject({ success: true });
  });
});
