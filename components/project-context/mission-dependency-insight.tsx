"use client";

import { useEffect, useState } from "react";

import type {
  MissionDependencyInsight,
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

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function parseInsight(value: unknown): MissionDependencyInsight | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  if (
    !Array.isArray(envelope.nodes) ||
    !Array.isArray(envelope.edges) ||
    !Array.isArray(envelope.cycles) ||
    typeof envelope.hasDependencies !== "boolean"
  ) {
    return null;
  }
  for (const candidate of envelope.nodes as Array<Record<string, unknown>>) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.workItemId !== "string" ||
      typeof candidate.title !== "string" ||
      typeof candidate.status !== "string" ||
      !(candidate.status in STATUS_PRESENTATION) ||
      !isStringArray(candidate.blockedByIds) ||
      !isStringArray(candidate.blockingIds) ||
      !isStringArray(candidate.missingDependencyIds) ||
      (candidate.blockedReason !== null &&
        typeof candidate.blockedReason !== "string") ||
      (candidate.cycleId !== null && typeof candidate.cycleId !== "string")
    ) {
      return null;
    }
  }
  return value as MissionDependencyInsight;
}

export function MissionDependencyInsightPanel({
  missionId,
  onLocateWorkItem,
  projectId,
  refreshSignal,
}: {
  missionId: string;
  onLocateWorkItem: (workItemId: string) => void;
  projectId: string;
  refreshSignal: unknown;
}) {
  const [insight, setInsight] = useState<MissionDependencyInsight | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const titleId = `mission-dependencies-title-${missionId}`;

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setLoadError(false);
    void (async () => {
      try {
        const response = await fetch(
          `/api/projects/${projectId}/missions/${missionId}/dependencies`,
        );
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("dependencies");
        const parsed = parseInsight(payload);
        if (!parsed) throw new Error("dependencies");
        if (active) setInsight(parsed);
      } catch {
        if (active) {
          setInsight(null);
          setLoadError(true);
        }
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, missionId, reloadKey, refreshSignal]);

  function relationButton(targetId: string) {
    const title =
      insight?.nodes.find((node) => node.workItemId === targetId)?.title ??
      targetId;
    return (
      <button
        key={targetId}
        onClick={() => onLocateWorkItem(targetId)}
        type="button"
      >
        {`定位任务 ${title}`}
      </button>
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      className="stack mission-dependencies"
    >
      <h3 id={titleId}>依赖全景</h3>
      {isLoading ? (
        <p aria-busy="true" className="state-message">
          正在加载依赖全景…
        </p>
      ) : loadError || !insight ? (
        <div className="state-message stack">
          <p className="error-text" role="alert">
            无法加载依赖全景，请重试。
          </p>
          <button
            onClick={() => setReloadKey((current) => current + 1)}
            type="button"
          >
            重试加载依赖全景
          </button>
        </div>
      ) : !insight.hasDependencies ? (
        <p className="state-message">该 Mission 暂无依赖关系。</p>
      ) : (
        <>
          {insight.cycles.length > 0 ? (
            <div aria-label="循环依赖" className="stack" role="group">
              {insight.cycles.map((cycle) => (
                <p className="error-text" key={cycle.cycleId}>
                  {`循环依赖 ${cycle.cycleId}：${cycle.path}`}
                </p>
              ))}
            </div>
          ) : null}
          <ul
            aria-label="任务依赖关系"
            className="stack mission-dependency-nodes"
          >
            {insight.nodes.map((node) => {
              const presentation = STATUS_PRESENTATION[node.status];
              return (
                <li className="task-summary stack" key={node.workItemId}>
                  <h4>
                    {node.title}{" "}
                    {node.cycleId ? (
                      <span className="status-label status-failed">
                        {`循环 ${node.cycleId}`}
                      </span>
                    ) : null}
                  </h4>
                  <p>
                    <span
                      className={`status-label status-${presentation.variant}`}
                    >
                      {presentation.label}
                    </span>
                  </p>
                  {node.blockedReason ? (
                    <p className="error-text">{node.blockedReason}</p>
                  ) : null}
                  {node.blockedByIds.length > 0 ? (
                    <p>被阻塞于：{node.blockedByIds.map(relationButton)}</p>
                  ) : null}
                  {node.blockingIds.length > 0 ? (
                    <p>阻塞：{node.blockingIds.map(relationButton)}</p>
                  ) : null}
                  {node.missingDependencyIds.length > 0 ? (
                    <p className="muted">
                      {`前置依赖缺失 ${node.missingDependencyIds.length} 项`}
                    </p>
                  ) : null}
                  <button
                    onClick={() => onLocateWorkItem(node.workItemId)}
                    type="button"
                  >
                    {`定位任务 ${node.title}`}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
