"use client";

import {
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { AuditPanel } from "@/components/project-context/audit-panel";
import { ContextPreview } from "@/components/project-context/context-preview";
import { MemoryPanel } from "@/components/project-context/memory-panel";

type ContextTab = "memory" | "context" | "skeleton" | "audit";

const TABS: Array<{ id: ContextTab; label: string }> = [
  { id: "memory", label: "共享记忆" },
  { id: "context", label: "上下文预览" },
  { id: "skeleton", label: "骨架运行" },
  { id: "audit", label: "审计" },
];

export function ProjectContextPanel({
  projectId,
  skeleton,
}: {
  projectId: string;
  skeleton: ReactNode;
}) {
  const [activeTab, setActiveTab] = useState<ContextTab>("memory");
  const tabRefs = useRef(new Map<ContextTab, HTMLButtonElement>());

  function selectTab(tab: ContextTab) {
    setActiveTab(tab);
    queueMicrotask(() => tabRefs.current.get(tab)?.focus());
  }

  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    const current = TABS.findIndex((tab) => tab.id === activeTab);
    let next: ContextTab | undefined;
    if (event.key === "Home") next = TABS[0].id;
    if (event.key === "End") next = TABS.at(-1)!.id;
    if (event.key === "ArrowLeft") {
      next = TABS[(current - 1 + TABS.length) % TABS.length].id;
    }
    if (event.key === "ArrowRight") {
      next = TABS[(current + 1) % TABS.length].id;
    }
    if (!next) return;
    event.preventDefault();
    selectTab(next);
  }

  return (
    <div className="stack project-context-panel">
      <div
        aria-label="项目上下文资源"
        className="project-context-tabs"
        onKeyDown={handleKeys}
        role="tablist"
      >
        {TABS.map((tab) => (
          <button
            aria-controls={`project-context-${tab.id}-${projectId}`}
            aria-selected={activeTab === tab.id}
            id={`project-context-tab-${tab.id}-${projectId}`}
            key={tab.id}
            onClick={() => selectTab(tab.id)}
            ref={(element) => {
              if (element) tabRefs.current.set(tab.id, element);
              else tabRefs.current.delete(tab.id);
            }}
            role="tab"
            tabIndex={activeTab === tab.id ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`project-context-tab-${activeTab}-${projectId}`}
        id={`project-context-${activeTab}-${projectId}`}
        role="tabpanel"
      >
        {activeTab === "memory" ? (
          <MemoryPanel projectId={projectId} />
        ) : activeTab === "context" ? (
          <ContextPreview projectId={projectId} />
        ) : activeTab === "audit" ? (
          <AuditPanel projectId={projectId} />
        ) : (
          skeleton
        )}
      </div>
    </div>
  );
}
