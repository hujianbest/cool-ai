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
const PROJECT_RETURN_PATH = /^\/projects\/[A-Za-z0-9_-]+$/;

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
): "/" | `/projects/${string}` {
  const returnTo = parseSingleParam(value);
  if (returnTo === "/") return "/";
  return returnTo && PROJECT_RETURN_PATH.test(returnTo)
    ? (returnTo as `/projects/${string}`)
    : "/";
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
