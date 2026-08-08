"use client";

import type { ReactElement } from "react";

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
  activePath: string;
  returnTo?: "/" | `/projects/${string}`;
};

type NavItem = {
  href: string;
  label: string;
  icon: ReactElement;
};

function ChatIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={20}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
      width={20}
    >
      <path d="M4 6h16v10H8l-4 4V6Z" />
    </svg>
  );
}

function TeamIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={20}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
      width={20}
    >
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 18a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="8" r="2.5" />
      <path d="M15 18a4.5 4.5 0 0 1 6-4.2" />
    </svg>
  );
}

function GuideIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={20}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
      width={20}
    >
      <path d="M5 5.5h14v13H5z" />
      <path d="M8 9h8M8 12h5M8 15h7" />
    </svg>
  );
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "工作", icon: <ChatIcon /> },
  { href: "/team", label: "团队", icon: <TeamIcon /> },
  {
    href: "/team?section=providers&guide=provider&returnTo=/",
    label: "首次使用引导",
    icon: <GuideIcon />,
  },
];

export function ActivityBar({
  activePath,
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
        return (
          <a
            key={item.href}
            aria-current={isActive ? "page" : undefined}
            className="activity-bar-item"
            href={href}
            title={item.label}
          >
            {item.icon}
          </a>
        );
      })}
      {pinnedSections.map((section) => (
        <a
          key={`settings-${section.id}`}
          aria-label={`打开固定设置：${section.label}`}
          className="activity-bar-item"
          href={buildSettingsHref(section.id, settingsReturnTo)}
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
        className="activity-bar-item"
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
        {themePreference.hydrated
          ? themePreference.theme === "light"
            ? "夜"
            : "日"
          : "·"}
      </button>
      {themeStatus ? (
        <span className="activity-bar-status" role="status">
          {themeStatus}
        </span>
      ) : null}
    </nav>
  );
}
