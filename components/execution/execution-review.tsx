"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  ApiDisplayError,
  apiErrorCopy,
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";
import type { ApiError } from "@/src/shared/contracts";
import type {
  ExecutionApprovalDto,
  ExecutionDto,
} from "@/src/shared/execution-contracts";
import { executionApprovalResponseSchema } from "@/src/shared/execution-contracts";

type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

type ExecutionDetail = {
  counts: {
    approvals: number;
    artifacts: number;
    events: number;
    mergeFiles: number;
    stagedBlockers: number;
    stagedObservations: number;
    validations: number;
  };
  execution: ExecutionDto;
  frozen: {
    policyHash: string;
    policyRevisionId: string;
    policyVersion: number;
  };
  staged: StagedSummary | null;
};

type StagedSummary = {
  blockReasons: string[];
  blockerCount: number;
  blockerCounts: Record<string, number>;
  classification: "auto_eligible" | "approval_required" | "blocked";
  id: string;
  mergeFileCount: number;
  mergeFinalBytes: number;
  observedFinalBytes: number;
  observedPathCount: number;
  stagedHash: string;
};

type ExecutionEvent = {
  actorType: string;
  createdAt: string;
  id: string;
  sequence: number;
  type: string;
};

type OutputHeader = {
  bytes: number;
  sha256: string;
  truncated: boolean;
};

type Validation = {
  afterLastWrite: boolean;
  exitCode: number;
  finishedAt: string;
  id: string;
  policyEntryId: string;
  required: boolean;
  stderr: OutputHeader;
  stdout: OutputHeader;
  succeeded: boolean;
};

type Artifact = {
  contentBytes: number;
  createdAt: string;
  id: string;
  name: string;
  path: string;
  sha256: string;
  truncated: boolean;
};

type Observation = {
  baselineHash: string | null;
  diffBytes: number;
  diffTruncated: boolean;
  finalSize: number;
  id: string;
  kind: string;
  observedHash: string | null;
  path: string;
  position: number;
};

type Blocker = {
  detailCode: string;
  kind: string;
  observationId: string;
  path: string;
  position: number;
  secondaryCodes: string[];
};

type TextChunk = {
  byteLength: number;
  byteOffset: number;
  chunkIndex: number;
  sha256: string;
  stream: "stdout" | "stderr" | "artifact";
  text: string;
};

type DiffChunk = {
  nextOffset: number | null;
  observationId: string;
  offset: number;
  sha256: string;
  text: string;
  totalBytes: number;
};

type ResourceState<T> = {
  error: string | null;
  items: T[];
  loaded: boolean;
  loading: boolean;
  nextCursor: string | null;
};

const approvalStatusCopy: Record<ExecutionApprovalDto["status"], string> = {
  approved: "已批准",
  consumed: "已使用",
  expired: "已过期",
  pending: "等待决定",
  rejected: "已拒绝",
  replaced: "已替换",
  revoked: "已撤销",
};

const APPROVAL_WARNING =
  "此 guardrail 不是 hostile OS sandbox。获批的本地程序仍可能产生平台无法隔离的本机、网络、进程或服务副作用。";

function shortHash(value: string | null): string {
  return value ? value.slice(0, 12) : "无";
}

async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const payload = (await response.json()) as T & Partial<ApiError>;
  if (!response.ok) {
    throw new ApiDisplayError(apiErrorCopy(payload, fallback));
  }
  return payload;
}

function usePagedResource<T>(
  url: string | null,
  fallback: string,
): ResourceState<T> & { loadMore: () => Promise<void>; retry: () => Promise<void> } {
  const [state, setState] = useState<ResourceState<T>>({
    error: null,
    items: [],
    loaded: false,
    loading: false,
    nextCursor: null,
  });

  const load = useCallback(async (reset: boolean) => {
    if (!url) return;
    const cursor = reset ? null : state.nextCursor;
    setState((current) => ({ ...current, error: null, loading: true }));
    try {
      const separator = url.includes("?") ? "&" : "?";
      const response = await fetch(
        cursor ? `${url}${separator}after=${encodeURIComponent(cursor)}` : url,
      );
      const page = await readResponse<Page<T>>(response, fallback);
      setState((current) => ({
        error: null,
        items: reset ? page.items : [...current.items, ...page.items],
        loaded: true,
        loading: false,
        nextCursor: page.nextCursor,
      }));
    } catch (cause: unknown) {
      setState((current) => ({
        ...current,
        error: caughtApiErrorCopy(cause, fallback),
        loaded: true,
        loading: false,
      }));
    }
  }, [fallback, state.nextCursor, url]);

  useEffect(() => {
    setState({
      error: null,
      items: [],
      loaded: false,
      loading: false,
      nextCursor: null,
    });
    if (url) void load(true);
    // `load` changes with the cursor; the URL is the resource identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return {
    ...state,
    loadMore: () => load(false),
    retry: () => load(state.items.length === 0),
  };
}

function ResourceMessage({
  empty,
  label,
  resource,
}: {
  empty: string;
  label: string;
  resource: ResourceState<unknown> & { retry: () => Promise<void> };
}) {
  if (resource.loading && resource.items.length === 0) {
    return <p aria-busy="true">正在加载{label}…</p>;
  }
  if (resource.error && resource.items.length === 0) {
    return (
      <div>
        <p className="error-text" role="alert">{resource.error}</p>
        <button onClick={() => void resource.retry()} type="button">
          重试加载{label}
        </button>
      </div>
    );
  }
  if (resource.loaded && resource.items.length === 0) return <p>{empty}</p>;
  return null;
}

function TextChunkReader({
  header,
  label,
  url,
}: {
  header: OutputHeader;
  label: string;
  url: string;
}) {
  const [chunks, setChunks] = useState<TextChunk[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadChunk() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        nextCursor ? `${url}?after=${encodeURIComponent(nextCursor)}` : url,
      );
      const page = await readResponse<Page<TextChunk>>(
        response,
        `无法读取 ${label}，请重试。`,
      );
      setChunks((current) => [...current, ...page.items].slice(0, 17));
      setNextCursor(page.nextCursor);
    } catch (cause: unknown) {
      setError(caughtApiErrorCopy(cause, `无法读取 ${label}，请重试。`));
    } finally {
      setLoading(false);
    }
  }

  if (header.bytes === 0) {
    return <p>{label} 为空 · 0 bytes · hash {shortHash(header.sha256)}</p>;
  }
  return (
    <section aria-label={`${label} 输出`} className="execution-output stack">
      <p>
        {label} · {header.bytes} bytes · hash {shortHash(header.sha256)}
        {header.truncated ? " · 已截断" : " · 未截断"}
      </p>
      {chunks.length > 0 ? (
        <pre className="execution-review-code">
          {chunks.map((chunk) => chunk.text).join("")}
        </pre>
      ) : null}
      {chunks.map((chunk) => (
        <small key={`${chunk.stream}-${chunk.chunkIndex}`}>
          chunk {chunk.chunkIndex + 1}/17 · offset {chunk.byteOffset} · {chunk.byteLength} bytes
          {" "}· hash {shortHash(chunk.sha256)}
        </small>
      ))}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {nextCursor !== null ? (
        <button disabled={loading} onClick={() => void loadChunk()} type="button">
          {chunks.length === 0 ? `读取 ${label}` : `加载更多 ${label}`}
        </button>
      ) : null}
    </section>
  );
}

function DiffReader({
  executionId,
  observation,
  stagedId,
}: {
  executionId: string;
  observation: Observation;
  stagedId: string;
}) {
  const [chunks, setChunks] = useState<DiffChunk[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadDiff() {
    setLoading(true);
    setError(null);
    try {
      const offset = nextOffset ?? 0;
      const response = await fetch(
        `/api/executions/${executionId}/staged/${stagedId}/observations/${observation.id}/diff`
        + `?offset=${offset}&limit=65536`,
      );
      const chunk = await readResponse<DiffChunk>(
        response,
        "无法读取文本差异，请重试。",
      );
      setChunks((current) => [...current, chunk].slice(0, 17));
      setNextOffset(chunk.nextOffset);
    } catch (cause: unknown) {
      setError(caughtApiErrorCopy(cause, "无法读取文本差异，请重试。"));
    } finally {
      setLoading(false);
    }
  }

  if (observation.diffBytes === 0) return <p>没有可读取的文本差异。</p>;
  return (
    <div className="stack">
      {chunks.length > 0 ? (
        <pre className="execution-review-code">
          {chunks.map((chunk) => chunk.text).join("")}
        </pre>
      ) : null}
      {chunks.map((chunk, index) => (
        <small key={chunk.offset}>
          diff chunk {index + 1}/17 · offset {chunk.offset} · total {chunk.totalBytes} bytes
          {" "}· hash {shortHash(chunk.sha256)}
        </small>
      ))}
      {observation.diffTruncated ? <p>差异已截断。</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {nextOffset !== null ? (
        <button disabled={loading} onClick={() => void loadDiff()} type="button">
          {chunks.length === 0
            ? `读取 ${observation.path} 文本差异`
            : `加载更多 ${observation.path} 文本差异`}
        </button>
      ) : null}
    </div>
  );
}

function ApprovalCard({
  approval,
  execution,
  onChanged,
}: {
  approval: ExecutionApprovalDto;
  execution: ExecutionDto;
  onChanged: (approval: ExecutionApprovalDto, execution: ExecutionDto) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function decide(action: "approve" | "reject" | "revoke" | "replace") {
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(
        `/api/executions/${execution.id}/approvals/${approval.id}`,
        {
          body: JSON.stringify({
            action,
            expectedVersion: execution.version,
            operationId: globalThis.crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const payload = await readResponse<unknown>(response, "无法更新审批，请重试。");
      const parsed = executionApprovalResponseSchema.safeParse(payload);
      if (!parsed.success) throw new ApiDisplayError("审批响应无效，请刷新后重试。");
      onChanged(parsed.data.approval, parsed.data.execution);
      setSuccess("审批已更新。");
    } catch (cause: unknown) {
      setError(caughtApiErrorCopy(cause, "无法更新审批，请重试。"));
    } finally {
      setPending(false);
    }
  }

  const command = approval.command;
  const commandTitle = approval.kind === "command" ? "命令一次性审批" : "staged hash 单次审批";
  return (
    <section
      aria-label={commandTitle}
      aria-describedby={`approval-warning-${approval.id}`}
      className="execution-approval stack"
      role="dialog"
    >
      <h4>{commandTitle}</h4>
      <p>审批状态：{approvalStatusCopy[approval.status]}</p>
      <p>方式：一次性，仅此 attempt {execution.attemptNo}</p>
      <p>request hash：{shortHash(approval.requestHash)}</p>
      <p>input hash：{shortHash(approval.inputHash)}</p>
      {approval.stagedHash ? <p>staged hash：{shortHash(approval.stagedHash)}</p> : null}
      {command ? (
        <dl className="execution-review-facts">
          <div><dt>可执行文件：</dt><dd><code>{command.executable}</code></dd></div>
          <div><dt>参数：</dt><dd>{command.args.length === 0 ? "无" : (
            <ol>{command.args.map((arg, index) => <li key={`${index}-${arg}`}><code>{arg}</code></li>)}</ol>
          )}</dd></div>
          <div><dt>工作目录：</dt><dd><code>{command.workdir}</code></dd></div>
          <div><dt>预期效果：</dt><dd>{command.expectedEffect}</dd></div>
          <div><dt>权限：</dt><dd>{command.permission}</dd></div>
          <div><dt>风险：</dt><dd>{command.riskReasons.join("、") || "未报告"}</dd></div>
        </dl>
      ) : null}
      <p className="warning-text" id={`approval-warning-${approval.id}`}>
        {APPROVAL_WARNING}
      </p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {success ? <p aria-live="polite">{success}</p> : null}
      <div className="execution-review-actions">
        {approval.status === "pending" ? (
          <>
            <button disabled={pending} onClick={() => void decide("approve")} type="button">
              {approval.kind === "command" ? "批准命令" : "批准当前 staged hash"}
            </button>
            <button disabled={pending} onClick={() => void decide("reject")} type="button">拒绝</button>
            <button disabled={pending} onClick={() => void decide("replace")} type="button">替换请求</button>
          </>
        ) : null}
        {approval.status === "approved" ? (
          <>
            <button disabled={pending} onClick={() => void decide("revoke")} type="button">撤销批准</button>
            <button disabled={pending} onClick={() => void decide("replace")} type="button">替换请求</button>
          </>
        ) : null}
      </div>
    </section>
  );
}

function LoadMore({
  error,
  label,
  loading,
  nextCursor,
  onLoad,
}: {
  error: string | null;
  label: string;
  loading: boolean;
  nextCursor: string | null;
  onLoad: () => Promise<void>;
}) {
  return (
    <>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {nextCursor ? (
        <button disabled={loading} onClick={() => void onLoad()} type="button">
          加载更多{label}
        </button>
      ) : null}
    </>
  );
}

export function ExecutionReview({
  execution,
  onExecutionChanged,
  onMerge,
}: {
  execution: ExecutionDto;
  onExecutionChanged: (execution: ExecutionDto) => void;
  onMerge: (stagedHash: string) => void;
}) {
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"timeline" | "validation" | "changes">("timeline");
  const [approvalOverrides, setApprovalOverrides] = useState<Record<string, ExecutionApprovalDto>>({});
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const panelHeadingRef = useRef<HTMLHeadingElement>(null);

  const loadDetail = useCallback(async () => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const response = await fetch(`/api/executions/${execution.id}`);
      setDetail(await readResponse<ExecutionDetail>(
        response,
        "无法加载执行审阅，请重试。",
      ));
    } catch (cause: unknown) {
      setDetailError(
        `执行审阅：${caughtApiErrorCopy(cause, "无法加载执行审阅，请重试。")}`,
      );
    } finally {
      setDetailLoading(false);
    }
  }, [execution.id]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const events = usePagedResource<ExecutionEvent>(
    detail && activeTab === "timeline"
      ? `/api/executions/${execution.id}/events?limit=100`
      : null,
    "无法加载时间线，请重试。",
  );
  const approvals = usePagedResource<ExecutionApprovalDto>(
    detail && detail.counts.approvals > 0
      ? `/api/executions/${execution.id}/approvals?limit=10`
      : null,
    "无法加载审批，请重试。",
  );
  const validations = usePagedResource<Validation>(
    detail && detail.counts.validations > 0
      ? `/api/executions/${execution.id}/validations?limit=20`
      : null,
    "无法加载验证，请重试。",
  );
  const artifacts = usePagedResource<Artifact>(
    detail && activeTab === "validation" && detail.counts.artifacts > 0
      ? `/api/executions/${execution.id}/artifacts?limit=20`
      : null,
    "无法加载产物，请重试。",
  );
  const observations = usePagedResource<Observation>(
    detail?.staged && activeTab === "changes"
      ? `/api/executions/${execution.id}/staged/${detail.staged.id}/observations?limit=100`
      : null,
    "无法加载观察，请重试。",
  );
  const blockers = usePagedResource<Blocker>(
    detail?.staged && activeTab === "changes"
      ? `/api/executions/${execution.id}/staged/${detail.staged.id}/blockers?limit=100`
      : null,
    "无法加载阻断，请重试。",
  );

  const approvalItems = approvals.items.map((item) => approvalOverrides[item.id] ?? item);
  const commandApprovals = approvalItems.filter(({ kind }) => kind === "command");
  const stagedApproval = approvalItems.find(({ kind }) => kind === "staged_merge");
  const requiredValidations = validations.items.filter(({ required }) => true);
  const requiredFresh = requiredValidations.length > 0
    && requiredValidations.every((item) => item.succeeded && item.afterLastWrite);
  const readError = Boolean(
    detailError || events.error || approvals.error || validations.error
    || artifacts.error || observations.error || blockers.error,
  );

  function changeTab(next: typeof activeTab, focus = false) {
    setActiveTab(next);
    if (focus) {
      const index = ["timeline", "validation", "changes"].indexOf(next);
      requestAnimationFrame(() => tabRefs.current[index]?.focus());
    } else {
      requestAnimationFrame(() => panelHeadingRef.current?.focus());
    }
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const tabs: Array<typeof activeTab> = ["timeline", "validation", "changes"];
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(tabs[next]!);
    tabRefs.current[next]?.focus();
  }

  if (detailLoading) return <p aria-busy="true">正在加载执行审阅…</p>;
  if (detailError || !detail) {
    return (
      <div>
        <p className="error-text" role="alert">{detailError ?? "执行审阅不可用。"}</p>
        <button onClick={() => void loadDetail()} type="button">重试加载执行审阅</button>
      </div>
    );
  }

  return (
    <div className="execution-review stack">
      {commandApprovals.map((approval) => (
        <ApprovalCard
          approval={approval}
          execution={execution}
          key={approval.id}
          onChanged={(nextApproval, nextExecution) => {
            setApprovalOverrides((current) => ({ ...current, [nextApproval.id]: nextApproval }));
            onExecutionChanged(nextExecution);
          }}
        />
      ))}
      {approvals.loading && approvals.items.length === 0 ? (
        <p aria-busy="true">正在加载审批…</p>
      ) : approvals.error ? (
        <p className="error-text" role="alert">{approvals.error}</p>
      ) : null}
      <div aria-label="执行审阅" className="execution-review-tabs" role="tablist">
        {([
          ["timeline", "时间线"],
          ["validation", "验证"],
          ["changes", "变更"],
        ] as const).map(([id, label], index) => (
          <button
            aria-controls={`execution-${execution.id}-${id}`}
            aria-selected={activeTab === id}
            id={`execution-${execution.id}-${id}-tab`}
            key={id}
            onClick={() => changeTab(id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            ref={(element) => { tabRefs.current[index] = element; }}
            role="tab"
            tabIndex={activeTab === id ? 0 : -1}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "timeline" ? (
        <section
          aria-labelledby={`execution-${execution.id}-timeline-tab`}
          id={`execution-${execution.id}-timeline`}
          role="tabpanel"
        >
          <h4 ref={panelHeadingRef} tabIndex={-1}>时间线（{detail.counts.events}）</h4>
          <ResourceMessage empty="还没有时间线事件。" label="时间线" resource={events} />
          {events.items.length > 0 ? (
            <ol aria-label="执行时间线" className="execution-timeline" role="log">
              {events.items.map((event) => (
                <li key={event.id}>
                  <strong>{event.type}</strong>
                  <span>#{event.sequence} · {event.actorType}</span>
                </li>
              ))}
            </ol>
          ) : null}
          <LoadMore
            error={events.items.length > 0 ? events.error : null}
            label="时间线"
            loading={events.loading}
            nextCursor={events.nextCursor}
            onLoad={events.loadMore}
          />
        </section>
      ) : null}

      {activeTab === "validation" ? (
        <section
          aria-labelledby={`execution-${execution.id}-validation-tab`}
          id={`execution-${execution.id}-validation`}
          role="tabpanel"
        >
          <h4 ref={panelHeadingRef} tabIndex={-1}>验证与产物</h4>
          <ResourceMessage empty="还没有验证记录。" label="验证" resource={validations} />
          {validations.items.map((validation) => (
            <section className="execution-review-item stack" key={validation.id}>
              <h5>{validation.policyEntryId}</h5>
              <p>
                {validation.required ? "必需" : "可选"}
                {" · "}
                {validation.afterLastWrite ? "新鲜" : "已过期"}
                {" · "}
                {validation.succeeded ? "通过" : `失败（exit ${validation.exitCode}）`}
              </p>
              <p>由持续政策放行（standing approval） · 修订 #{detail.frozen.policyVersion}</p>
              <TextChunkReader
                header={validation.stdout}
                label="stdout"
                url={`/api/executions/${execution.id}/validations/${validation.id}/stdout/chunks`}
              />
              <TextChunkReader
                header={validation.stderr}
                label="stderr"
                url={`/api/executions/${execution.id}/validations/${validation.id}/stderr/chunks`}
              />
            </section>
          ))}
          <LoadMore
            error={validations.items.length > 0 ? validations.error : null}
            label="验证"
            loading={validations.loading}
            nextCursor={validations.nextCursor}
            onLoad={validations.loadMore}
          />
          <h5>产物（{detail.counts.artifacts}）</h5>
          <ResourceMessage empty="还没有文本产物。" label="产物" resource={artifacts} />
          {artifacts.items.map((artifact) => (
            <section className="execution-review-item stack" key={artifact.id}>
              <h6>{artifact.name}</h6>
              <p>
                {artifact.path} · {artifact.contentBytes} bytes · hash {shortHash(artifact.sha256)}
                {artifact.truncated ? " · 已截断" : " · 未截断"}
              </p>
              <TextChunkReader
                header={{
                  bytes: artifact.contentBytes,
                  sha256: artifact.sha256,
                  truncated: artifact.truncated,
                }}
                label={`artifact ${artifact.name}`}
                url={`/api/executions/${execution.id}/artifacts/${artifact.id}/chunks`}
              />
            </section>
          ))}
          <LoadMore
            error={artifacts.items.length > 0 ? artifacts.error : null}
            label="产物"
            loading={artifacts.loading}
            nextCursor={artifacts.nextCursor}
            onLoad={artifacts.loadMore}
          />
        </section>
      ) : null}

      {activeTab === "changes" ? (
        <section
          aria-labelledby={`execution-${execution.id}-changes-tab`}
          id={`execution-${execution.id}-changes`}
          role="tabpanel"
        >
          <h4 ref={panelHeadingRef} tabIndex={-1}>变更审阅</h4>
          {!detail.staged ? (
            <p>还没有 staged 变更。</p>
          ) : (
            <>
              <div className="execution-staged-summary stack">
                <p>观察到 {detail.staged.observedPathCount} 个路径 · {detail.staged.observedFinalBytes} bytes</p>
                <p>可合入边界 {detail.staged.mergeFileCount} 个文件 · {detail.staged.mergeFinalBytes} bytes</p>
                <p>staged hash：{shortHash(detail.staged.stagedHash)}</p>
                <p>
                  必需验证：
                  {validations.loading
                    ? "正在核对"
                    : requiredValidations.length === 0
                      ? "没有必需验证政策"
                      : requiredFresh ? "全部新鲜且通过" : "缺失、失败或已过期"}
                </p>
                <p>政策 hash：{shortHash(detail.frozen.policyHash)} · 修订 #{detail.frozen.policyVersion}</p>
                <p>
                  风险与边界：
                  {detail.staged.classification === "blocked"
                    ? `阻断 · 不可自动合入${detail.staged.blockReasons.length ? ` · ${detail.staged.blockReasons.join("、")}` : ""}`
                    : detail.staged.classification === "approval_required"
                      ? "需要 owner 对当前 staged hash 单次批准"
                      : "边界内且具备自动合入资格"}
                </p>
              </div>
              <div className="execution-review-actions">
                {detail.staged.classification === "auto_eligible"
                && execution.status === "staged"
                && requiredFresh
                && !readError ? (
                  <button
                    onClick={() => onMerge(detail.staged!.stagedHash)}
                    type="button"
                  >
                    自动合入当前变更
                  </button>
                ) : null}
                {detail.staged.classification === "approval_required" ? (
                  stagedApproval ? (
                    <ApprovalCard
                      approval={approvalOverrides[stagedApproval.id] ?? stagedApproval}
                      execution={execution}
                      onChanged={(nextApproval, nextExecution) => {
                        setApprovalOverrides((current) => ({
                          ...current,
                          [nextApproval.id]: nextApproval,
                        }));
                        onExecutionChanged(nextExecution);
                      }}
                    />
                  ) : (
                    <button
                      disabled={
                        execution.status !== "staged"
                        || readError
                        || validations.loading
                        || (requiredValidations.length > 0 && !requiredFresh)
                      }
                      type="button"
                    >
                      批准当前 staged hash {shortHash(detail.staged.stagedHash)}
                    </button>
                  )
                ) : null}
              </div>
              <h5>观察（{detail.staged.observedPathCount}）</h5>
              <ResourceMessage empty="没有 staged 观察。" label="观察" resource={observations} />
              <ol className="execution-review-list">
                {observations.items.map((observation) => (
                  <li className="execution-review-item" key={observation.id}>
                    <p>
                      <strong>{observation.path}</strong> · {observation.kind} · {observation.finalSize} bytes
                    </p>
                    <p>
                      baseline {shortHash(observation.baselineHash)}
                      {" · "}observed {shortHash(observation.observedHash)}
                    </p>
                    <DiffReader
                      executionId={execution.id}
                      observation={observation}
                      stagedId={detail.staged!.id}
                    />
                  </li>
                ))}
              </ol>
              <LoadMore
                error={observations.items.length > 0 ? observations.error : null}
                label="观察"
                loading={observations.loading}
                nextCursor={observations.nextCursor}
                onLoad={observations.loadMore}
              />
              <h5>阻断（{detail.staged.blockerCount}）</h5>
              <ResourceMessage empty="没有 staged 阻断。" label="阻断" resource={blockers} />
              <ol className="execution-review-list">
                {blockers.items.map((blocker) => (
                  <li className="execution-review-item" key={`${blocker.observationId}-${blocker.position}`}>
                    <strong>{blocker.path}</strong>
                    <p>{blocker.kind} · {blocker.detailCode}</p>
                  </li>
                ))}
              </ol>
              <LoadMore
                error={blockers.items.length > 0 ? blockers.error : null}
                label="阻断"
                loading={blockers.loading}
                nextCursor={blockers.nextCursor}
                onLoad={blockers.loadMore}
              />
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
