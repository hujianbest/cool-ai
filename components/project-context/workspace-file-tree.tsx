"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

type WorkspaceTreeEntry = {
  kind: "dir" | "file";
  name: string;
  sensitive: boolean;
  sizeBytes?: number;
};

type DirState =
  | { status: "loading" }
  | { status: "ready"; entries: WorkspaceTreeEntry[] }
  | { status: "error" };

type EntryRow = {
  type: "entry";
  path: string;
  name: string;
  kind: "dir" | "file";
  level: number;
  sensitive: boolean;
};

type StatusRow = {
  type: "status";
  dir: string;
  level: number;
  state: "loading" | "error" | "empty";
};

type VisibleRow = EntryRow | StatusRow;

const ROOT_PATH = ".";

function childPath(parent: string, name: string): string {
  return parent === ROOT_PATH ? name : `${parent}/${name}`;
}

export type WorkspaceFileTreeProps = {
  projectId: string;
  onFileSelect?: (path: string) => void;
};

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={16}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 16 16"
      width={16}
    >
      {open ? (
        <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 2H13a1 1 0 0 1 1 1v1L11.5 12a1 1 0 0 1-1 .5H3a1 1 0 0 1-1-1Z" />
      ) : (
        <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 2H13a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
      )}
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={16}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 16 16"
      width={16}
    >
      <path d="M4.5 1.5h4l3 3v9a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" />
      <path d="M8.5 1.5v3h3" />
    </svg>
  );
}

export function WorkspaceFileTree({
  projectId,
  onFileSelect,
}: WorkspaceFileTreeProps) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const epochRef = useRef(0);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());

  const loadDirectory = useCallback(
    (path: string) => {
      const epoch = epochRef.current;
      setDirs((current) => ({ ...current, [path]: { status: "loading" } }));
      fetch(
        `/api/projects/${projectId}/workspace/files?path=${encodeURIComponent(path)}`,
      )
        .then(async (response) => {
          if (!response.ok) throw new Error("load-failed");
          const payload = (await response.json()) as {
            entries?: WorkspaceTreeEntry[];
          };
          return payload.entries ?? [];
        })
        .then((entries) => {
          if (epochRef.current !== epoch) return;
          setDirs((current) => ({
            ...current,
            [path]: { status: "ready", entries },
          }));
        })
        .catch(() => {
          if (epochRef.current !== epoch) return;
          setDirs((current) => ({ ...current, [path]: { status: "error" } }));
        });
    },
    [projectId],
  );

  useEffect(() => {
    epochRef.current += 1;
    setDirs({});
    setExpanded(new Set());
    setSelectedPath(null);
    setActivePath(null);
    itemRefs.current.clear();
  }, [projectId]);

  useEffect(() => {
    loadDirectory(ROOT_PATH);
  }, [loadDirectory, reloadKey]);

  const rows = useMemo(() => {
    const visible: VisibleRow[] = [];
    const walk = (dirPath: string, level: number) => {
      const state = dirs[dirPath];
      if (state?.status === "loading") {
        visible.push({ type: "status", dir: dirPath, level, state: "loading" });
        return;
      }
      if (state?.status === "error") {
        visible.push({ type: "status", dir: dirPath, level, state: "error" });
        return;
      }
      if (state?.status !== "ready") return;
      if (state.entries.length === 0) {
        visible.push({ type: "status", dir: dirPath, level, state: "empty" });
        return;
      }
      for (const entry of state.entries) {
        const path = childPath(dirPath, entry.name);
        visible.push({
          type: "entry",
          path,
          name: entry.name,
          kind: entry.kind,
          level,
          sensitive: entry.sensitive,
        });
        if (entry.kind === "dir" && expanded.has(path)) {
          walk(path, level + 1);
        }
      }
    };
    const root = dirs[ROOT_PATH];
    if (root?.status === "ready" && root.entries.length > 0) {
      for (const entry of root.entries) {
        const path = childPath(ROOT_PATH, entry.name);
        visible.push({
          type: "entry",
          path,
          name: entry.name,
          kind: entry.kind,
          level: 1,
          sensitive: entry.sensitive,
        });
        if (entry.kind === "dir" && expanded.has(path)) {
          walk(path, 2);
        }
      }
    }
    return visible;
  }, [dirs, expanded]);

  const entryRows = useMemo(
    () => rows.filter((row): row is EntryRow => row.type === "entry"),
    [rows],
  );

  function toggleDir(path: string) {
    const isExpanded = expanded.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!isExpanded) {
      const state = dirs[path];
      if (!state || state.status === "error") loadDirectory(path);
    }
    if (isExpanded && activePath && activePath.startsWith(`${path}/`)) {
      focusRow(path);
    }
  }

  function selectFile(path: string) {
    setSelectedPath(path);
    onFileSelect?.(path);
  }

  function focusRow(path: string) {
    setActivePath(path);
    itemRefs.current.get(path)?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>, row: EntryRow) {
    const index = entryRows.findIndex((entry) => entry.path === row.path);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = entryRows[index + 1];
      if (next) focusRow(next.path);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const previous = entryRows[index - 1];
      if (previous) focusRow(previous.path);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (row.kind === "dir") {
        if (!expanded.has(row.path)) {
          toggleDir(row.path);
        } else {
          const next = entryRows[index + 1];
          if (next && next.level === row.level + 1) focusRow(next.path);
        }
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.kind === "dir" && expanded.has(row.path)) {
        toggleDir(row.path);
      } else if (row.level > 1) {
        for (let i = index - 1; i >= 0; i -= 1) {
          const candidate = entryRows[i]!;
          if (candidate.level === row.level - 1) {
            focusRow(candidate.path);
            break;
          }
        }
      }
    } else if (event.key === "Home") {
      event.preventDefault();
      const first = entryRows[0];
      if (first) focusRow(first.path);
    } else if (event.key === "End") {
      event.preventDefault();
      const last = entryRows[entryRows.length - 1];
      if (last) focusRow(last.path);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (row.kind === "dir") toggleDir(row.path);
      else selectFile(row.path);
    }
  }

  const rootState = dirs[ROOT_PATH];

  return (
    <div className="workspace-tree">
      {rootState?.status === "ready" && rootState.entries.length > 0 ? (
        <ul aria-label="工作区文件" className="workspace-tree-list" role="tree">
          {rows.map((row) =>
            row.type === "status" ? (
              <li key={`status-${row.dir}-${row.state}`} role="none">
                <div
                  className="workspace-tree-status"
                  style={{
                    paddingInlineStart: `calc(var(--space-2) + var(--space-5) * ${row.level - 1})`,
                  }}
                >
                  {row.state === "loading" ? (
                    <span aria-busy="true" className="muted">
                      正在加载…
                    </span>
                  ) : null}
                  {row.state === "empty" ? (
                    <span className="muted">该目录为空。</span>
                  ) : null}
                  {row.state === "error" ? (
                    <span className="workspace-tree-branch-error">
                      <span className="error-text" role="alert">
                        无法加载该目录。
                      </span>
                      <button
                        onClick={() => loadDirectory(row.dir)}
                        type="button"
                      >
                        重试
                      </button>
                    </span>
                  ) : null}
                </div>
              </li>
            ) : (
              <li key={row.path} role="none">
                <div
                  aria-expanded={
                    row.kind === "dir" ? expanded.has(row.path) : undefined
                  }
                  aria-level={row.level}
                  aria-selected={selectedPath === row.path}
                  className="workspace-tree-item"
                  onClick={(event: MouseEvent<HTMLDivElement>) => {
                    event.preventDefault();
                    focusRow(row.path);
                    if (row.kind === "dir") toggleDir(row.path);
                    else selectFile(row.path);
                  }}
                  onKeyDown={(event: KeyboardEvent<HTMLDivElement>) =>
                    handleKeyDown(event, row)
                  }
                  ref={(element) => {
                    if (element) itemRefs.current.set(row.path, element);
                    else itemRefs.current.delete(row.path);
                  }}
                  role="treeitem"
                  style={{
                    paddingInlineStart: `calc(var(--space-2) + var(--space-5) * ${row.level - 1})`,
                  }}
                  tabIndex={
                    row.path === (activePath ?? rows.find((r): r is EntryRow => r.type === "entry")?.path)
                      ? 0
                      : -1
                  }
                >
                  <span className="workspace-tree-icon">
                    {row.kind === "dir" ? (
                      <FolderIcon open={expanded.has(row.path)} />
                    ) : (
                      <FileIcon />
                    )}
                  </span>
                  <span className="workspace-tree-name">{row.name}</span>
                  {row.sensitive ? (
                    <span className="status-label status-queued">已遮蔽</span>
                  ) : null}
                </div>
              </li>
            ),
          )}
        </ul>
      ) : null}
      {!rootState || rootState.status === "loading" ? (
        <p aria-busy="true" className="muted">
          正在加载文件列表…
        </p>
      ) : null}
      {rootState?.status === "error" ? (
        <div className="stack">
          <p className="error-text" role="alert">
            无法加载文件列表，请重试。
          </p>
          <div>
            <button
              onClick={() => setReloadKey((current) => current + 1)}
              type="button"
            >
              重试加载文件列表
            </button>
          </div>
        </div>
      ) : null}
      {rootState?.status === "ready" && rootState.entries.length === 0 ? (
        <p className="muted">该目录为空。</p>
      ) : null}
    </div>
  );
}
