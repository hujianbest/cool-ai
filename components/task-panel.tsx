"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import type { GovernanceView } from "@/components/activity-bar";
import { ApprovalCenterPanel } from "@/components/project-context/approval-center-panel";
import { AuditPanel } from "@/components/project-context/audit-panel";
import { MemoryPanel } from "@/components/project-context/memory-panel";
import { MissionBoard } from "@/components/project-context/mission-board";
import { OnboardingGuide } from "@/components/onboarding-guide";
import {
  ApiDisplayError,
  apiErrorCopy,
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";
import type {
  ApiError,
  Project,
  TaskEvent,
  TaskRun,
  TaskStateResponse,
} from "@/src/shared/contracts";
import {
  parseHomeState,
  type HomeState,
} from "@/src/shared/home-contracts";

type TaskCollection = {
  tasks: TaskRun[];
  events: TaskEvent[];
};

async function readPayload<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const statusLabels: Record<TaskRun["status"], string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
};

const eventMessages: Record<TaskEvent["status"], string> = {
  queued: "任务已排队。",
  running: "任务已开始。",
  completed: "任务已完成。",
  failed: "任务执行失败。",
};

type TaskPanelProps = {
  projectId: string | null;
  currentProjectName: string | null;
  currentProjectTitleRef: RefObject<HTMLHeadingElement | null>;
  projectLoading: boolean;
  projectError: string | null;
  narrow: boolean;
  editorOpen: boolean;
  onCloseEditor: () => void;
  editorSurfaceRef: RefObject<HTMLElement | null>;
  editorCloseRef: RefObject<HTMLButtonElement | null>;
  governance?: {
    onClose: () => void;
    onOpenFolder: () => void;
    projectId: string | null;
    view: GovernanceView;
  } | null;
  contextOpen: boolean;
  onCloseContext: () => void;
  contextSurfaceRef: RefObject<HTMLElement | null>;
  contextCloseRef: RefObject<HTMLButtonElement | null>;
  onSelectProject: () => void;
  onHomeStateChange?: (state: HomeState | null) => void;
  onboarding?: {
    onCreateProject: () => void;
    onSkip?: () => void;
    onSelectProject: (projectId: string) => void;
    projects: Project[];
    step: "project-select" | "goal";
  } | null;
  legacyTasksEnabled?: boolean;
  threadListState?: "loading" | "empty" | "ready" | "error" | null;
};

const GOVERNANCE_TITLES: Record<GovernanceView, string> = {
  mission: "任务看板",
  memory: "共享记忆",
  approvals: "审批中心",
  audit: "审计中心",
};

export function TaskPanel({
  projectId,
  currentProjectName,
  currentProjectTitleRef,
  projectLoading,
  projectError,
  narrow,
  editorOpen,
  onCloseEditor,
  editorSurfaceRef,
  editorCloseRef,
  governance,
  contextOpen,
  onCloseContext,
  contextSurfaceRef,
  contextCloseRef,
  onSelectProject,
  onHomeStateChange,
  onboarding,
  legacyTasksEnabled = true,
  threadListState = null,
}: TaskPanelProps) {
  const [tasks, setTasks] = useState<TaskRun[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [goalFactsVersion, setGoalFactsVersion] = useState(0);
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [locationVersion, setLocationVersion] = useState(0);
  const [collaborationSurface, setCollaborationSurface] = useState<
    "chat" | "board" | "run"
  >("chat");
  const [nestedModalOpen, setNestedModalOpen] = useState(false);
  const [homeState, setHomeState] = useState<HomeState | null>(null);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeReloadKey, setHomeReloadKey] = useState(0);
  const [executionSource, setExecutionSource] = useState<{
    projectId: string;
    runId: string;
    threadId: string;
  } | null>(null);
  const [collaborationTarget, setCollaborationTarget] = useState<{
    messageId: string | null;
    selectedRunId: string | null;
    threadId: string;
  } | null>(() => {
    if (!projectId || typeof window === "undefined") return null;
    const query = new URLSearchParams(window.location.search);
    const threadIds = query.getAll("thread");
    const runIds = query.getAll("run");
    const messageIds = query.getAll("message");
    return threadIds.length === 1 &&
      threadIds[0]!.length > 0 &&
      (runIds.length === 0 ||
        (runIds.length === 1 && runIds[0]!.length > 0)) &&
      (messageIds.length === 0 ||
        (messageIds.length === 1 && messageIds[0]!.length > 0))
      ? {
          messageId: messageIds[0] ?? null,
          selectedRunId: runIds[0] ?? null,
          threadId: threadIds[0]!,
        }
      : null;
  });
  const collaborationTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const taskGoalInputRef = useRef<HTMLInputElement>(null);
  const collaborationProjectId =
    projectId ?? (homeState?.kind === "ready" ? homeState.project.id : null);

  useEffect(() => {
    const updateLocation = () => setLocationVersion((current) => current + 1);
    window.addEventListener("popstate", updateLocation);
    return () => window.removeEventListener("popstate", updateLocation);
  }, []);

  useEffect(() => {
    if (!collaborationProjectId || typeof window === "undefined") {
      setExecutionSource(null);
      setCollaborationTarget(null);
      return;
    }
    const query = new URLSearchParams(window.location.search);
    const threadIds = query.getAll("thread");
    const runIds = query.getAll("run");
    const messageIds = query.getAll("message");
    const validThread = threadIds.length === 1 && threadIds[0]!.length > 0;
    const validRun = runIds.length === 0 ||
      (runIds.length === 1 && runIds[0]!.length > 0);
    const validMessage = messageIds.length === 0 ||
      (messageIds.length === 1 && messageIds[0]!.length > 0);
    setCollaborationTarget(
      validThread && validRun && validMessage
        ? {
            messageId: messageIds[0] ?? null,
            selectedRunId: runIds[0] ?? null,
            threadId: threadIds[0]!,
          }
        : null,
    );
    setExecutionSource(
      projectId &&
      validThread
      && runIds.length === 1
      && runIds[0]!.length > 0
        ? { projectId, runId: runIds[0]!, threadId: threadIds[0]! }
        : null,
    );
  }, [collaborationProjectId, locationVersion, projectId]);

  useEffect(() => {
    let active = true;
    setError(null);
    setTasks([]);
    setEvents([]);

    if (!projectId || !legacyTasksEnabled) {
      setIsLoading(false);
      return () => {
        active = false;
      };
    }

    setIsLoading(true);
    void fetch(`/api/projects/${projectId}/tasks`)
      .then(async (response) => {
        const payload = await readPayload<TaskCollection & Partial<ApiError>>(response);
        if (!response.ok) {
          throw new ApiDisplayError(apiErrorCopy(payload, "无法加载任务，请稍后重试。"));
        }
        return payload;
      })
      .then((payload) => {
        if (!active) return;
        setTasks(payload.tasks);
        setEvents(payload.events);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(caughtApiErrorCopy(cause, "无法加载任务，请稍后重试。"));
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [legacyTasksEnabled, projectId, reloadKey]);

  useEffect(() => {
    if (projectId || projectLoading || projectError) {
      setHomeState(null);
      setHomeError(null);
      setHomeLoading(false);
      onHomeStateChange?.(null);
      return;
    }

    const controller = new AbortController();
    setHomeLoading(true);
    setHomeError(null);
    setHomeState(null);
    onHomeStateChange?.(null);
    void fetch("/api/home", { signal: controller.signal })
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) {
          throw new ApiDisplayError("无法加载个人对话，请稍后重试。");
        }
        const parsed = parseHomeState(payload);
        if (!parsed) {
          throw new ApiDisplayError("个人对话响应无效，请稍后重试。");
        }
        return parsed;
      })
      .then((parsed) => {
        if (controller.signal.aborted) return;
        setHomeState(parsed);
        onHomeStateChange?.(parsed);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setHomeError(caughtApiErrorCopy(cause, "无法加载个人对话，请稍后重试。"));
        onHomeStateChange?.(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setHomeLoading(false);
      });

    return () => controller.abort();
  }, [
    homeReloadKey,
    onHomeStateChange,
    projectError,
    projectId,
    projectLoading,
  ]);

  function applyState(response: TaskStateResponse) {
    setTasks((current) => {
      const existing = current.findIndex((task) => task.id === response.task.id);
      if (existing === -1) return [...current, response.task];
      return current.map((task) => (task.id === response.task.id ? response.task : task));
    });
    setEvents((current) => [
      ...current.filter((taskEvent) => taskEvent.taskId !== response.task.id),
      ...response.events,
    ]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || !goal.trim() || isRunning) return;

    setError(null);
    setIsRunning(true);
    try {
      const createdResponse = await fetch(`/api/projects/${projectId}/tasks`, {
        body: JSON.stringify({ goal }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const created = await readPayload<TaskStateResponse & Partial<ApiError>>(createdResponse);
      if (!createdResponse.ok) {
        throw new ApiDisplayError(apiErrorCopy(created, "无法创建任务，请稍后重试。"));
      }
      applyState(created);

      const startedResponse = await fetch(`/api/tasks/${created.task.id}/start`, {
        method: "POST",
      });
      const started = await readPayload<TaskStateResponse & Partial<ApiError>>(startedResponse);
      if (!startedResponse.ok) {
        throw new ApiDisplayError(apiErrorCopy(started, "无法启动任务，请稍后重试。"));
      }
      applyState(started);

      const executedResponse = await fetch(`/api/tasks/${created.task.id}/execute`, {
        method: "POST",
      });
      const executed = await readPayload<TaskStateResponse & Partial<ApiError>>(executedResponse);
      if (executed.task && executed.events) {
        applyState(executed);
      }
      if (!executedResponse.ok) {
        throw new ApiDisplayError(apiErrorCopy(executed, "无法执行任务，请稍后重试。"));
      }

      setGoal("");
    } catch (cause) {
      setError(caughtApiErrorCopy(cause, "无法运行任务，请稍后重试。"));
    } finally {
      setIsRunning(false);
    }
  }

  const latestTask = tasks.at(-1);
  const collaborationSurfaces = [{ id: "chat", label: "群聊" }] as const;

  function selectCollaborationSurface(
    surface: (typeof collaborationSurfaces)[number]["id"],
    focus = false,
  ) {
    setCollaborationSurface(surface);
    if (focus) queueMicrotask(() => collaborationTabRefs.current.get(surface)?.focus());
  }

  function focusOnboardingSurface(
    surface: "chat",
    targetSelectors: string[],
  ) {
    if (narrow) selectCollaborationSurface(surface);
    let attempts = 0;
    const focusWhenReady = () => {
      const target = targetSelectors
        .map((selector) => document.querySelector<HTMLElement>(selector))
        .find((candidate) => candidate !== null);
      if (target) {
        target.focus();
        return;
      }
      attempts += 1;
      if (attempts < 100) window.setTimeout(focusWhenReady, 50);
    };
    focusWhenReady();
  }

  function handleCollaborationTabs(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = collaborationSurfaces.findIndex(
      (item) => item.id === collaborationSurface,
    );
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % collaborationSurfaces.length;
    else if (event.key === "ArrowLeft") {
      nextIndex =
        (currentIndex - 1 + collaborationSurfaces.length) % collaborationSurfaces.length;
    } else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = collaborationSurfaces.length - 1;
    else return;
    event.preventDefault();
    selectCollaborationSurface(collaborationSurfaces[nextIndex].id, true);
  }

  return (
    <>
      <section
        aria-label={narrow ? undefined : "任务事件流"}
        aria-labelledby={narrow ? "task-editor-label" : undefined}
        aria-modal={narrow && editorOpen && !nestedModalOpen ? "true" : undefined}
        className={
          governance ? "cockpit-flow cockpit-flow-governance" : "cockpit-flow"
        }
        data-open={editorOpen || Boolean(onboarding) || Boolean(governance)}
        data-testid="editor-surface"
        hidden={narrow && !editorOpen && !onboarding}
        id="task-editor-surface"
        ref={editorSurfaceRef}
        role={narrow && editorOpen && !nestedModalOpen ? "dialog" : undefined}
      >
        <span className="sr-only" id="task-editor-label">
          任务编辑
        </span>
        <button
          aria-label="关闭任务编辑"
          className="drawer-close button-ghost"
          data-dialog-close="true"
          onClick={onCloseEditor}
          ref={editorCloseRef}
          tabIndex={narrow && editorOpen ? 0 : -1}
          type="button"
        >
          关闭
        </button>
        {governance ? (
          <div className="governance-view stack">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">治理视图</p>
                {governance.projectId ? null : (
                  <h2 className="surface-heading">
                    {GOVERNANCE_TITLES[governance.view]}
                  </h2>
                )}
              </div>
              <button
                className="button-secondary"
                onClick={governance.onClose}
                type="button"
              >
                返回对话
              </button>
            </div>
            {governance.projectId ? (
              governance.view === "mission" ? (
                <MissionBoard projectId={governance.projectId} />
              ) : governance.view === "memory" ? (
                <MemoryPanel projectId={governance.projectId} />
              ) : governance.view === "approvals" ? (
                <ApprovalCenterPanel projectId={governance.projectId} />
              ) : (
                <AuditPanel projectId={governance.projectId} />
              )
            ) : (
              <div className="empty-guide state-message">
                <p>
                  先打开一个文件夹进入项目，即可查看
                  {GOVERNANCE_TITLES[governance.view]}。
                </p>
                <button
                  className="button-primary"
                  onClick={governance.onOpenFolder}
                  type="button"
                >
                  打开文件夹
                </button>
              </div>
            )}
          </div>
        ) : null}
        <div className="panel-heading">
          <span aria-hidden="true" className="agent-mark">
            {homeState?.kind === "ready" ? homeState.agent.avatarText : "A"}
          </span>
          <div>
            <p className="eyebrow">
              {currentProjectName
                ? "项目群聊"
                : homeState?.kind === "ready"
                  ? "1:1 对话"
                  : "确定性示例 Agent"}
            </p>
            <h2
              className="surface-heading"
              id="tasks-title"
              ref={currentProjectTitleRef}
              tabIndex={currentProjectName ? -1 : undefined}
            >
              {currentProjectName ??
                (homeState?.kind === "ready" ? homeState.agent.name : "任务活动")}
            </h2>
          </div>
        </div>

        {onboarding ? (
          <OnboardingGuide
            onCreateProject={onboarding.onCreateProject}
            onFocusChat={() => {
              if (projectId) {
                focusOnboardingSurface(
                  "chat",
                  [`#collaboration-message-${projectId}`],
                );
              }
            }}
            onFocusMission={() => {
              if (!projectId) return;
              const titleSelector = `#mission-title-${projectId}`;
              if (!document.querySelector(titleSelector)) {
                document
                  .querySelector<HTMLButtonElement>(
                    '#mission-board [aria-label="创建使命"]',
                  )
                  ?.click();
              }
              let attempts = 0;
              const focusWhenReady = () => {
                const target = document.querySelector<HTMLElement>(titleSelector);
                if (target) {
                  target.focus();
                  return;
                }
                attempts += 1;
                if (attempts < 20) window.setTimeout(focusWhenReady, 50);
              };
              focusWhenReady();
            }}
            onSelectProject={onboarding.onSelectProject}
            onSkip={onboarding.onSkip}
            projectId={projectId}
            projects={onboarding.projects}
            refreshKey={goalFactsVersion}
            selectedRunId={collaborationTarget?.selectedRunId}
            step={onboarding.step}
            threadId={collaborationTarget?.threadId}
          />
        ) : null}

        {projectLoading ? (
          <p aria-busy="true" className="state-message">
            正在加载项目…
          </p>
        ) : projectError ? (
          <p className="state-message">{projectError}</p>
        ) : !projectId ? (
          homeLoading || homeState === null && homeError === null ? (
            <p aria-busy="true" className="state-message">
              正在加载对话…
            </p>
          ) : homeError ? (
            <div className="state-message">
              <p className="error-text" role="alert">
                {homeError}
              </p>
              <button
                className="button-secondary"
                onClick={() => setHomeReloadKey((current) => current + 1)}
                type="button"
              >
                重试加载对话
              </button>
            </div>
          ) : homeState?.kind === "needs_agent" ? (
            <div className="empty-guide state-message">
              <p className="empty-guide-title">欢迎来到 Cool AI</p>
              <p>先配置一个 Agent，即可开始个人对话。</p>
              <p className="muted">输入 @成员 可召唤一名 Agent 开始协作。</p>
              <Link
                className="button-primary"
                href="/team?section=agents&returnTo=/"
              >
                配置 Agent
              </Link>
            </div>
          ) : homeState?.kind === "ready" ? (
            <CollaborationPanel
              directAgentName={homeState.agent.name}
              modalBackgroundRef={editorSurfaceRef}
              onNestedModalChange={setNestedModalOpen}
              projectId={homeState.project.id}
              requestedMessageId={collaborationTarget?.messageId}
              selectedRunId={collaborationTarget?.selectedRunId}
              surface="chat"
              threadId={collaborationTarget?.threadId}
            />
          ) : null
        ) : (
          <>
            {threadListState === "empty" ? (
              <p className="state-message">
                创建线程后即可开始协作。
              </p>
            ) : (
              <CollaborationPanel
                modalBackgroundRef={editorSurfaceRef}
                onGoalFactChanged={() =>
                  setGoalFactsVersion((current) => current + 1)
                }
                onNestedModalChange={setNestedModalOpen}
                projectId={projectId}
                requestedMessageId={collaborationTarget?.messageId}
                selectedRunId={collaborationTarget?.selectedRunId}
                startOnly={onboarding?.step === "goal"}
                surface="chat"
                threadId={collaborationTarget?.threadId}
              />
            )}
            {legacyTasksEnabled ? (
            <>
            <form className="composer" onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-field">
                  <label htmlFor="task-goal">任务目标</label>
                  <input
                    disabled={isRunning}
                    id="task-goal"
                    name="goal"
                    onChange={(event) => setGoal(event.target.value)}
                    placeholder="例如：整理本周发布说明"
                    ref={taskGoalInputRef}
                    value={goal}
                  />
                </div>
                <button
                  className="button-primary"
                  disabled={!goal.trim() || isRunning}
                  type="submit"
                >
                  {isRunning ? "任务运行中…" : "运行任务"}
                </button>
              </div>
            </form>

            {error ? (
              <div className="state-message">
                <p className="error-text" role="alert">
                  {error}
                </p>
                {!isRunning && tasks.length === 0 ? (
                  <button onClick={() => setReloadKey((current) => current + 1)} type="button">
                    重试任务历史
                  </button>
                ) : null}
              </div>
            ) : null}

            {isLoading ? (
              <p aria-busy="true" className="state-message">
                正在加载任务历史…
              </p>
            ) : tasks.length === 0 && !error ? (
              <div className="empty-guide state-message">
                <p>暂无任务。输入目标即可运行示例 Agent。</p>
                <button
                  className="button-primary"
                  onClick={() => taskGoalInputRef.current?.focus()}
                  type="button"
                >
                  开始创建任务
                </button>
              </div>
            ) : null}

            {events.length > 0 ? (
              <ol aria-label="Task events" className="timeline">
                {events.map((taskEvent) => (
                  <li className="timeline-item" key={taskEvent.id}>
                    <span className={`status-label status-${taskEvent.status}`}>
                      {statusLabels[taskEvent.status]}
                    </span>
                    <span>{eventMessages[taskEvent.status]}</span>
                  </li>
                ))}
              </ol>
            ) : null}

            <p aria-atomic="true" aria-live="polite" className="muted" role="status">
              {latestTask ? `最新任务状态：${statusLabels[latestTask.status]}` : ""}
            </p>
            </>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
