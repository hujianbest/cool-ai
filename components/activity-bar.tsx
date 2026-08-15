"use client";

import {
  BookOpen,
  Brain,
  ChatCircle,
  CheckCircle,
  ClockCounterClockwise,
  Kanban,
  Moon,
  Sun,
  UsersThree,
} from "@phosphor-icons/react";

import {
  buildSettingsHref,
  parseReturnTo,
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
  onGovernance?: (view: GovernanceView) => void;
  returnTo?: "/" | `/projects/${string}`;
};

export type GovernanceView = "mission" | "memory" | "approvals" | "audit";

type NavItem = {
  href: string;
  icon: typeof ChatCircle;
  label: string;
};

type GovernanceItem = {
  icon: typeof Brain;
  label: string;
  view: GovernanceView;
};

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", icon: ChatCircle, label: "工作" },
  { href: "/team", icon: UsersThree, label: "团队" },
  {
    href: "/team?section=providers&guide=provider&returnTo=/",
    icon: BookOpen,
    label: "首次使用引导",
  },
];

const GOVERNANCE_ITEMS: readonly GovernanceItem[] = [
  { view: "mission", icon: Kanban, label: "任务" },
  { view: "memory", icon: Brain, label: "记忆" },
  { view: "approvals", icon: CheckCircle, label: "审批" },
  { view: "audit", icon: ClockCounterClockwise, label: "审计" },
];

export function ActivityBar({
  activeGovernance = null,
  activePath,
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
  const workIsActive =
    activePath === "/" || parseReturnTo(activePath) === activePath;
  const pinnedSections = preference.pinned.flatMap((id) => {
    const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === id);
    return section?.available ? [section] : [];
  });

  return (
    <nav aria-label="主导航" className="activity-bar">
      {NAV_ITEMS.map((item) => {
        const isActive =
          item.href === "/" ? workIsActive : activePath === item.href;
        const href =
          item.href === "/team"
            ? buildSettingsHref("skills", settingsReturnTo)
            : item.href;
        const Icon = item.icon;
        return (
          <a
            aria-current={isActive ? "page" : undefined}
            aria-label={item.label}
            className="activity-bar-item"
            href={href}
            key={item.href}
            title={item.label}
          >
            <Icon aria-hidden="true" size={20} weight="regular" />
          </a>
        );
      })}
      <div aria-hidden="true" className="activity-bar-separator" />
      {GOVERNANCE_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            aria-pressed={activeGovernance === item.view}
            aria-label={item.label}
            className="activity-bar-item"
            key={item.view}
            onClick={() => onGovernance?.(item.view)}
            title={item.label}
            type="button"
          >
            <Icon aria-hidden="true" size={20} weight="regular" />
          </button>
        );
      })}
      {pinnedSections.map((section) => (
        <a
          aria-label={`打开固定设置：${section.label}`}
          className="activity-bar-item"
          href={buildSettingsHref(section.id, settingsReturnTo)}
          key={`settings-${section.id}`}
          title={`固定设置：${section.label}`}
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
        disabled={!themePreference.hydrated}
        onClick={() =>
          setThemePreference(
            themePreference.theme === "light" ? "dark" : "light",
          )
        }
        title={
          themePreference.hydrated
            ? themePreference.theme === "light"
              ? "切换到暗色主题"
              : "切换到明色主题"
            : "主题偏好加载中"
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
