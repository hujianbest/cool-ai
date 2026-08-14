"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { ApiError } from "@/src/shared/contracts";
import type {
  MemoryEntryV6,
  MemorySourceType,
  MemoryType,
} from "@/src/shared/memory-contracts";
import type { MemoryEntry as LegacyMemoryEntry } from "@/src/shared/project-context-contracts";

type MemoryDraft = {
  type: MemoryType;
  content: string;
  sourceType: "artifact_path" | "owner_input" | "work_item";
  sourceRef: string;
  supersedesId: string;
};
type MemoryEntry = MemoryEntryV6 | LegacyMemoryEntry;
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
  value: MemoryType;
  label: string;
}> = [
  { value: "goal", label: "目标" },
  { value: "decision", label: "决策" },
  { value: "fact", label: "事实" },
  { value: "artifact", label: "产物" },
  { value: "experience", label: "经验" },
];
const OWNER_SOURCE_LABELS: Record<MemoryDraft["sourceType"], string> = {
  owner_input: "Owner 输入",
  work_item: "任务",
  artifact_path: "产物路径",
};
const SOURCE_LABELS: Record<MemorySourceType, string> = {
  ...OWNER_SOURCE_LABELS,
  artifact: "artifact",
  result: "result",
  review: "review",
  task: "task",
  validation: "validation",
};

function isV6(memory: MemoryEntry): memory is MemoryEntryV6 {
  return "actor" in memory && "source" in memory && "version" in memory;
}

function memoryType(memory: MemoryEntry): MemoryType {
  return memory.type;
}

function chainId(memory: MemoryEntry): string {
  return isV6(memory) ? memory.chainId : memory.id;
}

function version(memory: MemoryEntry): number {
  return isV6(memory) ? memory.version : 1;
}

function source(memory: MemoryEntry): MemoryEntryV6["source"] {
  return isV6(memory)
    ? memory.source
    : {
        href: null,
        id: memory.sourceRef,
        type: memory.sourceType,
        version: null,
      };
}

function actorCopy(memory: MemoryEntry): string {
  if (!isV6(memory) || memory.actor.proposerType === "owner") {
    return "Owner 提议 · 平台持久化";
  }
  return `Agent ${memory.actor.proposerAgent.name} 提议 · 通过裁决 ${
    memory.actor.confirmer.decisionId
  } 确认 · 平台持久化`;
}

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
  const [searchQuery, setSearchQuery] = useState("");
  const [searchType, setSearchType] = useState("");
  const [searchSourceType, setSearchSourceType] = useState("");
  const [searchVersion, setSearchVersion] = useState("");
  const [searchHits, setSearchHits] = useState<Array<{
    memory: MemoryEntryV6;
    snippet: string;
  }> | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

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

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    setIsSearching(true);
    setSearchError(null);
    const params = new URLSearchParams({ q: query });
    if (searchType) params.set("type", searchType);
    if (searchSourceType) params.set("sourceType", searchSourceType);
    if (searchVersion.trim()) params.set("version", searchVersion.trim());
    try {
      const response = await fetch(
        `/api/projects/${projectId}/memories/search?${params.toString()}`,
      );
      const payload = (await response.json()) as {
        results?: Array<{ memory: MemoryEntryV6; snippet: string }>;
      } & MemoryPayload;
      if (!response.ok || !Array.isArray(payload.results)) {
        throw new Error("search");
      }
      setSearchHits(payload.results);
    } catch {
      setSearchError("无法检索记忆，请稍后重试。");
      setSearchHits(null);
    } finally {
      setIsSearching(false);
    }
  }

  function locateMemory(memoryId: string) {
    const card = document.getElementById(`memory-${memoryId}`);
    if (card && typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ block: "nearest" });
    }
    setFocusMemoryId(memoryId);
  }

  const supersedeOptions = memories.filter(
    (memory) => memory.active && memoryType(memory) === draft.type,
  );
  const displayedMemories = [...memories].sort((left, right) =>
    includeHistory
      ? chainId(left).localeCompare(chainId(right))
        || version(left) - version(right)
        || left.id.localeCompare(right.id)
      : left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
  const successorById = new Map(
    memories
      .filter((memory) => memory.supersedesId !== null)
      .map((memory) => [memory.supersedesId!, memory]),
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
                  .value as MemoryDraft["sourceType"],
              }))
            }
            value={draft.sourceType}
          >
            {Object.entries(OWNER_SOURCE_LABELS).map(([value, label]) => (
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
            placeholder="例如：docs/architecture.md"
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
        <button disabled={isLoading || isSaving} type="submit">
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
      <section
        aria-labelledby={`knowledge-feed-${projectId}`}
        className="stack memory-form"
      >
        <h3 id={`knowledge-feed-${projectId}`}>知识动态</h3>
        <form className="stack" onSubmit={submitSearch}>
          <div className="form-field">
            <label htmlFor={`memory-search-${projectId}`}>检索记忆</label>
            <input
              id={`memory-search-${projectId}`}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="例如：当前目标"
              value={searchQuery}
            />
          </div>
          <div className="form-row">
            <div className="form-field">
              <label htmlFor={`memory-search-type-${projectId}`}>检索类型</label>
              <select
                id={`memory-search-type-${projectId}`}
                onChange={(event) => setSearchType(event.target.value)}
                value={searchType}
              >
                <option value="">全部类型</option>
                {MEMORY_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`memory-search-source-${projectId}`}>检索来源</label>
              <select
                id={`memory-search-source-${projectId}`}
                onChange={(event) => setSearchSourceType(event.target.value)}
                value={searchSourceType}
              >
                <option value="">全部来源</option>
                {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`memory-search-version-${projectId}`}>检索版本</label>
              <input
                id={`memory-search-version-${projectId}`}
                inputMode="numeric"
                onChange={(event) => setSearchVersion(event.target.value)}
                placeholder="例如：2"
                value={searchVersion}
              />
            </div>
          </div>
          <button disabled={isSearching || !searchQuery.trim()} type="submit">
            {isSearching ? "正在检索…" : "检索"}
          </button>
        </form>
        {isSearching ? (
          <p aria-busy="true" className="state-message">
            正在检索记忆…
          </p>
        ) : null}
        {searchError ? (
          <p
            className="error-text"
            id={`memory-search-error-${projectId}`}
            role="alert"
          >
            {searchError}
          </p>
        ) : null}
        {!isSearching && searchHits && searchHits.length === 0 && !searchError ? (
          <p className="state-message">没有匹配的记忆。</p>
        ) : null}
        {searchHits && searchHits.length > 0 ? (
          <ul aria-label="记忆检索结果" className="stack">
            {searchHits.map((hit) => (
              <li key={hit.memory.id}>
                <button
                  aria-label={`定位记忆 ${hit.memory.content}`}
                  onClick={() => locateMemory(hit.memory.id)}
                  type="button"
                >
                  {hit.snippet}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
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
          {displayedMemories.map((memory) => {
            const memorySource = source(memory);
            const successor = successorById.get(memory.id);
            const predecessor = memory.supersedesId
              ? memories.find((candidate) => candidate.id === memory.supersedesId)
              : undefined;
            return (
            <li
              aria-label={`memory ${memory.id}`}
              className="task-summary stack"
              id={`memory-${memory.id}`}
              key={memory.id}
            >
              <h3
                ref={(element) => {
                  if (element) headingRefs.current.set(memory.id, element);
                  else headingRefs.current.delete(memory.id);
                }}
                tabIndex={-1}
              >
                {memory.content}
              </h3>
              <p>{MEMORY_TYPES.find((type) => type.value === memoryType(memory))?.label}</p>
              <p>{actorCopy(memory)}</p>
              {memorySource.href && memorySource.version ? (
                <a
                  aria-label={`${memorySource.type} · ${memorySource.id} · version ${memorySource.version}`}
                  href={memorySource.href}
                >
                  {SOURCE_LABELS[memorySource.type]} · <code>{memorySource.id}</code>
                  {" · version "}<code>{memorySource.version}</code>
                </a>
              ) : (
                <p>
                  {SOURCE_LABELS[memorySource.type]} · <code>{memorySource.id}</code>
                  {" · "}<span>原有来源（无版本）</span>
                </p>
              )}
              <p>chain <code>{chainId(memory)}</code> · v{version(memory)}</p>
              {memory.active ? (
                <p>Active · 当前版本</p>
              ) : (
                <>
                  <p>已失效</p>
                  <p>{successor ? `已被 v${version(successor)} 取代` : "已取代"}</p>
                </>
              )}
              {predecessor ? (
                <a href={`#memory-${predecessor.id}`}>
                  取代 memory {predecessor.id} · v{version(predecessor)}
                </a>
              ) : null}
              {successor ? (
                <a href={`#memory-${successor.id}`}>
                  后继 memory {successor.id} · v{version(successor)}
                </a>
              ) : null}
              {memorySource.type === "artifact_path" ? (
                <p className="muted">仅引用，尚未读取</p>
              ) : null}
            </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
