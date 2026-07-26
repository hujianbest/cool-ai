"use client";

import { useEffect, useState } from "react";

type Agent = { id: number; name: string };
type TraceStep = { role: string; content: string };
type Status = "idle" | "running" | "error";

export function AgentRun() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<number | null>(null);
  const [task, setTask] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [output, setOutput] = useState("");
  const [trace, setTrace] = useState<TraceStep[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((d) => {
        const list: Agent[] = (d.agents ?? []).map((a: Agent) => ({ id: a.id, name: a.name }));
        setAgents(list);
        setAgentId(list[0]?.id ?? null);
      })
      .catch(() => {});
  }, []);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (agentId == null) return;
    setStatus("running");
    setError("");
    setOutput("");
    setTrace([]);
    try {
      const res = await fetch(`/api/agents/${agentId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setOutput(data.output ?? "");
      setTrace(data.trace ?? []);
      setStatus("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : "运行失败");
      setStatus("error");
    }
  }

  return (
    <form
      onSubmit={run}
      aria-label="运行 Agent"
      className="space-y-4 rounded-token border border-line bg-surface-subtle p-4"
    >
      <div>
        <label htmlFor="run-agent" className="block text-sm text-muted">
          选择 Agent
        </label>
        <select
          id="run-agent"
          value={agentId ?? ""}
          onChange={(e) =>
            setAgentId(e.target.value ? Number(e.target.value) : null)
          }
          className="mt-1 w-full rounded-token border border-line bg-surface px-3 py-2"
        >
          <option value="">(无)</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="run-task" className="block text-sm text-muted">
          任务
        </label>
        <textarea
          id="run-task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-token border border-line bg-surface px-3 py-2"
        />
      </div>
      {status === "error" && (
        <p className="text-sm text-accent-strong" role="alert">
          {error || "运行失败"}
        </p>
      )}
      <button
        type="submit"
        disabled={status === "running" || agentId == null}
        className="inline-flex min-h-[44px] items-center rounded-token bg-accent-strong px-4 text-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
      >
        {status === "running" ? "运行中…" : "运行"}
      </button>

      {output && (
        <div className="rounded-token border border-line bg-surface p-3">
          <h4 className="mb-1 text-sm font-medium">输出</h4>
          <pre className="whitespace-pre-wrap break-words text-sm">{output}</pre>
        </div>
      )}
      {trace.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">执行轨迹</h4>
          {trace.map((t, i) => (
            <div key={i} className="rounded-token border border-line bg-surface p-2">
              <span className="text-xs text-muted">{t.role}</span>
              <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-muted">
                {t.content}
              </pre>
            </div>
          ))}
        </div>
      )}
    </form>
  );
}
