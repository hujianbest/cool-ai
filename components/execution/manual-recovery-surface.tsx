"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useModalSurface, useNarrowMode } from "@/components/mobile-dialog";
import {
  ApiDisplayError,
  apiErrorCopy,
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";
import type { ApiError } from "@/src/shared/contracts";
import {
  recoveryFilePageSchema,
  type ExecutionDto,
  type RecoveryFileDto,
  type RecoveryMergeFileStatus,
} from "@/src/shared/execution-contracts";

type Resolution = "recovered_old" | "recovered_new" | "abandon";

type RecoveryDetail = {
  recovery: {
    allowedResolutions: Resolution[];
    mismatchPathKey: string | null;
    mismatchPhase: string | null;
    observedManifestHash: string | null;
    oldManifestHash: string | null;
    postManifestHash: string | null;
    required: boolean;
  };
};

const resolutionCopy: Record<Resolution, {
  button: string;
  confirm: string;
  condition: string;
}> = {
  abandon: {
    button: "放弃且不改 canonical",
    confirm: "确认放弃恢复",
    condition: "不会恢复 canonical；仅有条件地清理平台 owned 对象，状态将不可逆地变为已停止。",
  },
  recovered_new: {
    button: "已确认完整新版本",
    confirm: "确认完整新版本",
    condition: "整个 manifest 必须精确等于完整新版，完成后任务将标记为已合入。",
  },
  recovered_old: {
    button: "已恢复为旧版本并重试",
    confirm: "确认已恢复旧版本",
    condition: "整个 manifest 必须精确等于旧版，完成后只能通过重试建立新 attempt。",
  },
};

function shortHash(value: string | null): string {
  return value ? value.slice(0, 12) : "无";
}

function recoveryFileStatusLabel(status: RecoveryMergeFileStatus): string {
  switch (status) {
    case "pending": return "待准备";
    case "temp_ready": return "临时文件已准备";
    case "applied": return "已记录应用";
    case "rolled_back": return "已记录回退";
    case "rolled_forward": return "已记录前滚";
    case "verified": return "已验证";
  }
}

async function responseJson<T>(response: Response, fallback: string): Promise<T> {
  const payload = (await response.json()) as T & Partial<ApiError>;
  if (!response.ok) throw new ApiDisplayError(apiErrorCopy(payload, fallback));
  return payload;
}

export function ManualRecoverySurface({
  execution,
  onResolved,
}: {
  execution: ExecutionDto;
  onResolved: (execution: ExecutionDto, uncleanedOwnedPaths: string[]) => void;
}) {
  const narrow = useNarrowMode();
  const [detail, setDetail] = useState<RecoveryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [files, setFiles] = useState<RecoveryFileDto[]>([]);
  const [filesCursor, setFilesCursor] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Resolution | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [uncleanedPaths, setUncleanedPaths] = useState<string[]>([]);
  const [uncleanedVisible, setUncleanedVisible] = useState(20);
  const rootRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRefs = useRef<Record<Resolution, HTMLButtonElement | null>>({
    abandon: null,
    recovered_new: null,
    recovered_old: null,
  });

  const closeConfirmation = useCallback(() => setConfirmation(null), []);
  const modalOptions = useMemo(() => ({
    active: !narrow && confirmation !== null,
    dialogRef,
    hideBackground: true,
    inertRootRefs: [rootRef],
    initialFocusRef: cancelRef,
    restoreFocusRef: {
      get current() {
        return confirmation ? triggerRefs.current[confirmation] : null;
      },
    },
    onClose: closeConfirmation,
  }), [closeConfirmation, confirmation, narrow]);
  useModalSurface(modalOptions);

  const loadDetail = useCallback(async () => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const response = await fetch(`/api/executions/${execution.id}`);
      setDetail(await responseJson<RecoveryDetail>(
        response,
        "无法加载人工恢复详情，请重试。",
      ));
    } catch (cause: unknown) {
      setDetailError(caughtApiErrorCopy(cause, "无法加载人工恢复详情，请重试。"));
    } finally {
      setDetailLoading(false);
    }
  }, [execution.id]);

  const loadFiles = useCallback(async (reset: boolean) => {
    setFilesLoading(true);
    setFilesError(null);
    try {
      const cursor = reset ? null : filesCursor;
      const response = await fetch(
        `/api/executions/${execution.id}/recovery/files?limit=20`
        + (cursor ? `&after=${encodeURIComponent(cursor)}` : ""),
      );
      const page = recoveryFilePageSchema.parse(
        await responseJson<unknown>(
          response,
          "无法加载差异路径，请重试。",
        ),
      );
      setFiles((current) => reset ? page.items : [...current, ...page.items]);
      setFilesCursor(page.nextCursor);
    } catch (cause: unknown) {
      setFilesError(caughtApiErrorCopy(cause, "无法加载差异路径，请重试。"));
    } finally {
      setFilesLoading(false);
    }
  }, [execution.id, filesCursor]);

  useEffect(() => {
    void loadDetail();
    void loadFiles(true);
    // The execution id is the resource identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [execution.id]);

  async function resolve(action: Resolution) {
    const observedManifestHash = detail?.recovery.observedManifestHash;
    if (!observedManifestHash) return;
    setSubmitting(true);
    setSubmitError(null);
    setSuccess(null);
    try {
      const response = await fetch(
        `/api/executions/${execution.id}/recovery/resolve`,
        {
          body: JSON.stringify({
            action,
            expectedVersion: execution.version,
            observedManifestHash,
            operationId: globalThis.crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const payload = (await response.json()) as {
        error?: { code?: string };
        execution?: ExecutionDto;
        recovery?: { observedManifestHash?: string };
        uncleanedOwnedPaths?: string[];
      } & Partial<ApiError>;
      if (!response.ok) {
        if (
          payload.error?.code === "RECOVERY_MANIFEST_MISMATCH"
          && payload.recovery?.observedManifestHash
        ) {
          setDetail((current) => current ? {
            ...current,
            recovery: {
              ...current.recovery,
              observedManifestHash: payload.recovery!.observedManifestHash!,
            },
          } : current);
          setConfirmation(null);
          setSubmitError("整个 manifest 已变化；已刷新 observed manifest，请重新核对并确认。");
          void loadFiles(true);
          return;
        }
        throw new ApiDisplayError(apiErrorCopy(payload, "无法完成人工恢复，请重试。"));
      }
      if (!payload.execution) throw new ApiDisplayError("人工恢复响应无效，请刷新后重试。");
      setConfirmation(null);
      setUncleanedPaths(payload.uncleanedOwnedPaths ?? []);
      setSuccess("人工恢复已完成。");
      queueMicrotask(() => {
        onResolved(payload.execution!, payload.uncleanedOwnedPaths ?? []);
        globalThis.setTimeout(() => {
          if (action === "recovered_old") {
            document.querySelector<HTMLButtonElement>(
              `[data-execution-retry="${execution.id}"]`,
            )?.focus();
          } else {
            document.getElementById(`execution-${execution.id}-title`)?.focus();
          }
        }, 0);
      });
    } catch (cause: unknown) {
      setSubmitError(caughtApiErrorCopy(cause, "无法完成人工恢复，请重试。"));
    } finally {
      setSubmitting(false);
    }
  }

  const recovery = detail?.recovery;
  return (
    <section
      aria-label={recovery ? "需要人工恢复" : "正在加载人工恢复"}
      className="execution-recovery stack"
      ref={rootRef}
      role="region"
    >
      <h4>需要人工恢复</h4>
      <p className="warning-text">
        检测到平台外写入；平台已停止自动改写，当前 workspace 可能既非完整旧版也非完整新版。
      </p>
      {detailLoading ? <p aria-busy="true">正在加载人工恢复详情…</p> : null}
      {detailError ? (
        <div>
          <p className="error-text" role="alert">{detailError}</p>
          <button onClick={() => void loadDetail()} type="button">重试加载人工恢复详情</button>
        </div>
      ) : null}
      {recovery ? (
        <>
          <dl className="execution-review-facts">
            <div><dt>不匹配阶段</dt><dd>{recovery.mismatchPhase ?? "未知"}</dd></div>
            <div>
              <dt>不匹配范围</dt>
              <dd>{recovery.mismatchPathKey ?? "整体不匹配"}</dd>
            </div>
            <div><dt>旧版 manifest</dt><dd><code>{shortHash(recovery.oldManifestHash)}</code></dd></div>
            <div><dt>新版 manifest</dt><dd><code>{shortHash(recovery.postManifestHash)}</code></dd></div>
            <div><dt>Observed manifest</dt><dd><code>{shortHash(recovery.observedManifestHash)}</code></dd></div>
          </dl>
          <h5>差异路径</h5>
          {filesLoading && files.length === 0 ? <p aria-busy="true">正在加载差异路径…</p> : null}
          {files.length === 0 && !filesLoading && !filesError ? <p>没有差异路径。</p> : null}
          <ol className="execution-review-list">
            {files.map((file) => (
              <li className="execution-review-item" key={file.pathKey}>
                <strong>{file.path}{file.isMismatch ? "（不匹配）" : ""}</strong>
                <p>
                  {recoveryFileStatusLabel(file.status)}
                  {" · old "}{shortHash(file.oldHash)}{" · post "}{shortHash(file.postHash)}
                </p>
              </li>
            ))}
          </ol>
          {filesError ? <p className="error-text" role="alert">{filesError}</p> : null}
          {filesCursor ? (
            <button disabled={filesLoading} onClick={() => void loadFiles(false)} type="button">
              加载更多差异路径
            </button>
          ) : null}
          {submitError ? <p className="error-text" role="alert">{submitError}</p> : null}
          {success ? <p aria-live="polite">{success}</p> : null}
          <div className="execution-review-actions">
            {recovery.allowedResolutions.map((action) => (
              <button
                disabled={submitting || filesError !== null || !recovery.observedManifestHash}
                key={action}
                onClick={() => setConfirmation(action)}
                ref={(element) => { triggerRefs.current[action] = element; }}
                type="button"
              >
                {resolutionCopy[action].button}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {uncleanedPaths.length > 0 ? (
        <section aria-label="未清理的平台 owned 路径" className="stack">
          <h5>未清理的平台 owned 路径</h5>
          <ol>{uncleanedPaths.slice(0, uncleanedVisible).map((path) => <li key={path}>{path}</li>)}</ol>
          {uncleanedVisible < uncleanedPaths.length ? (
            <button onClick={() => setUncleanedVisible((count) => count + 20)} type="button">
              加载更多未清理路径
            </button>
          ) : null}
        </section>
      ) : null}
      {narrow && confirmation && recovery ? (
        <section
          aria-labelledby={`recovery-confirm-title-${execution.id}`}
          className="execution-recovery-confirm stack"
        >
          <h5 id={`recovery-confirm-title-${execution.id}`}>确认人工恢复</h5>
          <p>{resolutionCopy[confirmation].condition}</p>
          <p>平台将比对整个 manifest，而不是单个文件。</p>
          <p>expected version {execution.version}</p>
          <p>observed manifest {shortHash(recovery.observedManifestHash)}</p>
          <div className="execution-review-actions">
            <button onClick={closeConfirmation} ref={cancelRef} type="button">取消</button>
            <button disabled={submitting} onClick={() => void resolve(confirmation)} type="button">
              {resolutionCopy[confirmation].confirm}
            </button>
          </div>
        </section>
      ) : null}
      {!narrow && confirmation && recovery && typeof document !== "undefined"
        ? createPortal(
            <div
              aria-describedby={`recovery-confirm-description-${execution.id}`}
              aria-labelledby={`recovery-confirm-title-${execution.id}`}
              aria-modal="true"
              className="modal-surface execution-recovery-confirm stack"
              ref={dialogRef}
              role="dialog"
            >
              <h3 id={`recovery-confirm-title-${execution.id}`}>确认人工恢复</h3>
              <p id={`recovery-confirm-description-${execution.id}`}>
                {resolutionCopy[confirmation].condition}
              </p>
              <p>平台将比对整个 manifest，而不是单个文件。</p>
              <p>expected version {execution.version}</p>
              <p>observed manifest {shortHash(recovery.observedManifestHash)}</p>
              <div className="execution-review-actions">
                <button onClick={closeConfirmation} ref={cancelRef} type="button">取消</button>
                <button disabled={submitting} onClick={() => void resolve(confirmation)} type="button">
                  {resolutionCopy[confirmation].confirm}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
