"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useModalSurface } from "@/components/mobile-dialog";
import type { ApiError } from "@/src/shared/contracts";
import type { WorkspaceState } from "@/src/shared/project-context-contracts";

type WorkspaceSetupProps = {
  projectId: string;
  projectVersion?: number;
  onVersionChange?: (version: number) => void;
  onConfirmationChange?: (open: boolean) => void;
  setupRootRef?: RefObject<HTMLElement | null>;
};

function looksAbsolute(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path.trim());
}

function workspaceError(payload: Partial<ApiError>): string {
  switch (payload.error?.code) {
    case "WORKSPACE_INVALID":
      return "请输入有效的绝对目录路径。";
    case "WORKSPACE_NOT_FOUND":
      return "未找到该目录。";
    case "WORKSPACE_NOT_DIRECTORY":
      return "请输入目录路径，而不是文件路径。";
    case "WORKSPACE_NOT_READABLE":
      return "该目录不可读取。";
    case "WORKSPACE_ALREADY_BOUND":
      return "该目录已绑定到其他项目。";
    case "RESOURCE_CONFLICT":
      return "项目已更新，请重新加载后再试。";
    default:
      return "无法绑定工作区，请检查路径后重试。";
  }
}

export function WorkspaceSetup({
  projectId,
  projectVersion,
  onVersionChange,
  onConfirmationChange,
  setupRootRef,
}: WorkspaceSetupProps) {
  const [path, setPath] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceState["workspace"]>(null);
  const [loadedVersion, setLoadedVersion] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [focusSummary, setFocusSummary] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const updateConfirmation = useCallback(
    (open: boolean) => {
      setConfirmOpen(open);
      onConfirmationChange?.(open);
    },
    [onConfirmationChange],
  );
  const modalOptions = useMemo(
    () => ({
      active: confirmOpen,
      dialogRef,
      inertRootRefs: [setupRootRef ?? contentRef],
      initialFocusRef: confirmRef,
      restoreFocusRef: saveRef,
      onClose: () => updateConfirmation(false),
    }),
    [confirmOpen, updateConfirmation],
  );
  useModalSurface(modalOptions);

  useEffect(() => {
    return () => onConfirmationChange?.(false);
  }, [onConfirmationChange]);

  useEffect(() => {
    setPath("");
    setWorkspace(null);
    setLoadedVersion(1);
    setError(null);
    setSuccess("");
  }, [projectId]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    setSuccess("");
    void fetch(`/api/projects/${projectId}/workspace`)
      .then(async (response) => {
        const payload = (await response.json()) as WorkspaceState &
          Partial<ApiError>;
        if (!response.ok) throw new Error(workspaceError(payload));
        if (
          !("workspace" in payload) ||
          !Number.isInteger(payload.projectVersion)
        ) {
          throw new Error("invalid workspace response");
        }
        return payload;
      })
      .then((payload) => {
        if (!active) return;
        setWorkspace(payload.workspace);
        setLoadedVersion(payload.projectVersion);
        setPath((current) => current || payload.workspace?.path || "");
        onVersionChange?.(payload.projectVersion);
      })
      .catch(() => {
        if (active) setError("无法加载工作区，请重试。");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onVersionChange, projectId, reloadKey]);

  useEffect(() => {
    if (!focusSummary) return;
    summaryRef.current?.focus();
    setFocusSummary(false);
  }, [focusSummary, workspace]);

  async function saveWorkspace(confirmRebind: boolean) {
    setError(null);
    setSuccess("");
    setIsSaving(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace`, {
        body: JSON.stringify({
          path,
          expectedVersion: projectVersion ?? loadedVersion,
          confirmRebind,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json()) as WorkspaceState &
        Partial<ApiError>;
      if (!response.ok) {
        if (payload.error?.code === "REBIND_CONFIRMATION_REQUIRED") {
          updateConfirmation(true);
          return;
        }
        throw new Error(workspaceError(payload));
      }
      setWorkspace(payload.workspace);
      setLoadedVersion(payload.projectVersion);
      setPath(payload.workspace?.path ?? path);
      onVersionChange?.(payload.projectVersion);
      updateConfirmation(false);
      setSuccess("工作区已保存。");
      setFocusSummary(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法绑定工作区。");
      pathRef.current?.focus();
    } finally {
      setIsSaving(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!looksAbsolute(path)) {
      setError("请输入绝对目录路径。");
      pathRef.current?.focus();
      return;
    }
    if (workspace && path.trim() !== workspace.path) {
      updateConfirmation(true);
      return;
    }
    void saveWorkspace(false);
  }

  return (
    <>
      <section aria-labelledby={`workspace-title-${projectId}`} className="stack">
        <div ref={contentRef}>
        <div className="stack">
          <h3 id={`workspace-title-${projectId}`}>本地工作区</h3>
          {isLoading ? (
            <p aria-busy="true" className="muted">
              正在加载工作区…
            </p>
          ) : workspace ? (
            <p
              aria-label="工作区绑定状态"
              ref={summaryRef}
              role="status"
              tabIndex={-1}
            >
              已绑定：<code>{workspace.path}</code>
            </p>
          ) : (
            <p className="muted">尚未绑定本地工作区。</p>
          )}
          <form className="stack" onSubmit={handleSubmit}>
            <div className="form-field">
              <label htmlFor={`workspace-path-${projectId}`}>
                本地工作区路径
              </label>
              <input
                aria-describedby={
                  error ? `workspace-error-${projectId}` : undefined
                }
                id={`workspace-path-${projectId}`}
                name="workspacePath"
                onChange={(event) => setPath(event.target.value)}
                placeholder="例如：D:\projects\my-app"
                ref={pathRef}
                value={path}
              />
            </div>
            <button disabled={isSaving} ref={saveRef} type="submit">
              {isSaving
                ? "正在保存工作区…"
                : workspace
                  ? "保存工作区"
                  : "绑定工作区"}
            </button>
          </form>
          {error ? (
            <div className="stack">
              <p
                className="error-text"
                id={`workspace-error-${projectId}`}
                role="alert"
              >
                {error}
              </p>
              {error.startsWith("无法加载") ? (
                <button
                  onClick={() => setReloadKey((current) => current + 1)}
                  type="button"
                >
                  重试加载工作区
                </button>
              ) : null}
            </div>
          ) : null}
          {success ? (
            <p aria-live="polite" aria-label="保存结果" role="status">
              {success}
            </p>
          ) : null}
        </div>
        </div>
      </section>
      {confirmOpen
        ? createPortal(
            <div
              aria-labelledby={`workspace-confirm-title-${projectId}`}
              aria-modal="true"
              className="modal-surface"
              ref={dialogRef}
              role="dialog"
            >
              <h3 id={`workspace-confirm-title-${projectId}`}>
                确认改绑工作区
              </h3>
              <p>改绑只更新目录边界，不会读取或修改目录内容。</p>
              <div className="form-row">
                <button
                  onClick={() => updateConfirmation(false)}
                  type="button"
                >
                  取消
                </button>
                <button
                  disabled={isSaving}
                  onClick={() => void saveWorkspace(true)}
                  ref={confirmRef}
                  type="button"
                >
                  确认改绑
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
