"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

import { ExecutionReview } from "@/components/execution/execution-review";
import { ManualRecoverySurface } from "@/components/execution/manual-recovery-surface";
import { useModalSurface, useNarrowMode } from "@/components/mobile-dialog";
import { ReviewProductSurface } from "@/components/review/review-product-surface";
import { ValidationPolicyPanel } from "@/components/execution/validation-policy-panel";
import {
  ApiDisplayError,
  apiErrorCopy,
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";
import type { ApiError } from "@/src/shared/contracts";
import type {
  ExecutionDto,
  ExecutionListResponse,
} from "@/src/shared/execution-contracts";
import {
  advanceExecutionResponseSchema,
  executionControlResponseSchema,
  executionDtoSchema,
  mergeExecutionResponseSchema,
} from "@/src/shared/execution-contracts";
import type { MissionState, WorkItem } from "@/src/shared/project-context-contracts";

const statusCopy: Record<ExecutionDto["status"], string> = {
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

const actionCopy: Record<
  Exclude<ExecutionDto["currentAction"]["kind"], null>,
  string
> = {
  sandbox_build: "正在准备隔离区",
  model: "正在调用模型",
  file_list: "正在列举文件",
  file_read: "正在读取文件",
  file_write: "正在写入文件",
  command: "正在运行命令",
  stage_compute: "正在生成变更预览",
  merge_apply: "正在合入变更",
  merge_recover: "正在恢复合入",
  manual_resolution: "正在核对人工恢复",
};

type StartRow = {
  operationId: string;
  state: "pending" | "success" | "error";
  taskId: string;
  title: string;
  message: string | null;
};

type ControlAction = "pause" | "continue" | "retry" | "stop";

type CardAsyncState = {
  advanceError?: string;
  controlError?: string;
  controlPending?: boolean;
  refreshError?: string;
  refreshPending?: boolean;
};

const controlCopy: Record<ControlAction, string> = {
  pause: "暂停",
  continue: "继续",
  retry: "重试",
  stop: "停止",
};

function availableControls(execution: ExecutionDto): ControlAction[] {
  if (execution.manualRecoveryRequired) return [];
  if (execution.status === "running" || execution.status === "queued") {
    return ["pause", "stop"];
  }
  if (execution.status === "waiting_approval" || execution.status === "staged") {
    return ["stop"];
  }
  if (execution.status === "paused") return ["continue", "stop"];
  if (
    execution.status === "stale"
    || execution.status === "conflicted"
    || execution.status === "failed"
  ) {
    return ["retry", "stop"];
  }
  return [];
}

function canAutoAdvance(execution: ExecutionDto): boolean {
  if (execution.manualRecoveryRequired || execution.currentAction.kind !== null) {
    return false;
  }
  if (execution.status === "running") return true;
  return execution.status === "queued"
    && execution.reasonCode !== "SANDBOX_RESUME_REQUIRED";
}

function ExecutionProgress({
  label,
  max,
  value,
}: {
  label: string;
  max: number;
  value: number;
}) {
  return (
    <div className="execution-progress">
      <span>{label} {value}/{max}</span>
      <progress
        aria-label={`${label}进度`}
        aria-valuemax={Math.max(max, 1)}
        aria-valuemin={0}
        aria-valuenow={Math.min(value, Math.max(max, 1))}
        max={Math.max(max, 1)}
        value={Math.min(value, Math.max(max, 1))}
      />
    </div>
  );
}

function ExecutionCard({
  asyncState,
  execution,
  headingRef,
  missionId,
  onAdvanceRetry,
  onControl,
  onExecutionChanged,
  onMerge,
  onRefresh,
}: {
  asyncState: CardAsyncState;
  execution: ExecutionDto;
  headingRef?: Ref<HTMLHeadingElement>;
  missionId: string | null;
  onAdvanceRetry: () => void;
  onControl: (action: ControlAction) => void;
  onExecutionChanged: (execution: ExecutionDto) => void;
  onMerge: (stagedHash: string) => void;
  onRefresh: () => void;
}) {
  const controls = availableControls(execution);
  const [recoveryOutcome, setRecoveryOutcome] = useState<{
    paths: string[];
    visible: number;
  } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  return (
    <section
      aria-labelledby={`execution-${execution.id}-title`}
      className="run-detail execution-card"
      data-accent={execution.agent.accentToken}
      role="region"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{execution.agent.avatarText}</p>
          <p>{execution.agent.name}</p>
          <h3
            id={`execution-${execution.id}-title`}
            ref={headingRef}
            tabIndex={-1}
          >
            {execution.workItem.title}
          </h3>
        </div>
        <span className={`status-label status-${execution.status}`}>
          {statusCopy[execution.status]}
        </span>
      </div>
      <p role="status">
        {execution.currentAction.kind
          ? actionCopy[execution.currentAction.kind]
          : "当前没有进行中的动作"}
      </p>
      {execution.reasonCode ? (
        <p className="error-text">阻断原因：{execution.reasonCode}</p>
      ) : null}
      {execution.manualRecoveryRequired ? (
        <ManualRecoverySurface
          execution={execution}
          onResolved={(next, paths) => {
            setRecoveryOutcome({ paths, visible: 20 });
            onExecutionChanged(next);
          }}
        />
      ) : null}
      {!execution.manualRecoveryRequired && recoveryOutcome ? (
        <section aria-label="人工恢复结果" className="stack">
          <p aria-live="polite">
            人工恢复已完成，执行状态：{statusCopy[execution.status]}。
          </p>
          {recoveryOutcome.paths.length > 0 ? (
            <>
              <h4>未清理的平台 owned 路径</h4>
              <ol className="execution-review-list">
                {recoveryOutcome.paths
                  .slice(0, recoveryOutcome.visible)
                  .map((path) => <li key={path}>{path}</li>)}
              </ol>
              {recoveryOutcome.visible < recoveryOutcome.paths.length ? (
                <button
                  onClick={() => setRecoveryOutcome((current) => current ? {
                    ...current,
                    visible: current.visible + 20,
                  } : current)}
                  type="button"
                >
                  加载更多未清理路径
                </button>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
      <div className="execution-progress-list">
        <ExecutionProgress
          label="业务回合"
          max={execution.limits.businessRounds}
          value={execution.businessRounds}
        />
        <ExecutionProgress
          label="工具调用"
          max={execution.limits.toolCalls}
          value={execution.toolCalls}
        />
        <ExecutionProgress
          label="Token "
          max={execution.usage.maxTokens}
          value={execution.usage.totalTokens}
        />
      </div>
      {!execution.manualRecoveryRequired ? (
        <ExecutionReview
          execution={execution}
          onExecutionChanged={onExecutionChanged}
          onMerge={onMerge}
        />
      ) : null}
      {!execution.manualRecoveryRequired
      && execution.status === "merged"
      && missionId ? (
        <div className="stack">
          <button
            aria-expanded={reviewOpen}
            aria-controls={`execution-${execution.id}-review-product`}
            onClick={() => setReviewOpen((open) => !open)}
            type="button"
          >
            {reviewOpen ? "关闭复核闭环" : "打开复核闭环"}
          </button>
          {reviewOpen ? (
            <div id={`execution-${execution.id}-review-product`}>
              <ReviewProductSurface
                missionId={missionId}
                projectId={execution.projectId}
                workItemId={execution.workItem.id}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {!execution.manualRecoveryRequired && asyncState.advanceError ? (
        <div className="stack">
          <p className="error-text" role="alert">{asyncState.advanceError}</p>
          <button
            onClick={onAdvanceRetry}
            style={{ minHeight: "var(--control-min)" }}
            type="button"
          >
            重试推进 {execution.workItem.title}
          </button>
        </div>
      ) : null}
      {asyncState.controlError ? (
        <p className="error-text" role="alert">{asyncState.controlError}</p>
      ) : null}
      {asyncState.refreshError ? (
        <p className="error-text" role="alert">{asyncState.refreshError}</p>
      ) : null}
      <div className="execution-card-controls">
        {controls.map((action) => (
          <button
            disabled={asyncState.controlPending}
            data-execution-retry={action === "retry" ? execution.id : undefined}
            key={action}
            onClick={() => onControl(action)}
            style={{ minHeight: "var(--control-min)" }}
            type="button"
          >
            {controlCopy[action]} {execution.workItem.title}
          </button>
        ))}
        <button
          disabled={asyncState.refreshPending}
          onClick={onRefresh}
          style={{ minHeight: "var(--control-min)" }}
          type="button"
        >
          刷新 {execution.workItem.title}
        </button>
      </div>
    </section>
  );
}

function newOperationId(): string {
  return globalThis.crypto.randomUUID();
}

export function ExecutionPanel({
  embedded = false,
  projectId,
}: {
  embedded?: boolean;
  projectId: string;
}) {
  const [executions, setExecutions] = useState<ExecutionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [sourceRunId, setSourceRunId] = useState<string | null>(null);
  const [pickerLoading, setPickerLoading] = useState(true);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [startRows, setStartRows] = useState<StartRow[]>([]);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [cardStates, setCardStates] = useState<Record<string, CardAsyncState>>({});
  const [mobileExecutionId, setMobileExecutionId] = useState<string | null>(null);
  const narrow = useNarrowMode();
  const panelRef = useRef<HTMLElement>(null);
  const mobileSwitcherRef = useRef<HTMLUListElement>(null);
  const mobileDialogRef = useRef<HTMLDivElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const mobileTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const firstHeadingRef = useRef<HTMLHeadingElement>(null);
  const mountedRef = useRef(true);
  const advanceInFlightRef = useRef(new Set<string>());
  const advanceOperationRef = useRef(new Map<string, string>());
  const advanceAbortRef = useRef(new Map<string, AbortController>());
  const mergeInFlightRef = useRef(new Set<string>());
  const mergeOperationRef = useRef(new Map<string, string>());

  const closeMobileExecution = useCallback(() => setMobileExecutionId(null), []);
  const mobileModalOptions = useMemo(() => ({
    active: narrow && mobileExecutionId !== null,
    dialogRef: mobileDialogRef,
    hideBackground: true,
    inertRootRefs: [panelRef, mobileSwitcherRef],
    initialFocusRef: mobileCloseRef,
    restoreFocusRef: {
      get current() {
        return mobileExecutionId
          ? mobileTriggerRefs.current.get(mobileExecutionId) ?? null
          : null;
      },
    },
    onClose: closeMobileExecution,
  }), [closeMobileExecution, mobileExecutionId, narrow]);
  useModalSurface(mobileModalOptions);

  const updateExecution = useCallback((next: ExecutionDto) => {
    setExecutions((current) => current.map((item) => (
      item.id === next.id ? next : item
    )));
  }, []);

  const advanceExecution = useCallback(async (
    execution: ExecutionDto,
    retryOperationId?: string,
  ) => {
    if (advanceInFlightRef.current.has(execution.id)) return;
    const operationId = retryOperationId
      ?? advanceOperationRef.current.get(execution.id)
      ?? newOperationId();
    advanceOperationRef.current.set(execution.id, operationId);
    advanceInFlightRef.current.add(execution.id);
    const controller = new AbortController();
    advanceAbortRef.current.set(execution.id, controller);
    setCardStates((current) => ({
      ...current,
      [execution.id]: { ...current[execution.id], advanceError: undefined },
    }));
    try {
      const response = await fetch(`/api/executions/${execution.id}/advance`, {
        body: JSON.stringify({
          expectedVersion: execution.version,
          operationId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        throw new ApiDisplayError(
          apiErrorCopy(payload as Partial<ApiError>, "无法推进此执行，请重试。"),
        );
      }
      const parsed = advanceExecutionResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ApiDisplayError("执行响应无效，请刷新后重试。");
      }
      advanceOperationRef.current.delete(execution.id);
      if (mountedRef.current) updateExecution(parsed.data.execution);
    } catch (cause: unknown) {
      if (!controller.signal.aborted && mountedRef.current) {
        setCardStates((current) => ({
          ...current,
          [execution.id]: {
            ...current[execution.id],
            advanceError: caughtApiErrorCopy(cause, "无法推进此执行，请重试。"),
          },
        }));
      }
    } finally {
      advanceInFlightRef.current.delete(execution.id);
      advanceAbortRef.current.delete(execution.id);
    }
  }, [updateExecution]);

  const controlExecution = useCallback(async (
    execution: ExecutionDto,
    action: ControlAction,
  ) => {
    setCardStates((current) => ({
      ...current,
      [execution.id]: {
        ...current[execution.id],
        controlError: undefined,
        controlPending: true,
      },
    }));
    try {
      const response = await fetch(`/api/executions/${execution.id}/control`, {
        body: JSON.stringify({
          action,
          expectedVersion: execution.version,
          operationId: newOperationId(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        throw new ApiDisplayError(
          apiErrorCopy(payload as Partial<ApiError>, "无法执行控制操作，请重试。"),
        );
      }
      const parsed = executionControlResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ApiDisplayError("控制响应无效，请刷新后重试。");
      }
      advanceOperationRef.current.delete(execution.id);
      updateExecution(parsed.data.execution);
    } catch (cause: unknown) {
      if (mountedRef.current) {
        setCardStates((current) => ({
          ...current,
          [execution.id]: {
            ...current[execution.id],
            controlError: caughtApiErrorCopy(cause, "无法执行控制操作，请重试。"),
          },
        }));
      }
    } finally {
      if (mountedRef.current) {
        setCardStates((current) => ({
          ...current,
          [execution.id]: { ...current[execution.id], controlPending: false },
        }));
      }
    }
  }, [updateExecution]);

  const refreshExecution = useCallback(async (execution: ExecutionDto) => {
    setCardStates((current) => ({
      ...current,
      [execution.id]: {
        ...current[execution.id],
        refreshError: undefined,
        refreshPending: true,
      },
    }));
    try {
      const response = await fetch(`/api/executions/${execution.id}`);
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        throw new ApiDisplayError(
          apiErrorCopy(payload as Partial<ApiError>, "无法刷新此执行，请重试。"),
        );
      }
      const candidate = (payload as { execution?: unknown }).execution;
      const parsed = executionDtoSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new ApiDisplayError("执行详情响应无效，请重试。");
      }
      updateExecution(parsed.data);
    } catch (cause: unknown) {
      if (mountedRef.current) {
        setCardStates((current) => ({
          ...current,
          [execution.id]: {
            ...current[execution.id],
            refreshError: caughtApiErrorCopy(cause, "无法刷新此执行，请重试。"),
          },
        }));
      }
    } finally {
      if (mountedRef.current) {
        setCardStates((current) => ({
          ...current,
          [execution.id]: { ...current[execution.id], refreshPending: false },
        }));
      }
    }
  }, [updateExecution]);

  const mergeExecution = useCallback(async (
    execution: ExecutionDto,
    stagedHash: string,
  ) => {
    if (mergeInFlightRef.current.has(execution.id)) return;
    const operationId = mergeOperationRef.current.get(execution.id) ?? newOperationId();
    mergeOperationRef.current.set(execution.id, operationId);
    mergeInFlightRef.current.add(execution.id);
    setCardStates((current) => ({
      ...current,
      [execution.id]: { ...current[execution.id], advanceError: undefined },
    }));
    try {
      const response = await fetch(`/api/executions/${execution.id}/merge`, {
        body: JSON.stringify({
          expectedVersion: execution.version,
          operationId,
          stagedHash,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        const code = (payload as Partial<ApiError>).error?.code;
        if (code === "MANUAL_RECOVERY_REQUIRED") {
          await refreshExecution(execution);
        }
        throw new ApiDisplayError(
          apiErrorCopy(payload as Partial<ApiError>, "无法合入此执行，请重试。"),
        );
      }
      const parsed = mergeExecutionResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ApiDisplayError("合入响应无效，请刷新后重试。");
      }
      mergeOperationRef.current.delete(execution.id);
      if (mountedRef.current) updateExecution(parsed.data.execution);
    } catch (cause: unknown) {
      if (mountedRef.current) {
        setCardStates((current) => ({
          ...current,
          [execution.id]: {
            ...current[execution.id],
            advanceError: caughtApiErrorCopy(cause, "无法合入此执行，请重试。"),
          },
        }));
      }
    } finally {
      mergeInFlightRef.current.delete(execution.id);
    }
  }, [refreshExecution, updateExecution]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetch(`/api/projects/${projectId}/executions`)
      .then(async (response) => {
        const payload = (await response.json()) as
          ExecutionListResponse & Partial<ApiError>;
        if (!response.ok) {
          throw new ApiDisplayError(
            apiErrorCopy(payload, "无法加载执行，请稍后重试。"),
          );
        }
        return payload;
      })
      .then((payload) => {
        if (active) setExecutions(payload.executions);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(caughtApiErrorCopy(cause, "无法加载执行，请稍后重试。"));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, reloadKey]);

  useEffect(() => {
    let active = true;
    setPickerLoading(true);
    setPickerError(null);
    void Promise.resolve().then(() => Promise.all([
      fetch(`/api/projects/${projectId}/mission`),
      fetch(`/api/projects/${projectId}/collaboration`),
    ])).then(async ([missionResponse, collaborationResponse]) => {
      const mission = (await missionResponse.json()) as MissionState & Partial<ApiError>;
      const collaboration = (await collaborationResponse.json()) as {
        run?: { id: string; status: string } | null;
      } & Partial<ApiError>;
      if (!missionResponse.ok) {
        throw new ApiDisplayError(apiErrorCopy(mission, "无法加载可执行任务。"));
      }
      if (!collaborationResponse.ok) {
        throw new ApiDisplayError(apiErrorCopy(collaboration, "无法加载协作计划。"));
      }
      if (!active) return;
      setWorkItems(mission.workItems);
      setSourceRunId(
        collaboration.run?.status === "planned" ? collaboration.run.id : null,
      );
    }).catch((cause: unknown) => {
      if (active) setPickerError(caughtApiErrorCopy(cause, "无法加载可执行任务。"));
    }).finally(() => {
      if (active) setPickerLoading(false);
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (!loading && !error && executions.length > 0) {
      firstHeadingRef.current?.focus();
    }
  }, [error, executions.length, loading]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const controller of advanceAbortRef.current.values()) {
        controller.abort();
      }
      advanceAbortRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (loading || error) return;
    for (const execution of executions.slice(0, 2)) {
      if (
        canAutoAdvance(execution)
        && !advanceOperationRef.current.has(execution.id)
      ) {
        void advanceExecution(execution);
      }
    }
  }, [advanceExecution, error, executions, loading]);

  const doneIds = new Set(
    workItems.filter(({ status }) => status === "done").map(({ id }) => id),
  );
  const activeTaskIds = new Set(executions.map(({ workItem }) => workItem.id));
  const activeAgentIds = new Set(executions.map(({ agent }) => agent.id));
  const eligibleTasks = workItems.filter(
    (item) =>
      item.status === "in_progress"
      && item.assigneeAgentId
      && item.dependencyIds.every((id) => doneIds.has(id))
      && !activeTaskIds.has(item.id)
      && !activeAgentIds.has(item.assigneeAgentId),
  );

  function toggleTask(taskId: string) {
    setSelectedTaskIds((current) =>
      current.includes(taskId)
        ? current.filter((id) => id !== taskId)
        : current.length < 2
          ? [...current, taskId]
          : current,
    );
  }

  async function submitStart(row: StartRow) {
    setStartRows((current) => [
      ...current.filter(({ taskId }) => taskId !== row.taskId),
      { ...row, message: null, state: "pending" },
    ]);
    try {
      const response = await fetch(`/api/projects/${projectId}/executions`, {
        body: JSON.stringify({
          operationId: row.operationId,
          sourceCollaborationRunId: sourceRunId,
          workItemId: row.taskId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as Partial<ApiError> & {
        execution?: ExecutionDto;
      };
      if (!response.ok) {
        throw new ApiDisplayError(
          `${row.title}：${apiErrorCopy(payload, "任务当前无法启动。")}`,
        );
      }
      setStartRows((current) =>
        current.map((item) =>
          item.taskId === row.taskId ? { ...item, state: "success" } : item,
        ),
      );
      if (payload.execution?.workItem && payload.execution.agent) {
        setExecutions((current) => [
          ...current.filter(({ id }) => id !== payload.execution!.id),
          payload.execution!,
        ]);
      }
    } catch (cause: unknown) {
      setStartRows((current) =>
        current.map((item) =>
          item.taskId === row.taskId
            ? {
                ...item,
                message: caughtApiErrorCopy(cause, `${row.title}：任务当前无法启动。`),
                state: "error",
              }
            : item,
        ),
      );
    }
  }

  function startSelected() {
    if (!sourceRunId) return;
    const rows = selectedTaskIds.map((taskId) => {
      const task = workItems.find(({ id }) => id === taskId);
      return {
        message: null,
        operationId: newOperationId(),
        state: "pending" as const,
        taskId,
        title: task?.title ?? taskId,
      };
    });
    setStartRows(rows);
    for (const row of rows) void submitStart(row);
  }

  return (
    <section
      aria-labelledby={`executions-title-${projectId}`}
      className="stack execution-panel"
      ref={panelRef}
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">项目执行</p>
          <h3 id={`executions-title-${projectId}`}>运行详情</h3>
        </div>
        <button
          onClick={() => setReloadKey((value) => value + 1)}
          style={{ minHeight: "var(--control-min)" }}
          type="button"
        >
          刷新执行
        </button>
      </div>
      {!loading && !error ? (
      <section aria-labelledby={`execution-picker-${projectId}`} className="stack">
        <h4 id={`execution-picker-${projectId}`}>选择并执行</h4>
        {pickerLoading ? (
          <p aria-busy="true">正在加载可执行任务…</p>
        ) : pickerError ? (
          <p className="error-text">{pickerError}</p>
        ) : eligibleTasks.length === 0 ? (
          <p>没有符合条件的进行中任务。</p>
        ) : (
          <>
            <div className="stack">
              {eligibleTasks.map((task) => {
                const checked = selectedTaskIds.includes(task.id);
                return (
                  <label key={task.id}>
                    <input
                      checked={checked}
                      disabled={!checked && selectedTaskIds.length >= 2}
                      onChange={() => toggleTask(task.id)}
                      type="checkbox"
                    />
                    {task.title}
                  </label>
                );
              })}
            </div>
            {!sourceRunId ? <p className="error-text">需要最新的已规划协作运行。</p> : null}
            <button
              disabled={!sourceRunId || selectedTaskIds.length === 0}
              onClick={startSelected}
              style={{ minHeight: "var(--control-min)" }}
              type="button"
            >
              开始执行所选任务
            </button>
          </>
        )}
        {startRows.length > 0 ? (
          <div aria-label="启动结果" className="stack">
            {startRows.map((row) => (
              <div key={row.taskId}>
                {row.state === "pending" ? (
                  <p aria-busy="true">正在启动…</p>
                ) : row.state === "success" ? (
                  <p aria-live="polite">{row.title} 已启动</p>
                ) : (
                  <>
                    <p role="alert">{row.message}</p>
                    <button
                      onClick={() => void submitStart(row)}
                      style={{ minHeight: "var(--control-min)" }}
                      type="button"
                    >
                      重试 {row.title}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </section>
      ) : null}
      <button
        aria-expanded={policyOpen}
        onClick={() => setPolicyOpen((open) => !open)}
        style={{ minHeight: "var(--control-min)" }}
        type="button"
      >
        {policyOpen ? "关闭验证政策" : "管理验证政策"}
      </button>
      {policyOpen ? <ValidationPolicyPanel projectId={projectId} /> : null}
      {loading ? (
        <p aria-busy="true" className="state-message">
          正在加载执行…
        </p>
      ) : error ? (
        <div className="state-message">
          <p className="error-text" role={embedded ? "status" : "alert"}>
            {error}
          </p>
          <button
            onClick={() => setReloadKey((value) => value + 1)}
            style={{ minHeight: "var(--control-min)" }}
            type="button"
          >
            重试加载执行
          </button>
        </div>
      ) : executions.length === 0 ? (
        <p className="state-message">尚无执行。</p>
      ) : narrow ? (
        <>
          <ul
            aria-label="执行摘要切换"
            className="execution-mobile-switcher"
            ref={mobileSwitcherRef}
            role="list"
          >
            {executions.slice(0, 2).map((execution) => (
              <li key={execution.id}>
                <button
                  aria-haspopup="dialog"
                  onClick={() => setMobileExecutionId(execution.id)}
                  ref={(element) => {
                    if (element) mobileTriggerRefs.current.set(execution.id, element);
                    else mobileTriggerRefs.current.delete(execution.id);
                  }}
                  type="button"
                >
                  <strong>{execution.workItem.title}</strong>
                  <span>{statusCopy[execution.status]}</span>
                  {execution.reasonCode ? <span>阻断原因：{execution.reasonCode}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {mobileExecutionId && typeof document !== "undefined"
            ? createPortal(
                <div
                  aria-label={`${executions.find(({ id }) => id === mobileExecutionId)?.workItem.title ?? "执行"} 详情`}
                  aria-modal="true"
                  className="modal-surface execution-mobile-detail"
                  ref={mobileDialogRef}
                  role="dialog"
                >
                  <button
                    className="drawer-close"
                    data-dialog-close="true"
                    onClick={closeMobileExecution}
                    ref={mobileCloseRef}
                    type="button"
                  >
                    关闭执行详情
                  </button>
                  {executions.filter(({ id }) => id === mobileExecutionId).map((execution) => (
                    <ExecutionCard
                      asyncState={cardStates[execution.id] ?? {}}
                      execution={execution}
                      key={execution.id}
                      missionId={workItems.find(({ id }) =>
                        id === execution.workItem.id)?.missionId ?? null}
                      onAdvanceRetry={() => {
                        void advanceExecution(
                          execution,
                          advanceOperationRef.current.get(execution.id),
                        );
                      }}
                      onControl={(action) => void controlExecution(execution, action)}
                      onExecutionChanged={updateExecution}
                      onMerge={(stagedHash) => void mergeExecution(execution, stagedHash)}
                      onRefresh={() => void refreshExecution(execution)}
                    />
                  ))}
                </div>,
                document.body,
              )
            : null}
        </>
      ) : (
        <div className="run-details">
          {executions.slice(0, 2).map((execution, index) => (
            <ExecutionCard
              asyncState={cardStates[execution.id] ?? {}}
              execution={execution}
              headingRef={index === 0 ? firstHeadingRef : undefined}
              key={execution.id}
              missionId={workItems.find(({ id }) =>
                id === execution.workItem.id)?.missionId ?? null}
              onAdvanceRetry={() => {
                void advanceExecution(
                  execution,
                  advanceOperationRef.current.get(execution.id),
                );
              }}
              onControl={(action) => void controlExecution(execution, action)}
              onExecutionChanged={updateExecution}
              onMerge={(stagedHash) => void mergeExecution(execution, stagedHash)}
              onRefresh={() => void refreshExecution(execution)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
