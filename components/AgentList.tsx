"use client";

import { useCallback, useEffect, useState } from "react";
import type { SkillIndexDTO } from "../src/server/skillService";
import type { ProviderConfigDTO } from "../src/server/providerService";

type Agent = { id: number; name: string; skills: number[]; providerConfigId: number | null; model: string };
type Status = "loading" | "success" | "empty" | "error";

export function AgentList({
  version = 0,
  skills = [],
  providerConfigs = [],
}: {
  version?: number;
  skills?: SkillIndexDTO[];
  providerConfigs?: ProviderConfigDTO[];
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [agents, setAgents] = useState<Agent[]>([]);

  const load = useCallback(() => {
    setStatus("loading");
    fetch("/api/agents")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list: Agent[] = (data.agents ?? []).map(
          (a: { id: number; name: string; skills?: number[]; providerConfigId?: number | null; model?: string }) => ({
            id: a.id,
            name: a.name,
            skills: Array.isArray(a.skills) ? a.skills : [],
            providerConfigId: a.providerConfigId ?? null,
            model: a.model ?? "",
          })
        );
        setAgents(list);
        setStatus(list.length === 0 ? "empty" : "success");
      })
      .catch(() => setStatus("error"));
  }, []);

  useEffect(() => {
    load();
  }, [load, version]);

  if (status === "loading") {
    return <p className="text-muted">加载中…</p>;
  }
  if (status === "empty") {
    return <p className="text-muted">暂无 Agent(后续可在上方创建)</p>;
  }
  if (status === "error") {
    return (
      <div>
        <p className="text-muted">加载失败,请重试</p>
        <button
          type="button"
          onClick={load}
          className="mt-2 inline-flex min-h-[44px] items-center rounded-token border border-line bg-surface px-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          重试
        </button>
      </div>
    );
  }

  const skillName = (id: number) =>
    skills.find((s) => s.id === id)?.name ?? String(id);
  const providerName = (id: number | null) =>
    id == null ? "未配置 provider" : providerConfigs.find((p) => p.id === id)?.name ?? `provider #${id}`;

  return (
    <div role="list" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {agents.map((a) => (
        <article
          key={a.id}
          role="listitem"
          className="rounded-token border border-line bg-surface p-4 shadow-token"
        >
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full bg-accent"
              aria-hidden="true"
            />
            <span className="font-medium">{a.name}</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            <span>{providerName(a.providerConfigId)}</span>
            {a.model && (
              <>
                <span> · </span>
                <span>{a.model}</span>
              </>
            )}
          </p>
          {a.skills.length > 0 && (
            <p className="mt-1 text-xs text-muted">
              <span className="mr-1">skills:</span>
              {a.skills.map((id) => (
                <span key={id} className="mr-1">
                  {skillName(id)}
                </span>
              ))}
            </p>
          )}
        </article>
      ))}
    </div>
  );
}
