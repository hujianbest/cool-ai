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
import { useRouter } from "next/navigation";
import { z } from "zod";

import {
  type TargetRequest,
  useTargetRequestGuard,
} from "@/components/collaboration/use-target-request-guard";
import { useModalSurface } from "@/components/mobile-dialog";
import { parseProjectSelection } from "@/components/settings-navigation";
import {
  ApiDisplayError,
  apiErrorCopy,
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";
import type { ApiError } from "@/src/shared/contracts";
import type {
  MembershipState,
  ProjectMember,
} from "@/src/shared/project-context-contracts";

type ThreadListState = "loading" | "empty" | "ready" | "error";

type ProjectThreadNavigationProps = {
  backgroundRef: RefObject<HTMLElement | null>;
  onDialogChange?: (open: boolean) => void;
  onNavigate?: (href: string) => void;
  onStateChange?: (state: ThreadListState) => void;
  projectId: string;
};

const resourceId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/);
const positiveInteger = z.number().int().positive().safe();
const nonnegativeInteger = z.number().int().nonnegative().safe();
const availability = z.enum(["ready", "repair_required"]);
const policyMemberSchema = z
  .object({
    agentId: resourceId,
    displayNameSnapshot: z.string().min(1),
    live: z.enum(["current", "removed"]),
    position: nonnegativeInteger,
  })
  .strict();
const policySchema = z
  .object({
    availability,
    createdAt: z.string().min(1),
    members: z.array(policyMemberSchema).min(2).max(100),
    revisionId: resourceId,
    unavailableMemberIds: z.array(resourceId),
    version: positiveInteger,
  })
  .strict();
const threadSummarySchema = z
  .object({
    availability,
    createdAt: z.string().min(1),
    id: resourceId,
    lastActivitySequence: positiveInteger,
    policyVersion: positiveInteger,
    projectId: resourceId,
    title: z.string().min(1),
    updatedAt: z.string().min(1),
    version: positiveInteger,
  })
  .strict();
const threadDetailSchema = threadSummarySchema
  .extend({ policy: policySchema })
  .strict();
const threadCreatedFactSchema = z
  .object({
    activitySequence: positiveInteger,
    actorId: z.null(),
    actorType: z.literal("owner"),
    createdAt: z.string().min(1),
    id: resourceId,
    message: z.null(),
    messageId: z.null(),
    payload: z.object({ title: z.string().min(1) }).strict(),
    policyRevisionId: z.null(),
    projectId: resourceId,
    runEventId: z.null(),
    runId: z.null(),
    sequence: positiveInteger,
    threadId: resourceId,
    type: z.literal("thread_created"),
  })
  .strict();
const threadCreateResponseSchema = z
  .object({
    created: z.literal(true),
    fact: threadCreatedFactSchema,
    thread: threadDetailSchema,
  })
  .strict();
const threadListResponseSchema = z
  .object({
    nextCursor: z.string().min(1).nullable(),
    threads: z.array(threadSummarySchema),
  })
  .strict();
const operationLookupSchema = z
  .object({
    httpStatus: z.number().int().min(100).max(599).nullable(),
    kind: z.enum([
      "thread_create",
      "policy_update",
      "start",
      "message",
      "control",
      "answer_decision",
      "advance",
      "recover",
    ]),
    operationId: z.string().uuid(),
    response: z.unknown().nullable(),
    status: z.enum(["pending", "completed"]),
  })
  .strict();

type ThreadSummary = z.infer<typeof threadSummarySchema>;
type ThreadCreateResponse = z.infer<typeof threadCreateResponseSchema>;

function canonicalThreadHref(projectId: string, threadId: string): string {
  return `/projects/${encodeURIComponent(projectId)}?thread=${encodeURIComponent(threadId)}`;
}

function canonicalProjectHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

function selectedThreadFromUrl(projectId: string): string | null {
  const selection = parseProjectSelection(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
  return selection?.projectId === projectId ? selection.threadId : null;
}

function compareThreads(left: ThreadSummary, right: ThreadSummary): number {
  return (
    right.lastActivitySequence - left.lastActivitySequence ||
    left.id.localeCompare(right.id)
  );
}

function assertThreadPage(
  payload: unknown,
  projectId: string,
  seenIds: Set<string>,
): z.infer<typeof threadListResponseSchema> {
  const parsed = threadListResponseSchema.parse(payload);
  for (const thread of parsed.threads) {
    if (thread.projectId !== projectId || seenIds.has(thread.id)) {
      throw new Error("invalid_thread_tuple");
    }
    seenIds.add(thread.id);
  }
  for (let index = 1; index < parsed.threads.length; index += 1) {
    if (compareThreads(parsed.threads[index - 1]!, parsed.threads[index]!) > 0) {
      throw new Error("invalid_thread_order");
    }
  }
  return parsed;
}

async function readError(response: Response): Promise<string> {
  try {
    return apiErrorCopy((await response.json()) as ApiError);
  } catch {
    return "请求失败，请稍后重试。";
  }
}

function countGraphemes(value: string): number {
  return Array.from(
    new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(value),
  ).length;
}

function currentMembers(payload: unknown): ProjectMember[] {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).some((key) => key !== "members" && key !== "projectVersion")
  ) {
    throw new Error("invalid_members");
  }
  const candidate = payload as Partial<MembershipState>;
  if (!Array.isArray(candidate.members) || !Number.isSafeInteger(candidate.projectVersion)) {
    throw new Error("invalid_members");
  }
  return candidate.members.filter(
    (member): member is ProjectMember =>
      Boolean(
        member &&
          typeof member.agentId === "string" &&
          typeof member.name === "string" &&
          member.agentId.length > 0 &&
          member.name.length > 0,
      ),
  );
}

export function ProjectThreadNavigation({
  backgroundRef,
  onDialogChange,
  onNavigate,
  onStateChange,
  projectId,
}: ProjectThreadNavigationProps) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [listState, setListState] = useState<ThreadListState>("loading");
  const [listError, setListError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [locationVersion, setLocationVersion] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [membersReloadKey, setMembersReloadKey] = useState(0);
  const [title, setTitle] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createNotice, setCreateNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [focusThreadId, setFocusThreadId] = useState<string | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const threadButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const targetGuard = useTargetRequestGuard(`${projectId}||`);

  const closeDialog = useCallback(() => {
    if (isSubmitting) return;
    setDialogOpen(false);
  }, [isSubmitting]);
  const modalOptions = useMemo(
    () => ({
      active: dialogOpen,
      dialogRef,
      hideBackground: true,
      inertRootRefs: [backgroundRef],
      initialFocusRef: titleInputRef,
      onClose: closeDialog,
      restoreFocusRef: createButtonRef,
    }),
    [backgroundRef, closeDialog, dialogOpen],
  );
  useModalSurface(modalOptions);

  useEffect(() => {
    onDialogChange?.(dialogOpen);
  }, [dialogOpen, onDialogChange]);

  useEffect(() => {
    onStateChange?.(listState);
  }, [listState, onStateChange]);

  useEffect(() => {
    const updateLocation = () => setLocationVersion((current) => current + 1);
    window.addEventListener("popstate", updateLocation);
    return () => window.removeEventListener("popstate", updateLocation);
  }, []);

  const loadThreads = useCallback(async (
    signal?: AbortSignal,
  ): Promise<ThreadSummary[]> => {
    const collected: ThreadSummary[] = [];
    const seenIds = new Set<string>();
    let cursor: string | null = null;
    do {
      const suffix = cursor
        ? `?limit=100&cursor=${encodeURIComponent(cursor)}`
        : "?limit=100";
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads${suffix}`,
        { signal },
      );
      if (!response.ok) throw new ApiDisplayError(await readError(response));
      const page = assertThreadPage(await response.json(), projectId, seenIds);
      collected.push(...page.threads);
      cursor = page.nextCursor;
    } while (cursor);
    for (let index = 1; index < collected.length; index += 1) {
      if (compareThreads(collected[index - 1]!, collected[index]!) > 0) {
        throw new Error("invalid_thread_order");
      }
    }
    return collected;
  }, [projectId]);

  useEffect(() => {
    const request = targetGuard.capture();
    setListState("loading");
    setListError(null);
    setThreads([]);
    setCreateNotice(null);
    setDialogOpen(false);
    setMembers([]);
    setMembersLoading(false);
    setMembersError(null);
    setTitle("");
    setSelectedMemberIds([]);
    setTitleError(null);
    setMemberError(null);
    setCreateError(null);
    setIsSubmitting(false);
    setFocusThreadId(null);
    threadButtonRefs.current.clear();
    void loadThreads(request.signal)
      .then((loaded) => {
        if (!request.isCurrent()) return;
        setThreads(loaded);
        setListState(loaded.length === 0 ? "empty" : "ready");
        const selectedThreadId = selectedThreadFromUrl(projectId);
        if (
          loaded.length > 0 &&
          (!selectedThreadId ||
            !loaded.some((thread) => thread.id === selectedThreadId))
        ) {
          const href = canonicalThreadHref(projectId, loaded[0]!.id);
          onNavigate?.(href);
          routerRef.current.replace(href);
        } else if (loaded.length === 0 && selectedThreadId) {
          const href = canonicalProjectHref(projectId);
          onNavigate?.(href);
          routerRef.current.replace(href);
        }
      })
      .catch((cause: unknown) => {
        if (!request.isCurrent()) return;
        setListState("error");
        setListError(
          caughtApiErrorCopy(
            cause,
            "无法加载项目线程，请重试；不会保留无效选择。",
          ),
        );
      });
  }, [loadThreads, onNavigate, projectId, reloadKey, targetGuard]);

  useEffect(() => {
    if (!focusThreadId) return;
    const selected = selectedThreadFromUrl(projectId);
    if (selected !== focusThreadId) return;
    threadButtonRefs.current.get(focusThreadId)?.focus();
    setFocusThreadId(null);
  }, [focusThreadId, locationVersion, projectId, threads]);

  useEffect(() => {
    if (listState !== "ready" || threads.length === 0) return;
    const selectedThreadId = selectedThreadFromUrl(projectId);
    if (!selectedThreadId || !threads.some((thread) => thread.id === selectedThreadId)) {
      const href = canonicalThreadHref(projectId, threads[0]!.id);
      onNavigate?.(href);
      routerRef.current.replace(href);
    }
  }, [listState, locationVersion, onNavigate, projectId, threads]);

  useEffect(() => {
    if (!dialogOpen) return;
    const request = targetGuard.capture();
    setMembersLoading(true);
    setMembersError(null);
    setMembers([]);
    setSelectedMemberIds([]);
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
      signal: request.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new ApiDisplayError(await readError(response));
        return currentMembers(await response.json());
      })
      .then((loaded) => {
        if (request.isCurrent()) setMembers(loaded);
      })
      .catch((cause: unknown) => {
        if (request.isCurrent()) {
          setMembersError(
            caughtApiErrorCopy(cause, "无法加载当前项目成员，请重试。"),
          );
        }
      })
      .finally(() => {
        if (request.isCurrent()) setMembersLoading(false);
      });
  }, [dialogOpen, membersReloadKey, projectId, targetGuard]);

  function openDialog() {
    setTitle("");
    setTitleError(null);
    setMemberError(null);
    setCreateError(null);
    setDialogOpen(true);
  }

  function chooseThread(threadId: string) {
    setCreateNotice(null);
    setFocusThreadId(threadId);
    const href = canonicalThreadHref(projectId, threadId);
    onNavigate?.(href);
    routerRef.current.push(href);
  }

  function finishCreatedThread(
    created: ThreadCreateResponse,
    reconciled: boolean,
  ) {
    if (
      created.thread.projectId !== projectId ||
      created.fact.projectId !== projectId ||
      created.fact.threadId !== created.thread.id ||
      created.fact.payload.title !== created.thread.title
    ) {
      throw new Error("invalid_created_tuple");
    }
    setThreads((current) =>
      [
        created.thread,
        ...current.filter((thread) => thread.id !== created.thread.id),
      ].sort(compareThreads),
    );
    setListState("ready");
    setDialogOpen(false);
    setCreateNotice(
      reconciled
        ? `已通过操作核对确认线程“${created.thread.title}”已创建。`
        : `线程“${created.thread.title}”已创建。`,
    );
    setFocusThreadId(created.thread.id);
    const href = canonicalThreadHref(projectId, created.thread.id);
    onNavigate?.(href);
    routerRef.current.push(href);
  }

  async function reconcileUnknownCreate(
    operationId: string,
    previousIds: Set<string>,
    request: TargetRequest,
  ): Promise<boolean> {
    try {
      const refreshed = await loadThreads(request.signal);
      if (!request.isCurrent()) return false;
      const candidates = refreshed.filter((thread) => !previousIds.has(thread.id));
      const matches: ThreadCreateResponse[] = [];
      for (const candidate of candidates) {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(
            candidate.id,
          )}/operations/${encodeURIComponent(operationId)}`,
          { signal: request.signal },
        );
        if (!request.isCurrent()) return false;
        if (!response.ok) continue;
        const lookup = operationLookupSchema.parse(await response.json());
        if (
          lookup.operationId !== operationId ||
          lookup.kind !== "thread_create" ||
          lookup.status !== "completed" ||
          lookup.httpStatus !== 201
        ) {
          continue;
        }
        const created = threadCreateResponseSchema.parse(lookup.response);
        if (created.thread.id === candidate.id) matches.push(created);
      }
      if (!request.isCurrent()) return false;
      setThreads(refreshed);
      setListState(refreshed.length === 0 ? "empty" : "ready");
      if (matches.length === 1) {
        finishCreatedThread(matches[0]!, true);
        return true;
      }
      setCreateError(
        "创建结果未知，无法唯一确认已创建的线程。请核对线程列表后再决定是否重试；不会自动重发。",
      );
      return false;
    } catch {
      setCreateError(
        "创建结果未知，且操作核对失败。请稍后核对线程列表；不会自动重发。",
      );
      return false;
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    const graphemeCount = countGraphemes(normalizedTitle);
    const nextTitleError =
      graphemeCount === 0
        ? "请输入线程标题。"
        : graphemeCount > 80
          ? "线程标题不能超过 80 个字符。"
          : null;
    const uniqueMemberIds = Array.from(new Set(selectedMemberIds));
    const nextMemberError =
      uniqueMemberIds.length < 2 ? "请明确选择至少 2 名当前项目成员。" : null;
    setTitleError(nextTitleError);
    setMemberError(nextMemberError);
    setCreateError(null);
    if (nextTitleError || nextMemberError) return;

    const operationId = crypto.randomUUID();
    const request = targetGuard.capture();
    const previousIds = new Set(threads.map((thread) => thread.id));
    setIsSubmitting(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads`,
        {
          body: JSON.stringify({
            memberAgentIds: uniqueMemberIds,
            operationId,
            title: normalizedTitle,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: request.signal,
        },
      );
      if (!request.isCurrent()) return;
      if (!response.ok) {
        throw new ApiDisplayError(await readError(response));
      }
      let created: ThreadCreateResponse;
      try {
        created = threadCreateResponseSchema.parse(await response.json());
      } catch {
        await reconcileUnknownCreate(operationId, previousIds, request);
        return;
      }
      if (!request.isCurrent()) return;
      finishCreatedThread(created, false);
    } catch (cause: unknown) {
      if (!request.isCurrent()) return;
      if (cause instanceof ApiDisplayError) {
        setCreateError(
          caughtApiErrorCopy(cause, "无法创建线程，请检查输入后重试。"),
        );
      } else {
        await reconcileUnknownCreate(operationId, previousIds, request);
      }
    } finally {
      if (request.isCurrent()) setIsSubmitting(false);
    }
  }

  const selectedThreadId =
    typeof window === "undefined" ? null : selectedThreadFromUrl(projectId);
  const submitReason = membersLoading
    ? "正在加载当前项目成员。"
    : membersError
      ? "当前项目成员加载失败，请先重试。"
      : selectedMemberIds.length < 2
        ? "至少选择 2 名当前项目成员后才能创建。"
        : isSubmitting
          ? "创建请求处理中，表单暂不可用。"
          : null;

  return (
    <>
      <section aria-labelledby="project-threads-title" className="stack">
        <div className="section-heading-row">
          <h2 className="surface-heading" id="project-threads-title">
            线程
          </h2>
          {listState !== "empty" ? (
            <button
              className="button-secondary"
              onClick={openDialog}
              ref={createButtonRef}
              type="button"
            >
              创建线程
            </button>
          ) : null}
        </div>
        <nav
          aria-busy={listState === "loading" ? "true" : undefined}
          aria-label="项目线程"
        >
          {listState === "loading" ? (
            <p className="muted" role="status">
              正在加载线程…
            </p>
          ) : listState === "error" ? (
            <div className="stack state-message">
              <p className="error-text" role="alert">
                {listError}
              </p>
              <button
                className="button-secondary"
                onClick={() => setReloadKey((current) => current + 1)}
                type="button"
              >
                重试加载线程
              </button>
            </div>
          ) : listState === "empty" ? (
            <div className="empty-guide state-message">
              <p>暂无线程。创建线程后开始协作。</p>
              <button
                className="button-primary"
                onClick={openDialog}
                ref={createButtonRef}
                type="button"
              >
                创建线程
              </button>
            </div>
          ) : (
            <ul className="project-list">
              {threads.map((thread) => (
                <li key={thread.id}>
                  <button
                    aria-current={
                      thread.id === selectedThreadId ? "page" : undefined
                    }
                    className="nav-item"
                    data-thread-id={thread.id}
                    onClick={() => chooseThread(thread.id)}
                    ref={(element) => {
                      if (element) threadButtonRefs.current.set(thread.id, element);
                      else threadButtonRefs.current.delete(thread.id);
                    }}
                    type="button"
                  >
                    {thread.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
        {createNotice ? (
          <p aria-atomic="true" aria-live="polite" role="status">
            {createNotice}
          </p>
        ) : null}
      </section>
      {dialogOpen && typeof document !== "undefined"
        ? createPortal(
            <section
              aria-labelledby="create-thread-title"
              aria-modal="true"
              className="modal-surface thread-create-dialog"
              ref={dialogRef}
              role="dialog"
            >
              <div className="section-heading-row">
                <h2 id="create-thread-title">创建线程</h2>
                <button
                  aria-label="关闭创建线程"
                  className="button-ghost"
                  disabled={isSubmitting}
                  onKeyDown={(event) => {
                    if (event.key === "Tab" && event.shiftKey) {
                      event.preventDefault();
                      dialogRef.current
                        ?.querySelector<HTMLButtonElement>(
                          '[data-thread-dialog-last="true"]',
                        )
                        ?.focus();
                    }
                  }}
                  onClick={closeDialog}
                  type="button"
                >
                  关闭
                </button>
              </div>
              <form className="stack" onSubmit={handleCreate}>
                <div className="form-field">
                  <label htmlFor="thread-title">线程标题</label>
                  <input
                    aria-describedby={
                      titleError ? "thread-title-error" : "thread-title-help"
                    }
                    aria-invalid={titleError ? "true" : undefined}
                    aria-required="true"
                    disabled={isSubmitting}
                    id="thread-title"
                    maxLength={160}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="例如：发布计划评审"
                    ref={titleInputRef}
                    value={title}
                  />
                  <p className="muted" id="thread-title-help">
                    最多 80 个字符。
                  </p>
                  {titleError ? (
                    <p className="error-text" id="thread-title-error" role="alert">
                      {titleError}
                    </p>
                  ) : null}
                </div>
                <fieldset
                  aria-busy={membersLoading ? "true" : undefined}
                  className="stack"
                  disabled={isSubmitting || membersLoading}
                >
                  <legend>当前策略成员</legend>
                  {membersLoading ? (
                    <p className="muted" role="status">
                      正在加载当前项目成员…
                    </p>
                  ) : membersError ? (
                    <div className="stack">
                      <p className="error-text" role="alert">
                        {membersError}
                      </p>
                      <button
                        className="button-secondary"
                        onClick={() =>
                          setMembersReloadKey((current) => current + 1)
                        }
                        type="button"
                      >
                        重试加载成员
                      </button>
                    </div>
                  ) : members.length === 0 ? (
                    <p className="muted">当前项目没有可选成员。</p>
                  ) : (
                    members.map((member) => (
                      <label className="check-row" key={member.agentId}>
                        <input
                          checked={selectedMemberIds.includes(member.agentId)}
                          onChange={(event) =>
                            setSelectedMemberIds((current) =>
                              event.target.checked
                                ? [...current, member.agentId]
                                : current.filter((id) => id !== member.agentId),
                            )
                          }
                          type="checkbox"
                          value={member.agentId}
                        />
                        <span>{member.name}</span>
                      </label>
                    ))
                  )}
                  {memberError ? (
                    <p className="error-text" id="thread-members-error" role="alert">
                      {memberError}
                    </p>
                  ) : null}
                </fieldset>
                {createError ? (
                  <p className="error-text" role="alert">
                    {createError}
                  </p>
                ) : null}
                {submitReason ? (
                  <p className="muted" id="thread-submit-reason">
                    {submitReason}
                  </p>
                ) : null}
                <div className="form-row">
                  <button
                    className="button-primary"
                    aria-describedby={
                      submitReason ? "thread-submit-reason" : undefined
                    }
                    disabled={Boolean(submitReason)}
                    type="submit"
                  >
                    {isSubmitting ? "正在创建线程…" : "创建线程"}
                  </button>
                  <button
                    className="button-secondary"
                    data-thread-dialog-last="true"
                    disabled={isSubmitting}
                    onKeyDown={(event) => {
                      if (event.key === "Tab" && !event.shiftKey) {
                        event.preventDefault();
                        dialogRef.current
                          ?.querySelector<HTMLButtonElement>(
                            '[aria-label="关闭创建线程"]',
                          )
                          ?.focus();
                      }
                    }}
                    onClick={closeDialog}
                    type="button"
                  >
                    取消
                  </button>
                </div>
              </form>
            </section>,
            document.body,
          )
        : null}
    </>
  );
}
