import { createHash } from "node:crypto";
import path from "node:path";

export const CLASSIFIER_VERSION = 1;

export type CommandInput = {
  args: string[];
  executable: string;
  executableIdentity: string;
  workdir: string;
};

export type StandingPolicyEntry = CommandInput & {
  required: boolean;
  tupleHash: string;
};

export type CommandPolicyContext = {
  canonicalRoot: string;
  executionRoot: string;
  platform: "posix" | "win32";
  sandboxRoot: string;
};

export type CommandClassification = {
  code: string | null;
  classifierVersion: number;
  decision: "deny" | "one_shot" | "standing_eligible" | "standing_exact";
  parseResult: "known" | "unknown_non_path" | "unknown_path_syntax";
  riskReasons: string[];
};

const SHELL_EXECUTABLES = new Set([
  "bash", "cmd", "cscript", "fish", "powershell", "pwsh", "sh", "wscript", "zsh",
]);
const KNOWN_EXECUTABLES = new Set([
  "git", "node", "npm", "npx", "pnpm", "python", "python3", "tsc", "vitest", "yarn",
]);
const PATH_OPTIONS = new Set(["-C", "--cwd", "--dir", "--output", "--prefix"]);
const SHELL_CONTROL_TOKENS = new Set(["|", "||", "&&", ">", ">>", "<", ";"]);

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function executableBase(executable: string): string {
  const normalized = executable.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.(?:exe)$/i, "").toLowerCase();
}

function denied(
  code: string,
  parseResult: CommandClassification["parseResult"] = "known",
): CommandClassification {
  return {
    classifierVersion: CLASSIFIER_VERSION,
    code,
    decision: "deny",
    parseResult,
    riskReasons: [],
  };
}

export function normalizeRelativeWorkdir(workdir: string): string {
  if (
    typeof workdir !== "string"
    || workdir.length === 0
    || workdir.includes("\0")
    || /^[a-zA-Z]:/.test(workdir)
    || workdir.startsWith("/")
    || workdir.startsWith("\\")
  ) {
    throw new Error("PATH_ESCAPE_DENIED");
  }
  const segments = workdir.replaceAll("\\", "/").split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) throw new Error("PATH_ESCAPE_DENIED");
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join("/") || ".";
}

export function commandTupleHash(input: CommandInput & { required: boolean }): string {
  return digest({
    args: input.args,
    classifierVersion: CLASSIFIER_VERSION,
    executable: input.executable,
    executableIdentity: input.executableIdentity,
    required: input.required,
    workdir: normalizeRelativeWorkdir(input.workdir),
  });
}

function pathApi(context: CommandPolicyContext): typeof path.posix {
  return context.platform === "win32" ? path.win32 : path.posix;
}

function comparable(value: string, context: CommandPolicyContext): string {
  const normalized = pathApi(context).normalize(value).replaceAll("\\", "/").replace(/\/+$/, "");
  return context.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(value: string, root: string, context: CommandPolicyContext): boolean {
  const candidate = comparable(value, context);
  const parent = comparable(root, context);
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function inspectPath(
  value: string,
  normalizedWorkdir: string,
  context: CommandPolicyContext,
): CommandClassification | null {
  if (!value || value.includes("\0")) {
    return denied("UNKNOWN_PATH_SYNTAX_DENIED", "unknown_path_syntax");
  }
  const api = pathApi(context);
  const nativeValue = context.platform === "win32" ? value.replaceAll("/", "\\") : value;
  const absolute = api.isAbsolute(nativeValue) || /^[a-zA-Z]:/.test(value) || /^[/\\]{2}/.test(value);
  const sandbox = context.platform === "win32"
    ? context.sandboxRoot.replaceAll("/", "\\")
    : context.sandboxRoot;
  let resolved: string;
  if (absolute) {
    resolved = api.normalize(nativeValue);
  } else {
    const cwd = normalizedWorkdir === "."
      ? sandbox
      : api.join(sandbox, normalizedWorkdir);
    resolved = api.resolve(cwd, nativeValue);
  }
  if (
    !isInside(resolved, context.sandboxRoot, context)
    || isInside(resolved, context.canonicalRoot, context)
    || (
      isInside(resolved, context.executionRoot, context)
      && !isInside(resolved, context.sandboxRoot, context)
    )
  ) {
    return denied("PATH_ESCAPE_DENIED");
  }
  return null;
}

function isPathShaped(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (/^[a-zA-Z]:/.test(value) || value.startsWith("/") || value.startsWith("\\\\")) return true;
  return value.includes("/")
    || value.includes("\\")
    || value.split(/[\\/]/).some((segment) => segment === "." || segment === "..");
}

function mechanicalClassification(
  input: CommandInput,
  context: CommandPolicyContext,
): Omit<CommandClassification, "decision"> | CommandClassification {
  const base = executableBase(input.executable);
  if (SHELL_EXECUTABLES.has(base)) return denied("SHELL_EXECUTABLE_DENIED");
  if (/\.(?:bat|cmd|ps1|sh)$/i.test(input.executable)) return denied("SHELL_SCRIPT_DENIED");
  for (const argument of input.args) {
    if (SHELL_CONTROL_TOKENS.has(argument)) return denied("SHELL_CONTROL_DENIED");
    if (/\$\(|`[^`]*`/.test(argument)) return denied("COMMAND_SUBSTITUTION_DENIED");
    if (/\$\{[^}]+\}|%[A-Za-z_][A-Za-z0-9_]*%/.test(argument)) {
      return denied("ENV_EXPANSION_DENIED");
    }
  }
  const lowerArgs = input.args.map((argument) => argument.toLowerCase());
  if (
    (base === "git" && ["push", "remote", "credential"].includes(lowerArgs[0] ?? ""))
    || (["npm", "pnpm", "yarn"].includes(base)
      && lowerArgs.some((argument) => ["deploy", "publish", "release"].includes(argument)))
  ) {
    return denied("DEPLOY_PUBLISH_PUSH_DENIED");
  }
  if (["scp", "sftp", "ssh"].includes(base)) return denied("REMOTE_TRANSFER_DENIED");

  let normalizedWorkdir: string;
  try {
    normalizedWorkdir = normalizeRelativeWorkdir(input.workdir);
  } catch {
    return denied("PATH_ESCAPE_DENIED");
  }
  for (let index = 0; index < input.args.length; index += 1) {
    const argument = input.args[index]!;
    if (PATH_OPTIONS.has(argument)) {
      const value = input.args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return denied("UNKNOWN_PATH_SYNTAX_DENIED", "unknown_path_syntax");
      }
      const pathDenial = inspectPath(value, normalizedWorkdir, context);
      if (pathDenial) return pathDenial;
      index += 1;
      continue;
    }
    const equals = argument.indexOf("=");
    if (equals > 0 && PATH_OPTIONS.has(argument.slice(0, equals))) {
      const pathDenial = inspectPath(argument.slice(equals + 1), normalizedWorkdir, context);
      if (pathDenial) return pathDenial;
      continue;
    }
    if (isPathShaped(argument)) {
      const pathDenial = inspectPath(argument, normalizedWorkdir, context);
      if (pathDenial) return pathDenial;
    }
  }
  const known = KNOWN_EXECUTABLES.has(base);
  return {
    classifierVersion: CLASSIFIER_VERSION,
    code: null,
    parseResult: known ? "known" : "unknown_non_path",
    riskReasons: known ? [] : ["UNKNOWN_NON_PATH_BEHAVIOR"],
  };
}

export function classifyPolicyEntry(
  input: CommandInput,
  context: CommandPolicyContext,
): CommandClassification {
  const result = mechanicalClassification(input, context);
  if ("decision" in result) return result;
  return { ...result, decision: "standing_eligible" };
}

export function classifyExecutionCommand(
  input: CommandInput,
  standingEntries: StandingPolicyEntry[],
  context: CommandPolicyContext,
): CommandClassification {
  const result = mechanicalClassification(input, context);
  if ("decision" in result) return result;
  const workdir = normalizeRelativeWorkdir(input.workdir);
  const exact = standingEntries.some((entry) =>
    entry.executable === input.executable
    && entry.executableIdentity === input.executableIdentity
    && entry.workdir === workdir
    && entry.args.length === input.args.length
    && entry.args.every((argument, index) => argument === input.args[index]));
  return { ...result, decision: exact ? "standing_exact" : "one_shot" };
}
