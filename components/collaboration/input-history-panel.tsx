"use client";

import { useEffect, useRef, useState } from "react";

import {
  setInputHistoryRecording,
  useInputHistoryRecording,
} from "@/components/input-history-recording-store";
import type {
  InputHistoryEntryDto,
  InputHistorySearchResponse,
} from "@/src/shared/collaboration-contracts";

type InputHistoryPanelProps = {
  disabled: boolean;
  onFill: (content: string) => void;
  onRequestClose: () => void;
  projectId: string;
};

const EXCERPT_MAX_GRAPHEMES = 80;
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

function excerpt(content: string): string {
  const collapsed = content.replace(/\s+/gu, " ").trim();
  const graphemes = Array.from(segmenter.segment(collapsed));
  return graphemes.length > EXCERPT_MAX_GRAPHEMES
    ? `${graphemes.slice(0, EXCERPT_MAX_GRAPHEMES).join("")}…`
    : collapsed;
}

function readableTime(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(timestamp));
}

function parseSearchResponse(value: unknown): InputHistorySearchResponse | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Array.isArray(candidate.entries)
    || (candidate.lastClearedAt !== null
      && typeof candidate.lastClearedAt !== "string")
  ) {
    return null;
  }
  const entries: InputHistoryEntryDto[] = [];
  for (const raw of candidate.entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.id !== "string"
      || typeof entry.threadId !== "string"
      || typeof entry.content !== "string"
      || typeof entry.createdAt !== "string"
    ) {
      return null;
    }
    entries.push({
      id: entry.id,
      threadId: entry.threadId,
      content: entry.content,
      createdAt: entry.createdAt,
    });
  }
  return {
    entries,
    lastClearedAt: candidate.lastClearedAt as string | null,
  };
}

export function InputHistoryPanel({
  disabled,
  onFill,
  onRequestClose,
  projectId,
}: InputHistoryPanelProps) {
  const recording = useInputHistoryRecording();
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<InputHistoryEntryDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const requestRef = useRef(0);
  const clearButtonRef = useRef<HTMLButtonElement | null>(null);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const searchId = `collaboration-input-history-search-${projectId}`;
  const regionId = `collaboration-input-history-${projectId}`;

  const onRequestCloseRef = useRef(onRequestClose);
  useEffect(() => {
    onRequestCloseRef.current = onRequestClose;
  }, [onRequestClose]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // The confirm buttons unmount when the two-step prompt dismisses; without
  // focus return, keyboard focus falls to <body> and Escape no longer reaches
  // this region.
  const wasConfirmingRef = useRef(false);
  useEffect(() => {
    if (wasConfirmingRef.current && !confirming) {
      clearButtonRef.current?.focus();
    }
    wasConfirmingRef.current = confirming;
  }, [confirming]);

  useEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    // The narrow task editor dialog closes on Escape via a native keydown
    // listener on the dialog element, which runs before React synthetic
    // handlers attached at the root. Only a native listener here can consume
    // Escape first, keeping dismissal layered (region closes, dialog stays).
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onRequestCloseRef.current();
    };
    region.addEventListener("keydown", handleKeyDown);
    return () => region.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/input-history`,
        );
        const body = parseSearchResponse(await response.json().catch(() => null));
        if (requestId !== requestRef.current) return;
        if (!response.ok || !body) {
          setEntries(null);
          setError("输入历史加载失败，请重试。");
          return;
        }
        setEntries(body.entries);
      } catch {
        if (requestId !== requestRef.current) return;
        setEntries(null);
        setError("输入历史加载失败，请重试。");
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    })();
  }, [projectId]);

  async function search(keyword: string) {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    setConfirming(false);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/input-history?query=${
          encodeURIComponent(keyword)
        }`,
      );
      const body = parseSearchResponse(await response.json().catch(() => null));
      if (requestId !== requestRef.current) return;
      if (!response.ok || !body) {
        setEntries(null);
        setError("输入历史加载失败，请重试。");
        return;
      }
      setEntries(body.entries);
    } catch {
      if (requestId !== requestRef.current) return;
      setEntries(null);
      setError("输入历史加载失败，请重试。");
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }

  async function clearAll() {
    const requestId = ++requestRef.current;
    setClearing(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/input-history`,
        { method: "DELETE" },
      );
      if (requestId !== requestRef.current) return;
      if (!response.ok) {
        setError("输入历史清除失败，请重试。");
        return;
      }
      setEntries([]);
      setConfirming(false);
    } catch {
      if (requestId !== requestRef.current) return;
      setError("输入历史清除失败，请重试。");
    } finally {
      if (requestId === requestRef.current) setClearing(false);
    }
  }

  return (
    <div
      aria-label="输入历史"
      className="input-history-panel"
      id={regionId}
      ref={regionRef}
      role="region"
    >
      <form
        className="input-history-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search(query);
        }}
      >
        <label htmlFor={searchId}>搜索输入历史</label>
        <input
          id={searchId}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按关键词检索"
          ref={searchRef}
          value={query}
        />
        <button disabled={loading} type="submit">搜索</button>
      </form>
      <label className="input-history-recording">
        <input
          checked={recording.record}
          disabled={!recording.hydrated}
          onChange={(event) => setInputHistoryRecording(event.target.checked)}
          type="checkbox"
        />
        记录新输入历史
      </label>
      {recording.error ? (
        <p className="muted">记录偏好保存失败，本次修改可能不会保留。</p>
      ) : null}
      {loading ? (
        <p aria-busy="true" className="muted">正在加载输入历史…</p>
      ) : null}
      {error ? <p className="muted">{error}</p> : null}
      {!loading && !error && entries !== null && entries.length === 0 ? (
        <p className="muted">没有匹配的输入历史。</p>
      ) : null}
      {entries !== null && entries.length > 0 ? (
        <ul className="input-history-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                disabled={disabled}
                onClick={() => onFill(entry.content)}
                type="button"
              >
                <span className="input-history-excerpt">
                  {excerpt(entry.content)}
                </span>
                <time dateTime={entry.createdAt}>
                  {readableTime(entry.createdAt)}
                </time>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {confirming ? (
        <div className="input-history-confirm">
          <p>确认清除全部输入历史？清除后不可恢复。</p>
          <button
            disabled={clearing}
            onClick={() => void clearAll()}
            type="button"
          >
            {clearing ? "正在清除…" : "确认清除"}
          </button>
          <button
            disabled={clearing}
            onClick={() => setConfirming(false)}
            type="button"
          >
            取消
          </button>
        </div>
      ) : (
        <button
          disabled={disabled || loading}
          onClick={() => setConfirming(true)}
          ref={clearButtonRef}
          type="button"
        >
          清除全部
        </button>
      )}
    </div>
  );
}
