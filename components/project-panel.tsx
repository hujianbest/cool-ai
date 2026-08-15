"use client";

import {
  Folder,
  FolderPlus,
  PencilSimple,
  SidebarSimple,
  X,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { usePathname, useRouter } from "next/navigation";

import { useModalSurface, useNarrowMode } from "@/components/mobile-dialog";
import { ActivityBar } from "@/components/activity-bar";
import { ProjectNotificationPoller } from "@/components/notifications/project-notification-poller";
import { ProjectThreadNavigation } from "@/components/project-thread-navigation";
import {
  parseReturnTo,
  type ProjectReturnTo,
} from "@/components/settings-navigation";
import { ProjectSetupPanel } from "@/components/project-context/project-setup-panel";
import { TaskPanel } from "@/components/task-panel";
import { ActionDialog } from "@/components/ui/action-dialog";
import { HelpTip } from "@/components/ui/help-tip";
import { IconButton } from "@/components/ui/icon-button";
import {
  ApiDisplayError,
  apiErrorCopy,
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";
import type { ApiError, Project } from "@/src/shared/contracts";
import type { HomeState } from "@/src/shared/home-contracts";
import {
  guideHref,
  parseGuideUrl,
  parseProjectCreateEnvelope,
  parseProjectGuideEnvelope,
  uniquelyReconciledProject,
} from "@/src/shared/onboarding-guide-machine";

async function errorMessage(response: Response): Promise<string> {
  const payload = (await response.json()) as ApiError;
  return apiErrorCopy(payload);
}

export function ProjectPanel({
  returnTo,
}: {
  returnTo?: ProjectReturnTo;
} = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const [guideStep, setGuideStep] = useState<
    "project-select" | "workspace" | "members" | "goal" | null
  >(null);
  const [guideActive, setGuideActive] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState("");
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [routeProjectError, setRouteProjectError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [projectCreateNotice, setProjectCreateNotice] = useState<string | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [focusCreatedProjectId, setFocusCreatedProjectId] = useState<string | null>(null);
  const [mobileSurface, setMobileSurface] = useState<
    "projects" | "context" | "editor" | null
  >(null);
  const [workspaceConfirmationOpen, setWorkspaceConfirmationOpen] =
    useState(false);
  const [threadDialogOpen, setThreadDialogOpen] = useState(false);
  const [threadListState, setThreadListState] = useState<
    "loading" | "empty" | "ready" | "error" | null
  >(null);
  const [homeState, setHomeState] = useState<HomeState | null>(null);
  const [settingsReturnTo, setSettingsReturnTo] = useState<ProjectReturnTo>(
    () =>
      returnTo ??
      (typeof window === "undefined"
        ? "/"
        : parseReturnTo(
            `${window.location.pathname}${window.location.search}`,
          )),
  );
  const narrow = useNarrowMode();
  const cockpitRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const projectSurfaceRef = useRef<HTMLElement>(null);
  const editorSurfaceRef = useRef<HTMLElement>(null);
  const contextSurfaceRef = useRef<HTMLElement>(null);
  const projectToggleRef = useRef<HTMLButtonElement>(null);
  const projectCloseRef = useRef<HTMLButtonElement>(null);
  const editorToggleRef = useRef<HTMLButtonElement>(null);
  const editorCloseRef = useRef<HTMLButtonElement>(null);
  const contextToggleRef = useRef<HTMLButtonElement>(null);
  const contextCloseRef = useRef<HTMLButtonElement>(null);
  const currentProjectTitleRef = useRef<HTMLHeadingElement>(null);
  const projectFolderPathInputRef = useRef<HTMLInputElement>(null);
  const closeMobileSurface = useCallback(() => setMobileSurface(null), []);
  const projectModal = useMemo(
    () => ({
      active:
        narrow && mobileSurface === "projects" && !threadDialogOpen,
      dialogRef: projectSurfaceRef,
      inertRootRefs: [toolbarRef, editorSurfaceRef, contextSurfaceRef],
      initialFocusRef: projectCloseRef,
      restoreFocusRef: projectToggleRef,
      onClose: closeMobileSurface,
    }),
    [closeMobileSurface, mobileSurface, narrow, threadDialogOpen],
  );
  const editorModal = useMemo(
    () => ({
      active: narrow && mobileSurface === "editor",
      dialogRef: editorSurfaceRef,
      inertRootRefs: [toolbarRef, projectSurfaceRef, contextSurfaceRef],
      initialFocusRef: editorCloseRef,
      restoreFocusRef: editorToggleRef,
      onClose: closeMobileSurface,
    }),
    [closeMobileSurface, mobileSurface, narrow],
  );
  const contextModal = useMemo(
    () => ({
      active: narrow && mobileSurface === "context",
      dialogRef: contextSurfaceRef,
      inertRootRefs: [toolbarRef, projectSurfaceRef, editorSurfaceRef],
      initialFocusRef: contextCloseRef,
      restoreFocusRef: contextToggleRef,
      onClose: closeMobileSurface,
    }),
    [closeMobileSurface, mobileSurface, narrow],
  );
  useModalSurface(projectModal);
  useModalSurface(editorModal);
  useModalSurface(contextModal);

  useEffect(() => {
    if (returnTo) setSettingsReturnTo(returnTo);
  }, [returnTo]);

  useEffect(() => {
    const syncSettingsReturnTo = () => {
      setSettingsReturnTo(
        parseReturnTo(`${window.location.pathname}${window.location.search}`),
      );
    };
    window.addEventListener("popstate", syncSettingsReturnTo);
    return () => window.removeEventListener("popstate", syncSettingsReturnTo);
  }, []);

  const updateSettingsReturnTo = useCallback((href: string) => {
    setSettingsReturnTo(parseReturnTo(href));
  }, []);
  const updateHomeState = useCallback((state: HomeState | null) => {
    setHomeState(state);
  }, []);

  useEffect(() => {
    const syncGuideStep = () => {
      const result = parseGuideUrl(
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
        isLoading ? null : projects.map((project) => project.id),
      );
      setGuideStep(
        result.kind === "guide" &&
          (result.route.step === "project-select" ||
            result.route.step === "workspace" ||
            result.route.step === "members" ||
            result.route.step === "goal")
          ? result.route.step
          : null,
      );
      setGuideActive(
        result.kind === "guide" &&
          (result.route.step === "project-select" ||
            result.route.step === "workspace" ||
            result.route.step === "members" ||
            result.route.step === "goal"),
      );
    };
    syncGuideStep();
    window.addEventListener("popstate", syncGuideStep);
    return () => window.removeEventListener("popstate", syncGuideStep);
  }, [isLoading, projects]);

  useEffect(() => {
    if (
      narrow &&
      (guideStep === "workspace" || guideStep === "members")
    ) {
      setMobileSurface("projects");
    }
  }, [guideStep, narrow]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setProjectLoadError(null);

    void fetch("/api/projects")
      .then(async (response) => {
        if (!response.ok) {
          throw new ApiDisplayError(await errorMessage(response));
        }
        return response.json() as Promise<unknown>;
      })
      .then((payload) => {
        if (!active) return;
        const parsed = parseProjectGuideEnvelope(payload);
        if (parsed.kind !== "success") {
          throw new ApiDisplayError("项目响应无效，已停止自动选择。");
        }
        const loadedProjects = parsed.projects.filter(
          (project) => project.name !== "个人对话",
        );
        setProjects(loadedProjects);

        // 从 URL 解析 projectId，如果存在且在列表中，则选中它
        // 如果 URL 中有 projectId 但不在列表中，显示错误
        // 否则默认选中第一个项目（兜底逻辑）
        if (pathname) {
          const match = pathname.match(/^\/projects\/([^/]+)/);
          const urlProjectId = match?.[1] ?? null;
          if (urlProjectId) {
            if (loadedProjects.some((p) => p.id === urlProjectId)) {
              setRouteProjectError(null);
              setCurrentProjectId(urlProjectId);
            } else {
              setRouteProjectError("未找到该项目。");
              setCurrentProjectId(null);
            }
          } else {
            setRouteProjectError(null);
            setCurrentProjectId(null);
          }
        } else {
          // SSR 首帧 pathname 为空，跳过路由同步并保留 home。
          setRouteProjectError(null);
          setCurrentProjectId(null);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setProjectLoadError(caughtApiErrorCopy(cause, "无法加载项目，请稍后重试。"));
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  // URL 同步：当 pathname 变化时（浏览器前进/后退），同步 currentProjectId
  useEffect(() => {
    if (!pathname || projects.length === 0) return;

    const match = pathname.match(/^\/projects\/([^/]+)/);
    const urlProjectId = match?.[1] ?? null;

    if (urlProjectId && projects.some((p) => p.id === urlProjectId)) {
      setRouteProjectError(null);
      setCurrentProjectId(urlProjectId);
    } else if (urlProjectId) {
      setRouteProjectError("未找到该项目。");
      setCurrentProjectId(null);
    } else {
      setRouteProjectError(null);
      setCurrentProjectId(null);
    }
  }, [pathname, projects]);

  useEffect(() => {
    if (focusCreatedProjectId && focusCreatedProjectId === currentProjectId) {
      currentProjectTitleRef.current?.focus();
      setFocusCreatedProjectId(null);
    }
  }, [currentProjectId, focusCreatedProjectId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setProjectCreateNotice(null);

    if (!folderPath.trim()) {
      setFormError("请输入本地文件夹路径。");
      return;
    }

    setIsSubmitting(true);
    const previousProjectIds = new Set(projects.map((project) => project.id));
    const guideCreate = guideStep === "project-select";

    const finishCreatedProject = (
      createdProject: Project,
      reconciled: boolean,
    ) => {
      setProjects((current) => {
        const withoutDuplicate = current.filter(
          (candidate) => candidate.id !== createdProject.id,
        );
        return [...withoutDuplicate, createdProject];
      });
      setCurrentProjectId(createdProject.id);
      setFolderPath("");
      setFolderDialogOpen(false);
      if (reconciled) {
        setProjectCreateNotice("已通过事实核对确认项目已打开。");
      }
      if (guideCreate) {
        setGuideStep(null);
        setGuideActive(true);
        router.push(guideHref("workspace", createdProject.id));
      } else {
        router.push(`/projects/${encodeURIComponent(createdProject.id)}`);
        setFocusCreatedProjectId(createdProject.id);
      }
    };

    const reconcileUnknownCreate = async () => {
      try {
        const response = await fetch("/api/projects");
        if (!response.ok) throw new Error("read");
        const payload: unknown = await response.json();
        const parsed = parseProjectGuideEnvelope(payload);
        if (parsed.kind !== "success") throw new Error("invalid");
        const folderProjects = parsed.projects.filter(
          (project) => project.name !== "个人对话",
        );
        setProjects(folderProjects);
        const reconciled = uniquelyReconciledProject(previousProjectIds, {
          projects: folderProjects,
        });
        if (!reconciled) {
          setFormError(
            "无法唯一确认文件夹项目是否已打开。请核对项目列表后再决定是否重试；不会自动重发。",
          );
          return;
        }
        finishCreatedProject(reconciled, true);
      } catch {
        setFormError(
          "打开文件夹结果未知，且事实核对失败。请稍后核对项目列表；不会自动重发。",
        );
      }
    };

    try {
      const response = await fetch("/api/projects", {
        body: JSON.stringify({ path: folderPath }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new ApiDisplayError(await errorMessage(response));
      }
      const payload: unknown = await response.json();
      const createdProject = parseProjectCreateEnvelope(payload);
      if (!createdProject) {
        await reconcileUnknownCreate();
        return;
      }
      finishCreatedProject(createdProject, false);
    } catch (cause) {
      if (cause instanceof ApiDisplayError) {
        setFormError(caughtApiErrorCopy(cause, "无法打开文件夹，请稍后重试。"));
      } else {
        await reconcileUnknownCreate();
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function openFolderDialog() {
    setFolderDialogOpen(true);
    queueMicrotask(() => projectFolderPathInputRef.current?.focus());
  }

  function closeProjectNavigation() {
    setMobileSurface(null);
  }

  function closeTaskContext() {
    setMobileSurface(null);
  }

  function guideToProjectSelection() {
    if (narrow) {
      setMobileSurface("projects");
      window.setTimeout(() => openFolderDialog(), 0);
      return;
    }
    openFolderDialog();
  }

  function projectRecovery() {
    const rawGuide = parseGuideUrl(
      `${window.location.pathname}${window.location.search}`,
    );
    const returnToGuide =
      rawGuide.kind === "guide" && rawGuide.route.projectId !== null;
    router.push(returnToGuide ? guideHref("project-select") : "/");
  }

  function continueGuideAfterClosingSurface(
    step: "goal" | "members",
    projectId: string,
  ) {
    setMobileSurface(null);
    setGuideStep(step);
    setGuideActive(true);
    queueMicrotask(() => router.push(guideHref(step, projectId)));
  }

  const rawGuideRoute =
    typeof window === "undefined"
      ? null
      : parseGuideUrl(`${window.location.pathname}${window.location.search}`);
  const guideProjectRecovery =
    rawGuideRoute?.kind === "guide" && rawGuideRoute.route.projectId !== null;
  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;

  return (
    <main
      className="collaboration-cockpit"
      data-testid="collaboration-cockpit"
      ref={cockpitRef}
    >
      <h1 className="sr-only">协作工作台</h1>
      <ProjectNotificationPoller projectId={currentProjectId} />
      <ActivityBar activePath={pathname ?? "/"} returnTo={settingsReturnTo} />
      <header className="mobile-toolbar">
        <div
          aria-label="驾驶舱面板"
          className="mobile-toolbar-controls"
          ref={toolbarRef}
          role="toolbar"
        >
          <button
            aria-controls="project-navigation-drawer"
            aria-expanded={mobileSurface === "projects"}
            aria-label={
              mobileSurface === "projects" ? "隐藏项目导航" : "打开项目导航"
            }
            className="button-secondary icon-button"
            onClick={() =>
              setMobileSurface((current) =>
                current === "projects" ? null : "projects",
              )
            }
            ref={projectToggleRef}
            type="button"
          >
            <Folder aria-hidden="true" size={20} weight="regular" />
            <span className="sr-only">项目</span>
          </button>
          <button
            aria-controls="task-editor-surface"
            aria-expanded={mobileSurface === "editor"}
            aria-label={mobileSurface === "editor" ? "隐藏编辑" : "打开编辑"}
            className="button-secondary icon-button"
            onClick={() =>
              setMobileSurface((current) =>
                current === "editor" ? null : "editor",
              )
            }
            ref={editorToggleRef}
            type="button"
          >
            <PencilSimple aria-hidden="true" size={20} weight="regular" />
            <span className="sr-only">编辑</span>
          </button>
          <button
            aria-controls="task-context-drawer"
            aria-expanded={mobileSurface === "context"}
            aria-label={
              mobileSurface === "context"
                ? "隐藏当前任务上下文"
                : "打开当前任务上下文"
            }
            className="button-secondary icon-button"
            onClick={() =>
              setMobileSurface((current) =>
                current === "context" ? null : "context",
              )
            }
            ref={contextToggleRef}
            type="button"
          >
            <SidebarSimple aria-hidden="true" size={20} weight="regular" />
            <span className="sr-only">上下文</span>
          </button>
          {routeProjectError && narrow ? (
            <button
              className="button-secondary"
              onClick={projectRecovery}
              type="button"
            >
              {guideProjectRecovery ? "返回项目选择" : "返回项目列表"}
            </button>
          ) : null}
        </div>
      </header>
      {projectLoadError && narrow ? (
        <section className="narrow-project-load-error stack state-message">
          <p className="error-text" role="alert">
            {projectLoadError}
          </p>
          <button
            className="button-secondary"
            onClick={() => setReloadKey((current) => current + 1)}
            type="button"
          >
            重试加载项目
          </button>
        </section>
      ) : null}

      <aside
        aria-label={narrow ? undefined : "项目导航"}
        aria-labelledby={narrow ? "project-navigation-label" : undefined}
        aria-modal={
          narrow &&
          mobileSurface === "projects" &&
          !workspaceConfirmationOpen &&
          !threadDialogOpen
            ? "true"
            : undefined
        }
        className="cockpit-sidebar"
        data-open={mobileSurface === "projects"}
        data-testid="project-surface"
        hidden={narrow && mobileSurface !== "projects"}
        id="project-navigation-drawer"
        ref={projectSurfaceRef}
        role={
          narrow &&
          mobileSurface === "projects" &&
          !workspaceConfirmationOpen &&
          !threadDialogOpen
            ? "dialog"
            : undefined
        }
      >
        <span className="sr-only" id="project-navigation-label">
          项目导航
        </span>
        <button
          aria-label="关闭项目导航"
          className="drawer-close button-ghost icon-button"
          onClick={closeProjectNavigation}
          ref={projectCloseRef}
          tabIndex={narrow && mobileSurface === "projects" ? 0 : -1}
          type="button"
        >
          <X aria-hidden="true" size={20} weight="regular" />
        </button>
        <div className="product-identity">
          <span aria-hidden="true" className="product-mark">
            C
          </span>
          <span className="sr-only">Cool AI</span>
        </div>

        <section aria-labelledby="projects-title" className="stack">
          <header className="panel-heading">
            <h2 className="surface-heading" id="projects-title">
              项目
            </h2>
            <IconButton
              className="button-primary"
              icon={<FolderPlus size={20} weight="regular" />}
              label="打开文件夹"
              onClick={openFolderDialog}
            />
            <HelpTip label="如何打开项目">
              打开本机文件夹即进入或恢复该协作项目。也可不选项目，直接在中间与一名 Agent 对话。
            </HelpTip>
          </header>
          {formError && !folderDialogOpen ? (
            <p className="error-text" id="project-folder-path-error" role="alert">
              {formError}
            </p>
          ) : null}
          {projectCreateNotice ? (
            <p className="onboarding-guide-success" role="status">
              {projectCreateNotice}
            </p>
          ) : null}
          {isLoading ? (
            <p aria-busy="true" className="muted">
              正在加载项目…
            </p>
          ) : projectLoadError ? (
            <div className="stack">
              <p className="error-text" role="alert">
                {projectLoadError}
              </p>
              <button onClick={() => setReloadKey((current) => current + 1)} type="button">
                重试加载项目
              </button>
            </div>
          ) : projects.length === 0 ? (
            <div className="empty-guide state-message">
              <p>暂无文件夹项目。</p>
              <HelpTip label="没有项目时还能做什么">
                打开本地文件夹开始协作，也可直接在中间与 Agent 对话。
              </HelpTip>
            </div>
          ) : (
            <>
              {routeProjectError && !narrow ? (
                <div className="empty-guide">
                  <p className="error-text" role="alert">
                    {routeProjectError}
                  </p>
                  <button
                    className="button-secondary"
                    onClick={projectRecovery}
                    type="button"
                  >
                    {guideProjectRecovery ? "返回项目选择" : "返回项目列表"}
                  </button>
                </div>
              ) : null}
              <nav aria-label="项目">
                <ul className="project-list">
                  {projects.map((project) => (
                    <li key={project.id}>
                      <button
                        aria-current={project.id === currentProjectId ? "page" : undefined}
                        className="nav-item"
                        onClick={() => {
                          router.push(`/projects/${project.id}`);
                          if (mobileSurface === "projects")
                            closeProjectNavigation();
                        }}
                        type="button"
                      >
                        {project.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            </>
          )}
        </section>
        {currentProject &&
        pathname?.startsWith(
          `/projects/${encodeURIComponent(currentProject.id)}`,
        ) ? (
          <ProjectThreadNavigation
            backgroundRef={cockpitRef}
            onDialogChange={setThreadDialogOpen}
            onNavigate={updateSettingsReturnTo}
            onStateChange={setThreadListState}
            projectId={currentProject.id}
          />
        ) : pathname === "/" && homeState?.kind === "ready" ? (
          <ProjectThreadNavigation
            backgroundRef={cockpitRef}
            directMode
            onDialogChange={setThreadDialogOpen}
            onNavigate={updateSettingsReturnTo}
            onStateChange={setThreadListState}
            projectId={homeState.project.id}
          />
        ) : null}
        {currentProject ? (
          <ProjectSetupPanel
            onGuideContinue={(step) =>
              continueGuideAfterClosingSurface(
                step === "workspace" ? "members" : "goal",
                currentProject.id,
              )
            }
            onGuideSkip={(step) =>
              continueGuideAfterClosingSurface(
                step === "workspace" ? "members" : "goal",
                currentProject.id,
              )
            }
            onWorkspaceConfirmationChange={setWorkspaceConfirmationOpen}
            projectId={currentProject.id}
            showMembersGuide={guideStep === "members"}
            showWorkspaceGuide={guideStep === "workspace"}
          />
        ) : null}
      </aside>
      <TaskPanel
        contextCloseRef={contextCloseRef}
        contextOpen={mobileSurface === "context"}
        contextSurfaceRef={contextSurfaceRef}
        currentProjectName={currentProject?.name ?? null}
        currentProjectTitleRef={currentProjectTitleRef}
        editorCloseRef={editorCloseRef}
        editorOpen={mobileSurface === "editor"}
        editorSurfaceRef={editorSurfaceRef}
        narrow={narrow}
        onboarding={
          guideStep === "project-select" || guideStep === "goal"
            ? {
                onCreateProject: guideToProjectSelection,
                onSkip:
                  guideStep === "goal" && currentProjectId
                    ? () => {
                        setMobileSurface(null);
                        queueMicrotask(() =>
                          router.push(
                            `/projects/${encodeURIComponent(currentProjectId)}`,
                          ),
                        );
                      }
                    : undefined,
                onSelectProject: (projectId) => {
                  setGuideStep(null);
                  setGuideActive(true);
                  router.push(guideHref("workspace", projectId));
                },
                projects,
                step: guideStep,
              }
            : null
        }
        onCloseContext={closeTaskContext}
        onCloseEditor={closeMobileSurface}
        onHomeStateChange={updateHomeState}
        onSelectProject={guideToProjectSelection}
        projectError={projectLoadError ?? routeProjectError}
        projectId={currentProjectId}
        projectLoading={isLoading}
        threadListState={threadListState}
        legacyTasksEnabled={!guideActive}
      />
      <ActionDialog
        closeLabel="关闭打开文件夹"
        initialFocusRef={projectFolderPathInputRef}
        onClose={() => setFolderDialogOpen(false)}
        open={folderDialogOpen}
        title="打开文件夹"
        titleId="open-folder-title"
      >
        <form className="stack" onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="project-folder-path">文件夹路径</label>
            <input
              aria-describedby={formError ? "project-folder-path-error" : undefined}
              aria-invalid={formError ? "true" : undefined}
              id="project-folder-path"
              name="path"
              onChange={(event) => setFolderPath(event.target.value)}
              placeholder="例如：D:\work\my-app"
              ref={projectFolderPathInputRef}
              value={folderPath}
            />
          </div>
          {formError ? (
            <p className="error-text" id="project-folder-path-error" role="alert">
              {formError}
            </p>
          ) : null}
          <button className="button-primary" disabled={isSubmitting} type="submit">
            {isSubmitting ? "正在打开…" : "打开文件夹"}
          </button>
        </form>
      </ActionDialog>
    </main>
  );
}
