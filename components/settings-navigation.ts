export type SettingsSectionId = "skills" | "providers" | "agents";

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  purpose: string;
  keywords: readonly string[];
  available: true;
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "skills",
    label: "技能",
    purpose: "管理可复用技能",
    keywords: ["skill", "skills", "技能"],
    available: true,
  },
  {
    id: "providers",
    label: "模型服务",
    purpose: "管理模型服务连接",
    keywords: ["provider", "providers", "model", "模型", "模型服务"],
    available: true,
  },
  {
    id: "agents",
    label: "Agent",
    purpose: "管理 Agent 成员与职责",
    keywords: ["agent", "agents", "成员", "智能体"],
    available: true,
  },
];

const SETTINGS_SECTION_IDS = new Set<SettingsSectionId>(
  SETTINGS_SECTIONS.map(({ id }) => id),
);
const PATH_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;

export type ProjectReturnTo = "/" | `/projects/${string}`;

export type ProjectSelection = {
  href: `/projects/${string}`;
  projectHref: `/projects/${string}`;
  projectId: string;
  runId: string | null;
  threadId: string | null;
};

function decodePathSafeId(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return PATH_SAFE_ID.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function pathSafeId(value: string): string | null {
  return PATH_SAFE_ID.test(value) ? value : null;
}

export function parseProjectSelection(value: string): ProjectSelection | null {
  if (!value.startsWith("/projects/") || value.startsWith("//") || value.includes("#")) {
    return null;
  }
  const queryIndex = value.indexOf("?");
  const rawPath = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? "" : value.slice(queryIndex + 1);
  const rawProjectId = rawPath.slice("/projects/".length);
  if (!rawProjectId || rawProjectId.includes("/")) return null;
  const projectId = decodePathSafeId(rawProjectId);
  if (!projectId) return null;

  const projectHref = `/projects/${encodeURIComponent(projectId)}` as const;
  if (queryIndex === -1) {
    return {
      href: projectHref,
      projectHref,
      projectId,
      runId: null,
      threadId: null,
    };
  }
  if (!rawQuery || rawQuery.split("&").some((part) => part === "")) return null;

  const searchParams = new URLSearchParams(rawQuery);
  for (const key of new Set(searchParams.keys())) {
    if (key !== "thread" && key !== "run") return null;
  }
  const threadValues = searchParams.getAll("thread");
  const runValues = searchParams.getAll("run");
  if (threadValues.length !== 1 || runValues.length > 1) return null;
  const threadId = pathSafeId(threadValues[0]!);
  const runId = runValues.length === 1 ? pathSafeId(runValues[0]!) : null;
  if (!threadId || (runValues.length === 1 && !runId)) return null;

  const href = `${projectHref}?thread=${encodeURIComponent(threadId)}${
    runId ? `&run=${encodeURIComponent(runId)}` : ""
  }` as `/projects/${string}`;
  return { href, projectHref, projectId, runId, threadId };
}

export function parseSingleParam(
  value: string | string[] | undefined,
): string | null {
  return typeof value === "string" ? value : null;
}

export function parseSettingsSection(
  value: string | string[] | undefined,
): SettingsSectionId {
  const section = parseSingleParam(value);
  return section && SETTINGS_SECTION_IDS.has(section as SettingsSectionId)
    ? (section as SettingsSectionId)
    : "skills";
}

export function parseReturnTo(
  value: string | string[] | undefined,
): ProjectReturnTo {
  const returnTo = parseSingleParam(value);
  if (returnTo === "/") return "/";
  return returnTo ? parseProjectSelection(returnTo)?.href ?? "/" : "/";
}

export async function reconcileReturnTo(
  value: string | string[] | undefined,
  tupleExists: (
    projectId: string,
    threadId: string,
    runId: string | null,
  ) => boolean | Promise<boolean>,
): Promise<ProjectReturnTo> {
  const returnTo = parseSingleParam(value);
  if (returnTo === "/") return "/";
  if (!returnTo) return "/";
  const selection = parseProjectSelection(returnTo);
  if (!selection) return "/";
  if (!selection.threadId) return selection.href;
  try {
    return (await tupleExists(
      selection.projectId,
      selection.threadId,
      selection.runId,
    ))
      ? selection.href
      : selection.projectHref;
  } catch {
    return selection.projectHref;
  }
}

export function buildSettingsHref(
  section: SettingsSectionId,
  returnTo: string,
): string {
  const searchParams = new URLSearchParams({
    section,
    returnTo: parseReturnTo(returnTo),
  });
  return `/team?${searchParams.toString()}`;
}
