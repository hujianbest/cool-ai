import type { Project } from "@/src/shared/contracts";

export type HomeAgent = {
  accentToken: string;
  avatarText: string;
  id: string;
  name: string;
  role: string;
};

export type HomeState =
  | { kind: "needs_agent" }
  | {
      agent: HomeAgent;
      kind: "ready";
      project: Project;
      threads: unknown[];
    };

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function parseProject(value: unknown): Project | null {
  if (!exactRecord(value, ["createdAt", "id", "name"])) return null;
  const { createdAt, id, name } = value;
  return typeof createdAt === "string" &&
    typeof id === "string" &&
    typeof name === "string"
    ? { createdAt, id, name }
    : null;
}

function parseAgent(value: unknown): HomeAgent | null {
  if (
    !exactRecord(value, [
      "accentToken",
      "avatarText",
      "id",
      "name",
      "role",
    ])
  ) {
    return null;
  }
  const { accentToken, avatarText, id, name, role } = value;
  return typeof accentToken === "string" &&
    typeof avatarText === "string" &&
    typeof id === "string" &&
    typeof name === "string" &&
    typeof role === "string"
    ? { accentToken, avatarText, id, name, role }
    : null;
}

export function parseHomeState(value: unknown): HomeState | null {
  if (exactRecord(value, ["kind"]) && value.kind === "needs_agent") {
    return { kind: "needs_agent" };
  }
  if (
    !exactRecord(value, ["agent", "kind", "project", "threads"]) ||
    value.kind !== "ready" ||
    !Array.isArray(value.threads)
  ) {
    return null;
  }
  const agent = parseAgent(value.agent);
  const project = parseProject(value.project);
  if (!agent || !project) return null;
  return {
    agent,
    kind: "ready",
    project,
    threads: value.threads,
  };
}
