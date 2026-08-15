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

import { FolderPlus } from "@phosphor-icons/react";
import { useModalSurface } from "@/components/mobile-dialog";
import { WorkspaceOnboardingGuide } from "@/components/onboarding-guide";
import { WorkspaceFilePreview } from "@/components/project-context/workspace-file-preview";
import { WorkspaceFileTree } from "@/components/project-context/workspace-file-tree";
import { ActionDialog } from "@/components/ui/action-dialog";
import { IconButton } from "@/components/ui/icon-button";
import type { ApiError } from "@/src/shared/contracts";
import type { WorkspaceState } from "@/src/shared/project-context-contracts";
import {
  parseWorkspaceGuideEnvelope,
  type WorkspaceGuideEnvelope,
} from "@/src/shared/onboarding-guide-machine";

type WorkspaceSetupProps = {
  projectId: string;
  projectVersion?: number;
  onVersionChange?: (version: number) => void;
  onConfirmationChange?: (open: boolean) => void;
  onGuideContinue?: () => void;
  onGuideSkip?: () => void;
  setupRootRef?: RefObject<HTMLElement | null>;
  showGuide?: boolean;
};

class KnownWorkspaceError extends Error {}
class InvalidWorkspaceResponseError extends Error {}

function looksAbsolute(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path.trim());
}

function comparableWorkspacePath(path: string): string {
  let normalized = path.trim().replace(/\//g, "\\");
  if (normalized.startsWith("\\\\?\\UNC\\")) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
  }
  if (!/^[A-Za-z]:\\$/.test(normalized)) {
    normalized = normalized.replace(/\\+$/, "");
  }
  return normalized.toLocaleLowerCase("en-US");
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
  onGuideContinue,
  onGuideSkip,
  setupRootRef,
  showGuide = false,
}: WorkspaceSetupProps) {
  const [path, setPath] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceState["workspace"]>(null);
  const [loadedVersion, setLoadedVersion] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [guideFacts, setGuideFacts] = useState<WorkspaceGuideEnvelope | null>(
    null,
  );
  const [guideLoadError, setGuideLoadError] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [focusSummary, setFocusSummary] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const bindOpenerRef = useRef<HTMLButtonElement>(null);
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
      restoreFocusRef: bindOpenerRef,
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
    setSelectedFile(null);
    setGuideFacts(null);
    setGuideLoadError(false);
    setNeedsReload(false);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    setSuccess("");
    setGuideLoadError(false);
    setNeedsReload(false);
    void fetch(`/api/projects/${projectId}/workspace`)
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) {
          throw new KnownWorkspaceError(
            workspaceError(payload as Partial<ApiError>),
          );
        }
        const parsed = parseWorkspaceGuideEnvelope(payload);
        if (parsed.kind === "invalid") {
          if (active) setGuideFacts(parsed);
          throw new InvalidWorkspaceResponseError();
        }
        return parsed;
      })
      .then((payload) => {
        if (!active) return;
        setGuideFacts(payload);
        setWorkspace(payload.workspace);
        setLoadedVersion(payload.projectVersion);
        setPath((current) => payload.workspace?.path ?? current);
        onVersionChange?.(payload.projectVersion);
      })
      .catch((cause) => {
        if (!active) return;
        setGuideLoadError(!(cause instanceof InvalidWorkspaceResponseError));
        setError(
          cause instanceof InvalidWorkspaceResponseError
            ? "工作区响应无效，已失败关闭。"
            : "无法加载工作区，请重试。",
        );
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
    setNeedsReload(false);
    setIsSaving(true);
    const expectedVersion = projectVersion ?? loadedVersion;
    const requestedPath = path.trim();
    const reconcileUnknownWrite = async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/workspace`);
        if (!response.ok) throw new Error("read");
        const parsed = parseWorkspaceGuideEnvelope(await response.json());
        const samePath =
          parsed.kind === "success" &&
          comparableWorkspacePath(parsed.workspace.path) ===
            comparableWorkspacePath(requestedPath);
        if (
          parsed.kind !== "success" ||
          !samePath ||
          parsed.projectVersion !== expectedVersion + 1
        ) {
          throw new Error("unconfirmed");
        }
        setGuideFacts(parsed);
        setGuideLoadError(false);
        setWorkspace(parsed.workspace);
        if (parsed.workspace.path !== workspace?.path) setSelectedFile(null);
        setLoadedVersion(parsed.projectVersion);
        setPath(parsed.workspace.path);
        onVersionChange?.(parsed.projectVersion);
        updateConfirmation(false);
        setSuccess("已通过事实核对确认工作区已保存。");
        setBindOpen(false);
        setFocusSummary(true);
      } catch {
        updateConfirmation(false);
        setBindOpen(true);
        setError(
          "工作区写入结果未知，且无法由 GET 唯一确认。请核对当前绑定后再决定是否重试；不会自动重发。",
        );
        setNeedsReload(true);
        pathRef.current?.focus();
      }
    };
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace`, {
        body: JSON.stringify({
          path,
          expectedVersion,
          confirmRebind,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const apiError = payload as Partial<ApiError>;
        if (apiError.error?.code === "REBIND_CONFIRMATION_REQUIRED") {
          setBindOpen(false);
          updateConfirmation(true);
          return;
        }
        if (apiError.error?.code === "RESOURCE_CONFLICT") {
          setNeedsReload(true);
          updateConfirmation(false);
          setBindOpen(false);
          setError(workspaceError(apiError));
          return;
        }
        throw new KnownWorkspaceError(workspaceError(apiError));
      }
      const parsed = parseWorkspaceGuideEnvelope(payload);
      if (parsed.kind === "invalid") {
        await reconcileUnknownWrite();
        return;
      }
      setGuideFacts(parsed);
      setGuideLoadError(false);
      setWorkspace(parsed.workspace);
      if (parsed.workspace?.path !== workspace?.path) setSelectedFile(null);
      setLoadedVersion(parsed.projectVersion);
      setPath(parsed.workspace?.path ?? path);
      onVersionChange?.(parsed.projectVersion);
      updateConfirmation(false);
      setSuccess("工作区已保存。");
      setBindOpen(false);
      setFocusSummary(true);
    } catch (cause) {
      if (cause instanceof KnownWorkspaceError) {
        updateConfirmation(false);
        setBindOpen(true);
        setError(cause.message);
        pathRef.current?.focus();
      } else {
        await reconcileUnknownWrite();
      }
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
      setBindOpen(false);
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
          {showGuide ? (
            <WorkspaceOnboardingGuide
              facts={guideFacts}
              loading={isLoading}
              loadError={guideLoadError}
              onContinue={onGuideContinue}
              onFocusWorkspace={() => {
                if (guideFacts?.kind === "success") summaryRef.current?.focus();
                else {
                  setBindOpen(true);
                  queueMicrotask(() => pathRef.current?.focus());
                }
              }}
              onRetry={() => setReloadKey((current) => current + 1)}
              onSkip={onGuideSkip}
            />
          ) : null}
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
          <IconButton
            className="button-primary"
            icon={<FolderPlus size={20} weight="regular" />}
            label={workspace ? "保存工作区" : "绑定工作区"}
            onClick={() => {
              setBindOpen(true);
              queueMicrotask(() => pathRef.current?.focus());
            }}
            ref={bindOpenerRef}
          />
          <ActionDialog
            closeLabel="关闭工作区绑定"
            initialFocusRef={pathRef}
            onClose={() => setBindOpen(false)}
            open={bindOpen}
            title={workspace ? "保存工作区" : "绑定工作区"}
            titleId={`workspace-bind-title-${projectId}`}
          >
          <form className="stack" onSubmit={handleSubmit}>
            <div className="form-field">
              <label htmlFor={`workspace-path-${projectId}`}>
                本地工作区路径
              </label>
              <input
                aria-describedby={
                  error ? `workspace-error-${projectId}` : undefined
                }
                aria-invalid={error ? "true" : undefined}
                id={`workspace-path-${projectId}`}
                name="workspacePath"
                onChange={(event) => setPath(event.target.value)}
                placeholder="例如：D:\projects\my-app"
                ref={pathRef}
                value={path}
              />
            </div>
            <button
              aria-describedby={
                isSaving ? `workspace-saving-reason-${projectId}` : undefined
              }
              disabled={isSaving}
              ref={saveRef}
              type="submit"
            >
              {isSaving
                ? "正在保存工作区…"
                : workspace
                  ? "保存工作区"
                  : "绑定工作区"}
            </button>
            {isSaving ? (
              <p className="muted" id={`workspace-saving-reason-${projectId}`}>
                正在核对并保存工作区，完成前不能重复提交。
              </p>
            ) : null}
          </form>
          {error && bindOpen ? (
            <p
              className="error-text"
              id={`workspace-error-${projectId}`}
              role="alert"
            >
              {error}
            </p>
          ) : null}
          </ActionDialog>
          {error && !bindOpen ? (
            <div className="stack">
              <p
                className="error-text"
                id={`workspace-error-${projectId}`}
                role="alert"
              >
                {error}
              </p>
              {error.startsWith("无法加载") || needsReload ? (
                <button
                  onClick={() => setReloadKey((current) => current + 1)}
                  type="button"
                >
                  {needsReload ? "重新加载工作区" : "重试加载工作区"}
                </button>
              ) : null}
            </div>
          ) : null}
          {success ? (
            <p aria-live="polite" aria-label="保存结果" role="status">
              {success}
            </p>
          ) : null}
          <div className="stack">
            <h4>工作区文件</h4>
            {workspace ? (
              <>
                <WorkspaceFileTree
                  key={`${projectId}:${workspace.path}`}
                  onFileSelect={setSelectedFile}
                  projectId={projectId}
                />
                <WorkspaceFilePreview
                  key={`preview-${projectId}:${workspace.path}`}
                  filePath={selectedFile}
                  projectId={projectId}
                />
              </>
            ) : (
              <p className="muted">绑定工作区后即可浏览文件。</p>
            )}
          </div>
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
