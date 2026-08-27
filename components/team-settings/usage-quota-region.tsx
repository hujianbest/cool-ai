"use client";

import { useEffect, useState } from "react";

import { buildSettingsHref, parseProjectSelection } from "@/components/settings-navigation";
import type { UsageQuotaDto, UsageTotalsDto } from "@/src/modules/operations-projection";

type UsageQuotaRegionProps = {
  returnTo?: string;
};

function meterLine(totals: UsageTotalsDto): string {
  return `未报告 ${totals.unreportedCalls} · 无效 ${totals.invalidCalls}`;
}

export function UsageQuotaRegion({ returnTo = "/" }: UsageQuotaRegionProps) {
  const projectId = parseProjectSelection(returnTo)?.projectId ?? null;
  const [usage, setUsage] = useState<UsageQuotaDto | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    void fetch(`/api/usage${query}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("usage");
        return response.json() as Promise<UsageQuotaDto>;
      })
      .then((payload) => {
        if (active) setUsage(payload);
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
      aria-labelledby="usage-quota-heading"
      className="usage-quota-region stack"
    >
      <h2 id="usage-quota-heading">用量与配额</h2>
      <p className="muted">基础用量不是账单</p>
      {usage ? (
        <div className="usage-quota-grid">
          <article className="task-summary stack">
            <h3>本项目</h3>
            <p>{usage.project.detail ?? `已报告 ${usage.project.totals.totalTokens} token`}</p>
            {usage.project.projectId ? <p className="muted">{meterLine(usage.project.totals)}</p> : null}
            {usage.budgets.map((budget) => (
              <p key={budget.agentId} className="muted">
                {`${budget.name} ${budget.usedTokens}/${budget.maxTokens} token`}
              </p>
            ))}
            <a className="button-secondary" href={buildSettingsHref("agents", returnTo)}>
              配置 Agent
            </a>
          </article>
          <article className="task-summary stack">
            <h3>协作运行</h3>
            {usage.runs.length === 0 ? (
              <p className="muted">没有协作运行</p>
            ) : (
              usage.runs.map((run) => (
                <p key={run.id}>
                  {`${run.id} ${run.roundCount}/${run.roundLimit} 轮`}
                </p>
              ))
            )}
          </article>
          <article className="task-summary stack">
            <h3>模型服务</h3>
            {usage.providers.length === 0 ? (
              <p className="muted">没有模型服务用量</p>
            ) : (
              usage.providers.map((provider) => (
                <p key={provider.id}>
                  {`${provider.name} ${provider.totals.totalTokens}`}
                </p>
              ))
            )}
          </article>
        </div>
      ) : error ? (
        <p className="state-message">无法加载用量。</p>
      ) : (
        <p aria-busy="true" className="state-message">正在加载用量…</p>
      )}
    </section>
  );
}
