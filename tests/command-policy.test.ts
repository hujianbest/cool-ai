import { beforeAll, describe, expect, it } from "vitest";

type CommandInput = {
  args: string[];
  executable: string;
  executableIdentity: string;
  workdir: string;
};
type StandingEntry = CommandInput & {
  required: boolean;
  tupleHash: string;
};
type Classification = {
  code: string | null;
  classifierVersion: number;
  decision: "deny" | "one_shot" | "standing_eligible" | "standing_exact";
  parseResult: "known" | "unknown_non_path" | "unknown_path_syntax";
  riskReasons: string[];
};
type CommandPolicyModule = {
  CLASSIFIER_VERSION: number;
  classifyExecutionCommand(
    input: CommandInput,
    standingEntries: StandingEntry[],
    context: PolicyContext,
  ): Classification;
  classifyPolicyEntry(input: CommandInput, context: PolicyContext): Classification;
  commandTupleHash(input: CommandInput & { required: boolean }): string;
  normalizeRelativeWorkdir(workdir: string): string;
};
type PolicyContext = {
  canonicalRoot: string;
  executionRoot: string;
  platform: "posix" | "win32";
  sandboxRoot: string;
};

const IDENTITY = "a".repeat(64);
const WINDOWS: PolicyContext = {
  canonicalRoot: "D:/project",
  executionRoot: "D:/execution-root",
  platform: "win32",
  sandboxRoot: "D:/execution-root/project/execution/1/sandbox",
};
const POSIX: PolicyContext = {
  canonicalRoot: "/workspace/project",
  executionRoot: "/var/lib/cool-ai/executions",
  platform: "posix",
  sandboxRoot: "/var/lib/cool-ai/executions/p/e/1/sandbox",
};

let commandPolicy: CommandPolicyModule;

function command(overrides: Partial<CommandInput> = {}): CommandInput {
  return {
    args: ["test", "--runInBand"],
    executable: "C:/verified/node.exe",
    executableIdentity: IDENTITY,
    workdir: ".",
    ...overrides,
  };
}

beforeAll(async () => {
  try {
    commandPolicy = await import("@/src/server/execution/command-policy") as CommandPolicyModule;
  } catch {
    expect.fail("The T-11 mechanical command classifier is unavailable.");
  }
});

describe("versioned mechanical command policy", () => {
  it("loads the classifier implementation", () => {
    expect(commandPolicy.CLASSIFIER_VERSION).toBe(1);
  });

  it("treats only the exact executable, identity, ordered args, and normalized cwd as standing", () => {
    const exact = command({ workdir: "./packages/app/." });
    const standing: StandingEntry = {
      ...exact,
      workdir: "packages/app",
      required: true,
      tupleHash: commandPolicy.commandTupleHash({
        ...exact,
        workdir: "packages/app",
        required: true,
      }),
    };

    expect(commandPolicy.classifyExecutionCommand(exact, [standing], WINDOWS)).toMatchObject({
      decision: "standing_exact",
      parseResult: "known",
    });
    for (const near of [
      command({ args: ["--runInBand", "test"], workdir: "packages/app" }),
      command({ args: ["test", "--runinband"], workdir: "packages/app" }),
      command({ executable: "C:/verified/Node.exe", workdir: "packages/app" }),
      command({ executableIdentity: "b".repeat(64), workdir: "packages/app" }),
      command({ args: ["test", "--runInBand", ""], workdir: "packages/app" }),
      command({ workdir: "packages/other" }),
    ]) {
      expect(commandPolicy.classifyExecutionCommand(near, [standing], WINDOWS)).toMatchObject({
        decision: "one_shot",
      });
    }

    expect(commandPolicy.commandTupleHash({ ...standing, required: false }))
      .not.toBe(standing.tupleHash);
  });

  it.each([
    ["cmd.exe", ["/c", "npm", "test"], "SHELL_EXECUTABLE_DENIED"],
    ["powershell.exe", ["-Command", "npm test"], "SHELL_EXECUTABLE_DENIED"],
    ["/bin/bash", ["-lc", "npm test"], "SHELL_EXECUTABLE_DENIED"],
    ["C:/tools/build.cmd", [], "SHELL_SCRIPT_DENIED"],
    ["/workspace/build.sh", [], "SHELL_SCRIPT_DENIED"],
    ["C:/verified/node.exe", ["test", "&&", "publish"], "SHELL_CONTROL_DENIED"],
    ["C:/verified/node.exe", ["$(whoami)"], "COMMAND_SUBSTITUTION_DENIED"],
    ["C:/verified/node.exe", ["`whoami`"], "COMMAND_SUBSTITUTION_DENIED"],
    ["C:/verified/node.exe", ["${TOKEN}"], "ENV_EXPANSION_DENIED"],
    ["C:/verified/node.exe", ["%TOKEN%"], "ENV_EXPANSION_DENIED"],
  ])("denies shell form %s %j", (executable, args, code) => {
    const result = commandPolicy.classifyPolicyEntry(
      command({ args, executable }),
      WINDOWS,
    );
    expect(result).toMatchObject({ code, decision: "deny" });
  });

  it.each([
    ["C:/tools/git.exe", ["push", "origin", "main"], "DEPLOY_PUBLISH_PUSH_DENIED"],
    ["C:/tools/git.exe", ["remote", "-v"], "DEPLOY_PUBLISH_PUSH_DENIED"],
    ["C:/tools/git.exe", ["credential", "fill"], "DEPLOY_PUBLISH_PUSH_DENIED"],
    ["C:/tools/npm.exe", ["publish"], "DEPLOY_PUBLISH_PUSH_DENIED"],
    ["C:/tools/pnpm.exe", ["run", "deploy"], "DEPLOY_PUBLISH_PUSH_DENIED"],
    ["C:/tools/yarn.exe", ["release"], "DEPLOY_PUBLISH_PUSH_DENIED"],
    ["C:/tools/ssh.exe", ["host"], "REMOTE_TRANSFER_DENIED"],
    ["C:/tools/scp.exe", ["a", "host:b"], "REMOTE_TRANSFER_DENIED"],
  ])("denies known deploy/publish/push matrix %s %j", (executable, args, code) => {
    expect(commandPolicy.classifyPolicyEntry(
      command({ args, executable }),
      WINDOWS,
    )).toMatchObject({ code, decision: "deny", parseResult: "known" });
  });

  it("denies path escape, canonical/execution roots, and unknown path option syntax", () => {
    const denied = [
      command({ args: ["../outside"], workdir: "." }),
      command({ args: ["--cwd", "../../canonical"], workdir: "." }),
      command({ args: ["--output=D:/project/dist"], workdir: "." }),
      command({ args: ["-C", "D:/execution-root/other"], workdir: "." }),
      command({ args: ["--prefix"], workdir: "." }),
      command({ args: ["--dir="], workdir: "." }),
      command({ workdir: "../sandbox" }),
    ];

    for (const input of denied) {
      const result = commandPolicy.classifyPolicyEntry(input, WINDOWS);
      expect(result.decision).toBe("deny");
      expect(["PATH_ESCAPE_DENIED", "UNKNOWN_PATH_SYNTAX_DENIED"]).toContain(result.code);
    }
    expect(commandPolicy.classifyPolicyEntry(
      command({
        args: ["--output", "dist/reports", "src/test.ts"],
        executable: "/usr/bin/node",
        workdir: "./packages/app",
      }),
      POSIX,
    )).toMatchObject({ decision: "standing_eligible", parseResult: "known" });
  });

  it("allows unknown non-path behavior only as warned standing policy or one-shot execution", () => {
    const unknown = command({
      args: ["https://example.invalid/archive", "--retry", "2"],
      executable: "C:/tools/curl.exe",
    });
    const policyResult = commandPolicy.classifyPolicyEntry(unknown, WINDOWS);
    expect(policyResult).toMatchObject({
      code: null,
      decision: "standing_eligible",
      parseResult: "unknown_non_path",
    });
    expect(policyResult.riskReasons).toContain("UNKNOWN_NON_PATH_BEHAVIOR");

    const executionResult = commandPolicy.classifyExecutionCommand(unknown, [], WINDOWS);
    expect(executionResult).toMatchObject({
      decision: "one_shot",
      parseResult: "unknown_non_path",
    });
  });
});
