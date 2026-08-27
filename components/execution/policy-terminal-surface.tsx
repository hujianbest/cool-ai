"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useModalSurface, useNarrowMode } from "@/components/mobile-dialog";

type PolicyCommand = {
  args: string[];
  entryId: string;
  executable: string;
  network: "loopback_only" | null;
  openPath: string | null;
  port: number | null;
  purpose: "preview" | "validation";
  required: boolean;
  timeoutSeconds: number;
  workdir: string;
};

type ProcessStatus =
  | "completed"
  | "failed"
  | "interrupted"
  | "ready"
  | "running"
  | "starting"
  | "stopped"
  | "stopping"
  | "termination_unconfirmed"
  | "timed_out";

type ProcessDto = {
  id: string;
  previewUrl: string | null;
  reasonCode?: string | null;
  status: ProcessStatus;
  version: number;
};

type Catalog = {
  commands: PolicyCommand[];
  currentProcess: ProcessDto | null;
  executionVersion: number;
  policyRevisionId: string;
};

type OutputChunk = { cursor: number; text: string };

const activeStatuses: ProcessStatus[] = ["starting", "running", "ready", "stopping"];

const statusCopy: Record<ProcessStatus, string> = {
  completed: "运行完成",
  failed: "运行失败",
  interrupted: "进程已中断",
  ready: "本地预览就绪",
  running: "运行中",
  starting: "正在启动",
  stopped: "已停止",
  stopping: "正在停止",
  termination_unconfirmed: "无法确认已停止",
  timed_out: "运行超时",
};

function operationId(): string {
  return globalThis.crypto.randomUUID();
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function PolicyTerminalSurface({
  executionId,
  executionRunnable,
  executionVersion,
  taskTitle,
}: {
  executionId: string;
  executionRunnable: boolean;
  executionVersion: number;
  taskTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState("");
  const [process, setProcess] = useState<ProcessDto | null>(null);
  const [stdout, setStdout] = useState<OutputChunk[]>([]);
  const [stderr, setStderr] = useState<OutputChunk[]>([]);
  const stdoutCursorRef = useRef(0);
  const stderrCursorRef = useRef(0);
  const [pending, setPending] = useState<"catalog" | "run" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oneShotOpen, setOneShotOpen] = useState(false);
  const [oneShotExecutable, setOneShotExecutable] = useState("");
  const [oneShotArgs, setOneShotArgs] = useState("");
  const [oneShotWorkdir, setOneShotWorkdir] = useState(".");
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const narrow = useNarrowMode();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useModalSurface(useMemo(() => ({
    active: narrow && open,
    dialogRef,
    hideBackground: true,
    inertRootRefs: [rootRef],
    initialFocusRef: closeRef,
    onClose: close,
    restoreFocusRef: triggerRef,
  }), [close, narrow, open]));

  const selected = catalog?.commands.find(({ entryId }) => entryId === selectedEntryId)
    ?? catalog?.commands[0]
    ?? null;

  const refreshProcess = useCallback(async (processId: string) => {
    const [detailResponse, outputResponse] = await Promise.all([
      fetch(`/api/executions/${executionId}/policy-processes/${processId}`),
      fetch(
        `/api/executions/${executionId}/policy-processes/${processId}/output`
        + `?stdoutCursor=${stdoutCursorRef.current}&stderrCursor=${stderrCursorRef.current}`,
      ),
    ]);
    if (!detailResponse.ok || !outputResponse.ok) throw new Error("POLICY_PROCESS_READ_FAILED");
    const detail = await json<ProcessDto>(detailResponse);
    const output = await json<{
      stderr: { chunks: OutputChunk[]; nextCursor: number };
      stdout: { chunks: OutputChunk[]; nextCursor: number };
    }>(outputResponse);
    setProcess(detail);
    if (output.stdout.chunks.length > 0) {
      setStdout((current) => [...current, ...output.stdout.chunks]);
    }
    if (output.stderr.chunks.length > 0) {
      setStderr((current) => [...current, ...output.stderr.chunks]);
    }
    stdoutCursorRef.current = output.stdout.nextCursor;
    stderrCursorRef.current = output.stderr.nextCursor;
  }, [executionId]);

  const loadCatalog = useCallback(async () => {
    setPending("catalog");
    setError(null);
    try {
      const response = await fetch(`/api/executions/${executionId}/policy-commands`);
      if (!response.ok) throw new Error("POLICY_CATALOG_FAILED");
      const next = await json<Catalog>(response);
      setCatalog(next);
      setSelectedEntryId((current) =>
        next.commands.some(({ entryId }) => entryId === current)
          ? current
          : next.commands[0]?.entryId ?? "");
      setOneShotExecutable((current) =>
        next.commands.some(({ executable }) => executable === current)
          ? current
          : next.commands[0]?.executable ?? "");
      setProcess(next.currentProcess);
      if (next.currentProcess) await refreshProcess(next.currentProcess.id);
    } catch {
      setError("无法载入策略命令，请重试。");
    } finally {
      setPending(null);
    }
  }, [executionId, refreshProcess]);

  useEffect(() => {
    if (open) void loadCatalog();
  }, [loadCatalog, open]);

  useEffect(() => {
    if (!open || !process || !activeStatuses.includes(process.status)) return;
    const handle = window.setInterval(() => {
      void refreshProcess(process.id).catch(() => setError("无法刷新进程状态，请重试。"));
    }, 1_000);
    return () => window.clearInterval(handle);
  }, [open, process, refreshProcess]);

  const run = async () => {
    if (!selected || pending) return;
    setPending("run");
    setError(null);
    setStdout([]);
    setStderr([]);
    stdoutCursorRef.current = 0;
    stderrCursorRef.current = 0;
    try {
      const response = await fetch(`/api/executions/${executionId}/policy-processes`, {
        body: JSON.stringify({
          entryId: selected.entryId,
          expectedExecutionVersion: catalog?.executionVersion ?? executionVersion,
          operationId: operationId(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("POLICY_PROCESS_START_FAILED");
      const next = await json<ProcessDto>(response);
      setProcess(next);
      await refreshProcess(next.id);
    } catch {
      setError("无法运行策略命令，请检查执行状态后重试。");
    } finally {
      setPending(null);
    }
  };

  const stop = async () => {
    if (!process || pending) return;
    setPending("stop");
    setError(null);
    try {
      const response = await fetch(
        `/api/executions/${executionId}/policy-processes/${process.id}/stop`,
        {
          body: JSON.stringify({ expectedVersion: process.version }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      if (!response.ok) throw new Error("POLICY_PROCESS_STOP_FAILED");
      setProcess(await json<ProcessDto>(response));
    } catch {
      setError("无法停止进程，请重试。");
    } finally {
      setPending(null);
    }
  };

  const requestOneShot = async () => {
    if (!oneShotExecutable || pending) return;
    setPending("run");
    setError(null);
    try {
      const response = await fetch(`/api/executions/${executionId}/policy-processes`, {
        body: JSON.stringify({
          command: {
            args: oneShotArgs.split(/\r?\n/u).filter((argument) => argument.length > 0),
            executable: oneShotExecutable,
            workdir: oneShotWorkdir,
          },
          expectedExecutionVersion: catalog?.executionVersion ?? executionVersion,
          operationId: operationId(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = await json<{
        approvalId: string | null;
        decision: "denied" | "one_shot" | "standing_exact";
        reasonCode: string | null;
      }>(response);
      if (!response.ok) throw new Error("POLICY_PROCESS_REQUEST_FAILED");
      if (result.decision === "denied") {
        setError(`单次命令被拒绝：${result.reasonCode ?? "POLICY_COMMAND_DENIED"}`);
        return;
      }
      setApprovalId(result.approvalId);
    } catch {
      setError("无法申请单次命令。");
    } finally {
      setPending(null);
    }
  };

  const continueApproved = async () => {
    if (!approvalId || pending) return;
    setPending("run");
    setError(null);
    try {
      const catalogResponse = await fetch(`/api/executions/${executionId}/policy-commands`);
      if (!catalogResponse.ok) throw new Error("APPROVAL_STATE_UNAVAILABLE");
      const latest = await json<Catalog>(catalogResponse);
      const response = await fetch(`/api/executions/${executionId}/policy-processes`, {
        body: JSON.stringify({
          approvalId,
          expectedExecutionVersion: latest.executionVersion,
          operationId: operationId(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("APPROVAL_NOT_READY");
      const next = await json<ProcessDto>(response);
      setCatalog(latest);
      setProcess(next);
      setApprovalId(null);
      await refreshProcess(next.id);
    } catch {
      setError("审批尚未通过或已失效，请在审批中心处理后重试。");
    } finally {
      setPending(null);
    }
  };

  const content = open ? (
    <div
      aria-busy={pending === "catalog"}
      aria-label={`终端与预览 · ${taskTitle}`}
      className={`policy-terminal-surface stack${narrow ? " modal-surface" : ""}`}
      ref={narrow ? dialogRef : undefined}
      role={narrow ? "dialog" : "region"}
      aria-modal={narrow ? true : undefined}
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">策略内进程</p>
          <h4>终端与预览 · {taskTitle}</h4>
        </div>
        <button ref={closeRef} onClick={close} type="button">关闭</button>
      </div>
      {pending === "catalog" && !catalog ? <p role="status">正在载入策略命令…</p> : null}
      {error ? (
        <div className="stack">
          <p className="error-text" role="alert">{error}</p>
          <button onClick={() => void loadCatalog()} type="button">重试载入</button>
        </div>
      ) : null}
      {catalog && catalog.commands.length === 0 ? (
        <p>当前任务没有可运行的策略命令。</p>
      ) : null}
      {catalog && selected ? (
        <>
          <label>
            策略命令
            <select
              onChange={(event) => setSelectedEntryId(event.target.value)}
              value={selected.entryId}
            >
              {catalog.commands.map((command) => (
                <option key={command.entryId} value={command.entryId}>
                  {command.executable} {command.args.join(" ")}
                </option>
              ))}
            </select>
          </label>
          <dl className="policy-terminal-summary">
            <div><dt>命令</dt><dd>{selected.executable} {selected.args.join(" ")}</dd></div>
            <div><dt>工作目录</dt><dd>{selected.workdir}</dd></div>
            <div><dt>授权</dt><dd>冻结政策 {catalog.policyRevisionId}</dd></div>
            <div>
              <dt>边界</dt>
              <dd>
                {selected.network === "loopback_only" ? "仅本机" : "无网络"}
                {selected.port ? ` · 端口 ${selected.port}` : ""}
                {` · 超时 ${Math.ceil(selected.timeoutSeconds / 60)} 分钟`}
              </dd>
            </div>
          </dl>
          <button
            disabled={
              !executionRunnable
              || pending !== null
              || Boolean(process && activeStatuses.includes(process.status))
            }
            onClick={() => void run()}
            type="button"
          >
            {pending === "run" ? "正在启动…" : "运行策略命令"}
          </button>
          {!executionRunnable ? (
            <p className="helper-text">当前 Execution 不在可运行状态。</p>
          ) : null}
          <div className="policy-terminal-one-shot stack">
            <button
              aria-expanded={oneShotOpen}
              onClick={() => setOneShotOpen((current) => !current)}
              type="button"
            >
              申请单次命令
            </button>
            {oneShotOpen ? (
              <div className="stack">
                <label>
                  已验证程序
                  <select
                    onChange={(event) => setOneShotExecutable(event.target.value)}
                    value={oneShotExecutable}
                  >
                    {[...new Set(catalog.commands.map(({ executable }) => executable))]
                      .map((executable) => (
                        <option key={executable} value={executable}>{executable}</option>
                      ))}
                  </select>
                </label>
                <label>
                  参数（每行一个，不经过 shell）
                  <textarea
                    onChange={(event) => setOneShotArgs(event.target.value)}
                    value={oneShotArgs}
                  />
                </label>
                <label>
                  相对工作目录
                  <input
                    onChange={(event) => setOneShotWorkdir(event.target.value)}
                    placeholder="例如：."
                    value={oneShotWorkdir}
                  />
                </label>
                <button
                  disabled={
                    !executionRunnable
                    || !oneShotExecutable
                    || pending !== null
                    || Boolean(approvalId)
                  }
                  onClick={() => void requestOneShot()}
                  type="button"
                >
                  提交审批
                </button>
                {approvalId ? (
                  <div className="stack" role="status">
                    <p>单次命令已送审批中心；批准后可从这里继续。</p>
                    <button onClick={() => void continueApproved()} type="button">
                      审批后继续
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      <section aria-label="只读进程输出" className="policy-terminal-output" tabIndex={0}>
        <div className="panel-heading">
          <h5>输出（只读）</h5>
          <span aria-live="polite" role="status">
            {process ? statusCopy[process.status] : "尚未运行"}
          </span>
        </div>
        <div role="log" aria-live="off">
          {stdout.map((chunk) => (
            <p data-stream="stdout" key={`stdout-${chunk.cursor}`}>
              {`stdout · ${chunk.text}`}
            </p>
          ))}
          {stderr.map((chunk) => (
            <p data-stream="stderr" key={`stderr-${chunk.cursor}`}>
              {`stderr · ${chunk.text}`}
            </p>
          ))}
          {stdout.length === 0 && stderr.length === 0 ? <p>暂无输出。</p> : null}
        </div>
      </section>
      <div className="execution-card-controls policy-terminal-actions">
        <button
          disabled={!process || !activeStatuses.includes(process.status) || pending !== null}
          onClick={() => void stop()}
          type="button"
        >
          {pending === "stop" ? "正在停止…" : "停止进程"}
        </button>
        <button
          disabled={!process?.previewUrl || process.status !== "ready"}
          onClick={() => {
            if (process?.previewUrl) {
              window.open(process.previewUrl, "_blank", "noopener,noreferrer");
            }
          }}
          type="button"
        >
          打开本地预览
        </button>
      </div>
      <p className="helper-text">
        运行的是 Owner 配置的可信本机程序；命令成功不等于任务完成或复核通过。
      </p>
    </div>
  ) : null;

  return (
    <div className="policy-terminal" ref={rootRef}>
      <button
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >
        终端与预览
      </button>
      {narrow && content && typeof document !== "undefined"
        ? createPortal(content, document.body)
        : content}
    </div>
  );
}
