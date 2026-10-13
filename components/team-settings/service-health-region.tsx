"use client";

import { useEffect, useState } from "react";

import { buildSettingsHref, parseProjectSelection } from "@/components/settings-navigation";
import type { ServiceHealthDto, ServiceHealthStatus } from "@/src/modules/operations-projection";

const STATUS_LABEL: Record<ServiceHealthStatus, string> = {
  degraded: "降级",
  failed: "失败",
  ok: "已就绪",
  unknown: "未知",
};

/* 服务健康状态 → 状态胶囊语义（DESIGN.md §6.1 ①：tinted pill）。 */
const STATUS_PILL_CLASS: Record<ServiceHealthStatus, string> = {
  degraded: "status-queued",
  failed: "status-failed",
  ok: "status-completed",
  unknown: "",
};

type ServiceHealthRegionProps = {
  returnTo?: string;
};

export function ServiceHealthRegion({ returnTo = "/" }: ServiceHealthRegionProps) {
  const projectId = parseProjectSelection(returnTo)?.projectId ?? null;
  const [health, setHealth] = useState<ServiceHealthDto | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    void fetch(`/api/health${query}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("health");
        return response.json() as Promise<ServiceHealthDto>;
      })
      .then((payload) => {
        if (active) setHealth(payload);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  return (
    <section
      aria-labelledby="service-health-heading"
      className="service-health-region stack"
    >
      <h2 id="service-health-heading">服务健康</h2>
      {health ? (
        <div className="service-health-grid">
          <HealthCard
            actionHref="/"
            actionLabel="打开对话"
            detail={health.app.detail}
            status={health.app.status}
            title="应用"
          />
          <HealthCard
            actionHref={buildSettingsHref("providers", returnTo)}
            actionLabel="配置模型服务"
            detail={health.providers.detail}
            status={health.providers.status}
            title="模型服务"
          />
          <HealthCard
            actionHref={projectId ? `/projects/${encodeURIComponent(projectId)}` : "/"}
            actionLabel={projectId ? "打开记忆" : "打开文件夹"}
            detail={health.memoryIndex.detail}
            status={health.memoryIndex.status}
            title="记忆索引"
          />
          <HealthCard
            actionHref={projectId ? `/projects/${encodeURIComponent(projectId)}` : null}
            actionLabel="打开审计"
            detail={health.execution.detail}
            status={health.execution.status}
            title="执行"
          />
        </div>
      ) : error ? (
        <p className="state-message">无法加载服务健康。</p>
      ) : (
        <p aria-busy="true" className="state-message">正在检查服务健康…</p>
      )}
    </section>
  );
}

function HealthCard({
  actionHref,
  actionLabel,
  detail,
  status,
  title,
}: {
  actionHref: string | null;
  actionLabel: string;
  detail: string | null;
  status: ServiceHealthStatus;
  title: string;
}) {
  const disabled = actionHref === null;
  return (
    // 标准卡模板（DESIGN.md §6.1 ⑤）：标题 → 状态胶囊 → 说明 → 紧凑操作槽位。
    <article className="task-summary stack" data-status={status}>
      <h3>{title}</h3>
      <p>
        <span className={`status-label ${STATUS_PILL_CLASS[status]}`.trim()}>
          {STATUS_LABEL[status]}
        </span>
      </p>
      {detail ? <p className="muted">{detail}</p> : null}
      <a
        aria-disabled={disabled ? "true" : undefined}
        className="button-secondary button-compact"
        href={actionHref ?? "#"}
        onClick={disabled ? (event) => event.preventDefault() : undefined}
        tabIndex={disabled ? -1 : undefined}
      >
        {actionLabel}
      </a>
    </article>
  );
}
