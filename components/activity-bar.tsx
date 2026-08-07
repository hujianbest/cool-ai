"use client";

import type { ReactElement } from "react";

export type ActivityBarProps = {
  activePath: string;
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

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "工作", icon: <ChatIcon /> },
  { href: "/team", label: "团队", icon: <TeamIcon /> },
];

export function ActivityBar({ activePath }: ActivityBarProps) {
  return (
    <nav aria-label="主导航" className="activity-bar">
      {NAV_ITEMS.map((item) => {
        const isActive = activePath === item.href;
        return (
          <a
            key={item.href}
            aria-current={isActive ? "page" : undefined}
            className="activity-bar-item"
            href={item.href}
            title={item.label}
          >
            {item.icon}
          </a>
        );
      })}
    </nav>
  );
}
