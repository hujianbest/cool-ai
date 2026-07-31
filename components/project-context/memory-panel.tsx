"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { ApiError } from "@/src/shared/contracts";
import type { MemoryEntry } from "@/src/shared/project-context-contracts";

type MemoryDraft = {
  type: MemoryEntry["type"];
  content: string;
  sourceType: MemoryEntry["sourceType"];
  sourceRef: string;
  supersedesId: string;
};
type MemoryPayload = Partial<ApiError> & {
  error?: ApiError["error"] & {
    fields?: Array<{ field: string; code: string }>;
  };
};

const EMPTY_DRAFT: MemoryDraft = {
  type: "goal",
  content: "",
  sourceType: "owner_input",
  sourceRef: "",
  supersedesId: "",
};
const MEMORY_TYPES: Array<{
  value: MemoryEntry["type"];
  label: string;
}> = [
  { value: "goal", label: "目标" },
  { value: "decision", label: "决策" },
  { value: "fact", label: "事实" },
  { value: "artifact", label: "产物" },
];
const SOURCE_LABELS: Record<MemoryEntry["sourceType"], string> = {
  owner_input: "Owner 输入",
  work_item: "任务",
  artifact_path: "产物路径",
};

function memoryError(payload: MemoryPayload): string {
  switch (payload.error?.code) {
    case "INVALID_SOURCE":
      return "来源引用无效，请检查来源类型与引用。";
    case "MEMORY_NOT_FOUND":
      return "要取代的记忆不存在，请刷新后重试。";
    case "MEMORY_NOT_ACTIVE":
      return "要取代的记忆已失效，请刷新后重试。";
    case "MEMORY_TYPE_MISMATCH":
      return "只能取代相同类型的 active 记忆。";
    case "RESOURCE_CONFLICT":
      return "数据已更新，请刷新后重试。";
    case "INVALID_INPUT":
      return "记忆内容无效，请检查字段长度。";
    default:
      return "无法保存共享记忆，请稍后重试。";
  }
}

export function MemoryPanel({ projectId }: { projectId: string }) {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [draft, setDraft] = useState<MemoryDraft>(EMPTY_DRAFT);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const headingRefs = useRef(new Map<string, HTMLHeadingElement>());
  const [focusMemoryId, setFocusMemoryId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    void fetch(
      `/api/projects/${projectId}/memories?includeInactive=${
        includeHistory ? "1" : "0"
      }`,
    )
      .then(async (response) => {
        const payload = (await response.json()) as {
          memories?: MemoryEntry[];
        } & MemoryPayload;
        if (!response.ok || !Array.isArray(payload.memories)) {
          throw new Error("load");
        }
        return payload.memories;
      })
      .then((loaded) => {
        if (active) setMemories(loaded);
      })
      .catch(() => {
        if (active) setError("无法加载共享记忆，请重试。");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [includeHistory, projectId, reloadKey]);

  useEffect(() => {
    if (!focusMemoryId) return;
    headingRefs.current.get(focusMemoryId)?.focus();
    setFocusMemoryId(null);
  }, [focusMemoryId, memories]);

  async function saveMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess("");
    if (!draft.content.trim()) {
      setError("请输入记忆正文。");
      contentRef.current?.focus();
      return;
    }
    if (!draft.sourceRef.trim()) {
      setError("请输入来源引用。");
      sourceRef.current?.focus();
      return;
    }
    setIsSaving(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/memories`, {
        body: JSON.stringify({
          type: draft.type,
          content: draft.content,
          sourceType: draft.sourceType,
          sourceRef: draft.sourceRef,
          ...(draft.supersedesId
            ? { supersedesId: draft.supersedesId }
            : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as {
        memory?: MemoryEntry;
      } & MemoryPayload;
      if (!response.ok || !payload.memory) {
        throw new Error(memoryError(payload));
      }
      const created = payload.memory;
      setMemories((current) => [
        ...current
          .map((memory) =>
            memory.id === created.supersedesId
              ? { ...memory, active: false }
              : memory,
          )
          .filter((memory) => includeHistory || memory.active),
        created,
      ]);
      setDraft(EMPTY_DRAFT);
      setSuccess("共享记忆已保存。");
      setFocusMemoryId(created.id);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "无法保存共享记忆，请稍后重试。",
      );
      contentRef.current?.focus();
    } finally {
      setIsSaving(false);
    }
  }

  const supersedeOptions = memories.filter(
    (memory) => memory.active && memory.type === draft.type,
  );

  return (
    <section aria-labelledby={`memory-title-${projectId}`} className="stack">
      <h2 id={`memory-title-${projectId}`}>共享记忆</h2>
      <form className="stack memory-form" onSubmit={saveMemory}>
        <fieldset>
          <legend>记忆类型</legend>
          <div className="memory-type-options">
            {MEMORY_TYPES.map((type) => (
              <label className="check-row" key={type.value}>
                <input
                  checked={draft.type === type.value}
                  name={`memory-type-${projectId}`}
                  onChange={() =>
                    setDraft((current) => ({
                      ...current,
                      type: type.value,
                      supersedesId: "",
                    }))
                  }
                  type="radio"
                  value={type.value}
                />
                <span>{type.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form-field">
          <label htmlFor={`memory-content-${projectId}`}>记忆正文</label>
          <textarea
            aria-describedby={error ? `memory-error-${projectId}` : undefined}
            id={`memory-content-${projectId}`}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                content: event.target.value,
              }))
            }
            ref={contentRef}
            value={draft.content}
          />
        </div>
        <div className="form-field">
          <label htmlFor={`memory-source-type-${projectId}`}>来源类型</label>
          <select
            id={`memory-source-type-${projectId}`}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                sourceType: event.target
                  .value as MemoryEntry["sourceType"],
              }))
            }
            value={draft.sourceType}
          >
            {Object.entries(SOURCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {draft.sourceType === "artifact_path" ? (
          <p className="muted">仅引用，尚未读取</p>
        ) : null}
        <div className="form-field">
          <label htmlFor={`memory-source-ref-${projectId}`}>来源引用</label>
          <input
            aria-describedby={error ? `memory-error-${projectId}` : undefined}
            id={`memory-source-ref-${projectId}`}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                sourceRef: event.target.value,
              }))
            }
            ref={sourceRef}
            value={draft.sourceRef}
          />
        </div>
        <div className="form-field">
          <label htmlFor={`memory-supersede-${projectId}`}>取代旧记忆</label>
          <select
            id={`memory-supersede-${projectId}`}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                supersedesId: event.target.value,
              }))
            }
            value={draft.supersedesId}
          >
            <option value="">不取代</option>
            {supersedeOptions.map((memory) => (
              <option key={memory.id} value={memory.id}>
                {memory.content}
              </option>
            ))}
          </select>
        </div>
        <button disabled={isSaving} type="submit">
          {isSaving ? "正在保存记忆…" : "保存记忆"}
        </button>
      </form>

      {error ? (
        <div className="state-message stack">
          <p
            className="error-text"
            id={`memory-error-${projectId}`}
            role="alert"
          >
            {error}
          </p>
          {error.startsWith("无法加载") ||
          error.includes("刷新后重试") ? (
            <button
              onClick={() => setReloadKey((current) => current + 1)}
              type="button"
            >
              重试加载共享记忆
            </button>
          ) : null}
        </div>
      ) : null}
      {success ? (
        <p aria-live="polite" aria-label="保存结果" role="status">
          {success}
        </p>
      ) : null}
      <button
        disabled={isLoading}
        onClick={() => setIncludeHistory((current) => !current)}
        type="button"
      >
        {includeHistory ? "只看 active 记忆" : "查看历史记忆"}
      </button>
      {isLoading ? (
        <p aria-busy="true" className="state-message">
          正在加载共享记忆…
        </p>
      ) : memories.length === 0 && !error ? (
        <p className="state-message">尚无共享记忆。</p>
      ) : memories.length > 0 ? (
        <ul
          aria-label={includeHistory ? "共享记忆历史" : "Active 共享记忆"}
          className="stack memory-list"
        >
          {memories.map((memory) => (
            <li className="task-summary stack" key={memory.id}>
              <h3
                ref={(element) => {
                  if (element) headingRefs.current.set(memory.id, element);
                  else headingRefs.current.delete(memory.id);
                }}
                tabIndex={-1}
              >
                {memory.content}
              </h3>
              <p>
                {MEMORY_TYPES.find((type) => type.value === memory.type)?.label} ·{" "}
                {SOURCE_LABELS[memory.sourceType]} · {memory.sourceRef}
              </p>
              <p>创建者：owner</p>
              <p>{memory.active ? "Active" : "已失效"}</p>
              {memory.sourceType === "artifact_path" ? (
                <p className="muted">仅引用，尚未读取</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
