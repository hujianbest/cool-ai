"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
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
import { HelpTip } from "@/components/ui/help-tip";
import { parseProjectSelection } from "@/components/settings-navigation";
import {
  ApiDisplayError,
  apiErrorCopy,
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";
import type { ApiError } from "@/src/shared/contracts";
import type {
  RecycleBinListResponseDto,
  ThreadDeleteResponse,
  ThreadPurgeResponse,
  ThreadRestoreResponse,
} from "@/src/shared/collaboration-contracts";
import type {
  MembershipState,
  ProjectMember,
} from "@/src/shared/project-context-contracts";
import {
  projectThreadSearchPageSchema,
  type ThreadSearchResultItemDto,
} from "@/src/shared/thread-search-contracts";

type ThreadListState = "loading" | "empty" | "ready" | "error";
type RecycleBinState = "loading" | "empty" | "ready" | "error";
type ThreadSearchState = "error" | "idle" | "loading";
type UrlThreadSelection =
  | { kind: "none"; threadId: null }
  | { kind: "invalid"; threadId: null }
  | { kind: "selected"; threadId: string };

type ProjectThreadNavigationProps = {
  backgroundRef: RefObject<HTMLElement | null>;
  directMode?: boolean;
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
    members: z.array(policyMemberSchema).min(1).max(100),
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
const threadTagRefSchema = z
  .object({
    id: resourceId,
    name: z.string().min(1),
  })
  .strict();
const threadListItemSchema = threadSummarySchema
  .extend({
    favoritedAt: z.string().min(1).nullable(),
    isFavorite: z.boolean(),
    tags: z.array(threadTagRefSchema),
  })
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
    threads: z.array(threadListItemSchema),
  })
  .strict();
const threadFavoriteSetResponseSchema = z
  .object({
    favoritedAt: z.string().min(1).nullable(),
    isFavorite: z.boolean(),
    projectId: resourceId,
    threadId: resourceId,
  })
  .strict();
const threadDeleteResponseSchema = z
  .object({
    deleted: z.boolean(),
    deletedAt: z.string().min(1),
    threadId: resourceId,
  })
  .strict();
const threadRestoreResponseSchema = z
  .object({
    restored: z.boolean(),
    threadId: resourceId,
  })
  .strict();
const threadPurgeResponseSchema = z
  .object({
    purged: z.literal(true),
    removedAttachmentCount: nonnegativeInteger,
    removedMessageCount: nonnegativeInteger,
    threadId: resourceId,
  })
  .strict();
const recycleBinItemSchema = z
  .object({
    attachmentCount: nonnegativeInteger,
    deletedAt: z.string().min(1),
    id: resourceId,
    messageCount: nonnegativeInteger,
    projectId: resourceId,
    title: z.string().min(1),
  })
  .strict();
const recycleBinResponseSchema = z
  .object({
    nextCursor: z.string().min(1).nullable(),
    threads: z.array(recycleBinItemSchema),
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

const threadTagSchema = z
  .object({
    createdAt: z.string().min(1),
    id: resourceId,
    name: z.string().min(1),
    projectId: resourceId,
  })
  .strict();
const threadTagListItemSchema = threadTagSchema
  .extend({ threadCount: nonnegativeInteger })
  .strict();
const threadTagListResponseSchema = z
  .object({ tags: z.array(threadTagListItemSchema) })
  .strict();
const threadTagCreateResponseSchema = z
  .object({ created: z.boolean(), tag: threadTagSchema })
  .strict();
const threadTagDeleteResponseSchema = z
  .object({ removedEdgeCount: nonnegativeInteger, tagId: resourceId })
  .strict();
const threadTagBatchResponseSchema = z
  .object({
    applied: z.array(
      z
        .object({
          addedTagIds: z.array(resourceId),
          removedTagIds: z.array(resourceId),
          threadId: resourceId,
        })
        .strict(),
    ),
    operationId: z.string().uuid(),
    replayed: z.boolean(),
  })
  .strict();

type ThreadSummary = z.infer<typeof threadSummarySchema>;
type ThreadListItem = z.infer<typeof threadListItemSchema>;
type ThreadListView = "all" | "favorites" | "recycle_bin";
type ThreadCreateResponse = z.infer<typeof threadCreateResponseSchema>;
type RecycleBinItem = z.infer<typeof recycleBinItemSchema>;
type ThreadTagListItem = z.infer<typeof threadTagListItemSchema>;
type TagListState = "error" | "loading" | "ready";
type BatchRequest = {
  addTagIds: string[];
  removeTagIds: string[];
  threadIds: string[];
};

const SEARCH_DEBOUNCE_MS = 300;
const THREAD_TAG_NAME_MAX_GRAPHEMES = 40;

function canonicalThreadHref(
  projectId: string,
  threadId: string,
  directMode = false,
): string {
  return directMode
    ? `/?thread=${encodeURIComponent(threadId)}`
    : `/projects/${encodeURIComponent(projectId)}?thread=${encodeURIComponent(threadId)}`;
}

function canonicalMessageHref(
  projectId: string,
  threadId: string,
  messageId: string | null,
  directMode = false,
): string {
  const base = canonicalThreadHref(projectId, threadId, directMode);
  return messageId ? `${base}&message=${encodeURIComponent(messageId)}` : base;
}

function readableTime(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(timestamp));
}

function threadSelectionFromUrl(
  projectId: string,
  directMode = false,
): UrlThreadSelection {
  const current = new URL(window.location.href);
  if (directMode) {
    const threadIds = current.searchParams.getAll("thread");
    return threadIds.length === 0
      ? { kind: "none", threadId: null }
      : threadIds.length === 1 && threadIds[0]?.length
        ? { kind: "selected", threadId: threadIds[0] }
        : { kind: "invalid", threadId: null };
  }
  if (
    current.searchParams.getAll("guide").length === 1 &&
    current.searchParams.get("guide") === "goal"
  ) {
    current.searchParams.delete("guide");
  }
  const selection = parseProjectSelection(
    `${current.pathname}${current.search}${current.hash}`,
  );
  if (selection?.projectId === projectId && selection.threadId) {
    return { kind: "selected", threadId: selection.threadId };
  }
  return current.searchParams.has("thread")
    ? { kind: "invalid", threadId: null }
    : { kind: "none", threadId: null };
}

function selectedThreadFromUrl(
  projectId: string,
  directMode = false,
): string | null {
  return threadSelectionFromUrl(projectId, directMode).threadId;
}

function compareThreads(left: ThreadSummary, right: ThreadSummary): number {
  return (
    right.lastActivitySequence - left.lastActivitySequence ||
    left.id.localeCompare(right.id)
  );
}

function compareFavorites(left: ThreadListItem, right: ThreadListItem): number {
  return (
    (right.favoritedAt ?? "").localeCompare(left.favoritedAt ?? "")
    || left.id.localeCompare(right.id)
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

function assertFavoritesPage(
  payload: unknown,
  projectId: string,
): z.infer<typeof threadListResponseSchema> {
  const parsed = threadListResponseSchema.parse(payload);
  if (parsed.nextCursor !== null) {
    throw new Error("invalid_favorites_page");
  }
  const seenIds = new Set<string>();
  for (const thread of parsed.threads) {
    if (thread.projectId !== projectId || seenIds.has(thread.id)) {
      throw new Error("invalid_thread_tuple");
    }
    if (!thread.isFavorite || thread.favoritedAt === null) {
      throw new Error("invalid_favorites_page");
    }
    seenIds.add(thread.id);
  }
  for (let index = 1; index < parsed.threads.length; index += 1) {
    if (compareFavorites(parsed.threads[index - 1]!, parsed.threads[index]!) > 0) {
      throw new Error("invalid_favorites_order");
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

async function readApiError(response: Response): Promise<ApiError | null> {
  try {
    return (await response.json()) as ApiError;
  } catch {
    return null;
  }
}

function countGraphemes(value: string): number {
  return Array.from(
    new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(value),
  ).length;
}

function toggleSetMember(
  set: ReadonlySet<string>,
  id: string,
): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function dropSetMember(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
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

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      height={20}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
      width={20}
    >
      <path d="M12 2.5l2.92 5.92 6.53.95-4.72 4.6 1.11 6.5L12 17.44l-5.84 3.07 1.11-6.5-4.72-4.6 6.53-.95L12 2.5z" />
    </svg>
  );
}

export function ProjectThreadNavigation({
  backgroundRef,
  directMode = false,
  onDialogChange,
  onNavigate,
  onStateChange,
  projectId,
}: ProjectThreadNavigationProps) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [listState, setListState] = useState<ThreadListState>("loading");
  const [listError, setListError] = useState<string | null>(null);
  const [recycleBinState, setRecycleBinState] = useState<RecycleBinState>("loading");
  const [recycleBinError, setRecycleBinError] = useState<string | null>(null);
  const [recycleBin, setRecycleBin] = useState<RecycleBinItem[]>([]);
  const [recycleBinNextCursor, setRecycleBinNextCursor] = useState<string | null>(null);
  const [recycleBinLoadingMore, setRecycleBinLoadingMore] = useState(false);
  const [recycleBinAlertByThread, setRecycleBinAlertByThread] = useState<
    Record<string, string>
  >({});
  const [recycleReloadKey, setRecycleReloadKey] = useState(0);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [view, setView] = useState<ThreadListView>("all");
  const [pendingFavoriteIds, setPendingFavoriteIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
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
  const [searchText, setSearchText] = useState("");
  const [searchState, setSearchState] = useState<ThreadSearchState>("idle");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchPage, setSearchPage] = useState<{
    nextCursor: string | null;
    query: string;
    results: ThreadSearchResultItemDto[];
  } | null>(null);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [searchLoadMoreError, setSearchLoadMoreError] = useState<string | null>(null);
  const [searchReloadKey, setSearchReloadKey] = useState(0);
  const searchEpochRef = useRef(0);
  const searchAreaRef = useRef<HTMLElement>(null);
  const searchActiveRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultRefs = useRef(new Map<number, HTMLButtonElement>());
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const threadButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const allViewTabRef = useRef<HTMLButtonElement>(null);
  const favoritesViewTabRef = useRef<HTMLButtonElement>(null);
  const recycleBinViewTabRef = useRef<HTMLButtonElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [tags, setTags] = useState<ThreadTagListItem[]>([]);
  const [tagsState, setTagsState] = useState<TagListState>("loading");
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [tagsReloadKey, setTagsReloadKey] = useState(0);
  const tagsProjectRef = useRef(projectId);
  const [activeTagId, setActiveTagId] = useState<string | null>(null);
  const activeTagIdRef = useRef(activeTagId);
  activeTagIdRef.current = activeTagId;
  const [manageOpen, setManageOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagError, setNewTagError] = useState<string | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  const [manageNotice, setManageNotice] = useState<string | null>(null);
  const [tagSearchText, setTagSearchText] = useState("");
  const [pendingDeleteTag, setPendingDeleteTag] = useState<ThreadTagListItem | null>(
    null,
  );
  const [deletingTag, setDeletingTag] = useState(false);
  const [deleteTagError, setDeleteTagError] = useState<string | null>(null);
  const [organizeMode, setOrganizeMode] = useState(false);
  const organizeActiveRef = useRef(false);
  organizeActiveRef.current = organizeMode;
  const [selectedThreadIds, setSelectedThreadIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [batchAddTagIds, setBatchAddTagIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [batchRemoveTagIds, setBatchRemoveTagIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [batchConfirm, setBatchConfirm] = useState<BatchRequest | null>(null);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [batchRetry, setBatchRetry] = useState<{
    addTagIds: string[];
    operationId: string;
    removeTagIds: string[];
    threadIds: string[];
  } | null>(null);
  const manageButtonRef = useRef<HTMLButtonElement>(null);
  const manageDialogRef = useRef<HTMLElement>(null);
  const newTagInputRef = useRef<HTMLInputElement>(null);
  const tagSearchInputRef = useRef<HTMLInputElement>(null);
  const confirmDialogRef = useRef<HTMLElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const organizeButtonRef = useRef<HTMLButtonElement>(null);
  const batchConfirmDialogRef = useRef<HTMLElement>(null);
  const batchConfirmApplyRef = useRef<HTMLButtonElement>(null);
  const [pendingDeleteThread, setPendingDeleteThread] = useState<ThreadListItem | null>(
    null,
  );
  const [deletingThread, setDeletingThread] = useState(false);
  const [deleteThreadError, setDeleteThreadError] = useState<string | null>(null);
  const deleteThreadDialogRef = useRef<HTMLElement>(null);
  const deleteThreadCancelRef = useRef<HTMLButtonElement>(null);
  const [pendingPurgeThread, setPendingPurgeThread] = useState<RecycleBinItem | null>(
    null,
  );
  const [purgingThread, setPurgingThread] = useState(false);
  const [purgeThreadError, setPurgeThreadError] = useState<string | null>(null);
  const purgeThreadDialogRef = useRef<HTMLElement>(null);
  const purgeThreadCancelRef = useRef<HTMLButtonElement>(null);
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

  const closeManageDialog = useCallback(() => {
    if (creatingTag) return;
    setManageOpen(false);
  }, [creatingTag]);
  const manageModalOptions = useMemo(
    () => ({
      active: manageOpen,
      dialogRef: manageDialogRef,
      hideBackground: true,
      inertRootRefs: [backgroundRef],
      initialFocusRef: newTagInputRef,
      onClose: closeManageDialog,
      restoreFocusRef: manageButtonRef,
    }),
    [backgroundRef, closeManageDialog, manageOpen],
  );
  useModalSurface(manageModalOptions);

  const closeDeleteConfirm = useCallback(() => {
    if (deletingTag) return;
    setPendingDeleteTag(null);
  }, [deletingTag]);
  const deleteConfirmModalOptions = useMemo(
    () => ({
      active: pendingDeleteTag !== null,
      dialogRef: confirmDialogRef,
      hideBackground: false,
      inertRootRefs: [backgroundRef],
      initialFocusRef: deleteCancelRef,
      onClose: closeDeleteConfirm,
      restoreFocusRef: tagSearchInputRef,
    }),
    [backgroundRef, closeDeleteConfirm, pendingDeleteTag],
  );
  useModalSurface(deleteConfirmModalOptions);

  const closeBatchConfirm = useCallback(() => {
    if (batchSubmitting) return;
    setBatchConfirm(null);
  }, [batchSubmitting]);
  const batchConfirmModalOptions = useMemo(
    () => ({
      active: batchConfirm !== null,
      dialogRef: batchConfirmDialogRef,
      hideBackground: true,
      inertRootRefs: [backgroundRef],
      initialFocusRef: batchConfirmApplyRef,
      onClose: closeBatchConfirm,
      restoreFocusRef: organizeButtonRef,
    }),
    [backgroundRef, batchConfirm, closeBatchConfirm],
  );
  useModalSurface(batchConfirmModalOptions);

  const closeDeleteThreadConfirm = useCallback(() => {
    if (deletingThread) return;
    setPendingDeleteThread(null);
  }, [deletingThread]);
  const deleteThreadModalOptions = useMemo(
    () => ({
      active: pendingDeleteThread !== null,
      dialogRef: deleteThreadDialogRef,
      hideBackground: false,
      inertRootRefs: [backgroundRef],
      initialFocusRef: deleteThreadCancelRef,
      onClose: closeDeleteThreadConfirm,
      restoreFocusRef: createButtonRef,
    }),
    [backgroundRef, closeDeleteThreadConfirm, pendingDeleteThread],
  );
  useModalSurface(deleteThreadModalOptions);

  const closePurgeThreadConfirm = useCallback(() => {
    if (purgingThread) return;
    setPendingPurgeThread(null);
  }, [purgingThread]);
  const purgeThreadModalOptions = useMemo(
    () => ({
      active: pendingPurgeThread !== null,
      dialogRef: purgeThreadDialogRef,
      hideBackground: false,
      inertRootRefs: [backgroundRef],
      initialFocusRef: purgeThreadCancelRef,
      onClose: closePurgeThreadConfirm,
      restoreFocusRef: recycleBinViewTabRef,
    }),
    [backgroundRef, closePurgeThreadConfirm, pendingPurgeThread],
  );
  useModalSurface(purgeThreadModalOptions);

  const anyDialogOpen =
    dialogOpen
    || manageOpen
    || pendingDeleteTag !== null
    || batchConfirm !== null
    || pendingDeleteThread !== null
    || pendingPurgeThread !== null;

  useEffect(() => {
    onDialogChange?.(anyDialogOpen);
  }, [anyDialogOpen, onDialogChange]);

  useEffect(() => {
    onStateChange?.(listState);
  }, [listState, onStateChange]);

  useEffect(() => {
    const updateLocation = () => setLocationVersion((current) => current + 1);
    window.addEventListener("popstate", updateLocation);
    return () => window.removeEventListener("popstate", updateLocation);
  }, []);

  const loadThreads = useCallback(async (
    view: ThreadListView,
    tagId: string | null,
    signal?: AbortSignal,
  ): Promise<ThreadListItem[]> => {
    if (view === "favorites") {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads?limit=100&favorites=true`,
        { signal },
      );
      if (!response.ok) throw new ApiDisplayError(await readError(response));
      return assertFavoritesPage(await response.json(), projectId).threads;
    }
    const collected: ThreadListItem[] = [];
    const seenIds = new Set<string>();
    let cursor: string | null = null;
    do {
      const params = ["limit=100"];
      if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
      if (tagId) params.push(`tagId=${encodeURIComponent(tagId)}`);
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads?${params.join("&")}`,
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

  const loadRecycleBinPage = useCallback(async (
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof recycleBinResponseSchema>> => {
    const params = new URLSearchParams();
    params.set("limit", "50");
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/thread-recycle-bin?${params.toString()}`,
      { signal },
    );
    if (!response.ok) throw new ApiDisplayError(await readError(response));
    const parsed = recycleBinResponseSchema.parse(await response.json());
    for (const item of parsed.threads) {
      if (item.projectId !== projectId) throw new Error("invalid_recycle_bin_tuple");
    }
    return parsed;
  }, [projectId]);

  useEffect(() => {
    const request = targetGuard.capture();
    setListState("loading");
    setListError(null);
    setSelectionError(null);
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
    setFavoriteError(null);
    setPendingFavoriteIds(new Set());
    setSearchText("");
    setSearchState("idle");
    setSearchError(null);
    setSearchPage(null);
    setSearchLoadingMore(false);
    setSearchLoadMoreError(null);
    setOrganizeMode(false);
    setSelectedThreadIds(new Set());
    setBatchAddTagIds(new Set());
    setBatchRemoveTagIds(new Set());
    setBatchConfirm(null);
    setBatchSubmitting(false);
    setBatchError(null);
    setBatchNotice(null);
    setBatchRetry(null);
    searchEpochRef.current += 1;
    searchResultRefs.current.clear();
    threadButtonRefs.current.clear();
    void loadThreads(view, activeTagId, request.signal)
      .then((loaded) => {
        if (!request.isCurrent()) return;
        setThreads(loaded);
        setListState(loaded.length === 0 ? "empty" : "ready");
        if (view !== "all" || activeTagId) return;
        const selection = threadSelectionFromUrl(projectId, directMode);
        if (loaded.length > 0 && selection.kind === "none") {
          const href = canonicalThreadHref(projectId, loaded[0]!.id, directMode);
          onNavigate?.(href);
          routerRef.current.replace(href);
        } else if (
          selection.kind === "invalid"
          || (
            selection.kind === "selected"
            && !loaded.some((thread) => thread.id === selection.threadId)
          )
        ) {
          setSelectionError(
            "所选线程无效或不属于当前项目。请选择一个可用线程。",
          );
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
  }, [
    activeTagId,
    directMode,
    loadThreads,
    onNavigate,
    projectId,
    reloadKey,
    targetGuard,
    view,
  ]);

  useEffect(() => {
    if (view !== "recycle_bin") return;
    const request = targetGuard.capture();
    setRecycleBinState("loading");
    setRecycleBinError(null);
    setRecycleBinAlertByThread({});
    setRecycleBin([]);
    setRecycleBinNextCursor(null);
    setRecycleBinLoadingMore(false);
    void loadRecycleBinPage(null, request.signal)
      .then((page) => {
        if (!request.isCurrent()) return;
        setRecycleBin(page.threads);
        setRecycleBinNextCursor(page.nextCursor);
        setRecycleBinState(page.threads.length === 0 ? "empty" : "ready");
      })
      .catch((cause: unknown) => {
        if (!request.isCurrent()) return;
        setRecycleBinState("error");
        setRecycleBinError(caughtApiErrorCopy(cause, "无法加载回收站，请稍后重试。"));
      });
  }, [loadRecycleBinPage, recycleReloadKey, targetGuard, view]);

  useEffect(() => {
    setActiveTagId(null);
    setManageOpen(false);
    setNewTagName("");
    setNewTagError(null);
    setCreatingTag(false);
    setManageNotice(null);
    setTagSearchText("");
    setPendingDeleteTag(null);
    setDeletingTag(false);
    setDeleteTagError(null);
    setRecycleBin([]);
    setRecycleBinState("loading");
    setRecycleBinError(null);
    setRecycleBinNextCursor(null);
    setRecycleBinLoadingMore(false);
    setRecycleBinAlertByThread({});
    setRecycleReloadKey(0);
    setPendingDeleteThread(null);
    setDeletingThread(false);
    setDeleteThreadError(null);
    setPendingPurgeThread(null);
    setPurgingThread(false);
    setPurgeThreadError(null);
  }, [projectId]);

  useEffect(() => {
    const request = targetGuard.capture();
    if (tagsProjectRef.current !== projectId) {
      tagsProjectRef.current = projectId;
      setTags([]);
      setTagsState("loading");
    } else {
      // Reloads keep the current chips visible; only the first load of a
      // project shows the loading state.
      setTagsState((current) => (current === "ready" ? current : "loading"));
    }
    setTagsError(null);
    void fetch(
      `/api/projects/${encodeURIComponent(projectId)}/thread-tags?limit=100`,
      { signal: request.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new ApiDisplayError(await readError(response));
        return threadTagListResponseSchema.parse(await response.json());
      })
      .then((payload) => {
        if (!request.isCurrent()) return;
        for (const item of payload.tags) {
          if (item.projectId !== projectId) throw new Error("invalid_tag_tuple");
        }
        setTags(payload.tags);
        setTagsState("ready");
      })
      .catch((cause: unknown) => {
        if (!request.isCurrent()) return;
        setTags([]);
        setTagsState("error");
        setTagsError(caughtApiErrorCopy(cause, "无法加载标签，请重试。"));
      });
  }, [projectId, tagsReloadKey, targetGuard]);

  const refreshThreadsSilently = useCallback(
    async (request: TargetRequest) => {
      try {
        const loaded = await loadThreads(
          viewRef.current,
          activeTagIdRef.current,
          request.signal,
        );
        if (!request.isCurrent()) return;
        setThreads(loaded);
        setListState(loaded.length === 0 ? "empty" : "ready");
      } catch {
        // Silent refresh keeps showing the current list; the next explicit
        // reload surfaces any persistent failure.
      }
    },
    [loadThreads],
  );

  const refreshRecycleBinSilently = useCallback(
    async (request: TargetRequest) => {
      try {
        const page = await loadRecycleBinPage(null, request.signal);
        if (!request.isCurrent()) return;
        setRecycleBin(page.threads);
        setRecycleBinNextCursor(page.nextCursor);
        setRecycleBinState(page.threads.length === 0 ? "empty" : "ready");
      } catch {
        // Silent refresh keeps current recycle-bin rows visible.
      }
    },
    [loadRecycleBinPage],
  );

  useEffect(() => {
    const query = searchText.trim();
    searchEpochRef.current += 1;
    setSearchLoadingMore(false);
    setSearchLoadMoreError(null);
    if (!query) {
      setSearchState("idle");
      setSearchError(null);
      setSearchPage(null);
      return;
    }
    if (organizeActiveRef.current) {
      setOrganizeMode(false);
      setSelectedThreadIds(new Set());
      setBatchAddTagIds(new Set());
      setBatchRemoveTagIds(new Set());
      setBatchConfirm(null);
      setBatchError(null);
      setBatchRetry(null);
    }
    const epoch = searchEpochRef.current;
    setSearchState("loading");
    setSearchError(null);
    const timer = window.setTimeout(() => {
      const request = targetGuard.capture();
      void fetch(
        `/api/projects/${encodeURIComponent(projectId)}/thread-search?q=${encodeURIComponent(query)}`,
        { signal: request.signal },
      )
        .then(async (response) => {
          if (!response.ok) throw new ApiDisplayError(await readError(response));
          return projectThreadSearchPageSchema.parse(await response.json());
        })
        .then((page) => {
          if (!request.isCurrent() || epoch !== searchEpochRef.current) return;
          setSearchPage({ nextCursor: page.nextCursor, query, results: page.results });
          setSearchState("idle");
        })
        .catch((cause: unknown) => {
          if (!request.isCurrent() || epoch !== searchEpochRef.current) return;
          setSearchState("error");
          setSearchError(caughtApiErrorCopy(cause, "无法搜索线程，请稍后重试。"));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [projectId, searchReloadKey, searchText, targetGuard]);

  useEffect(() => {
    const area = searchAreaRef.current;
    if (!area) return;
    // Layered dismissal: an enclosing surface (the narrow navigation drawer)
    // closes on Escape through a native keydown listener that runs before
    // React synthetic handlers attached at the root, so the search area must
    // consume Escape natively while a query is active (input-history-panel
    // precedent) — the clear and focus return live here, not in onKeyDown.
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (organizeActiveRef.current) {
        // Organize mode is the innermost layer above the list; the enclosing
        // drawer surface must not consume this Escape (input-history-panel
        // layered-dismissal precedent).
        event.stopPropagation();
        setOrganizeMode(false);
        setSelectedThreadIds(new Set());
        setBatchAddTagIds(new Set());
        setBatchRemoveTagIds(new Set());
        setBatchConfirm(null);
        setBatchError(null);
        setBatchRetry(null);
        organizeButtonRef.current?.focus();
        return;
      }
      if (!searchActiveRef.current) return;
      event.stopPropagation();
      setSearchText("");
      searchInputRef.current?.focus();
    };
    area.addEventListener("keydown", handleKeyDown);
    return () => area.removeEventListener("keydown", handleKeyDown);
  }, []);

  const trimmedSearch = searchText.trim();
  const searchActive = trimmedSearch.length > 0;
  searchActiveRef.current = searchActive;
  const visibleSearchPage =
    searchPage && searchPage.query === trimmedSearch ? searchPage : null;

  function loadMoreSearchResults() {
    if (!visibleSearchPage || visibleSearchPage.nextCursor === null) return;
    if (searchLoadingMore) return;
    const { nextCursor, query } = visibleSearchPage;
    const epoch = searchEpochRef.current;
    const request = targetGuard.capture();
    setSearchLoadingMore(true);
    setSearchLoadMoreError(null);
    void fetch(
      `/api/projects/${encodeURIComponent(projectId)}/thread-search?q=${encodeURIComponent(query)}&before=${encodeURIComponent(nextCursor)}`,
      { signal: request.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new ApiDisplayError(await readError(response));
        return projectThreadSearchPageSchema.parse(await response.json());
      })
      .then((page) => {
        if (!request.isCurrent() || epoch !== searchEpochRef.current) return;
        setSearchPage((current) =>
          current && current.query === query
            ? {
                nextCursor: page.nextCursor,
                query,
                results: [...current.results, ...page.results],
              }
            : current,
        );
      })
      .catch((cause: unknown) => {
        if (!request.isCurrent() || epoch !== searchEpochRef.current) return;
        setSearchLoadMoreError(
          caughtApiErrorCopy(cause, "无法加载更多搜索结果，请稍后重试。"),
        );
      })
      .finally(() => {
        if (request.isCurrent() && epoch === searchEpochRef.current) {
          setSearchLoadingMore(false);
        }
      });
  }

  function activateSearchResult(item: ThreadSearchResultItemDto) {
    const href = canonicalMessageHref(
      projectId,
      item.threadId,
      item.messageId,
      directMode,
    );
    onNavigate?.(href);
    window.history.pushState(window.history.state, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function handleSearchInputKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (
      event.key === "ArrowDown"
      && visibleSearchPage
      && visibleSearchPage.results.length > 0
    ) {
      event.preventDefault();
      searchResultRefs.current.get(0)?.focus();
    }
  }

  function handleSearchResultKeys(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      searchResultRefs.current.get(index + 1)?.focus();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) searchInputRef.current?.focus();
      else searchResultRefs.current.get(index - 1)?.focus();
    }
  }

  useEffect(() => {
    if (!focusThreadId) return;
    const selected = selectedThreadFromUrl(projectId, directMode);
    if (selected !== focusThreadId) return;
    threadButtonRefs.current.get(focusThreadId)?.focus();
    setFocusThreadId(null);
  }, [directMode, focusThreadId, locationVersion, projectId, threads]);

  useEffect(() => {
    if (view !== "all" || activeTagId) return;
    if (listState !== "ready" || threads.length === 0) return;
    const selection = threadSelectionFromUrl(projectId, directMode);
    if (selection.kind === "none") {
      setSelectionError(null);
      const href = canonicalThreadHref(projectId, threads[0]!.id, directMode);
      onNavigate?.(href);
      routerRef.current.replace(href);
    } else if (
      selection.kind === "invalid"
      || !threads.some((thread) => thread.id === selection.threadId)
    ) {
      setSelectionError(
        "所选线程无效或不属于当前项目。请选择一个可用线程。",
      );
    } else {
      setSelectionError(null);
    }
  }, [
    activeTagId,
    directMode,
    listState,
    locationVersion,
    onNavigate,
    projectId,
    threads,
    view,
  ]);

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
        if (!request.isCurrent()) return;
        setMembers(loaded);
        const onlyMember = loaded.length === 1 ? loaded.at(0) : undefined;
        if (directMode && onlyMember) {
          setSelectedMemberIds([onlyMember.agentId]);
        }
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
  }, [dialogOpen, directMode, membersReloadKey, projectId, targetGuard]);

  function openDialog() {
    setTitle("");
    setTitleError(null);
    setMemberError(null);
    setCreateError(null);
    setDialogOpen(true);
  }

  function chooseThread(threadId: string) {
    setCreateNotice(null);
    setSelectionError(null);
    setFocusThreadId(threadId);
    const href = canonicalThreadHref(projectId, threadId, directMode);
    onNavigate?.(href);
    routerRef.current.push(href);
  }

  function selectView(next: ThreadListView, focusTab = false) {
    setView(next);
    if (focusTab) {
      queueMicrotask(() => {
        (next === "all" ? allViewTabRef : favoritesViewTabRef).current?.focus();
      });
    }
  }

  function handleViewKeys(event: KeyboardEvent<HTMLDivElement>) {
    const order: ThreadListView[] = ["all", "favorites", "recycle_bin"];
    const currentIndex = order.indexOf(view);
    let next: ThreadListView | undefined;
    if (event.key === "Home") next = order[0];
    if (event.key === "End") next = order[order.length - 1];
    if (event.key === "ArrowLeft") {
      next = order[(currentIndex - 1 + order.length) % order.length];
    }
    if (event.key === "ArrowRight") {
      next = order[(currentIndex + 1) % order.length];
    }
    if (!next) return;
    event.preventDefault();
    selectView(next, true);
  }

  function applyFavoriteState(
    thread: ThreadListItem,
    isFavorite: boolean,
    favoritedAt: string | null,
  ) {
    setThreads((current) => {
      const source = current.find((item) => item.id === thread.id) ?? thread;
      const nextItem = { ...source, favoritedAt, isFavorite };
      if (viewRef.current === "favorites") {
        const remaining = current.filter((item) => item.id !== thread.id);
        return isFavorite
          ? [...remaining, nextItem].sort(compareFavorites)
          : remaining;
      }
      return current.map((item) => (item.id === thread.id ? nextItem : item));
    });
  }

  async function toggleFavorite(thread: ThreadListItem) {
    if (pendingFavoriteIds.has(thread.id)) return;
    const request = targetGuard.capture();
    const nextFavorite = !thread.isFavorite;
    const previous = {
      favoritedAt: thread.favoritedAt,
      isFavorite: thread.isFavorite,
    };
    setFavoriteError(null);
    setPendingFavoriteIds((current) => new Set(current).add(thread.id));
    applyFavoriteState(
      thread,
      nextFavorite,
      nextFavorite ? new Date().toISOString() : null,
    );
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(thread.id)}/favorite`,
        {
          body: JSON.stringify({ favorite: nextFavorite }),
          headers: { "content-type": "application/json" },
          method: "PUT",
          signal: request.signal,
        },
      );
      if (!request.isCurrent()) return;
      if (!response.ok) {
        throw new ApiDisplayError(await readError(response));
      }
      const result = threadFavoriteSetResponseSchema.parse(await response.json());
      if (result.projectId !== projectId || result.threadId !== thread.id) {
        throw new Error("invalid_favorite_tuple");
      }
      applyFavoriteState(thread, result.isFavorite, result.favoritedAt);
    } catch (cause: unknown) {
      if (!request.isCurrent()) return;
      applyFavoriteState(thread, previous.isFavorite, previous.favoritedAt);
      setFavoriteError(
        caughtApiErrorCopy(cause, "无法更新收藏状态，请重试。"),
      );
    } finally {
      if (request.isCurrent()) {
        setPendingFavoriteIds((current) => {
          const next = new Set(current);
          next.delete(thread.id);
          return next;
        });
      }
    }
  }

  async function confirmDeleteThread() {
    if (!pendingDeleteThread || deletingThread) return;
    const target = pendingDeleteThread;
    const request = targetGuard.capture();
    setDeletingThread(true);
    setDeleteThreadError(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(target.id)}`,
        { method: "DELETE", signal: request.signal },
      );
      if (!request.isCurrent()) return;
      if (!response.ok) throw new ApiDisplayError(await readError(response));
      const result = threadDeleteResponseSchema.parse(
        (await response.json()) as ThreadDeleteResponse,
      );
      if (result.threadId !== target.id) throw new Error("invalid_thread_delete_tuple");
      setPendingDeleteThread(null);
      setCreateNotice(`线程“${target.title}”已移入回收站。`);
      setRecycleReloadKey((current) => current + 1);
      void refreshThreadsSilently(request);
      void refreshRecycleBinSilently(request);
      const selected = selectedThreadFromUrl(projectId, directMode);
      if (selected === target.id) {
        const href = directMode ? "/" : `/projects/${encodeURIComponent(projectId)}`;
        onNavigate?.(href);
        routerRef.current.push(href);
      }
    } catch (cause: unknown) {
      if (!request.isCurrent()) return;
      setDeleteThreadError(caughtApiErrorCopy(cause, "无法移入回收站，请稍后重试。"));
    } finally {
      if (request.isCurrent()) setDeletingThread(false);
    }
  }

  async function restoreThread(item: RecycleBinItem) {
    const request = targetGuard.capture();
    setRecycleBinAlertByThread((current) => ({ ...current, [item.id]: "" }));
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(item.id)}/restore`,
        {
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: request.signal,
        },
      );
      if (!request.isCurrent()) return;
      if (!response.ok) throw new ApiDisplayError(await readError(response));
      const result = threadRestoreResponseSchema.parse(
        (await response.json()) as ThreadRestoreResponse,
      );
      if (result.threadId !== item.id) throw new Error("invalid_thread_restore_tuple");
      setCreateNotice(`线程“${item.title}”已恢复。`);
      setRecycleReloadKey((current) => current + 1);
      void refreshThreadsSilently(request);
      void refreshRecycleBinSilently(request);
    } catch (cause: unknown) {
      if (!request.isCurrent()) return;
      setRecycleBinAlertByThread((current) => ({
        ...current,
        [item.id]: caughtApiErrorCopy(cause, "恢复线程失败，请稍后重试。"),
      }));
    }
  }

  async function confirmPurgeThread() {
    if (!pendingPurgeThread || purgingThread) return;
    const target = pendingPurgeThread;
    const request = targetGuard.capture();
    setPurgingThread(true);
    setPurgeThreadError(null);
    setRecycleBinAlertByThread((current) => ({ ...current, [target.id]: "" }));
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(target.id)}/purge`,
        {
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: request.signal,
        },
      );
      if (!request.isCurrent()) return;
      if (!response.ok) {
        if (response.status === 409) {
          const payload = await readApiError(response);
          if (payload?.error?.fields?.threadId === "has_executions") {
            setPendingPurgeThread(null);
            setRecycleBinAlertByThread((current) => ({
              ...current,
              [target.id]: "该线程已产生执行记录，不可永久删除",
            }));
            return;
          }
        }
        throw new ApiDisplayError(await readError(response));
      }
      const result = threadPurgeResponseSchema.parse(
        (await response.json()) as ThreadPurgeResponse,
      );
      if (result.threadId !== target.id) throw new Error("invalid_thread_purge_tuple");
      setPendingPurgeThread(null);
      setCreateNotice(`线程“${target.title}”已永久删除。`);
      setRecycleReloadKey((current) => current + 1);
      void refreshThreadsSilently(request);
      void refreshRecycleBinSilently(request);
    } catch (cause: unknown) {
      if (!request.isCurrent()) return;
      setPurgeThreadError(caughtApiErrorCopy(cause, "永久删除失败，请稍后重试。"));
    } finally {
      if (request.isCurrent()) setPurgingThread(false);
    }
  }

  function loadMoreRecycleBin() {
    if (!recycleBinNextCursor || recycleBinLoadingMore) return;
    const request = targetGuard.capture();
    setRecycleBinLoadingMore(true);
    setRecycleBinError(null);
    void loadRecycleBinPage(recycleBinNextCursor, request.signal)
      .then((page) => {
        if (!request.isCurrent()) return;
        setRecycleBin((current) => [...current, ...page.threads]);
        setRecycleBinNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (!request.isCurrent()) return;
        setRecycleBinError(caughtApiErrorCopy(cause, "无法加载更多回收站线程，请稍后重试。"));
      })
      .finally(() => {
        if (request.isCurrent()) setRecycleBinLoadingMore(false);
      });
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
    const { policy: _createdPolicy, ...createdSummary } = created.thread;
    setThreads((current) =>
      [
        { ...createdSummary, favoritedAt: null, isFavorite: false, tags: [] },
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
    const href = canonicalThreadHref(
      projectId,
      created.thread.id,
      directMode,
    );
    onNavigate?.(href);
    routerRef.current.push(href);
  }

  async function reconcileUnknownCreate(
    operationId: string,
    previousIds: Set<string>,
    request: TargetRequest,
  ): Promise<boolean> {
    try {
      const refreshed = await loadThreads("all", null, request.signal);
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
      uniqueMemberIds.length < (directMode ? 1 : 2)
        ? directMode
          ? "个人对话 Agent 尚未就绪。"
          : "请明确选择至少 2 名当前项目成员。"
        : null;
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

  function selectTagFilter(tagId: string | null) {
    if (view === "favorites" && tagId !== null) setView("all");
    setActiveTagId((current) => (current === tagId ? null : tagId));
  }

  function handleFavoritesViewSelect() {
    setActiveTagId(null);
    setView("favorites");
  }

  function openManageDialog() {
    setNewTagName("");
    setNewTagError(null);
    setTagSearchText("");
    setManageNotice(null);
    setDeleteTagError(null);
    setManageOpen(true);
  }

  async function handleCreateTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = newTagName.trim();
    if (countGraphemes(normalized) === 0) {
      setNewTagError("请输入标签名称。");
      return;
    }
    if (countGraphemes(normalized) > 40) {
      setNewTagError("标签名称不能超过 40 个字符。");
      return;
    }
    setNewTagError(null);
    const request = targetGuard.capture();
    setCreatingTag(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/thread-tags`,
        {
          body: JSON.stringify({ name: normalized }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: request.signal,
        },
      );
      if (!request.isCurrent()) return;
      if (!response.ok) throw new ApiDisplayError(await readError(response));
      const result = threadTagCreateResponseSchema.parse(await response.json());
      if (result.tag.projectId !== projectId) throw new Error("invalid_tag_tuple");
      setTags((current) =>
        current.some((tag) => tag.id === result.tag.id)
          ? current
          : [...current, { ...result.tag, threadCount: 0 }],
      );
      setNewTagName("");
      setManageNotice(
        result.created
          ? `已创建标签“${result.tag.name}”。`
          : `标签“${result.tag.name}”已存在。`,
      );
    } catch (cause: unknown) {
      if (!request.isCurrent()) return;
      setNewTagError(caughtApiErrorCopy(cause, "无法创建标签，请重试。"));
    } finally {
      if (request.isCurrent()) setCreatingTag(false);
    }
  }

  async function confirmDeleteTag() {
    if (!pendingDeleteTag || deletingTag) return;
    const target = pendingDeleteTag;
    const request = targetGuard.capture();
    setDeletingTag(true);
    setDeleteTagError(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/thread-tags/${encodeURIComponent(target.id)}`,
        { method: "DELETE", signal: request.signal },
      );
      if (!request.isCurrent()) return;
      if (!response.ok) throw new ApiDisplayError(await readError(response));
      const result = threadTagDeleteResponseSchema.parse(await response.json());
      if (result.tagId !== target.id) {
        throw new Error("invalid_tag_tuple");
      }
      if (activeTagId === target.id) setActiveTagId(null);
      setBatchAddTagIds((current) => dropSetMember(current, target.id));
      setBatchRemoveTagIds((current) => dropSetMember(current, target.id));
      setTagsReloadKey((current) => current + 1);
      void refreshThreadsSilently(request);
      setManageNotice(
        `已删除标签“${target.name}”，解除 ${result.removedEdgeCount} 条分配。`,
      );
      setPendingDeleteTag(null);
    } catch (cause: unknown) {
      if (!request.isCurrent()) return;
      setDeleteTagError(caughtApiErrorCopy(cause, "无法删除标签，请重试。"));
    } finally {
      if (request.isCurrent()) setDeletingTag(false);
    }
  }

  function toggleThreadSelected(threadId: string) {
    setSelectedThreadIds((current) => toggleSetMember(current, threadId));
  }

  function toggleBatchAddTag(tagId: string) {
    const enabling = !batchAddTagIds.has(tagId);
    setBatchAddTagIds((current) => toggleSetMember(current, tagId));
    if (enabling) {
      setBatchRemoveTagIds((current) => dropSetMember(current, tagId));
    }
  }

  function toggleBatchRemoveTag(tagId: string) {
    const enabling = !batchRemoveTagIds.has(tagId);
    setBatchRemoveTagIds((current) => toggleSetMember(current, tagId));
    if (enabling) {
      setBatchAddTagIds((current) => dropSetMember(current, tagId));
    }
  }

  const batchAddCount = batchAddTagIds.size;
  const batchRemoveCount = batchRemoveTagIds.size;
  const batchSelectionCount = selectedThreadIds.size;
  const batchConfirmCopy = useMemo(() => {
    if (!batchConfirm) return null;
    const parts: string[] = [];
    if (batchConfirm.addTagIds.length > 0) {
      parts.push(`添加 ${batchConfirm.addTagIds.length} 个标签`);
    }
    if (batchConfirm.removeTagIds.length > 0) {
      parts.push(`移除 ${batchConfirm.removeTagIds.length} 个标签`);
    }
    return `将为 ${batchConfirm.threadIds.length} 条线程${parts.join("、")}。`;
  }, [batchConfirm]);

  function exitOrganizeMode() {
    setOrganizeMode(false);
    setSelectedThreadIds(new Set());
    setBatchAddTagIds(new Set());
    setBatchRemoveTagIds(new Set());
    setBatchConfirm(null);
    setBatchError(null);
    setBatchRetry(null);
    organizeButtonRef.current?.focus();
  }

  function confirmBatch() {
    setBatchError(null);
    setBatchNotice(null);
    setBatchConfirm({
      addTagIds: Array.from(batchAddTagIds),
      removeTagIds: Array.from(batchRemoveTagIds),
      threadIds: Array.from(selectedThreadIds),
    });
  }

  async function applyBatch(
    confirmed: BatchRequest,
    operationId: string,
  ) {
    if (batchSubmitting) return;
    const request = targetGuard.capture();
    setBatchSubmitting(true);
    setBatchError(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/thread-tag-batch`,
        {
          body: JSON.stringify({
            addTagIds: confirmed.addTagIds,
            operationId,
            removeTagIds: confirmed.removeTagIds,
            threadIds: confirmed.threadIds,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: request.signal,
        },
      );
      if (!request.isCurrent()) return;
      if (!response.ok) throw new ApiDisplayError(await readError(response));
      const result = threadTagBatchResponseSchema.parse(await response.json());
      if (result.operationId !== operationId) throw new Error("invalid_batch_tuple");
      setBatchRetry(null);
      setBatchNotice(`已为 ${result.applied.length} 条线程更新标签。`);
      setBatchConfirm(null);
      setOrganizeMode(false);
      setSelectedThreadIds(new Set());
      setBatchAddTagIds(new Set());
      setBatchRemoveTagIds(new Set());
      setTagsReloadKey((current) => current + 1);
      void refreshThreadsSilently(request);
    } catch (cause: unknown) {
      if (!request.isCurrent()) return;
      setBatchConfirm(null);
      setBatchRetry({ ...confirmed, operationId });
      setBatchError(
        caughtApiErrorCopy(cause, "批量更新失败，未写入任何变更，可重试。"),
      );
    } finally {
      if (request.isCurrent()) setBatchSubmitting(false);
    }
  }

  const selectedThreadId =
    typeof window === "undefined"
      ? null
      : selectedThreadFromUrl(projectId, directMode);
  const submitReason = membersLoading
    ? "正在加载当前项目成员。"
    : membersError
      ? "当前项目成员加载失败，请先重试。"
      : selectedMemberIds.length < (directMode ? 1 : 2)
        ? directMode
          ? "个人对话 Agent 尚未就绪。"
          : "至少选择 2 名当前项目成员后才能创建。"
        : isSubmitting
          ? "创建请求处理中，表单暂不可用。"
          : null;

  return (
    <>
      <section
        aria-labelledby="project-threads-title"
        className="stack"
        ref={searchAreaRef}
      >
        <div className="section-heading-row">
          <h2 className="surface-heading" id="project-threads-title">
            线程
          </h2>
          {listState !== "empty" && view === "all" ? (
            <button
              className="button-secondary"
              onClick={openDialog}
              ref={createButtonRef}
              type="button"
            >
              创建线程
            </button>
          ) : null}
          {listState !== "empty" ? (
            <button
              className="button-secondary"
              onClick={openManageDialog}
              ref={manageButtonRef}
              type="button"
            >
              管理标签
            </button>
          ) : null}
          {listState !== "empty" && view === "all" ? (
            <button
              aria-pressed={organizeMode}
              className="button-secondary"
              onClick={() => setOrganizeMode(true)}
              ref={organizeButtonRef}
              type="button"
            >
              整理线程
            </button>
          ) : null}
        </div>
        <div className="thread-search">
          <input
            aria-label="搜索线程"
            onChange={(event) => setSearchText(event.target.value)}
            onKeyDown={handleSearchInputKeys}
            placeholder="搜索线程标题与消息"
            ref={searchInputRef}
            type="search"
            value={searchText}
          />
        </div>
        {searchActive ? (
          <>
            {searchState === "loading" ? (
              <p className="muted" role="status">
                正在搜索…
              </p>
            ) : null}
            {searchState === "error" ? (
              <section
                aria-label="线程搜索结果"
                className="stack"
                id="project-threads-search-results"
              >
                <div className="stack state-message">
                  <p className="error-text" role="alert">
                    {searchError}
                  </p>
                  <button
                    className="button-secondary"
                    onClick={() => setSearchReloadKey((current) => current + 1)}
                    type="button"
                  >
                    重试搜索
                  </button>
                </div>
              </section>
            ) : null}
            {searchState !== "error" && visibleSearchPage ? (
              <section
                aria-label="线程搜索结果"
                className="stack"
                id="project-threads-search-results"
              >
                {visibleSearchPage.results.length === 0 ? (
                  <p className="muted" role="status">
                    无匹配结果。
                  </p>
                ) : (
                  <ul className="stack thread-search-results">
                    {visibleSearchPage.results.map((item, index) => (
                      <li key={`${item.threadId}:${item.messageId ?? "title"}`}>
                        <button
                          className="thread-search-result"
                          onClick={() => activateSearchResult(item)}
                          onKeyDown={(event) => handleSearchResultKeys(event, index)}
                          ref={(node) => {
                            if (node) searchResultRefs.current.set(index, node);
                            else searchResultRefs.current.delete(index);
                          }}
                          type="button"
                        >
                          <span className="thread-search-result-header">
                            <span className="thread-search-result-title">
                              {item.threadTitle}
                            </span>
                            <span
                              className={
                                item.kind === "thread_title"
                                  ? "status-label thread-search-kind thread-search-kind-title"
                                  : "status-label thread-search-kind"
                              }
                            >
                              {item.kind === "thread_title" ? "标题" : "内容"}
                            </span>
                          </span>
                          {item.kind === "message" && item.snippet ? (
                            <span className="thread-search-result-snippet">
                              {item.snippet}
                            </span>
                          ) : null}
                          <span className="thread-search-result-time">
                            {readableTime(item.occurredAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {visibleSearchPage.nextCursor !== null ? (
                  <button
                    className="button-secondary"
                    disabled={searchLoadingMore}
                    onClick={loadMoreSearchResults}
                    type="button"
                  >
                    {searchLoadingMore ? "正在加载更多…" : "加载更多搜索结果"}
                  </button>
                ) : null}
                {searchLoadMoreError ? (
                  <p className="error-text" role="alert">
                    {searchLoadMoreError}
                  </p>
                ) : null}
              </section>
            ) : null}
          </>
        ) : null}
        {searchActive ? null : (
        <div
          aria-label="线程视图"
          className="thread-view-tabs"
          onKeyDown={handleViewKeys}
          role="tablist"
        >
          <button
            aria-controls="project-threads-list"
            aria-selected={view === "all"}
            className="nav-item"
            id="thread-view-tab-all"
            onClick={() => selectView("all")}
            ref={allViewTabRef}
            role="tab"
            tabIndex={view === "all" ? 0 : -1}
            type="button"
          >
            全部
          </button>
          <button
            aria-controls="project-threads-list"
            aria-selected={view === "favorites"}
            className="nav-item"
            id="thread-view-tab-favorites"
            onClick={handleFavoritesViewSelect}
            ref={favoritesViewTabRef}
            role="tab"
            tabIndex={view === "favorites" ? 0 : -1}
            type="button"
          >
            已收藏
          </button>
          <button
            aria-controls="project-threads-list"
            aria-selected={view === "recycle_bin"}
            className="nav-item"
            id="thread-view-tab-recycle-bin"
            onClick={() => selectView("recycle_bin")}
            ref={recycleBinViewTabRef}
            role="tab"
            tabIndex={view === "recycle_bin" ? 0 : -1}
            type="button"
          >
            回收站
          </button>
        </div>
        )}
        {searchActive || view === "recycle_bin" ? null : (
        <div className="thread-tag-filter-bar">
          {tagsState === "loading" ? (
            <p className="muted" role="status">
              正在加载标签…
            </p>
          ) : null}
          {tagsState === "error" ? (
            <div className="thread-tag-filter-error">
              <p className="error-text" role="alert">
                {tagsError}
              </p>
              <button
                className="button-secondary"
                onClick={() => setTagsReloadKey((current) => current + 1)}
                type="button"
              >
                重试加载标签
              </button>
            </div>
          ) : null}
          {tagsState === "ready" && tags.length > 0 && !organizeMode ? (
            <div aria-label="按标签筛选线程" className="thread-tag-filter-chips" role="group">
              <button
                aria-pressed={activeTagId === null}
                className={
                  activeTagId === null
                    ? "status-label thread-tag-filter-chip active"
                    : "status-label thread-tag-filter-chip"
                }
                onClick={() => setActiveTagId(null)}
                type="button"
              >
                全部
              </button>
              {tags.map((tag) => (
                <button
                  aria-pressed={activeTagId === tag.id}
                  className={
                    activeTagId === tag.id
                      ? "status-label thread-tag-filter-chip active"
                      : "status-label thread-tag-filter-chip"
                  }
                  key={tag.id}
                  onClick={() => selectTagFilter(tag.id)}
                  type="button"
                >
                  {tag.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        )}
        {searchActive || !organizeMode ? null : (
        <section aria-label="批量整理线程" className="thread-batch-bar">
          <button
            className="button-secondary"
            disabled={batchSubmitting}
            onClick={exitOrganizeMode}
            type="button"
          >
            取消整理
          </button>
          <p aria-atomic="true" aria-live="polite" className="muted" role="status">
            {`已选 ${batchSelectionCount} 条线程`}
          </p>
          <div aria-label="添加标签" className="thread-batch-group" role="group">
            {tags.map((tag) => (
              <button
                aria-pressed={batchAddTagIds.has(tag.id)}
                className={
                  batchAddTagIds.has(tag.id)
                    ? "status-label thread-tag-filter-chip active"
                    : "status-label thread-tag-filter-chip"
                }
                disabled={batchSubmitting}
                key={tag.id}
                onClick={() => toggleBatchAddTag(tag.id)}
                type="button"
              >
                {tag.name}
              </button>
            ))}
          </div>
          <div aria-label="移除标签" className="thread-batch-group" role="group">
            {tags.map((tag) => (
              <button
                aria-pressed={batchRemoveTagIds.has(tag.id)}
                className={
                  batchRemoveTagIds.has(tag.id)
                    ? "status-label thread-tag-filter-chip active"
                    : "status-label thread-tag-filter-chip"
                }
                disabled={batchSubmitting}
                key={tag.id}
                onClick={() => toggleBatchRemoveTag(tag.id)}
                type="button"
              >
                {tag.name}
              </button>
            ))}
          </div>
          <button
            className="button-primary"
            disabled={
              batchSubmitting
              || batchSelectionCount === 0
              || batchAddCount + batchRemoveCount === 0
            }
            onClick={confirmBatch}
            type="button"
          >
            应用更改
          </button>
          {batchError ? (
            <div className="thread-batch-error">
              <p className="error-text" role="alert">
                {batchError}
              </p>
              {batchRetry ? (
                <button
                  className="button-secondary"
                  disabled={batchSubmitting}
                  onClick={() =>
                    void applyBatch(
                      {
                        addTagIds: batchRetry.addTagIds,
                        removeTagIds: batchRetry.removeTagIds,
                        threadIds: batchRetry.threadIds,
                      },
                      batchRetry.operationId,
                    )
                  }
                  type="button"
                >
                  重试批量整理
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
        )}
        {selectionError ? (
          <p className="error-text" role="alert">
            {selectionError}
          </p>
        ) : null}
        {favoriteError ? (
          <p className="error-text" role="alert">
            {favoriteError}
          </p>
        ) : null}
        {searchActive ? null : (
        <nav
          aria-busy={listState === "loading" ? "true" : undefined}
          aria-label="项目线程"
          id="project-threads-list"
        >
          {view === "recycle_bin" ? (
            recycleBinState === "loading" ? (
              <p className="muted" role="status">正在加载回收站…</p>
            ) : recycleBinState === "error" ? (
              <div className="stack state-message">
                <p className="error-text" role="alert">{recycleBinError}</p>
                <button
                  className="button-secondary"
                  onClick={() => setRecycleReloadKey((current) => current + 1)}
                  type="button"
                >
                  重试加载回收站
                </button>
              </div>
            ) : recycleBin.length === 0 ? (
              <div className="empty-guide state-message">
                <p>回收站为空。</p>
              </div>
            ) : (
              <ul className="project-list">
                {recycleBin.map((item) => (
                  <li className="thread-list-item" key={item.id}>
                    <div className="thread-list-main">
                      <p className="thread-recycle-title">{item.title}</p>
                      <p className="thread-recycle-meta">
                        删除于 {readableTime(item.deletedAt)}
                      </p>
                      <p className="thread-recycle-counts">
                        {`消息 ${item.messageCount} · 附件 ${item.attachmentCount}`}
                      </p>
                      {recycleBinAlertByThread[item.id] ? (
                        <p className="error-text" role="alert">
                          {recycleBinAlertByThread[item.id]}
                        </p>
                      ) : null}
                    </div>
                    <div className="thread-recycle-item-actions">
                      <button
                        aria-label={`恢复 ${item.title}`}
                        className="thread-recycle-item-action"
                        onClick={() => void restoreThread(item)}
                        type="button"
                      >
                        恢复
                      </button>
                      <button
                        aria-label={`永久删除 ${item.title}`}
                        className="thread-recycle-item-action"
                        onClick={() => {
                          setPurgeThreadError(null);
                          setPendingPurgeThread(item);
                        }}
                        type="button"
                      >
                        永久删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : listState === "loading" ? (
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
          ) : listState === "empty" || threads.length === 0 ? (
            view === "favorites" ? (
              <div className="empty-guide state-message">
                <p>暂无收藏线程。在“全部”视图中收藏线程后会显示在这里。</p>
                <button
                  className="button-secondary"
                  onClick={() => selectView("all")}
                  type="button"
                >
                  查看全部线程
                </button>
              </div>
            ) : activeTagId ? (
              <div className="empty-guide state-message">
                <p>{`标签“${tags.find((tag) => tag.id === activeTagId)?.name ?? ""}”下暂无线程。`}</p>
                <button
                  className="button-secondary"
                  onClick={() => setActiveTagId(null)}
                  type="button"
                >
                  清除筛选
                </button>
              </div>
            ) : (
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
            )
          ) : (
            <ul className="project-list">
              {threads.map((thread) => (
                <li className="thread-list-item" key={thread.id}>
                  {organizeMode ? (
                    <label className="thread-list-select">
                      <input
                        aria-label={`选择线程 ${thread.title}`}
                        checked={selectedThreadIds.has(thread.id)}
                        disabled={batchSubmitting}
                        onChange={() => toggleThreadSelected(thread.id)}
                        type="checkbox"
                      />
                      <span className="sr-only">{`选择线程 ${thread.title}`}</span>
                    </label>
                  ) : null}
                  <div className="thread-list-main">
                    <button
                      aria-current={
                        !organizeMode && thread.id === selectedThreadId
                          ? "page"
                          : undefined
                      }
                      className="nav-item thread-list-entry"
                      data-thread-id={thread.id}
                      onClick={() => {
                        if (organizeMode) toggleThreadSelected(thread.id);
                        else chooseThread(thread.id);
                      }}
                      ref={(element) => {
                        if (element) threadButtonRefs.current.set(thread.id, element);
                        else threadButtonRefs.current.delete(thread.id);
                      }}
                      type="button"
                    >
                      {thread.title}
                    </button>
                    {thread.tags.length > 0 ? (
                      <span className="thread-tag-chip-list">
                        {thread.tags.map((tag) => (
                          <span className="status-label thread-tag-chip" key={tag.id}>
                            {tag.name}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                  {!organizeMode ? (
                    <button
                      aria-label={`移入回收站 ${thread.title}`}
                      className="thread-recycle-item-action"
                      onClick={() => {
                        setDeleteThreadError(null);
                        setPendingDeleteThread(thread);
                      }}
                      type="button"
                    >
                      移入回收站
                    </button>
                  ) : null}
                  <button
                    aria-label={
                      thread.isFavorite
                        ? `取消收藏 ${thread.title}`
                        : `收藏线程 ${thread.title}`
                    }
                    aria-pressed={thread.isFavorite}
                    className="thread-favorite-toggle"
                    disabled={organizeMode || pendingFavoriteIds.has(thread.id)}
                    onClick={() => void toggleFavorite(thread)}
                    type="button"
                  >
                    <StarIcon filled={thread.isFavorite} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {view === "recycle_bin" && recycleBinNextCursor !== null ? (
            <button
              className="button-secondary"
              disabled={recycleBinLoadingMore}
              onClick={loadMoreRecycleBin}
              type="button"
            >
              {recycleBinLoadingMore ? "正在加载更多…" : "加载更多回收站线程"}
            </button>
          ) : null}
        </nav>
        )}
        {batchNotice ?? createNotice ? (
          <p aria-atomic="true" aria-live="polite" role="status">
            {batchNotice ?? createNotice}
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
                  <HelpTip id="thread-title-help" label="标题字数规则">
                    最多 80 个字符。
                  </HelpTip>
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
                  <legend>{directMode ? "对话 Agent" : "当前策略成员"}</legend>
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
                  ) : directMode ? (
                    <p>{members.at(0)?.name ?? "个人对话 Agent"}</p>
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
      {manageOpen && typeof document !== "undefined"
        ? createPortal(
            <section
              aria-labelledby="manage-tags-title"
              aria-modal="true"
              className="modal-surface manage-tags-dialog"
              ref={manageDialogRef}
              role="dialog"
            >
              <div className="section-heading-row">
                <h2 id="manage-tags-title">管理标签</h2>
                <button
                  aria-label="关闭管理标签"
                  className="button-ghost"
                  onClick={closeManageDialog}
                  type="button"
                >
                  关闭
                </button>
              </div>
              {manageNotice ? (
                <p aria-atomic="true" aria-live="polite" role="status">
                  {manageNotice}
                </p>
              ) : null}
              <form className="stack" onSubmit={handleCreateTag}>
                <div className="form-field">
                  <label htmlFor="new-thread-tag-name">新标签名称</label>
                  <input
                    aria-describedby="new-thread-tag-help"
                    aria-invalid={newTagError ? "true" : undefined}
                    disabled={creatingTag}
                    id="new-thread-tag-name"
                    onChange={(event) => setNewTagName(event.target.value)}
                    placeholder="例如：发布阻塞"
                    ref={newTagInputRef}
                    value={newTagName}
                  />
                  <HelpTip id="new-thread-tag-help" label="标签字数规则">
                    最多 40 个字符。
                  </HelpTip>
                  {newTagError ? (
                    <p className="error-text" id="new-thread-tag-error" role="alert">
                      {newTagError}
                    </p>
                  ) : null}
                </div>
                <button
                  className="button-primary"
                  disabled={creatingTag}
                  type="submit"
                >
                  {creatingTag ? "正在创建…" : "创建标签"}
                </button>
              </form>
              <div className="form-field">
                <label htmlFor="manage-tag-search">搜索标签</label>
                <input
                  id="manage-tag-search"
                  onChange={(event) => setTagSearchText(event.target.value)}
                  placeholder="按名称过滤"
                  ref={tagSearchInputRef}
                  type="search"
                  value={tagSearchText}
                />
              </div>
              {tagsState === "loading" ? (
                <p className="muted" role="status">
                  正在加载标签…
                </p>
              ) : null}
              {tagsState === "error" ? (
                <div className="stack state-message">
                  <p className="error-text" role="alert">
                    {tagsError}
                  </p>
                  <button
                    className="button-secondary"
                    onClick={() => setTagsReloadKey((current) => current + 1)}
                    type="button"
                  >
                    重试加载标签
                  </button>
                </div>
              ) : null}
              {tagsState === "ready" ? (
                tags.length === 0 ? (
                  <p className="muted" role="status">
                    暂无标签。创建标签后开始整理线程。
                  </p>
                ) : (
                  (() => {
                    const query = tagSearchText.trim().toLowerCase();
                    const visible = query
                      ? tags.filter((tag) => tag.name.toLowerCase().includes(query))
                      : tags;
                    return visible.length === 0 ? (
                      <p className="muted" role="status">
                        无匹配标签。
                      </p>
                    ) : (
                      <ul className="stack thread-tag-manage-list">
                        {visible.map((tag) => (
                          <li className="thread-tag-manage-item" key={tag.id}>
                            <span className="thread-tag-list-name">{tag.name}</span>
                            <span className="thread-tag-count">
                              {`已分配 ${tag.threadCount} 条线程`}
                            </span>
                            <button
                              aria-label={`删除标签 ${tag.name}`}
                              className="button-secondary"
                              disabled={deletingTag}
                              onClick={() => {
                                setDeleteTagError(null);
                                setPendingDeleteTag(tag);
                              }}
                              type="button"
                            >
                              删除
                            </button>
                          </li>
                        ))}
                      </ul>
                    );
                  })()
                )
              ) : null}
            </section>,
            document.body,
          )
        : null}
      {pendingDeleteTag && typeof document !== "undefined"
        ? createPortal(
            <section
              aria-labelledby="delete-tag-title"
              aria-modal="true"
              className="modal-surface delete-tag-confirm"
              ref={confirmDialogRef}
              role="dialog"
            >
              <h2 id="delete-tag-title">删除标签</h2>
              <p>
                {`删除标签“${pendingDeleteTag.name}”将解除 ${pendingDeleteTag.threadCount} 条分配。此操作不可撤销。`}
              </p>
              {deleteTagError ? (
                <p className="error-text" role="alert">
                  {deleteTagError}
                </p>
              ) : null}
              <div className="form-row">
                <button
                  className="button-primary"
                  disabled={deletingTag}
                  onClick={() => void confirmDeleteTag()}
                  type="button"
                >
                  {deletingTag ? "正在删除…" : "确认删除"}
                </button>
                <button
                  className="button-secondary"
                  disabled={deletingTag}
                  onClick={() => setPendingDeleteTag(null)}
                  ref={deleteCancelRef}
                  type="button"
                >
                  取消
                </button>
              </div>
            </section>,
            document.body,
          )
        : null}
      {batchConfirm && typeof document !== "undefined"
        ? createPortal(
            <section
              aria-labelledby="batch-apply-title"
              aria-modal="true"
              className="modal-surface batch-apply-confirm"
              ref={batchConfirmDialogRef}
              role="dialog"
            >
              <h2 id="batch-apply-title">确认批量整理</h2>
              <p>{batchConfirmCopy}</p>
              {batchConfirm.removeTagIds.length > 0 ? (
                <p className="muted">
                  移除会立即解除这些线程上的标签分配。
                </p>
              ) : null}
              <div className="form-row">
                <button
                  className="button-primary"
                  disabled={batchSubmitting}
                  onClick={() => void applyBatch(batchConfirm, crypto.randomUUID())}
                  ref={batchConfirmApplyRef}
                  type="button"
                >
                  {batchSubmitting ? "正在提交…" : "确认应用"}
                </button>
                <button
                  className="button-secondary"
                  disabled={batchSubmitting}
                  onClick={closeBatchConfirm}
                  type="button"
                >
                  取消
                </button>
              </div>
            </section>,
            document.body,
          )
        : null}
      {pendingDeleteThread && typeof document !== "undefined"
        ? createPortal(
            <section
              aria-labelledby="thread-delete-title"
              aria-modal="true"
              className="modal-surface thread-delete-confirm"
              ref={deleteThreadDialogRef}
              role="dialog"
            >
              <h2 id="thread-delete-title">移入回收站</h2>
              <p>移入后可从回收站恢复。</p>
              {deleteThreadError ? (
                <p className="error-text" role="alert">{deleteThreadError}</p>
              ) : null}
              <div className="form-row">
                <button
                  className="button-primary"
                  disabled={deletingThread}
                  onClick={() => void confirmDeleteThread()}
                  type="button"
                >
                  {deletingThread ? "正在移入…" : "确认移入"}
                </button>
                <button
                  className="button-secondary"
                  disabled={deletingThread}
                  onClick={closeDeleteThreadConfirm}
                  ref={deleteThreadCancelRef}
                  type="button"
                >
                  取消
                </button>
              </div>
            </section>,
            document.body,
          )
        : null}
      {pendingPurgeThread && typeof document !== "undefined"
        ? createPortal(
            <section
              aria-labelledby="thread-purge-title"
              aria-modal="true"
              className="modal-surface thread-purge-confirm"
              ref={purgeThreadDialogRef}
              role="dialog"
            >
              <h2 id="thread-purge-title">永久删除线程</h2>
              <p>
                {`将永久删除 ${pendingPurgeThread.messageCount} 条消息、${pendingPurgeThread.attachmentCount} 个附件。此操作不可恢复；删除操作会记录在审计日志中。`}
              </p>
              {purgeThreadError ? (
                <p className="error-text" role="alert">{purgeThreadError}</p>
              ) : null}
              <div className="form-row">
                <button
                  className="button-primary"
                  disabled={purgingThread}
                  onClick={() => void confirmPurgeThread()}
                  type="button"
                >
                  {purgingThread ? "正在删除…" : "永久删除"}
                </button>
                <button
                  className="button-secondary"
                  disabled={purgingThread}
                  onClick={closePurgeThreadConfirm}
                  ref={purgeThreadCancelRef}
                  type="button"
                >
                  取消
                </button>
              </div>
            </section>,
            document.body,
          )
        : null}
    </>
  );
}
