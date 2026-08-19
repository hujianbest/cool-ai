"use client";

import { useEffect, useRef, useState } from "react";

type WorkspaceImageContentType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

type WorkspaceFilePreviewDto =
  | {
      content: string;
      kind: "text";
      lineCount: number;
      sizeBytes: number;
      truncated: boolean;
    }
  | {
      contentType: WorkspaceImageContentType;
      dataUrl: string;
      kind: "image";
      sizeBytes: number;
    }
  | { kind: "binary-unsupported" }
  | { kind: "sensitive-masked" };

type PreviewState =
  | { status: "idle" }
  | { status: "loading"; path: string }
  | { status: "error"; path: string }
  | { status: "ready"; path: string; preview: WorkspaceFilePreviewDto };

export type WorkspaceFilePreviewProps = {
  filePath: string | null;
  projectId: string;
};

const IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Rebuilds each branch from known fields only, so a misbehaving server
// cannot smuggle content through a masked/unsupported payload.
function parsePreview(payload: unknown): WorkspaceFilePreviewDto | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  switch (candidate.kind) {
    case "text": {
      const { content, lineCount, sizeBytes, truncated } = candidate;
      if (
        typeof content !== "string"
        || typeof truncated !== "boolean"
        || typeof lineCount !== "number"
        || !Number.isInteger(lineCount)
        || lineCount < 0
        || !isByteCount(sizeBytes)
      ) {
        return null;
      }
      return { content, kind: "text", lineCount, sizeBytes, truncated };
    }
    case "image": {
      const { contentType, dataUrl, sizeBytes } = candidate;
      if (
        typeof contentType !== "string"
        || !IMAGE_CONTENT_TYPES.has(contentType)
        || typeof dataUrl !== "string"
        || !isByteCount(sizeBytes)
      ) {
        return null;
      }
      return {
        contentType: contentType as WorkspaceImageContentType,
        dataUrl,
        kind: "image",
        sizeBytes,
      };
    }
    case "binary-unsupported":
      return { kind: "binary-unsupported" };
    case "sensitive-masked":
      return { kind: "sensitive-masked" };
    default:
      return null;
  }
}

export function formatWorkspaceFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

function PreviewBody({
  onEdit,
  path,
  preview,
}: {
  onEdit?: () => void;
  path: string;
  preview: WorkspaceFilePreviewDto;
}) {
  switch (preview.kind) {
    case "text":
      return (
        <>
          {preview.truncated ? (
            <p className="workspace-preview-truncated" role="status">
              已截断（仅显示前 512KiB）
            </p>
          ) : null}
          <p className="workspace-preview-meta muted">
            {preview.lineCount} 行 · {formatWorkspaceFileSize(preview.sizeBytes)}
          </p>
          {onEdit && !preview.truncated ? (
            <div>
              <button onClick={onEdit} type="button">
                编辑
              </button>
            </div>
          ) : null}
          <pre className="workspace-preview-content">{preview.content}</pre>
        </>
      );
    case "image": {
      const fileName = path.split("/").pop() ?? path;
      return (
        <>
          <p className="workspace-preview-meta muted">
            {preview.contentType} · {formatWorkspaceFileSize(preview.sizeBytes)}
          </p>
          <img
            alt={fileName}
            className="workspace-preview-image"
            src={preview.dataUrl}
          />
        </>
      );
    }
    case "binary-unsupported":
      return <p className="muted">该文件类型不支持预览。</p>;
    case "sensitive-masked":
      return <p className="muted">敏感文件已遮蔽，内容不回显。</p>;
  }
}

export function WorkspaceFilePreview({
  filePath,
  projectId,
}: WorkspaceFilePreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<{
    content: string;
    expectedHash: string;
    sessionId: string;
    version: number;
  } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const epochRef = useRef(0);

  useEffect(() => {
    if (filePath === null) {
      epochRef.current += 1;
      setState({ status: "idle" });
      return;
    }
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    setState({ status: "loading", path: filePath });
    fetch(
      `/api/projects/${projectId}/workspace/file?path=${encodeURIComponent(filePath)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error("preview-load-failed");
        const preview = parsePreview(payload);
        if (preview === null) throw new Error("preview-response-invalid");
        return preview;
      })
      .then((preview) => {
        if (epochRef.current !== epoch) return;
        setState({ path: filePath, preview, status: "ready" });
      })
      .catch(() => {
        if (epochRef.current !== epoch || controller.signal.aborted) return;
        setState({ path: filePath, status: "error" });
      });
    return () => {
      controller.abort();
    };
  }, [filePath, projectId, reloadKey]);

  async function startEdit(path: string, content: string): Promise<void> {
    setEditorError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/edits`, {
        body: JSON.stringify({ operationId: crypto.randomUUID(), path }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || typeof payload !== "object" || payload === null) {
        throw new Error("edit-open-failed");
      }
      const session = payload as Record<string, unknown>;
      if (
        typeof session.sessionId !== "string"
        || typeof session.expectedHash !== "string"
        || typeof session.version !== "number"
      ) {
        throw new Error("edit-open-failed");
      }
      setEditor({
        content,
        expectedHash: session.expectedHash,
        sessionId: session.sessionId,
        version: session.version,
      });
    } catch {
      setEditorError("无法开始编辑。");
    } finally {
      setBusy(false);
    }
  }

  async function abandonEdit(): Promise<void> {
    if (!editor) return;
    setBusy(true);
    try {
      await fetch(
        `/api/projects/${projectId}/workspace/edits/${editor.sessionId}/abandon`,
        {
          body: JSON.stringify({
            expectedVersion: editor.version,
            operationId: crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
    } finally {
      setBusy(false);
      setEditor(null);
    }
  }

  async function requestMerge(): Promise<void> {
    if (!editor) return;
    setEditorError(null);
    setBusy(true);
    try {
      const put = await fetch(
        `/api/projects/${projectId}/workspace/edits/${editor.sessionId}`,
        {
          body: JSON.stringify({
            content: editor.content,
            expectedHash: editor.expectedHash,
            expectedVersion: editor.version,
            operationId: crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        },
      );
      const putBody: unknown = await put.json().catch(() => null);
      if (!put.ok || typeof putBody !== "object" || putBody === null) {
        throw new Error("edit-put-failed");
      }
      const version = (putBody as { version?: unknown }).version;
      if (typeof version !== "number") throw new Error("edit-put-failed");
      await fetch(
        `/api/projects/${projectId}/workspace/edits/${editor.sessionId}/diff`,
      );
      const staged = await fetch(
        `/api/projects/${projectId}/workspace/edits/${editor.sessionId}/stage`,
        {
          body: JSON.stringify({
            expectedVersion: version,
            operationId: crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      if (!staged.ok) throw new Error("edit-stage-failed");
      setEditor(null);
      setReloadKey((current) => current + 1);
    } catch {
      setEditorError("无法申请合入。");
    } finally {
      setBusy(false);
    }
  }

  const visible: PreviewState =
    filePath === null
      ? { status: "idle" }
      : state.status !== "idle" && state.path === filePath
        ? state
        : { path: filePath, status: "loading" };

  return (
    <section aria-label="文件预览" className="workspace-preview">
      {visible.status === "idle" ? (
        <p className="muted">在文件树中选择文件即可预览。</p>
      ) : (
        <>
          <p aria-label="当前文件" className="workspace-preview-path">
            <code>{visible.path}</code>
          </p>
          {visible.status === "loading" ? (
            <p aria-busy="true" className="muted">
              正在加载预览…
            </p>
          ) : null}
          {visible.status === "error" ? (
            <>
              <p className="error-text" role="alert">
                无法加载文件预览，请重试。
              </p>
              <div>
                <button
                  onClick={() => setReloadKey((current) => current + 1)}
                  type="button"
                >
                  重试加载预览
                </button>
              </div>
            </>
          ) : null}
          {visible.status === "ready" ? (
            <PreviewBody
              onEdit={
                visible.preview.kind === "text" && !visible.preview.truncated
                  ? () => {
                      const content = visible.preview.kind === "text"
                        ? visible.preview.content
                        : "";
                      void startEdit(visible.path, content);
                    }
                  : undefined
              }
              path={visible.path}
              preview={visible.preview}
            />
          ) : null}
        </>
      )}
      {editorError ? (
        <p className="error-text" role="alert">
          {editorError}
        </p>
      ) : null}
      {editor ? (
        <div
          aria-labelledby="workspace-edit-title"
          aria-modal="true"
          className="cockpit-context modal-surface workspace-edit-dialog"
          role="dialog"
        >
          <div className="panel-heading">
            <h3 id="workspace-edit-title">编辑文件</h3>
            <button
              aria-label="关闭编辑"
              className="button-ghost drawer-close"
              disabled={busy}
              onClick={() => {
                void abandonEdit();
              }}
              type="button"
            >
              关闭
            </button>
          </div>
          <label className="stack" htmlFor="workspace-edit-content">
            文件内容
            <textarea
              id="workspace-edit-content"
              onChange={(event) => {
                setEditor((current) =>
                  current ? { ...current, content: event.target.value } : current,
                );
              }}
              value={editor.content}
            />
          </label>
          <div className="cluster">
            <button
              disabled={busy}
              onClick={() => {
                void abandonEdit();
              }}
              type="button"
            >
              放弃
            </button>
            <button
              className="button-primary"
              disabled={busy}
              onClick={() => {
                void requestMerge();
              }}
              type="button"
            >
              申请合入
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
