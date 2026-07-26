"use client";

import { useState } from "react";

type Status = "idle" | "submitting" | "error";

export function SkillForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("");
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
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description,
          content,
          category,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setName("");
      setDescription("");
      setContent("");
      setCategory("");
      setStatus("idle");
      onCreated();
    } catch {
      setStatus("error");
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="创建 skill"
      className="space-y-4 rounded-token border border-line bg-surface-subtle p-4"
    >
      <div>
        <label htmlFor="skill-name" className="block text-sm text-muted">
          名字
        </label>
        <input
          id="skill-name"
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
        <label htmlFor="skill-desc" className="block text-sm text-muted">
          描述
        </label>
        <input
          id="skill-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="mt-1 w-full rounded-token border border-line bg-surface px-3 py-2"
        />
      </div>
      <div>
        <label htmlFor="skill-content" className="block text-sm text-muted">
          内容
        </label>
        <textarea
          id="skill-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          className="mt-1 w-full rounded-token border border-line bg-surface px-3 py-2"
        />
      </div>
      <div>
        <label htmlFor="skill-cat" className="block text-sm text-muted">
          分类
        </label>
        <input
          id="skill-cat"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="mt-1 w-full rounded-token border border-line bg-surface px-3 py-2"
        />
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
        {status === "submitting" ? "保存中…" : "创建 skill"}
      </button>
    </form>
  );
}
