"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { MagnifyingGlass, Plus } from "@phosphor-icons/react";

import { ActionDialog } from "@/components/ui/action-dialog";
import { HelpTip } from "@/components/ui/help-tip";
import { IconButton } from "@/components/ui/icon-button";

import type { ApiError } from "@/src/shared/contracts";
import type {
  CurationCandidateListItemDto,
  CurationDecisionResultDto,
  KnowledgeGraphDto,
  MemoryCollectionCatalogDto,
} from "@/src/modules/knowledge-provenance";
import type { ProjectMemoryIndexHealthDto } from "@/src/modules/operations-projection";
import type {
  MemoryEntryV6,
  MemorySourceType,
  MemoryType,
} from "@/src/shared/memory-contracts";
import type { MemoryEntry as LegacyMemoryEntry } from "@/src/shared/project-context-contracts";

type MemoryDraft = {
  type: MemoryType;
  content: string;
  sourceType: "artifact_path" | "owner_input" | "work_item";
  sourceRef: string;
  supersedesId: string;
};
type MemoryEntry = MemoryEntryV6 | LegacyMemoryEntry;
type MemoryPayload = Partial<ApiError> & {
  error?: ApiError["error"] & {
    fields?: Array<{ field: string; code: string }>;
  };
};

const EMPTY_DRAFT: MemoryDraft = {
  type: "goal",
  content: "",
  sourceType: "owner_input",
  sourceRef: "",
  supersedesId: "",
};
const MEMORY_TYPES: Array<{
  value: MemoryType;
  label: string;
}> = [
  { value: "goal", label: "目标" },
  { value: "decision", label: "决策" },
  { value: "fact", label: "事实" },
  { value: "artifact", label: "产物" },
  { value: "experience", label: "经验" },
];
const OWNER_SOURCE_LABELS: Record<MemoryDraft["sourceType"], string> = {
  owner_input: "Owner 输入",
  work_item: "任务",
  artifact_path: "产物路径",
};
const SOURCE_LABELS: Record<MemorySourceType, string> = {
  ...OWNER_SOURCE_LABELS,
  artifact: "artifact",
  result: "result",
  review: "review",
  task: "task",
  validation: "validation",
};

function sourcedGraphEdges(graph: KnowledgeGraphDto) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.flatMap((edge) => {
    const from = nodes.get(edge.fromId);
    const to = nodes.get(edge.toId);
    if (
      from === undefined
      || to === undefined
      || (edge.kind !== "supersedes" && edge.kind !== "collection")
    ) {
      return [];
    }
    return [{
      from,
      key: `${edge.kind}:${edge.fromId}:${edge.toId}`,
      kind: edge.kind,
      label: edge.kind === "supersedes"
        ? `${from.title} 取代 ${to.title}`
        : `${from.title} 与 ${to.title} 同属一集合`,
      to,
    }];
  });
}

function isV6(memory: MemoryEntry): memory is MemoryEntryV6 {
  return "actor" in memory && "source" in memory && "version" in memory;
}

function memoryType(memory: MemoryEntry): MemoryType {
  return memory.type;
}

function chainId(memory: MemoryEntry): string {
  return isV6(memory) ? memory.chainId : memory.id;
}

function version(memory: MemoryEntry): number {
  return isV6(memory) ? memory.version : 1;
}

function source(memory: MemoryEntry): MemoryEntryV6["source"] {
  return isV6(memory)
    ? memory.source
    : {
        href: null,
        id: memory.sourceRef,
        type: memory.sourceType,
        version: null,
      };
}

function actorCopy(memory: MemoryEntry): string {
  if (!isV6(memory) || memory.actor.proposerType === "owner") {
    return "Owner 提议 · 平台持久化";
  }
  if (memory.actor.confirmer === null) {
    return `Agent ${memory.actor.proposerAgent.name} 提议 · Owner 经审批发布 · 平台持久化`;
  }
  return `Agent ${memory.actor.proposerAgent.name} 提议 · 通过裁决 ${
    memory.actor.confirmer.decisionId
  } 确认 · 平台持久化`;
}

function memoryError(payload: MemoryPayload): string {
  switch (payload.error?.code) {
    case "INVALID_SOURCE":
      return "来源引用无效，请检查来源类型与引用。";
    case "MEMORY_NOT_FOUND":
      return "要取代的记忆不存在，请刷新后重试。";
    case "MEMORY_NOT_ACTIVE":
      return "要取代的记忆已失效，请刷新后重试。";
    case "MEMORY_TYPE_MISMATCH":
      return "只能取代相同类型的 active 记忆。";
    case "RESOURCE_CONFLICT":
      return "数据已更新，请刷新后重试。";
    case "INVALID_INPUT":
      return "记忆内容无效，请检查字段长度。";
    default:
      return "无法保存共享记忆，请稍后重试。";
  }
}

export function MemoryPanel({
  projectId,
  writeIntent = 0,
}: {
  projectId: string;
  writeIntent?: number;
}) {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [draft, setDraft] = useState<MemoryDraft>(EMPTY_DRAFT);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const headingRefs = useRef(new Map<string, HTMLHeadingElement>());
  const [focusMemoryId, setFocusMemoryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // U-08（UCD §9.2.4）：记忆卡片列表的顶部搜索与类型过滤。
  const [listQuery, setListQuery] = useState("");
  const [listType, setListType] = useState<MemoryType | "all">("all");
  const [searchType, setSearchType] = useState("");
  const [searchSourceType, setSearchSourceType] = useState("");
  const [searchVersion, setSearchVersion] = useState("");
  const [writeOpen, setWriteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchHits, setSearchHits] = useState<Array<{
    memory: MemoryEntryV6;
    snippet: string;
  }> | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [indexHealth, setIndexHealth] = useState<ProjectMemoryIndexHealthDto | null>(null);
  const [indexHealthError, setIndexHealthError] = useState(false);
  const [indexHealthReloadKey, setIndexHealthReloadKey] = useState(0);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const rebuildCancelRef = useRef<HTMLButtonElement>(null);
  const [collections, setCollections] = useState<MemoryCollectionCatalogDto[]>([]);
  const [collectionsReloadKey, setCollectionsReloadKey] = useState(0);
  const [deleteCollection, setDeleteCollection] = useState<MemoryCollectionCatalogDto | null>(null);
  const [isDeletingCollection, setIsDeletingCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [isCreatingCollection, setIsCreatingCollection] = useState(false);
  const [graph, setGraph] = useState<KnowledgeGraphDto>({ edges: [], nodes: [] });
  const deleteCollectionCancelRef = useRef<HTMLButtonElement>(null);
  const [curationCandidates, setCurationCandidates] = useState<
    CurationCandidateListItemDto[]
  >([]);
  const [curationReloadKey, setCurationReloadKey] = useState(0);
  const [isCurationLoading, setIsCurationLoading] = useState(true);
  const [curationError, setCurationError] = useState<string | null>(null);
  const [curationNotice, setCurationNotice] = useState<string | null>(null);
  const [decidingCandidateActions, setDecidingCandidateActions] = useState<
    Record<string, "publish" | "reject">
  >({});
  const [curationDecisionErrors, setCurationDecisionErrors] = useState<
    Record<string, string>
  >({});
  const [focusCurationRegion, setFocusCurationRegion] = useState(false);
  const curationEpochRef = useRef(0);
  const curationRegionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    void fetch(
      `/api/projects/${projectId}/memories?includeInactive=${
        includeHistory ? "1" : "0"
      }`,
    )
      .then(async (response) => {
        const payload = (await response.json()) as {
          memories?: MemoryEntry[];
        } & MemoryPayload;
        if (!response.ok || !Array.isArray(payload.memories)) {
          throw new Error("load");
        }
        return payload.memories;
      })
      .then((loaded) => {
        if (active) setMemories(loaded);
      })
      .catch(() => {
        if (active) setError("无法加载共享记忆，请重试。");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [includeHistory, projectId, reloadKey]);

  useEffect(() => {
    let active = true;
    setIndexHealthError(false);
    void fetch(`/api/projects/${projectId}/memory-index/health`)
      .then(async (response) => {
        const payload = await response.json() as Partial<ProjectMemoryIndexHealthDto>;
        if (
          !response.ok
          || payload.projectId !== projectId
          || typeof payload.version !== "number"
          || typeof payload.coverage?.active !== "number"
          || typeof payload.coverage?.valid !== "number"
        ) {
          throw new Error("invalid_health");
        }
        return payload as ProjectMemoryIndexHealthDto;
      })
      .then((health) => {
        if (active) setIndexHealth(health);
      })
      .catch(() => {
        if (active) setIndexHealthError(true);
      });
    return () => {
      active = false;
    };
  }, [indexHealthReloadKey, projectId]);

  useEffect(() => {
    const epoch = ++curationEpochRef.current;
    const controller = new AbortController();
    setIsCurationLoading(true);
    setCurationError(null);
    setCurationCandidates([]);
    void fetch(
      `/api/projects/${encodeURIComponent(projectId)}/memory-curation-candidates`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const payload = await response.json() as {
          candidates?: CurationCandidateListItemDto[];
        };
        if (!response.ok || !Array.isArray(payload.candidates)) {
          throw new Error("invalid_curation_candidates");
        }
        return payload.candidates;
      })
      .then((candidates) => {
        if (curationEpochRef.current === epoch) {
          setCurationCandidates(candidates);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && curationEpochRef.current === epoch) {
          setCurationError("无法加载提炼候选，请稍后重试。");
        }
      })
      .finally(() => {
        if (curationEpochRef.current === epoch) setIsCurationLoading(false);
      });
    return () => controller.abort();
  }, [curationReloadKey, projectId]);

  useEffect(() => {
    let active = true;
    void fetch(`/api/projects/${projectId}/memory-collections`)
      .then(async (response) => {
        const payload = await response.json() as { collections?: MemoryCollectionCatalogDto[] };
        if (!response.ok || !Array.isArray(payload.collections)) return [];
        return payload.collections;
      })
      .then((loaded) => {
        if (active) setCollections(loaded);
      })
      .catch(() => {
        if (active) setCollections([]);
      });
    return () => {
      active = false;
    };
  }, [collectionsReloadKey, projectId]);

  useEffect(() => {
    let active = true;
    void fetch(`/api/projects/${projectId}/knowledge-graph`)
      .then(async (response) => {
        const payload = await response.json() as Partial<KnowledgeGraphDto>;
        if (!response.ok || !Array.isArray(payload.edges) || !Array.isArray(payload.nodes)) {
          return { edges: [], nodes: [] } satisfies KnowledgeGraphDto;
        }
        return { edges: payload.edges, nodes: payload.nodes };
      })
      .then((loaded) => {
        if (active) setGraph(loaded);
      })
      .catch(() => {
        if (active) setGraph({ edges: [], nodes: [] });
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (!focusMemoryId) return;
    const heading = headingRefs.current.get(focusMemoryId);
    if (!heading) return;
    heading.focus();
    setFocusMemoryId(null);
  }, [focusMemoryId, memories]);

  useEffect(() => {
    if (!focusCurationRegion || isCurationLoading) return;
    curationRegionRef.current?.focus();
    setFocusCurationRegion(false);
  }, [curationCandidates, focusCurationRegion, isCurationLoading]);

  async function saveMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess("");
    if (!draft.content.trim()) {
      setError("请输入记忆正文。");
      contentRef.current?.focus();
      return;
    }
    if (!draft.sourceRef.trim()) {
      setError("请输入来源引用。");
      sourceRef.current?.focus();
      return;
    }
    setIsSaving(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/memories`, {
        body: JSON.stringify({
          type: draft.type,
          content: draft.content,
          sourceType: draft.sourceType,
          sourceRef: draft.sourceRef,
          ...(draft.supersedesId
            ? { supersedesId: draft.supersedesId }
            : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as {
        memory?: MemoryEntry;
      } & MemoryPayload;
      if (!response.ok || !payload.memory) {
        throw new Error(memoryError(payload));
      }
      const created = payload.memory;
      setMemories((current) => [
        ...current
          .map((memory) =>
            memory.id === created.supersedesId
              ? { ...memory, active: false }
              : memory,
          )
          .filter((memory) => includeHistory || memory.active),
        created,
      ]);
      setDraft(EMPTY_DRAFT);
      setWriteOpen(false);
      setSuccess("共享记忆已保存。");
      setFocusMemoryId(created.id);
      setIndexHealthReloadKey((current) => current + 1);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "无法保存共享记忆，请稍后重试。",
      );
      contentRef.current?.focus();
    } finally {
      setIsSaving(false);
    }
  }

  async function rebuildIndex() {
    if (!indexHealth || isRebuilding) return;
    setIsRebuilding(true);
    setIndexHealthError(false);
    try {
      const response = await fetch(`/api/projects/${projectId}/memory-index/rebuild`, {
        body: JSON.stringify({
          confirmation: "重建记忆索引",
          expectedVersion: indexHealth.version,
          operationId: crypto.randomUUID(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json() as {
        replayed?: number;
        status?: string;
        version?: number;
      };
      if (
        !response.ok
        || payload.status !== "caught_up"
        || typeof payload.replayed !== "number"
        || typeof payload.version !== "number"
      ) {
        throw new Error("rebuild_failed");
      }
      const replayed = payload.replayed;
      const nextVersion = payload.version;
      setIndexHealth((current) => current === null
        ? current
        : {
            ...current,
            coverage: {
              active: replayed,
              indexed: replayed,
              ratio: 1,
              valid: replayed,
            },
            freshness: { pending: 0, status: "caught_up" },
            lastErrorCode: null,
            status: "caught_up",
            version: nextVersion,
          });
      setRebuildOpen(false);
    } catch {
      setIndexHealthError(true);
    } finally {
      setIsRebuilding(false);
    }
  }

  // UCD §9.2.4 顶栏「＋ 沉淀新记忆」：task-panel 顶栏发出的意图在此消费——
  // 打开沉淀表单并聚焦正文（与任务看板共建新任务同范式）。
  useEffect(() => {
    if (writeIntent <= 0) return;
    setDraft(EMPTY_DRAFT);
    setWriteOpen(true);
    queueMicrotask(() => contentRef.current?.focus());
  }, [writeIntent]);

  // UCD §9.2.4：卡片「修订（Supersede）」复用沉淀表单——预填正文/类型与取代目标，
  // 来源沿用原记忆的冻结来源元组（修订不改变事实来源）。V6 来源域比沉淀表单更宽
  // （artifact/task/result/review/validation），修订表单只接受 owner 可写的三种来源，
  // 其余按产物路径归档（保留 sourceRef 原文，不伪造新来源）。
  function openRevise(
    memory: MemoryEntry,
    memorySource: ReturnType<typeof source>,
  ) {
    const draftSourceType: MemoryDraft["sourceType"] =
      memorySource.type in OWNER_SOURCE_LABELS
        ? (memorySource.type as MemoryDraft["sourceType"])
        : "artifact_path";
    setDraft({
      content: memory.content,
      sourceRef: memorySource.id,
      sourceType: draftSourceType,
      supersedesId: memory.id,
      type: memoryType(memory),
    });
    setWriteOpen(true);
    queueMicrotask(() => contentRef.current?.focus());
  }

  async function decideCurationCandidate(
    candidate: CurationCandidateListItemDto,
    action: "publish" | "reject",
  ) {
    if (decidingCandidateActions[candidate.id] !== undefined) return;
    const epoch = curationEpochRef.current;
    setDecidingCandidateActions((current) => ({
      ...current,
      [candidate.id]: action,
    }));
    setCurationNotice(null);
    setCurationDecisionErrors((current) => {
      const next = { ...current };
      delete next[candidate.id];
      return next;
    });
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}`
          + `/memory-curation-candidates/${encodeURIComponent(candidate.id)}`
          + `/${action === "publish" ? "publish" : "reject"}`,
        {
          body: JSON.stringify({ operationId: crypto.randomUUID() }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const payload = await response.json() as Partial<CurationDecisionResultDto>;
      if (!response.ok || payload.candidate?.id !== candidate.id) {
        throw new Error("curation_decision_failed");
      }
      if (curationEpochRef.current !== epoch) return;
      setCurationCandidates((current) =>
        current.filter((entry) => entry.id !== candidate.id));
      setCurationNotice(
        action === "publish" ? "提炼候选已发布。" : "提炼候选已驳回。",
      );
      if (action === "publish" && payload.memory?.id) {
        setFocusMemoryId(payload.memory.id);
      } else {
        setFocusCurationRegion(true);
      }
      setCurationReloadKey((current) => current + 1);
      setReloadKey((current) => current + 1);
      setIndexHealthReloadKey((current) => current + 1);
    } catch {
      if (curationEpochRef.current !== epoch) return;
      setCurationDecisionErrors((current) => ({
        ...current,
        [candidate.id]: "无法完成提炼候选裁决，请稍后重试。",
      }));
    } finally {
      if (curationEpochRef.current === epoch) {
        setDecidingCandidateActions((current) => {
          const next = { ...current };
          delete next[candidate.id];
          return next;
        });
      }
    }
  }

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    setIsSearching(true);
    setSearchOpen(false);
    setSearchError(null);
    const params = new URLSearchParams({ q: query });
    if (searchType) params.set("type", searchType);
    if (searchSourceType) params.set("sourceType", searchSourceType);
    if (searchVersion.trim()) params.set("version", searchVersion.trim());
    try {
      const response = await fetch(
        `/api/projects/${projectId}/memories/search?${params.toString()}`,
      );
      const payload = (await response.json()) as {
        results?: Array<{ memory: MemoryEntryV6; snippet: string }>;
      } & MemoryPayload;
      if (!response.ok || !Array.isArray(payload.results)) {
        throw new Error("search");
      }
      setSearchHits(payload.results);
    } catch {
      setSearchError("无法检索记忆，请稍后重试。");
      setSearchHits(null);
    } finally {
      setIsSearching(false);
    }
  }

  function locateMemory(memoryId: string) {
    const card = document.getElementById(`memory-${memoryId}`);
    if (card && typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ block: "nearest" });
    }
    setFocusMemoryId(memoryId);
  }

  const supersedeOptions = memories.filter(
    (memory) => memory.active && memoryType(memory) === draft.type,
  );
  const displayedMemories = [...memories].sort((left, right) =>
    includeHistory
      ? chainId(left).localeCompare(chainId(right))
        || version(left) - version(right)
        || left.id.localeCompare(right.id)
      : left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
  const visibleMemories = displayedMemories.filter((memory) => {
    if (listType !== "all" && memoryType(memory) !== listType) return false;
    const query = listQuery.trim().toLowerCase();
    if (query === "") return true;
    const memorySourceValue = source(memory);
    return [memory.content, memorySourceValue.id, memorySourceValue.type]
      .some((value) => value.toLowerCase().includes(query));
  });
  const successorById = new Map(
    memories
      .filter((memory) => memory.supersedesId !== null)
      .map((memory) => [memory.supersedesId!, memory]),
  );
  const relationEdges = sourcedGraphEdges(graph);
  const pendingCurationCandidates = curationCandidates.filter(
    (candidate) => candidate.status === "pending",
  );

  return (
    <section aria-labelledby={`memory-title-${projectId}`} className="stack">
      <h2 className="sr-only" id={`memory-title-${projectId}`}>
        共享记忆
      </h2>
      {indexHealth ? (
        <section
          aria-label="记忆索引健康"
          className="task-summary memory-index-health"
        >
          <div>
            <strong>
              {indexHealth.status === "caught_up"
                ? `索引已追平 · ${indexHealth.coverage.valid}/${indexHealth.coverage.active} 有效`
                : indexHealth.status === "behind"
                  ? `索引落后 ${indexHealth.freshness.pending} 条`
                  : indexHealth.status === "rebuilding"
                    ? "索引重建中"
                    : "索引需要修复"}
            </strong>
            {indexHealth.status !== "caught_up" ? (
              <p className="muted">来源记忆与检索仍可用。</p>
            ) : null}
          </div>
          <button
            className="button-secondary"
            disabled={isRebuilding || indexHealth.status === "rebuilding"}
            onClick={() => setRebuildOpen(true)}
            type="button"
          >
            重建索引
          </button>
        </section>
      ) : indexHealthError ? (
        <div className="state-message">
          <p>索引状态暂不可用；来源记忆与检索仍可用。</p>
          <button
            className="button-secondary"
            onClick={() => setIndexHealthReloadKey((current) => current + 1)}
            type="button"
          >
            重试索引状态
          </button>
        </div>
      ) : (
        <p aria-busy="true" className="state-message">正在检查记忆索引…</p>
      )}

      {/* UCD §9.2.4：索引健康条之后为顶部搜索框 + 类型过滤胶囊，记忆卡片列表为主内容。 */}
      <div aria-label="记忆搜索" className="stack memory-search-row" role="group">
        <div className="form-field">
          <label htmlFor={`memory-list-search-${projectId}`}>搜索记忆</label>
          <input
            id={`memory-list-search-${projectId}`}
            onChange={(event) => setListQuery(event.target.value)}
            placeholder="搜索记忆关键字、标签或来源…"
            type="search"
            value={listQuery}
          />
        </div>
        <div className="form-row memory-type-chips">
          <button
            aria-pressed={listType === "all"}
            onClick={() => setListType("all")}
            type="button"
          >
            全部
          </button>
          {MEMORY_TYPES.map((type) => (
            <button
              aria-pressed={listType === type.value}
              key={type.value}
              onClick={() => setListType(type.value)}
              type="button"
            >
              {type.label}
            </button>
          ))}
          <button
            className="button-secondary memory-search-open"
            onClick={() => setSearchOpen(true)}
            type="button"
          >
            打开记忆检索
          </button>
        </div>
      </div>
      <section
        aria-labelledby={`memory-cards-${projectId}`}
        className="stack memory-form"
      >
        <div className="panel-heading">
          <h3 id={`memory-cards-${projectId}`}>记忆卡片</h3>
          <HelpTip label="共享记忆说明">
            只收录带来源的目标、决策、事实与产物；原始聊天不会自动变成记忆。
          </HelpTip>
        </div>
        <ActionDialog
          closeLabel="关闭记忆检索"
          onClose={() => setSearchOpen(false)}
          open={searchOpen}
          title="记忆检索"
          titleId={`memory-search-title-${projectId}`}
        >
        <form className="stack" onSubmit={submitSearch}>
          <div className="form-field">
            <label htmlFor={`memory-search-${projectId}`}>检索记忆</label>
            <input
              id={`memory-search-${projectId}`}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="例如：当前目标"
              value={searchQuery}
            />
          </div>
          <div className="form-row">
            <div className="form-field">
              <label htmlFor={`memory-search-type-${projectId}`}>检索类型</label>
              <select
                id={`memory-search-type-${projectId}`}
                onChange={(event) => setSearchType(event.target.value)}
                value={searchType}
              >
                <option value="">全部类型</option>
                {MEMORY_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`memory-search-source-${projectId}`}>检索来源</label>
              <select
                id={`memory-search-source-${projectId}`}
                onChange={(event) => setSearchSourceType(event.target.value)}
                value={searchSourceType}
              >
                <option value="">全部来源</option>
                {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`memory-search-version-${projectId}`}>检索版本</label>
              <input
                id={`memory-search-version-${projectId}`}
                inputMode="numeric"
                onChange={(event) => setSearchVersion(event.target.value)}
                placeholder="例如：2"
                value={searchVersion}
              />
            </div>
          </div>
          <button disabled={isSearching || !searchQuery.trim()} type="submit">
            {isSearching ? "正在检索…" : "检索"}
          </button>
        </form>
        </ActionDialog>
        {isSearching ? (
          <p aria-busy="true" className="state-message">
            正在检索记忆…
          </p>
        ) : null}
        {searchError ? (
          <p
            className="error-text"
            id={`memory-search-error-${projectId}`}
            role="alert"
          >
            {searchError}
          </p>
        ) : null}
        {!isSearching && searchHits && searchHits.length === 0 && !searchError ? (
          <p className="state-message">没有匹配的记忆。</p>
        ) : null}
        {searchHits && searchHits.length > 0 ? (
          <ul aria-label="记忆检索结果" className="stack">
            {searchHits.map((hit) => (
              <li key={hit.memory.id}>
                <button
                  aria-label={`定位记忆 ${hit.memory.content}`}
                  className="button-ghost"
                  onClick={() => locateMemory(hit.memory.id)}
                  type="button"
                >
                  {hit.snippet}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <button
        className="button-secondary"
        disabled={isLoading}
        onClick={() => setIncludeHistory((current) => !current)}
        type="button"
      >
        {includeHistory ? "只看 active 记忆" : "查看历史记忆"}
      </button>
      {isLoading ? (
        <p aria-busy="true" className="state-message">
          正在加载共享记忆…
        </p>
      ) : memories.length === 0 && !error ? (
        <p className="state-message">尚无共享记忆。</p>
      ) : memories.length > 0 ? (
        <ul
          aria-label={includeHistory ? "共享记忆历史" : "Active 共享记忆"}
          className="stack memory-list"
        >
          {visibleMemories.map((memory) => {
            const memorySource = source(memory);
            const successor = successorById.get(memory.id);
            const predecessor = memory.supersedesId
              ? memories.find((candidate) => candidate.id === memory.supersedesId)
              : undefined;
            return (
            <li
              aria-label={`memory ${memory.id}`}
              className="task-summary stack"
              id={`memory-${memory.id}`}
              key={memory.id}
            >
              <h3
                ref={(element) => {
                  if (element) headingRefs.current.set(memory.id, element);
                  else headingRefs.current.delete(memory.id);
                }}
                tabIndex={-1}
              >
                {memory.content}
              </h3>
              <p>
                {/* UCD §9.2.4 记忆卡片：类型徽标（胶囊标签）。 */}
                <span className="status-label">
                  {MEMORY_TYPES.find((type) => type.value === memoryType(memory))?.label}
                </span>
              </p>
              <p>{actorCopy(memory)}</p>
              {memorySource.href && memorySource.version ? (
                <a
                  aria-label={`${memorySource.type} · ${memorySource.id} · version ${memorySource.version}`}
                  href={memorySource.href}
                >
                  {SOURCE_LABELS[memorySource.type]} · <code>{memorySource.id}</code>
                  {" · version "}<code>{memorySource.version}</code>
                </a>
              ) : (
                <p>
                  {SOURCE_LABELS[memorySource.type]} · <code>{memorySource.id}</code>
                  {" · "}<span>原有来源（无版本）</span>
                </p>
              )}
              {/* 版本号面向用户；内部 chain id 仅保留在 title 供追溯，不回显原始标识符。 */}
              <p title={chainId(memory)}>版本 v{version(memory)}</p>
              {memory.active ? (
                <p>Active · 当前版本</p>
              ) : (
                <>
                  <p>已失效</p>
                  <p>{successor ? `已被 v${version(successor)} 取代` : "已取代"}</p>
                </>
              )}
              {predecessor ? (
                <a href={`#memory-${predecessor.id}`}>
                  取代 v{version(predecessor)}
                </a>
              ) : null}
              {successor ? (
                <a href={`#memory-${successor.id}`}>
                  后继 v{version(successor)}
                </a>
              ) : null}
              {memorySource.type === "artifact_path" ? (
                <p className="muted">仅引用，尚未读取</p>
              ) : null}
              {/* UCD §9.2.4 记忆卡片操作区：「查看来源」与「修订（Supersede）」；
                  修订复用沉淀表单并预填取代目标与正文。 */}
              <div className="memory-card-actions">
                {memorySource.href ? (
                  <a className="button-ghost" href={memorySource.href}>
                    查看来源
                  </a>
                ) : null}
                {memory.active ? (
                  <button
                    aria-label={`修订记忆 ${memory.content}`}
                    className="button-secondary"
                    onClick={() => openRevise(memory, memorySource)}
                    type="button"
                  >
                    修订
                  </button>
                ) : null}
              </div>
            </li>
            );
          })}
        </ul>
      ) : null}
      <section
        aria-label="提炼候选"
        className="stack task-summary memory-curation"
        ref={curationRegionRef}
        tabIndex={-1}
      >
        <h3>提炼候选</h3>
        {isCurationLoading ? (
          <div
            aria-busy="true"
            aria-label="正在加载提炼候选…"
            className="memory-curation-skeleton"
            role="status"
          >
            <span className="sr-only">正在加载提炼候选…</span>
          </div>
        ) : curationError ? (
          <div className="stack">
            <p className="error-text" role="alert">{curationError}</p>
            <button
              className="button-secondary memory-curation-action"
              onClick={() => setCurationReloadKey((current) => current + 1)}
              type="button"
            >
              重试加载提炼候选
            </button>
          </div>
        ) : pendingCurationCandidates.length === 0 ? (
          <div className="stack">
            <p className="muted">暂无待发布的提炼候选。</p>
            <button
              className="button-secondary memory-curation-action"
              onClick={() => setCurationReloadKey((current) => current + 1)}
              type="button"
            >
              刷新提炼候选
            </button>
          </div>
        ) : (
          <ul aria-label="待发布提炼候选" className="stack memory-curation-list">
            {pendingCurationCandidates.map((candidate) => {
              const decidingAction = decidingCandidateActions[candidate.id];
              const deciding = decidingAction !== undefined;
              const decisionError = curationDecisionErrors[candidate.id];
              return (
                <li className="stack memory-curation-item" key={candidate.id}>
                  <h4>{candidate.content}</h4>
                  <p>
                    Agent {candidate.agentName} · {
                      MEMORY_TYPES.find((type) => type.value === candidate.type)?.label
                    }
                  </p>
                  <ul aria-label={`${candidate.content} 来源`} className="stack">
                    {candidate.sources.map((candidateSource, index) => {
                      const sourceLabel = SOURCE_LABELS[candidateSource.type];
                      return (
                        <li key={`${candidate.id}-source-${index}`}>
                          {candidateSource.href && candidateSource.version ? (
                            <a
                              aria-label={
                                `${candidateSource.type} · ${candidateSource.id}`
                                + ` · version ${candidateSource.version}`
                              }
                              href={candidateSource.href}
                            >
                              {sourceLabel} · <code>{candidateSource.id}</code>
                              {" · version "}<code>{candidateSource.version}</code>
                            </a>
                          ) : (
                            <span>
                              {sourceLabel} · <code>{candidateSource.id}</code>
                              {candidateSource.version === null ? (
                                <>{" · "}<span>原有来源（无版本）</span></>
                              ) : null}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <pre
                    aria-label={`${candidate.content} 文本差异`}
                    className="memory-curation-diff"
                  >
                    {candidate.diff.map((line, index) => (
                      <span
                        className={`memory-curation-diff-${line.kind}`}
                        key={`${candidate.id}-diff-${index}`}
                      >
                        {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
                        {line.text}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                  <div
                    aria-busy={deciding || undefined}
                    className="memory-curation-actions"
                  >
                    <button
                      className="button-primary memory-curation-action"
                      disabled={deciding}
                      onClick={() => void decideCurationCandidate(candidate, "publish")}
                      type="button"
                    >
                      {decidingAction === "publish" ? "正在发布…" : "批准发布"}
                    </button>
                    <button
                      className="button-secondary memory-curation-action"
                      disabled={deciding}
                      onClick={() => void decideCurationCandidate(candidate, "reject")}
                      type="button"
                    >
                      {decidingAction === "reject" ? "正在驳回…" : "驳回"}
                    </button>
                  </div>
                  {decisionError ? (
                    <p className="error-text" role="alert">{decisionError}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {curationNotice ? (
          <p aria-live="polite" className="muted" role="status">
            {curationNotice}
          </p>
        ) : null}
      </section>
      <section
        aria-label="知识集合"
        className="stack task-summary"
      >
        <h3>知识集合</h3>
        {collections.length === 0 ? (
          <p className="muted">尚无集合。</p>
        ) : (
          <ul className="stack">
            {collections.map((collection) => (
              <li className="form-row" key={collection.id}>
                <span>{collection.name}</span>
                <button
                  className="button-secondary"
                  onClick={() => setDeleteCollection(collection)}
                  type="button"
                >
                  删除集合 {collection.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="form-row"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newCollectionName.trim();
            if (name.length < 1 || isCreatingCollection) return;
            setIsCreatingCollection(true);
            void fetch(`/api/projects/${encodeURIComponent(projectId)}/memory-collections`, {
              body: JSON.stringify({ name }),
              headers: { "content-type": "application/json" },
              method: "POST",
            })
              .then((response) => {
                if (!response.ok) throw new Error("create");
                setNewCollectionName("");
                setCollectionsReloadKey((current) => current + 1);
              })
              .finally(() => {
                setIsCreatingCollection(false);
              });
          }}
        >
          <label className="stack">
            集合名称
            <input
              onChange={(event) => setNewCollectionName(event.target.value)}
              placeholder="例如：架构决策"
              value={newCollectionName}
            />
          </label>
          <button
            className="button-secondary"
            disabled={isCreatingCollection}
            type="submit"
          >
            新建集合
          </button>
        </form>
      </section>
      <section
        aria-label="关系列表"
        className="stack task-summary"
      >
        <h3>关系列表</h3>
        {relationEdges.length === 0 ? (
          <p className="muted">尚无有来源的关系。</p>
        ) : (
          <ul className="stack">
            {relationEdges.map((edge) => (
              <li className="form-row" key={edge.key}>
                <span>{edge.label}</span>
                <button
                  className="button-secondary"
                  onClick={() => setFocusMemoryId(edge.from.id)}
                  type="button"
                >
                  定位记忆 {edge.from.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ActionDialog
        closeLabel="关闭删除集合确认"
        initialFocusRef={deleteCollectionCancelRef}
        onClose={() => {
          if (!isDeletingCollection) setDeleteCollection(null);
        }}
        open={deleteCollection !== null}
        title="删除集合"
        titleId={`memory-collection-delete-title-${projectId}`}
      >
        <div className="stack">
          <p>不会删除来源记忆。</p>
          <div className="form-row">
            <button
              className="button-primary"
              disabled={isDeletingCollection}
              onClick={() => {
                if (deleteCollection === null) return;
                const target = deleteCollection;
                setIsDeletingCollection(true);
                void fetch(
                  `/api/projects/${encodeURIComponent(projectId)}/memory-collections/${encodeURIComponent(target.id)}`,
                  { method: "DELETE" },
                )
                  .then((response) => {
                    if (!response.ok) throw new Error("delete");
                    setCollections((current) => current.filter((entry) => entry.id !== target.id));
                    setDeleteCollection(null);
                    setCollectionsReloadKey((current) => current + 1);
                  })
                  .finally(() => {
                    setIsDeletingCollection(false);
                  });
              }}
              type="button"
            >
              {isDeletingCollection ? "正在删除…" : "确认删除"}
            </button>
            <button
              className="button-secondary"
              disabled={isDeletingCollection}
              onClick={() => setDeleteCollection(null)}
              ref={deleteCollectionCancelRef}
              type="button"
            >
              取消
            </button>
          </div>
        </div>
      </ActionDialog>
      <ActionDialog
        closeLabel="关闭重建索引确认"
        initialFocusRef={rebuildCancelRef}
        onClose={() => {
          if (!isRebuilding) setRebuildOpen(false);
        }}
        open={rebuildOpen}
        title="重建记忆索引"
        titleId={`memory-index-rebuild-title-${projectId}`}
      >
        <div className="stack">
          <p>只会丢弃并重建可恢复的索引投影，不会修改或删除来源记忆。</p>
          <div className="form-row">
            <button
              className="button-primary"
              disabled={isRebuilding}
              onClick={() => void rebuildIndex()}
              type="button"
            >
              {isRebuilding ? "正在重建…" : "确认重建"}
            </button>
            <button
              className="button-secondary"
              disabled={isRebuilding}
              onClick={() => setRebuildOpen(false)}
              ref={rebuildCancelRef}
              type="button"
            >
              取消
            </button>
          </div>
        </div>
      </ActionDialog>
      <ActionDialog
        closeLabel="关闭记忆编辑器"
        initialFocusRef={contentRef}
        onClose={() => setWriteOpen(false)}
        open={writeOpen}
        title="添加记忆"
        titleId={`memory-write-title-${projectId}`}
      >
      <form className="stack memory-form" onSubmit={saveMemory}>
        <div className="stack memory-form-body">
          <fieldset>
            <legend>记忆类型</legend>
            <div className="memory-type-options">
              {MEMORY_TYPES.map((type) => (
                <label className="check-row" key={type.value}>
                  <input
                    checked={draft.type === type.value}
                    name={`memory-type-${projectId}`}
                    onChange={() =>
                      setDraft((current) => ({
                        ...current,
                        type: type.value,
                        supersedesId: "",
                      }))
                    }
                    type="radio"
                    value={type.value}
                  />
                  <span>{type.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="form-field">
            <label htmlFor={`memory-content-${projectId}`}>记忆正文</label>
            <textarea
              aria-describedby={error ? `memory-error-${projectId}` : undefined}
              id={`memory-content-${projectId}`}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  content: event.target.value,
                }))
              }
              ref={contentRef}
              value={draft.content}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`memory-source-type-${projectId}`}>来源类型</label>
            <select
              id={`memory-source-type-${projectId}`}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  sourceType: event.target
                    .value as MemoryDraft["sourceType"],
                }))
              }
              value={draft.sourceType}
            >
              {Object.entries(OWNER_SOURCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {draft.sourceType === "artifact_path" ? (
            <p className="muted">仅引用，尚未读取</p>
          ) : null}
          <div className="form-field">
            <label htmlFor={`memory-source-ref-${projectId}`}>来源引用</label>
            <input
              aria-describedby={error ? `memory-error-${projectId}` : undefined}
              id={`memory-source-ref-${projectId}`}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  sourceRef: event.target.value,
                }))
              }
              placeholder="例如：docs/architecture.md"
              ref={sourceRef}
              value={draft.sourceRef}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`memory-supersede-${projectId}`}>取代旧记忆</label>
            <select
              id={`memory-supersede-${projectId}`}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  supersedesId: event.target.value,
                }))
              }
              value={draft.supersedesId}
            >
              <option value="">不取代</option>
              {supersedeOptions.map((memory) => (
                <option key={memory.id} value={memory.id}>
                  {memory.content}
                </option>
              ))}
            </select>
          </div>
          {error && writeOpen ? (
            <p
              className="error-text"
              id={`memory-error-${projectId}`}
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
        <button
          className="button-primary"
          disabled={isLoading || isSaving}
          type="submit"
        >
          {isSaving ? "正在保存记忆…" : "保存记忆"}
        </button>
      </form>
      </ActionDialog>

      {error && !writeOpen ? (
        <div className="state-message stack">
          <p
            className="error-text"
            id={`memory-error-${projectId}`}
            role="alert"
          >
            {error}
          </p>
          {error.startsWith("无法加载") ||
          error.includes("刷新后重试") ? (
            <button
              onClick={() => setReloadKey((current) => current + 1)}
              type="button"
            >
              重试加载共享记忆
            </button>
          ) : null}
        </div>
      ) : null}
      {success ? (
        <p aria-live="polite" aria-label="保存结果" role="status">
          {success}
        </p>
      ) : null}
    </section>
  );
}
