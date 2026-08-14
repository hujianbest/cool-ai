"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { AgentPanel } from "@/components/agent-panel";
import { ActivityBar } from "@/components/activity-bar";
import {
  trapModalFocus,
  useModalSurface,
  useNarrowMode,
} from "@/components/mobile-dialog";
import { ProviderPanel } from "@/components/provider-panel";
import {
  buildSettingsHref,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/components/settings-navigation";
import {
  pinSettingsSection,
  unpinSettingsSection,
  useSettingsPreferences,
} from "@/components/settings-preferences-store";
import { NotificationSettingsRegion } from "@/components/notifications/notification-settings-region";
import { SkillPanel } from "@/components/skill-panel";

const resources: SettingsSectionId[] = ["skills", "providers", "agents"];
const RESOURCE_NAV_INERT = [".cockpit-flow", ".cockpit-context"];

function normalizeSearch(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

type TeamPanelProps = {
  guide?: "agent" | "provider";
  returnTo?: "/" | `/projects/${string}`;
  section?: SettingsSectionId;
};

export function TeamPanel({
  guide,
  returnTo = "/",
  section = "skills",
}: TeamPanelProps) {
  const [resourceNavigationOpen, setResourceNavigationOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const router = useRouter();
  const narrow = useNarrowMode();
  const settingsPreferences = useSettingsPreferences();
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingPanelFocusRef = useRef<SettingsSectionId | null>(null);
  const skillTabRef = useRef<HTMLButtonElement>(null);
  const providerTabRef = useRef<HTMLButtonElement>(null);
  const agentTabRef = useRef<HTMLButtonElement>(null);
  const resourceNavigationRef = useRef<HTMLElement>(null);
  const resourceToggleRef = useRef<HTMLButtonElement>(null);

  useModalSurface(
    narrow && resourceNavigationOpen,
    resourceNavigationRef,
    RESOURCE_NAV_INERT,
  );

  useEffect(() => {
    if (pendingPanelFocusRef.current !== section) return;
    pendingPanelFocusRef.current = null;
    const heading = document.querySelector<HTMLElement>(
      `#${section === "skills" ? "skill" : section.slice(0, -1)}-resource-panel h2`,
    );
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus();
  }, [section]);

  const normalizedQuery = normalizeSearch(searchQuery);
  const searchResults = SETTINGS_SECTIONS.filter((candidate) => {
    if (!candidate.available) return false;
    if (!normalizedQuery) return true;
    return normalizeSearch(
      [candidate.label, candidate.purpose, ...candidate.keywords].join(" "),
    ).includes(normalizedQuery);
  });
  const pinned = new Set(settingsPreferences.preference.pinned);

  function togglePinnedSettings(next: SettingsSectionId) {
    if (pinned.has(next)) unpinSettingsSection(next);
    else pinSettingsSection(next);
  }

  function closeResourceNavigation() {
    setResourceNavigationOpen(false);
    queueMicrotask(() => resourceToggleRef.current?.focus());
  }

  function selectResource(
    next: SettingsSectionId,
    focusTarget: "panel" | "tab" = "tab",
  ) {
    if (focusTarget === "panel") pendingPanelFocusRef.current = next;
    router.push(buildSettingsHref(next, returnTo));
    if (narrow && resourceNavigationOpen) {
      closeResourceNavigation();
    } else if (focusTarget === "tab") {
      const refs = {
        agents: agentTabRef,
        providers: providerTabRef,
        skills: skillTabRef,
      };
      queueMicrotask(() => refs[next].current?.focus());
    }
    if (focusTarget === "panel" && next === section) {
      queueMicrotask(() => {
        const heading = document.querySelector<HTMLElement>(
          `#${section === "skills" ? "skill" : section.slice(0, -1)}-resource-panel h2`,
        );
        if (!heading) return;
        pendingPanelFocusRef.current = null;
        heading.tabIndex = -1;
        heading.focus();
      });
    }
  }

  function handleResourceKeys(event: KeyboardEvent<HTMLDivElement>) {
    const focusedIndex = [
      skillTabRef.current,
      providerTabRef.current,
      agentTabRef.current,
    ].indexOf(document.activeElement as HTMLButtonElement);
    const currentIndex = focusedIndex >= 0 ? focusedIndex : resources.indexOf(section);
    let next: SettingsSectionId | undefined;
    if (event.key === "Home") next = resources[0];
    if (event.key === "End") next = resources[resources.length - 1];
    if (event.key === "ArrowLeft") {
      next = resources[(currentIndex - 1 + resources.length) % resources.length];
    }
    if (event.key === "ArrowRight") {
      next = resources[(currentIndex + 1) % resources.length];
    }
    if (!next) return;
    event.preventDefault();
    selectResource(next);
  }

  return (
    <div className="collaboration-cockpit">
      <h1 className="sr-only">团队管理</h1>
      <ActivityBar activePath="/team" returnTo={returnTo} />
      <div className="mobile-toolbar">
        <button
          aria-expanded={resourceNavigationOpen}
          aria-label={resourceNavigationOpen ? "关闭团队资源" : "打开团队资源"}
          className="button-secondary"
          onClick={() => {
            if (resourceNavigationOpen) closeResourceNavigation();
            else setResourceNavigationOpen(true);
          }}
          ref={resourceToggleRef}
          type="button"
        >
          团队资源
        </button>
      </div>
      <aside
        aria-label="团队导航"
        aria-modal={narrow && resourceNavigationOpen ? true : undefined}
        className="cockpit-sidebar"
        data-open={narrow && resourceNavigationOpen ? "true" : undefined}
        onKeyDown={
          narrow && resourceNavigationOpen
            ? (event) => trapModalFocus(event, closeResourceNavigation)
            : undefined
        }
        ref={resourceNavigationRef}
        role={narrow && resourceNavigationOpen ? "dialog" : undefined}
      >
        <button
          aria-label="关闭团队资源"
          className="drawer-close button-ghost"
          data-dialog-close="true"
          onClick={closeResourceNavigation}
          type="button"
        >
          关闭
        </button>
        <div className="product-identity">
          <span aria-hidden="true" className="product-mark">
            C
          </span>
          <div>
            <p className="eyebrow">协作驾驶舱</p>
            <p className="surface-heading">Cool AI</p>
          </div>
        </div>
        <a
          className="nav-item"
          href={returnTo}
          onClick={
            narrow && resourceNavigationOpen
              ? closeResourceNavigation
              : undefined
          }
        >
          返回原位置
        </a>
        <div className="settings-search stack" role="search">
          <label htmlFor="settings-section-search">搜索设置分区</label>
          <input
            id="settings-section-search"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="按名称、用途或关键词检索"
            ref={searchRef}
            type="search"
            value={searchQuery}
          />
          {searchResults.length > 0 ? (
            <ul className="settings-search-results stack">
              {searchResults.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    aria-label={
                      candidate.id === "agents"
                        ? "打开 Agent 设置"
                        : `打开${candidate.label}设置`
                    }
                    className="nav-item settings-search-result"
                    onClick={() => selectResource(candidate.id, "panel")}
                    type="button"
                  >
                    <span>{candidate.label}</span>
                    <span className="muted">{candidate.purpose}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-guide state-message">
              <p>没有匹配的设置分区。</p>
              <button
                className="button-ghost"
                onClick={() => {
                  setSearchQuery("");
                  queueMicrotask(() => searchRef.current?.focus());
                }}
                type="button"
              >
                清除检索
              </button>
            </div>
          )}
        </div>
        <div
          aria-busy={!settingsPreferences.hydrated}
          aria-label="固定设置分区"
          className="settings-pinning stack"
        >
          {SETTINGS_SECTIONS.filter(({ available }) => available).map(
            (candidate) => {
              const isPinned = pinned.has(candidate.id);
              return (
                <button
                  key={candidate.id}
                  aria-label={`${isPinned ? "取消固定" : "固定"}${candidate.label}`}
                  aria-pressed={isPinned}
                  className="nav-item"
                  disabled={!settingsPreferences.hydrated}
                  onClick={() => togglePinnedSettings(candidate.id)}
                  type="button"
                >
                  {isPinned ? "取消固定" : "固定"} {candidate.label}
                </button>
              );
            },
          )}
        </div>
        {settingsPreferences.error ? (
          <p className="state-message" role="status">
            {settingsPreferences.error === "write"
              ? "固定设置保存失败，导航仍可继续使用。"
              : settingsPreferences.error === "conflict"
                ? "检测到固定设置冲突，已按确定性规则合并。"
              : "固定设置读取失败，导航仍可继续使用。"}
          </p>
        ) : null}
        <section
          aria-labelledby="settings-preference-history-heading"
          className="settings-preference-history stack"
        >
          <h2 id="settings-preference-history-heading">固定历史</h2>
          {settingsPreferences.preference.events.length > 0 ? (
            <ol className="stack">
              {settingsPreferences.preference.events.map((event) => {
                const eventSection = SETTINGS_SECTIONS.find(
                  ({ id }) => id === event.section,
                );
                return (
                  <li key={event.eventId}>
                    Clock {event.clock}{" "}
                    {event.action === "pin" ? "固定" : "取消固定"}{" "}
                    {eventSection?.label ?? event.section} {event.changedAt}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="muted">固定分区后，变更记录会显示在这里。</p>
          )}
        </section>
        <NotificationSettingsRegion />
        <div
          aria-label="团队资源"
          className="resource-tabs"
          onKeyDown={handleResourceKeys}
          role="tablist"
        >
          <button
            aria-controls="skill-resource-panel"
            aria-selected={section === "skills"}
            className="nav-item"
            id="skill-resource-tab"
            onClick={() => selectResource("skills")}
            ref={skillTabRef}
            role="tab"
            tabIndex={section === "skills" ? 0 : -1}
            type="button"
          >
            技能
          </button>
          <button
            aria-controls="provider-resource-panel"
            aria-selected={section === "providers"}
            className="nav-item"
            id="provider-resource-tab"
            onClick={() => selectResource("providers")}
            ref={providerTabRef}
            role="tab"
            tabIndex={section === "providers" ? 0 : -1}
            type="button"
          >
            模型服务
          </button>
          <button
            aria-controls="agent-resource-panel"
            aria-selected={section === "agents"}
            className="nav-item"
            id="agent-resource-tab"
            onClick={() => selectResource("agents")}
            ref={agentTabRef}
            role="tab"
            tabIndex={section === "agents" ? 0 : -1}
            type="button"
          >
            Agent
          </button>
        </div>
      </aside>

      {section === "agents" ? (
        <AgentPanel
          guide={guide === "agent" ? guide : undefined}
          onGuideContinue={
            guide === "agent"
              ? () => router.push("/?guide=project-select")
              : undefined
          }
          onGuideSkip={
            guide === "agent"
              ? () => router.push("/?guide=project-select")
              : undefined
          }
          projectId={
            guide === "agent" && returnTo.startsWith("/projects/")
              ? returnTo.slice("/projects/".length)
              : undefined
          }
        />
      ) : section === "providers" ? (
        <ProviderPanel
          guide={guide === "provider" ? guide : undefined}
          onGuideContinue={
            guide === "provider"
              ? () =>
                  router.push(
                    "/team?section=agents&guide=agent&returnTo=/",
                  )
              : undefined
          }
          onGuideSkip={
            guide === "provider"
              ? () =>
                  router.push(
                    "/team?section=agents&guide=agent&returnTo=/",
                  )
              : undefined
          }
        />
      ) : (
        <SkillPanel />
      )}
    </div>
  );
}
