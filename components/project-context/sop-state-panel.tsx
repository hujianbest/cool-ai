"use client";

import { useEffect, useState } from "react";

import type {
  SopMatchedWorkItem,
  SopStateItem,
  SopStateProjection,
  WorkItemStatus,
} from "@/src/modules/mission-work";

const STATUS_PRESENTATION: Record<
  WorkItemStatus,
  { label: string; variant: string }
> = {
  todo: { label: "待办", variant: "queued" },
  in_progress: { label: "进行中", variant: "running" },
  blocked: { label: "阻塞", variant: "failed" },
  done: { label: "完成", variant: "completed" },
};

const STALE_COPY: Record<NonNullable<SopStateItem["staleReason"]>, string> = {
  source_unreadable: "来源文件无法读取。",
  declared_stage_diverges: "声明阶段与匹配任务状态不一致。",
};

function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return typeof value === "string" && value in STATUS_PRESENTATION;
}

function parseMatchedWorkItem(value: unknown): SopMatchedWorkItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  if (
    typeof record.workItemId !== "string" ||
    typeof record.title !== "string" ||
    !isWorkItemStatus(record.status)
  ) {
    return null;
  }
  return {
    workItemId: record.workItemId,
    title: record.title,
    status: record.status,
  };
}

function parseSopItem(value: unknown): SopStateItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  if (
    typeof record.relativePath !== "string" ||
    typeof record.title !== "string" ||
    typeof record.declaredStage !== "string" ||
    (record.freshness !== "current" && record.freshness !== "stale") ||
    (record.staleReason !== null &&
      record.staleReason !== "source_unreadable" &&
      record.staleReason !== "declared_stage_diverges") ||
    !Array.isArray(record.workItems)
  ) {
    return null;
  }
  const workItems: SopMatchedWorkItem[] = [];
  for (const candidate of record.workItems) {
    const parsed = parseMatchedWorkItem(candidate);
    if (!parsed) return null;
    workItems.push(parsed);
  }
  return {
    relativePath: record.relativePath,
    title: record.title,
    declaredStage: record.declaredStage,
    freshness: record.freshness,
    staleReason: record.staleReason,
    workItems,
  };
}

function parseProjection(value: unknown): SopStateProjection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  if (
    typeof record.workspaceBound !== "boolean" ||
    typeof record.readAt !== "string" ||
    !Array.isArray(record.items)
  ) {
    return null;
  }
  const items: SopStateItem[] = [];
  for (const candidate of record.items) {
    const parsed = parseSopItem(candidate);
    if (!parsed) return null;
    items.push(parsed);
  }
  return {
    workspaceBound: record.workspaceBound,
    readAt: record.readAt,
    items,
  };
}

export function SopStatePanel({
  onLocateWorkItem,
  projectId,
  refreshSignal,
}: {
  onLocateWorkItem: (workItemId: string) => void;
  projectId: string;
  refreshSignal: unknown;
}) {
  const [projection, setProjection] = useState<SopStateProjection | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const titleId = `mission-sop-state-title-${projectId}`;

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setLoadError(false);
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/sop-state`);
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("sop-state");
        const parsed = parseProjection(payload);
        if (!parsed) throw new Error("sop-state");
        if (active) setProjection(parsed);
      } catch {
        if (active) {
          setProjection(null);
          setLoadError(true);
        }
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, reloadKey, refreshSignal]);

  return (
    <section
      aria-labelledby={titleId}
      className="stack mission-sop-state"
    >
      <h3 id={titleId}>流程状态</h3>
      {isLoading ? (
        <p aria-busy="true" className="state-message">
          正在加载流程状态…
        </p>
      ) : loadError || !projection ? (
        <div className="state-message stack">
          <p className="error-text" role="alert">
            无法加载流程状态，请重试。
          </p>
          <button
            onClick={() => setReloadKey((current) => current + 1)}
            type="button"
          >
            重试加载流程状态
          </button>
        </div>
      ) : !projection.workspaceBound ? (
        <p className="state-message">未绑定工作区，无法读取流程文件。</p>
      ) : projection.items.length === 0 ? (
        <p className="state-message">未发现流程文件。</p>
      ) : (
        <ul aria-label="流程文件" className="stack mission-sop-items">
          {projection.items.map((item) => {
            const staleCopy =
              item.freshness === "stale" && item.staleReason
                ? STALE_COPY[item.staleReason]
                : null;
            return (
              <li className="task-summary stack" key={item.relativePath}>
                <h4>{item.title}</h4>
                <p>
                  来源 <span>{item.relativePath}</span>
                </p>
                <p>
                  声明阶段 <span>{item.declaredStage}</span>
                </p>
                {staleCopy ? <p className="error-text">{staleCopy}</p> : null}
                {item.workItems.map((workItem) => {
                  const presentation = STATUS_PRESENTATION[workItem.status];
                  return (
                    <p key={workItem.workItemId}>
                      <span
                        className={`status-label status-${presentation.variant}`}
                      >
                        {presentation.label}
                      </span>
                      <button
                        onClick={() => onLocateWorkItem(workItem.workItemId)}
                        type="button"
                      >
                        {`定位任务 ${workItem.title}`}
                      </button>
                    </p>
                  );
                })}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
