"use client";

import { useMemo, useState } from "react";

import { ActionDialog } from "@/components/ui/action-dialog";
import {
  previewRecoveryAction,
  recoveryActionsFor,
  RECOVERY_CONFIRM_EXECUTE,
} from "@/src/modules/safe-execution/public/recovery-catalog";
import type { ExecutionDto } from "@/src/shared/execution-contracts";

const STATUS_COPY: Record<ExecutionDto["status"], string> = {
  queued: "排队中",
  running: "运行中",
  waiting_approval: "等待审批",
  paused: "已暂停",
  staged: "变更待审阅",
  stale: "上下文已过期",
  conflicted: "存在冲突",
  failed: "执行失败",
  stopped: "已停止",
  merged: "已合入",
};

export function RecoveryOperationsSurface({
  execution,
  onExecuted,
}: {
  execution: ExecutionDto;
  onExecuted: (next: ExecutionDto) => void;
}) {
  const actions = useMemo(
    () => recoveryActionsFor(execution.status, execution.reasonCode),
    [execution.reasonCode, execution.status],
  );
  const [open, setOpen] = useState(false);
  const [actionId, setActionId] = useState(actions[0]?.id ?? "");
  const [previewedId, setPreviewedId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selected = actions.find((action) => action.id === actionId) ?? actions[0];

  if (actions.length === 0 || selected === undefined) return null;

  const preview = previewedId === selected.id
    ? previewRecoveryAction(selected.id)
    : null;

  function closeDialog(): void {
    if (pending) return;
    setOpen(false);
    setPreviewedId(null);
    setPreviewError(null);
    setExecuteError(null);
  }

  function showPreview(): void {
    try {
      previewRecoveryAction(selected.id);
      setPreviewedId(selected.id);
      setPreviewError(null);
    } catch {
      setPreviewedId(null);
      setPreviewError("未知救援动作已被拒绝。");
    }
  }

  async function execute(): Promise<void> {
    if (previewedId !== selected.id || pending) return;
    setPending(true);
    setExecuteError(null);
    try {
      const response = await fetch(
        `/api/executions/${execution.id}/recovery-actions/${selected.id}/execute`,
        {
          body: JSON.stringify({
            confirmation: RECOVERY_CONFIRM_EXECUTE,
            expectedVersion: execution.version,
            operationId: globalThis.crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const payload = (await response.json()) as {
        error?: { message?: string };
        toStatus?: ExecutionDto["status"];
        version?: number;
      };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? "无法执行救援。");
      }
      onExecuted({
        ...execution,
        reasonCode: payload.toStatus === "queued" ? null : execution.reasonCode,
        status: payload.toStatus ?? execution.status,
        version: payload.version ?? execution.version + 1,
      });
      setOpen(false);
      setPreviewedId(null);
    } catch (cause: unknown) {
      setExecuteError(cause instanceof Error ? cause.message : "无法执行救援。");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        className="button-secondary"
        onClick={() => {
          setActionId(actions[0]?.id ?? "");
          setOpen(true);
        }}
        style={{ minHeight: "var(--control-min)" }}
        type="button"
      >
        救援
      </button>
      <ActionDialog
        className="recovery-operations-dialog"
        closeLabel="关闭"
        onClose={closeDialog}
        open={open}
        title={`救援 · 任务「${execution.workItem.title}」`}
        titleId={`recovery-operations-${execution.id}`}
      >
        <div className="stack recovery-operations">
          <p>
            故障 {execution.reasonCode} · 状态 {STATUS_COPY[execution.status]}
          </p>
          <label className="stack">
            可选动作
            <select
              onChange={(event) => {
                setActionId(event.target.value);
                setPreviewedId(null);
                setPreviewError(null);
                setExecuteError(null);
              }}
              value={selected.id}
            >
              {actions.map((action) => (
                <option key={action.id} value={action.id}>{action.title}</option>
              ))}
            </select>
          </label>
          {preview ? (
            <p>
              影响：不改工作区文件；{preview.changes.join("；")}
              {selected.approvalRequired ? "；需要现有 Approval。" : "。"}
            </p>
          ) : (
            <p>先预览结构化影响，再执行救援。没有自由命令输入。</p>
          )}
          {previewError ? <p className="error-text" role="alert">{previewError}</p> : null}
          {executeError ? <p className="error-text" role="alert">{executeError}</p> : null}
          <div className="form-row">
            <button
              className="button-secondary"
              onClick={showPreview}
              style={{ minHeight: "var(--control-min)" }}
              type="button"
            >
              预览
            </button>
            <button
              className="button-primary"
              disabled={previewedId !== selected.id || pending}
              onClick={() => void execute()}
              style={{ minHeight: "var(--control-min)" }}
              type="button"
            >
              执行救援
            </button>
            <button
              className="button-secondary"
              disabled
              style={{ minHeight: "var(--control-min)" }}
              title="此动作不可撤销"
              type="button"
            >
              撤销
            </button>
          </div>
        </div>
      </ActionDialog>
    </>
  );
}
