"use client";

import type { ProviderConfigDTO } from "../src/server/providerService";

type Status = "loading" | "empty" | "error" | "success";

export function ProviderList({
  status,
  configs,
  onRetry,
}: {
  status: Status;
  configs: ProviderConfigDTO[];
  onRetry: () => void;
}) {
  if (status === "loading") {
    return <p className="text-muted">加载中…</p>;
  }
  if (status === "empty") {
    return <p className="text-muted">暂无 provider 配置(在上方创建)</p>;
  }
  if (status === "error") {
    return (
      <div>
        <p className="text-muted">加载失败,请重试</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex min-h-[44px] items-center rounded-token border border-line bg-surface px-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div role="list" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {configs.map((c) => (
        <article
          key={c.id}
          role="listitem"
          className="rounded-token border border-line bg-surface p-4 shadow-token"
        >
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full bg-accent"
              aria-hidden="true"
            />
            <span className="font-medium">{c.name}</span>
          </div>
          <p className="mt-1 break-all text-xs text-muted">{c.baseUrl}</p>
          <p className="mt-1 text-xs text-muted">
            被 {c.agentCount} 个 agent 关联
          </p>
        </article>
      ))}
    </div>
  );
}
