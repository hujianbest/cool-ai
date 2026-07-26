"use client";

import { useState } from "react";
import { PROVIDERS, TOOLS } from "../src/shared/agentOptions";
import type { SkillIndexDTO } from "../src/server/skillService";

type Status = "idle" | "submitting" | "error";

function toggle(list: number[], id: number): number[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export function AgentForm({
  onCreated,
  skills = [],
}: {
  onCreated: () => void;
  skills?: SkillIndexDTO[];
}) {
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [provider, setProvider] = useState<string>(PROVIDERS[0].id);
  const [selectedSkills, setSelectedSkills] = useState<number[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [nameError, setNameError] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setNameError(true);
      return;
    }
    setNameError(false);
    setStatus("submitting");
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          systemPrompt,
          tools,
          provider,
          skills: selectedSkills,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setName("");
      setSystemPrompt("");
      setTools([]);
      setSelectedSkills([]);
      setStatus("idle");
      onCreated();
    } catch {
      setStatus("error");
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="创建 Agent"
      className="space-y-4 rounded-token border border-line bg-surface-subtle p-4"
    >
      <div>
        <label htmlFor="agent-name" className="block text-sm text-muted">
          名字
        </label>
        <input
          id="agent-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-token border border-line bg-surface px-3 py-2"
          aria-invalid={nameError}
        />
        {nameError && (
          <p className="mt-1 text-sm text-accent-strong" role="alert">
            必填
          </p>
        )}
      </div>

      <div>
        <label htmlFor="agent-prompt" className="block text-sm text-muted">
          角色描述
        </label>
        <textarea
          id="agent-prompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-token border border-line bg-surface px-3 py-2"
        />
      </div>

      <div>
        <span className="block text-sm text-muted">可用工具</span>
        <div
          role="group"
          aria-label="可用工具"
          className="mt-1 flex flex-wrap gap-3"
        >
          {TOOLS.map((t) => (
            <label
              key={t.id}
              className="inline-flex items-center gap-1 text-sm"
            >
              <input
                type="checkbox"
                checked={tools.includes(t.id)}
                onChange={() => setTools((v) => toggleStr(v, t.id))}
              />
              {t.label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label
          htmlFor="agent-provider"
          className="block text-sm text-muted"
        >
          模型供应商
        </label>
        <select
          id="agent-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="mt-1 w-full rounded-token border border-line bg-surface px-3 py-2"
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <span className="block text-sm text-muted">skills</span>
        <div
          role="group"
          aria-label="skills"
          className="mt-1 flex flex-wrap gap-3"
        >
          {skills.length === 0 && (
            <span className="text-sm text-muted">暂无可用 skill(先创建)</span>
          )}
          {skills.map((s) => (
            <label
              key={s.id}
              className="inline-flex items-center gap-1 text-sm"
            >
              <input
                type="checkbox"
                checked={selectedSkills.includes(s.id)}
                onChange={() => setSelectedSkills((v) => toggle(v, s.id))}
              />
              {s.name}
            </label>
          ))}
        </div>
      </div>

      {status === "error" && (
        <p className="text-sm text-accent-strong" role="alert">
          保存失败,请重试
        </p>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="inline-flex min-h-[44px] items-center rounded-token bg-accent-strong px-4 text-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
      >
        {status === "submitting" ? "保存中…" : "创建 Agent"}
      </button>
    </form>
  );
}

function toggleStr(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}
