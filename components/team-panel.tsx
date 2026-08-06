"use client";

import {
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { AgentPanel } from "@/components/agent-panel";
import {
  trapModalFocus,
  useModalSurface,
  useNarrowMode,
} from "@/components/mobile-dialog";
import { ProviderPanel } from "@/components/provider-panel";
import { SkillPanel } from "@/components/skill-panel";

type Resource = "skills" | "providers" | "agents";

const resources: Resource[] = ["skills", "providers", "agents"];
const RESOURCE_NAV_INERT = [".cockpit-flow", ".cockpit-context"];

export function TeamPanel() {
  const [resource, setResource] = useState<Resource>("skills");
  const [resourceNavigationOpen, setResourceNavigationOpen] = useState(false);
  const narrow = useNarrowMode();
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

  function closeResourceNavigation() {
    setResourceNavigationOpen(false);
    queueMicrotask(() => resourceToggleRef.current?.focus());
  }

  function selectResource(next: Resource) {
    setResource(next);
    if (narrow && resourceNavigationOpen) {
      closeResourceNavigation();
      return;
    }
    const refs = {
      agents: agentTabRef,
      providers: providerTabRef,
      skills: skillTabRef,
    };
    queueMicrotask(() => refs[next].current?.focus());
  }

  function handleResourceKeys(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = resources.indexOf(resource);
    let next: Resource | undefined;
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
            <h1 className="surface-heading">Cool AI</h1>
          </div>
        </div>
        <nav aria-label="主导航">
          <ul className="project-list">
            <li>
              <a className="nav-item" href="/">工作</a>
            </li>
            <li>
              <a aria-current="page" className="nav-item" href="/team">
                团队
              </a>
            </li>
          </ul>
        </nav>
        <div
          aria-label="团队资源"
          className="resource-tabs"
          onKeyDown={handleResourceKeys}
          role="tablist"
        >
          <button
            aria-controls="skill-resource-panel"
            aria-selected={resource === "skills"}
            className="nav-item"
            id="skill-resource-tab"
            onClick={() => selectResource("skills")}
            ref={skillTabRef}
            role="tab"
            tabIndex={resource === "skills" ? 0 : -1}
            type="button"
          >
            技能
          </button>
          <button
            aria-controls="provider-resource-panel"
            aria-selected={resource === "providers"}
            className="nav-item"
            id="provider-resource-tab"
            onClick={() => selectResource("providers")}
            ref={providerTabRef}
            role="tab"
            tabIndex={resource === "providers" ? 0 : -1}
            type="button"
          >
            模型服务
          </button>
          <button
            aria-controls="agent-resource-panel"
            aria-selected={resource === "agents"}
            className="nav-item"
            id="agent-resource-tab"
            onClick={() => selectResource("agents")}
            ref={agentTabRef}
            role="tab"
            tabIndex={resource === "agents" ? 0 : -1}
            type="button"
          >
            Agent
          </button>
        </div>
      </aside>

      {resource === "agents" ? (
        <AgentPanel />
      ) : resource === "providers" ? (
        <ProviderPanel />
      ) : (
        <SkillPanel />
      )}
    </div>
  );
}
