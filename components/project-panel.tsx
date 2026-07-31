"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { useModalSurface, useNarrowMode } from "@/components/mobile-dialog";
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
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
        setCurrentProjectId(loadedProjects[0]?.id ?? null);
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
      setCurrentProjectId(project.id);
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

  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;

  return (
    <div className="collaboration-cockpit" data-testid="collaboration-cockpit">
      <div
        aria-label="驾驶舱面板"
        className="mobile-toolbar"
        ref={toolbarRef}
        role="toolbar"
      >
        <button
          aria-controls="project-navigation-drawer"
          aria-expanded={mobileSurface === "projects"}
          aria-label={
            mobileSurface === "projects" ? "隐藏项目导航" : "打开项目导航"
          }
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
      </div>

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
          className="drawer-close"
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
            <h1>Cool AI</h1>
          </div>
        </div>

        <nav aria-label="主导航">
          <ul className="project-list">
            <li>
              <a aria-current="page" href="/">
                工作
              </a>
            </li>
            <li>
              <a href="/team">团队</a>
            </li>
          </ul>
        </nav>

        <section aria-labelledby="projects-title" className="stack">
          <h2 id="projects-title">项目</h2>
          <form className="stack" onSubmit={handleSubmit}>
            <div className="form-field">
              <label htmlFor="project-name">项目名称</label>
              <input
                id="project-name"
                name="name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>
            <button disabled={isSubmitting} type="submit">
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
            <p className="muted">暂无项目。</p>
          ) : (
            <nav aria-label="项目">
              <ul className="project-list">
                {projects.map((project) => (
                  <li key={project.id}>
                    <button
                      aria-current={project.id === currentProjectId ? "page" : undefined}
                      onClick={() => {
                        setCurrentProjectId(project.id);
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
        projectError={projectLoadError}
        projectId={currentProjectId}
        projectLoading={isLoading}
      />
    </div>
  );
}
