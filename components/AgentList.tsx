"use client";

import { useCallback, useEffect, useState } from "react";

type Agent = { id: number; name: string; role: string };
type Status = "loading" | "success" | "empty" | "error";

export function AgentList() {
  const [status, setStatus] = useState<Status>("loading");
  const [agents, setAgents] = useState<Agent[]>([]);

  const load = useCallback(() => {
    setStatus("loading");
    fetch("/api/agents")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list: Agent[] = data.agents ?? [];
        setAgents(list);
        setStatus(list.length === 0 ? "empty" : "success");
      })
      .catch(() => setStatus("error"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (status === "loading") {
    return <p className="text-muted">加载中…</p>;
  }
  if (status === "empty") {
    return <p className="text-muted">暂无 Agent(后续可在侧栏创建)</p>;
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
          <p className="mt-1 text-sm text-muted">{a.role}</p>
        </article>
      ))}
    </div>
  );
}
