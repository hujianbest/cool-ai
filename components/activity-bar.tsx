"use client";

import {
  Brain,
  ChatCircle,
  CheckSquare,
  Gear,
  ListMagnifyingGlass,
  Moon,
  ShieldCheck,
  Sun,
  UsersThree,
} from "@phosphor-icons/react";

import {
  buildSettingsHref,
  parseProjectSelection,
  SETTINGS_SECTIONS,
} from "@/components/settings-navigation";
import { useSettingsPreferences } from "@/components/settings-preferences-store";
import {
  setThemePreference,
  useThemePreference,
} from "@/components/theme-preference-store";

export type ActivityBarProps = {
  activeGovernance?: GovernanceView | null;
  activePath: string;
  needsMe?: boolean;
  onGovernance?: (view: GovernanceView | null) => void;
  returnTo?: "/" | `/projects/${string}`;
};

export type GovernanceView = "mission" | "memory" | "approvals" | "audit";

type GovernanceItem = {
  icon: typeof Brain;
  label: string;
  view: GovernanceView;
};

const GOVERNANCE_ITEMS: readonly GovernanceItem[] = [
  { view: "mission", icon: CheckSquare, label: "任务" },
  { view: "memory", icon: Brain, label: "记忆" },
  { view: "approvals", icon: ShieldCheck, label: "审批" },
  { view: "audit", icon: ListMagnifyingGlass, label: "审计" },
];

export function ActivityBar({
  activeGovernance = null,
  activePath,
  needsMe = false,
  onGovernance,
  returnTo,
}: ActivityBarProps) {
  const { preference } = useSettingsPreferences();
  const themePreference = useThemePreference();
  const themeStatus = themePreference.error
    ? {
        read: "主题偏好读取失败，已使用明色主题",
        invalid: "主题偏好数据无效，已使用明色主题",
        write: "主题偏好保存失败，仍保持当前主题",
      }[themePreference.error]
    : null;
  const settingsReturnTo = returnTo ?? activePath;
  const chatHref =
    parseProjectSelection(activePath)?.projectHref ??
    (settingsReturnTo.startsWith("/projects/") ? settingsReturnTo : "/");
  const chatIsActive =
    (activePath === "/" || Boolean(parseProjectSelection(activePath))) &&
    !activeGovernance;
  const teamIsActive = activePath === "/team" || activePath.startsWith("/team?");
  const teamHref = buildSettingsHref("skills", settingsReturnTo);
  const settingsHref = buildSettingsHref("providers", settingsReturnTo);
  const pinnedSections = preference.pinned.flatMap((id) => {
    const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === id);
    return section?.available ? [section] : [];
  });

  return (
    <nav aria-label="主导航" className="activity-bar">
      <a
        aria-current={chatIsActive ? "page" : undefined}
        aria-label="对话"
        className="activity-bar-item"
        data-tooltip="对话"
        href={chatHref}
        onClick={(event) => {
          onGovernance?.(null);
          if (chatHref === activePath) {
            event.preventDefault();
          }
        }}
      >
        <ChatCircle aria-hidden="true" size={20} weight="regular" />
      </a>
      {GOVERNANCE_ITEMS.map((item) => {
        const Icon = item.icon;
        const attention = needsMe && item.view === "approvals";
        return (
          <button
            aria-pressed={activeGovernance === item.view}
            aria-label={attention ? `${item.label}，有待处理项` : item.label}
            className="activity-bar-item"
            data-tooltip={item.label}
            key={item.view}
            onClick={() => onGovernance?.(item.view)}
            type="button"
          >
            <Icon aria-hidden="true" size={20} weight="regular" />
            {attention ? (
              <span aria-hidden="true" className="activity-bar-attention" />
            ) : null}
          </button>
        );
      })}
      <div aria-hidden="true" className="activity-bar-separator" />
      <a
        aria-current={teamIsActive ? "page" : undefined}
        aria-label="团队"
        className="activity-bar-item"
        data-tooltip="团队"
        href={teamHref}
      >
        <UsersThree aria-hidden="true" size={20} weight="regular" />
      </a>
      <a
        aria-label="设置"
        className="activity-bar-item"
        data-tooltip="设置"
        href={settingsHref}
      >
        <Gear aria-hidden="true" size={20} weight="regular" />
      </a>
      {pinnedSections.map((section) => (
        <a
          aria-label={`打开固定设置：${section.label}`}
          className="activity-bar-item"
          data-tooltip={section.label}
          href={buildSettingsHref(section.id, settingsReturnTo)}
          key={`settings-${section.id}`}
        >
          <span aria-hidden="true">
            {section.id === "agents" ? "A" : section.label.slice(0, 1)}
          </span>
        </a>
      ))}
      <button
        aria-busy={themePreference.hydrated ? undefined : true}
        aria-label={
          themePreference.hydrated
            ? themePreference.theme === "light"
              ? "当前为明色主题，切换到暗色主题"
              : "当前为暗色主题，切换到明色主题"
            : "主题偏好加载中"
        }
        aria-pressed={
          themePreference.hydrated
            ? themePreference.theme === "dark"
            : undefined
        }
        className="activity-bar-item activity-bar-end"
        data-tooltip={
          themePreference.hydrated
            ? themePreference.theme === "light"
              ? "切换到暗色主题"
              : "切换到明色主题"
            : "主题偏好加载中"
        }
        disabled={!themePreference.hydrated}
        onClick={() =>
          setThemePreference(
            themePreference.theme === "light" ? "dark" : "light",
          )
        }
        type="button"
      >
        {themePreference.hydrated ? (
          themePreference.theme === "light" ? (
            <Moon aria-hidden="true" size={20} weight="regular" />
          ) : (
            <Sun aria-hidden="true" size={20} weight="regular" />
          )
        ) : (
          <span aria-hidden="true">·</span>
        )}
      </button>
      {themeStatus ? (
        <span className="activity-bar-status" role="status">
          {themeStatus}
        </span>
      ) : null}
    </nav>
  );
}
