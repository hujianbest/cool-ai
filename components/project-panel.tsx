"use client";

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
import { ProjectSetupPanel } from "@/components/project-context/project-setup-panel";
import { TaskPanel } from "@/components/task-panel";
import {
  ApiDisplayError,
  apiErrorCopy,
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";
import type { ApiError, Project } from "@/src/shared/contracts";

async function errorMessage(response: Response): Promise<string> {
  const payload = (await response.json()) as ApiError;
  return apiErrorCopy(payload);
}

export function ProjectPanel() {
  const pathname = usePathname();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [routeProjectError, setRouteProjectError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [focusCreatedProjectId, setFocusCreatedProjectId] = useState<string | null>(null);
  const [mobileSurface, setMobileSurface] = useState<
    "projects" | "context" | "editor" | null
  >(null);
  const [workspaceConfirmationOpen, setWorkspaceConfirmationOpen] =
    useState(false);
  const narrow = useNarrowMode();
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
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const closeMobileSurface = useCallback(() => setMobileSurface(null), []);
  const projectModal = useMemo(
    () => ({
      active: narrow && mobileSurface === "projects",
      dialogRef: projectSurfaceRef,
      inertRootRefs: [toolbarRef, editorSurfaceRef, contextSurfaceRef],
      initialFocusRef: projectCloseRef,
      restoreFocusRef: projectToggleRef,
      onClose: closeMobileSurface,
    }),
    [closeMobileSurface, mobileSurface, narrow],
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
    let active = true;
    setIsLoading(true);
    setProjectLoadError(null);

    void fetch("/api/projects")
      .then(async (response) => {
        if (!response.ok) {
          throw new ApiDisplayError(await errorMessage(response));
        }
        return response.json() as Promise<{ projects: Project[] }>;
      })
      .then(({ projects: loadedProjects }) => {
        if (!active) return;
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
            setCurrentProjectId(loadedProjects[0]?.id ?? null);
          }
        } else {
          // SSR 首帧 pathname 为空，跳过路由同步，使用默认选中首个
          setRouteProjectError(null);
          setCurrentProjectId(loadedProjects[0]?.id ?? null);
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
      setCurrentProjectId(projects[0]?.id ?? null);
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

    if (!name.trim()) {
      setFormError("请输入项目名称。");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/projects", {
        body: JSON.stringify({ name }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new ApiDisplayError(await errorMessage(response));
      }
      const { project } = (await response.json()) as { project: Project };
      setProjects((current) => [...current, project]);
      // 使用 router.push 导航到新项目的 URL
      router.push(`/projects/${project.id}`);
      setFocusCreatedProjectId(project.id);
      setName("");
    } catch (cause) {
      setFormError(caughtApiErrorCopy(cause, "无法创建项目，请稍后重试。"));
    } finally {
      setIsSubmitting(false);
    }
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
      window.setTimeout(() => projectNameInputRef.current?.focus(), 0);
      return;
    }
    projectNameInputRef.current?.focus();
  }

  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;

  return (
    <main className="collaboration-cockpit" data-testid="collaboration-cockpit">
      <h1 className="sr-only">协作工作台</h1>
      <ActivityBar activePath={pathname ?? "/"} />
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
            className="button-secondary"
            onClick={() =>
              setMobileSurface((current) =>
                current === "projects" ? null : "projects",
              )
            }
            ref={projectToggleRef}
            type="button"
          >
            项目
          </button>
          <button
            aria-controls="task-editor-surface"
            aria-expanded={mobileSurface === "editor"}
            aria-label={mobileSurface === "editor" ? "隐藏编辑" : "打开编辑"}
            className="button-secondary"
            onClick={() =>
              setMobileSurface((current) =>
                current === "editor" ? null : "editor",
              )
            }
            ref={editorToggleRef}
            type="button"
          >
            编辑
          </button>
          <button
            aria-controls="task-context-drawer"
            aria-expanded={mobileSurface === "context"}
            aria-label={
              mobileSurface === "context"
                ? "隐藏当前任务上下文"
                : "打开当前任务上下文"
            }
            className="button-secondary"
            onClick={() =>
              setMobileSurface((current) =>
                current === "context" ? null : "context",
              )
            }
            ref={contextToggleRef}
            type="button"
          >
            上下文
          </button>
          {routeProjectError && narrow ? (
            <button
              className="button-secondary"
              onClick={() => router.push("/")}
              type="button"
            >
              返回项目列表
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
          !workspaceConfirmationOpen
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
          !workspaceConfirmationOpen
            ? "dialog"
            : undefined
        }
      >
        <span className="sr-only" id="project-navigation-label">
          项目导航
        </span>
        <button
          aria-label="关闭项目导航"
          className="drawer-close button-ghost"
          onClick={closeProjectNavigation}
          ref={projectCloseRef}
          tabIndex={narrow && mobileSurface === "projects" ? 0 : -1}
          type="button"
        >
          关闭
        </button>
        <div className="product-identity">
          <span aria-hidden="true" className="product-mark">
            C
          </span>
          <div>
            <p className="eyebrow">协作驾驶舱</p>
            <p className="surface-heading">Cool AI</p>
          </div>
        </div>

        <section aria-labelledby="projects-title" className="stack">
          <h2 className="surface-heading" id="projects-title">项目</h2>
          <form className="stack" onSubmit={handleSubmit}>
            <div className="form-field">
              <label htmlFor="project-name">项目名称</label>
              <input
                id="project-name"
                name="name"
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：官网改版"
                ref={projectNameInputRef}
                value={name}
              />
            </div>
            <button className="button-primary" disabled={isSubmitting} type="submit">
              {isSubmitting ? "正在创建项目…" : "创建项目"}
            </button>
          </form>
          {formError ? (
            <p className="error-text" role="alert">
              {formError}
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
              <p>暂无项目。创建项目开始使用协作驾驶舱。</p>
              <button
                className="button-primary"
                onClick={() => projectNameInputRef.current?.focus()}
                type="button"
              >
                创建项目
              </button>
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
                    onClick={() => router.push("/")}
                    type="button"
                  >
                    返回项目列表
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
        {currentProject ? (
          <ProjectSetupPanel
            onWorkspaceConfirmationChange={setWorkspaceConfirmationOpen}
            projectId={currentProject.id}
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
        onCloseContext={closeTaskContext}
        onCloseEditor={closeMobileSurface}
        onSelectProject={guideToProjectSelection}
        projectError={projectLoadError ?? routeProjectError}
        projectId={currentProjectId}
        projectLoading={isLoading}
      />
    </main>
  );
}
