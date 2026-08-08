"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import { ExecutionPanel } from "@/components/execution/execution-panel";
import { OnboardingGuide } from "@/components/onboarding-guide";
import { MissionBoard } from "@/components/project-context/mission-board";
import { ProjectContextPanel } from "@/components/project-context/project-context-panel";
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
  contextOpen: boolean;
  onCloseContext: () => void;
  contextSurfaceRef: RefObject<HTMLElement | null>;
  contextCloseRef: RefObject<HTMLButtonElement | null>;
  onSelectProject: () => void;
  onboarding?: {
    onCreateProject: () => void;
    onSkip?: () => void;
    onSelectProject: (projectId: string) => void;
    projects: Project[];
    step: "project-select" | "goal";
  } | null;
  legacyTasksEnabled?: boolean;
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
  contextOpen,
  onCloseContext,
  contextSurfaceRef,
  contextCloseRef,
  onSelectProject,
  onboarding,
  legacyTasksEnabled = true,
}: TaskPanelProps) {
  const [tasks, setTasks] = useState<TaskRun[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [goalFactsVersion, setGoalFactsVersion] = useState(0);
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [collaborationSurface, setCollaborationSurface] = useState<
    "chat" | "board" | "run"
  >("chat");
  const [nestedModalOpen, setNestedModalOpen] = useState(false);
  const collaborationTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const taskGoalInputRef = useRef<HTMLInputElement>(null);

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
  const collaborationSurfaces = [
    { id: "chat", label: "群聊" },
    { id: "board", label: "看板" },
    { id: "run", label: "运行详情" },
  ] as const;

  function selectCollaborationSurface(
    surface: (typeof collaborationSurfaces)[number]["id"],
    focus = false,
  ) {
    setCollaborationSurface(surface);
    if (focus) queueMicrotask(() => collaborationTabRefs.current.get(surface)?.focus());
  }

  function focusOnboardingSurface(
    surface: "board" | "chat",
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
        className="cockpit-flow"
        data-open={editorOpen || Boolean(onboarding)}
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
        <div className="panel-heading">
          <span aria-hidden="true" className="agent-mark">
            A
          </span>
          <div>
            <p className="eyebrow">确定性示例 Agent</p>
            <h2
              className="surface-heading"
              id="tasks-title"
              ref={currentProjectTitleRef}
              tabIndex={currentProjectName ? -1 : undefined}
            >
              {currentProjectName ?? "任务活动"}
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
              if (projectId) {
                focusOnboardingSurface("board", [
                  `#mission-title-${projectId}`,
                  "#mission-board .mission-summary h3",
                ]);
              }
            }}
            onSelectProject={onboarding.onSelectProject}
            onSkip={onboarding.onSkip}
            projectId={projectId}
            projects={onboarding.projects}
            refreshKey={goalFactsVersion}
            step={onboarding.step}
          />
        ) : null}

        {narrow && projectId ? (
          <div
            aria-label="协作视图"
            className="collaboration-mobile-tabs"
            onKeyDown={handleCollaborationTabs}
            role="tablist"
          >
            {collaborationSurfaces.map((item) => (
              <button
                aria-controls={`collaboration-${item.id}-panel`}
                aria-selected={collaborationSurface === item.id}
                id={`collaboration-${item.id}-tab`}
                key={item.id}
                onClick={() => selectCollaborationSurface(item.id)}
                ref={(element) => {
                  if (element) collaborationTabRefs.current.set(item.id, element);
                  else collaborationTabRefs.current.delete(item.id);
                }}
                role="tab"
                tabIndex={collaborationSurface === item.id ? 0 : -1}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}

        {projectLoading ? (
          <p aria-busy="true" className="state-message">
            正在加载项目…
          </p>
        ) : projectError ? (
          <p className="state-message">{projectError}</p>
        ) : !projectId ? (
          <div className="empty-guide state-message">
            <p>请先创建或选择项目，再运行任务。</p>
            <button className="button-primary" onClick={onSelectProject} type="button">
              选择项目以运行任务
            </button>
          </div>
        ) : (
          <>
            {narrow ? (
              <>
                <section
                  aria-labelledby={`collaboration-${collaborationSurface}-tab`}
                  className="collaboration-mobile-surface"
                  id={`collaboration-${collaborationSurface}-panel`}
                  role="tabpanel"
                >
                  {collaborationSurface === "board" ? (
                    <MissionBoard
                      onGoalFactChanged={() =>
                        setGoalFactsVersion((current) => current + 1)
                      }
                      projectId={projectId}
                    />
                  ) : collaborationSurface === "run" ? (
                    <>
                      <CollaborationPanel
                        modalBackgroundRef={editorSurfaceRef}
                        onGoalFactChanged={() =>
                          setGoalFactsVersion((current) => current + 1)
                        }
                        onNestedModalChange={setNestedModalOpen}
                        projectId={projectId}
                        startOnly={onboarding?.step === "goal"}
                        surface="run"
                      />
                      <ExecutionPanel embedded projectId={projectId} />
                    </>
                  ) : (
                    <CollaborationPanel
                      modalBackgroundRef={editorSurfaceRef}
                      onGoalFactChanged={() =>
                        setGoalFactsVersion((current) => current + 1)
                      }
                      onNestedModalChange={setNestedModalOpen}
                      projectId={projectId}
                      startOnly={onboarding?.step === "goal"}
                      surface={collaborationSurface}
                    />
                  )}
                </section>
              </>
            ) : (
              <>
                <CollaborationPanel
                  onGoalFactChanged={() =>
                    setGoalFactsVersion((current) => current + 1)
                  }
                  projectId={projectId}
                  startOnly={onboarding?.step === "goal"}
                />
                <MissionBoard
                  onGoalFactChanged={() =>
                    setGoalFactsVersion((current) => current + 1)
                  }
                  projectId={projectId}
                />
                <ExecutionPanel embedded projectId={projectId} />
              </>
            )}
            {legacyTasksEnabled &&
            (!narrow || collaborationSurface === "chat") ? (
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

      <aside
        aria-label={narrow ? undefined : "当前任务上下文"}
        aria-labelledby={narrow ? "task-context-label" : undefined}
        aria-modal={narrow && contextOpen ? "true" : undefined}
        className="cockpit-context"
        data-open={contextOpen}
        data-testid="context-surface"
        hidden={narrow && !contextOpen}
        id="task-context-drawer"
        ref={contextSurfaceRef}
        role={narrow && contextOpen ? "dialog" : undefined}
      >
        <span className="sr-only" id="task-context-label">
          当前任务上下文
        </span>
        <button
          aria-label="关闭当前任务上下文"
          className="drawer-close button-ghost"
          data-dialog-close="true"
          onClick={onCloseContext}
          ref={contextCloseRef}
          tabIndex={contextOpen ? 0 : -1}
          type="button"
        >
          关闭
        </button>
        <div>
          <p className="eyebrow">项目资源</p>
          <h2 className="surface-heading">项目上下文</h2>
        </div>
        {projectLoading ? (
          <p aria-busy="true" className="state-message">
            正在加载项目上下文…
          </p>
        ) : projectError ? (
          <p className="state-message">{projectError}</p>
        ) : projectId ? (
          <ProjectContextPanel
            projectId={projectId}
            skeleton={
              latestTask ? (
                <div className="context-body">
                  <p className="context-label">目标</p>
                  <p>{latestTask.goal}</p>
                  <p className={`context-status status-${latestTask.status}`}>
                    状态：{statusLabels[latestTask.status]}
                  </p>
                  <p className="context-label">更新时间</p>
                  <time dateTime={latestTask.updatedAt}>
                    {latestTask.updatedAt}
                  </time>
                  <p className="context-label">结果</p>
                  <p>{latestTask.result ?? "暂无结果。"}</p>
                  {latestTask.error ? (
                    <p className="error-text">
                      任务执行失败，请稍后重试。
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="state-message">暂无当前任务。</p>
              )
            }
          />
        ) : (
          <div className="empty-guide state-message">
            <p>请先选择项目。</p>
            <button className="button-primary" onClick={onSelectProject} type="button">
              选择项目
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
