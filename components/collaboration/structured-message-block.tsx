"use client";

import { GitCommit } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useTargetRequestGuard } from "@/components/collaboration/use-target-request-guard";
import type {
  TranscriptBlock,
  TranscriptKnownBlock,
} from "@/src/shared/transcript-model";

type DecisionAction = "accept" | "reject" | "check_item" | "uncheck_item";
type Receipt = {
  action: DecisionAction;
  blockId: string;
  blockRevision: number;
  decisionId: string;
  fromStateVersion: number;
  itemId?: string;
  operationId: string;
  receiptId: string;
  receiptSchemaVersion: number;
  requestHash: string;
  toStateVersion: number;
};
type SourceProjection = {
  display: {
    fromAgentId?: string;
    name?: string;
    preview?: string;
    summary?: string;
    toAgentId?: string;
  };
  executionId?: string;
  runId?: string;
  version: string;
};

export type StructuredMessageBlockProps = {
  block: TranscriptBlock;
  targetKey: string;
};

const formalTypeLabels: Record<TranscriptKnownBlock["kind"], string> = {
  checklist: "Checklist",
  diff_preview: "Diff Preview",
  file_reference: "File Reference",
  handoff_card: "Handoff Card",
  proposal: "Proposal",
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function completedReceipt(
  value: unknown,
  block: TranscriptKnownBlock,
  operationId: string,
  action: DecisionAction,
  itemId: string | undefined,
  expectedStateVersion: number,
): Receipt | null {
  if (!record(value) || value.kind !== "completed" || !record(value.receipt)) return null;
  const receipt = value.receipt;
  if (
    receipt.operationId !== operationId
    || receipt.blockId !== block.id
    || receipt.blockRevision !== block.blockRevision
    || receipt.action !== action
    || receipt.receiptSchemaVersion !== 1
    || receipt.fromStateVersion !== expectedStateVersion
    || receipt.toStateVersion !== expectedStateVersion + 1
    || typeof receipt.decisionId !== "string"
    || typeof receipt.receiptId !== "string"
    || typeof receipt.requestHash !== "string"
    || !/^[0-9a-f]{64}$/.test(receipt.requestHash)
    || (itemId === undefined ? "itemId" in receipt : receipt.itemId !== itemId)
  ) return null;
  return receipt as Receipt;
}

function conflictVersion(value: unknown): number | null {
  if (
    !record(value)
    || value.kind !== "version_conflict"
    || !Number.isSafeInteger(value.currentStateVersion)
    || Number(value.currentStateVersion) < 1
    || !record(value.error)
    || value.error.code !== "VERSION_CONFLICT"
  ) return null;
  return Number(value.currentStateVersion);
}

function latestBlock(
  value: unknown,
  current: TranscriptKnownBlock,
  minStateVersion: number,
): TranscriptKnownBlock | null {
  if (!record(value) || !record(value.block) || value.block.kind !== "known") return null;
  const raw = value.block;
  const payload = raw.payload;
  const state = raw.state;
  if (
    !record(payload)
    || !record(state)
    || !record(raw.actor)
    || typeof raw.actor.displayName !== "string"
    || raw.blockRevision !== current.blockRevision
    || raw.blockSchemaVersion !== current.blockSchemaVersion
    || raw.blockType !== current.kind
    || payload.blockType !== current.kind
    || !Number.isSafeInteger(raw.stateVersion)
    || Number(raw.stateVersion) < minStateVersion
    || state.stateVersion !== raw.stateVersion
    || !record(raw.source)
    || raw.source.id !== current.source.id
    || raw.source.kind !== current.source.kind
    || raw.source.version !== current.source.entityVersion
    || typeof payload.title !== "string"
  ) return null;
  const common = {
    ...current,
    actorLabel: raw.actor.displayName,
    payload,
    state,
    stateVersion: Number(raw.stateVersion),
    title: payload.title,
  };
  if (
    current.kind === "proposal"
    && typeof payload.body === "string"
    && Array.isArray(payload.actions)
    && JSON.stringify(payload.actions) === JSON.stringify(["accept", "reject"])
    && ["pending", "accepted", "rejected"].includes(String(state.status))
  ) {
    return { ...common, body: payload.body, kind: "proposal" };
  }
  if (
    current.kind === "checklist"
    && Array.isArray(payload.actions)
    && JSON.stringify(payload.actions) === JSON.stringify(["check_item", "uncheck_item"])
    && Array.isArray(payload.items)
    && Array.isArray(state.items)
  ) {
    const checked = new Map<string, boolean>();
    for (const item of state.items) {
      if (!record(item) || typeof item.id !== "string" || typeof item.checked !== "boolean") {
        return null;
      }
      checked.set(item.id, item.checked);
    }
    const items: Array<{ checked: boolean; id: string; text: string }> = [];
    for (const item of payload.items) {
      if (!record(item) || typeof item.id !== "string" || typeof item.text !== "string"
        || !checked.has(item.id)) {
        return null;
      }
      items.push({ checked: checked.get(item.id) ?? false, id: item.id, text: item.text });
    }
    if (items.length !== checked.size) return null;
    return { ...common, items, kind: "checklist" };
  }
  return null;
}

function endpoint(block: TranscriptKnownBlock): string {
  const source = block.source;
  return `/api/projects/${encodeURIComponent(source.projectId)}`
    + `/threads/${encodeURIComponent(source.threadId)}`
    + `/runs/${encodeURIComponent(source.runId ?? "")}`
    + `/messages/${encodeURIComponent(source.messageId)}`
    + `/blocks/${encodeURIComponent(block.id)}`;
}

function operationEndpoint(
  block: TranscriptKnownBlock,
  operationId: string,
): string {
  const source = block.source;
  return `/api/projects/${encodeURIComponent(source.projectId)}`
    + `/threads/${encodeURIComponent(source.threadId)}`
    + `/runs/${encodeURIComponent(source.runId ?? "")}`
    + `/operations/${encodeURIComponent(operationId)}`;
}

function canonicalRunHref(block: TranscriptKnownBlock, runId: string): string {
  const query = new URLSearchParams({
    thread: block.source.threadId,
    run: runId,
  });
  return `/projects/${encodeURIComponent(block.source.projectId)}?${query.toString()}`;
}

function sourceProjection(
  value: unknown,
  block: TranscriptKnownBlock,
): SourceProjection | null {
  if (
    !record(value)
    || !record(value.display)
    || !record(value.navigation)
    || !record(value.source)
    || value.source.id !== block.source.id
    || value.source.kind !== block.source.kind
    || value.source.version !== block.source.entityVersion
    || value.navigation.sourceId !== block.source.id
    || typeof value.source.version !== "string"
  ) return null;
  if (
    block.kind === "diff_preview"
    && typeof value.display.preview === "string"
    && typeof value.navigation.executionId === "string"
  ) {
    return {
      display: { preview: value.display.preview },
      executionId: value.navigation.executionId,
      version: value.source.version,
    };
  }
  if (
    block.kind === "file_reference"
    && typeof value.display.name === "string"
    && typeof value.navigation.executionId === "string"
  ) {
    return {
      display: { name: value.display.name },
      executionId: value.navigation.executionId,
      version: value.source.version,
    };
  }
  if (
    block.kind === "handoff_card"
    && typeof value.display.fromAgentId === "string"
    && typeof value.display.summary === "string"
    && typeof value.display.toAgentId === "string"
    && typeof value.navigation.runId === "string"
    && value.navigation.runId === block.source.runId
  ) {
    return {
      display: {
        fromAgentId: value.display.fromAgentId,
        summary: value.display.summary,
        toAgentId: value.display.toAgentId,
      },
      runId: value.navigation.runId,
      version: value.source.version,
    };
  }
  return null;
}

export function StructuredMessageBlock({
  block,
  targetKey,
}: StructuredMessageBlockProps) {
  const guard = useTargetRequestGuard(targetKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [conflict, setConflict] = useState<{
    action: DecisionAction;
    itemId?: string;
    minStateVersion: number;
  } | null>(null);
  const [latest, setLatest] = useState<TranscriptKnownBlock | null>(null);
  const [latestLoading, setLatestLoading] = useState(false);
  const [latestError, setLatestError] = useState<string | null>(null);
  const [projection, setProjection] = useState<SourceProjection | null>(null);
  const [sourcePending, setSourcePending] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const conflictRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    setPending(false);
    setError(null);
    setReceipt(null);
    setConflict(null);
    setLatest(null);
    setLatestLoading(false);
    setLatestError(null);
    setProjection(null);
    setSourcePending(false);
    setSourceError(null);
  }, [targetKey, block.id]);

  useEffect(() => {
    if (receipt) resultRef.current?.focus();
  }, [receipt]);

  useEffect(() => {
    if (conflict) conflictRef.current?.focus();
  }, [conflict]);

  if (block.kind === "unknown") {
    return (
      <section
        aria-label="不支持的结构化消息"
        className="structured-block structured-block-unknown"
      >
        <h5>不支持的结构化消息</h5>
        <p>此版本不可执行；其他协作事实仍可继续阅读。</p>
        <p className="muted">
          {block.actorLabel} · schema {block.blockSchemaVersion} · revision{" "}
          {block.blockRevision} · state {block.stateVersion} · {block.sourceLabel}
        </p>
      </section>
    );
  }
  const knownBlock = block;
  const displayBlock = latest ?? knownBlock;

  const terminalProposal = displayBlock.kind === "proposal"
    && displayBlock.state.status !== "pending";
  const reconciling = conflict !== null
    && (latest === null || latestLoading || latestError !== null);
  const disabled = pending || receipt !== null || reconciling || terminalProposal;

  async function loadLatest(
    request: ReturnType<typeof guard.capture>,
    minStateVersion: number,
  ) {
    if (!request.isCurrent()) return;
    setLatestLoading(true);
    setLatestError(null);
    try {
      const response = await fetch(endpoint(knownBlock), { signal: request.signal });
      const payload = await response.json().catch(() => null);
      const next = response.ok ? latestBlock(payload, knownBlock, minStateVersion) : null;
      if (!next) throw new Error("invalid latest");
      if (request.isCurrent()) {
        setLatest(next);
        setLatestError(null);
      }
    } catch {
      if (request.isCurrent()) {
        setLatestError("无法读取服务端最新状态；旧动作保持禁用，不会自动重新提交。");
      }
    } finally {
      if (request.isCurrent()) setLatestLoading(false);
    }
  }

  function enterConflict(
    action: DecisionAction,
    itemId: string | undefined,
    version: number,
    request: ReturnType<typeof guard.capture>,
  ) {
    if (request.isCurrent()) {
      setConflict({ action, ...(itemId ? { itemId } : {}), minStateVersion: version });
      setLatestError(null);
      setError(null);
    }
  }

  async function reconcile(
    operationId: string,
    action: DecisionAction,
    itemId: string | undefined,
    expectedStateVersion: number,
    request: ReturnType<typeof guard.capture>,
  ) {
    try {
      const response = await fetch(
        operationEndpoint(knownBlock, operationId),
        { signal: request.signal },
      );
      const payload = await response.json() as unknown;
      const completed = response.ok
        ? completedReceipt(
            payload,
            knownBlock,
            operationId,
            action,
            itemId,
            expectedStateVersion,
          )
        : null;
      if (completed && request.isCurrent()) {
        setReceipt(completed);
        setError(null);
        return;
      }
      const version = conflictVersion(payload);
      if (version !== null) {
        enterConflict(action, itemId, version, request);
        await loadLatest(request, version);
        return;
      }
      if (request.isCurrent()) {
        setError("无法确认决定结果；仅完成了 operation 对账，不会自动重新提交。");
      }
    } catch {
      if (request.isCurrent()) {
        setError("无法确认决定结果；仅完成了 operation 对账，不会自动重新提交。");
      }
    }
  }

  async function decide(
    action: DecisionAction,
    itemId?: string,
  ) {
    const expectedStateVersion = displayBlock.stateVersion;
    if (pending || receipt || terminalProposal || reconciling) return;
    const operationId = crypto.randomUUID();
    const request = guard.capture();
    setPending(true);
    setError(null);
    let responseReceived = false;
    try {
      const response = await fetch(`${endpoint(knownBlock)}/decision`, {
        body: JSON.stringify({
          action,
          expectedStateVersion,
          ...(itemId ? { itemId } : {}),
          operationId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: request.signal,
      });
      responseReceived = true;
      const payload = await response.json() as unknown;
      const completed = response.ok
        ? completedReceipt(
            payload,
            displayBlock,
            operationId,
            action,
            itemId,
            expectedStateVersion,
          )
        : null;
      if (completed) {
        if (request.isCurrent()) {
          setReceipt(completed);
          setConflict(null);
        }
        return;
      }
      const version = conflictVersion(payload);
      if (version !== null) {
        enterConflict(action, itemId, version, request);
        await loadLatest(request, version);
        return;
      }
      if (request.isCurrent()) setError("决定响应无效，未显示成功。");
    } catch {
      if (!responseReceived && request.isCurrent()) {
        await reconcile(operationId, action, itemId, expectedStateVersion, request);
      } else if (request.isCurrent()) {
        setError("决定请求失败，未显示成功。");
      }
    } finally {
      if (request.isCurrent()) setPending(false);
    }
  }

  async function loadSource() {
    if (
      sourcePending
      || (knownBlock.kind !== "diff_preview"
        && knownBlock.kind !== "file_reference"
        && knownBlock.kind !== "handoff_card")
    ) return;
    const request = guard.capture();
    setSourcePending(true);
    setSourceError(null);
    try {
      const response = await fetch(`${endpoint(knownBlock)}/source`, {
        body: JSON.stringify({
          source: {
            id: knownBlock.source.id,
            kind: knownBlock.source.kind,
            version: knownBlock.source.entityVersion,
          },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: request.signal,
      });
      const payload = await response.json() as unknown;
      const next = response.ok ? sourceProjection(payload, knownBlock) : null;
      if (!next) throw new Error("invalid source");
      if (request.isCurrent()) setProjection(next);
    } catch {
      if (request.isCurrent()) setSourceError("来源不可用；未读取宿主路径，也不会回退到最新来源。");
    } finally {
      if (request.isCurrent()) setSourcePending(false);
    }
  }

  const typeLabel = formalTypeLabels[displayBlock.kind];
  const regionLabel = displayBlock.title === typeLabel
    ? typeLabel
    : `${typeLabel}：${displayBlock.title}`;

  function handleProposalKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (displayBlock.kind !== "proposal") return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.nativeEvent.isComposing) return;
    const target = event.target;
    if (
      target instanceof HTMLElement
      && (target.tagName === "INPUT"
        || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT"
        || target.isContentEditable)
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key !== "a" && key !== "r") return;
    if (disabled) return;
    event.preventDefault();
    void decide(key === "a" ? "accept" : "reject");
  }

  return (
    <section
      aria-busy={pending || sourcePending}
      aria-label={regionLabel}
      className={
        displayBlock.kind === "proposal"
          ? "structured-block block-card"
          : "structured-block"
      }
      onKeyDown={
        displayBlock.kind === "proposal" ? handleProposalKeyDown : undefined
      }
      tabIndex={displayBlock.kind === "proposal" ? 0 : undefined}
    >
      {displayBlock.kind === "proposal" ? (
        <div className="block-card-header">
          <h5 className="block-card-title">{displayBlock.title}</h5>
          <span className="block-card-tag">PROPOSAL</span>
        </div>
      ) : (
        <h5>{displayBlock.title}</h5>
      )}
      <p className="muted block-provenance sr-only">
        {displayBlock.actorLabel} · schema {displayBlock.blockSchemaVersion} · revision{" "}
        {displayBlock.blockRevision} · state {displayBlock.stateVersion} ·{" "}
        {displayBlock.sourceLabel}
      </p>
      {displayBlock.body ? <p>{displayBlock.body}</p> : null}
      {displayBlock.kind === "proposal" ? (
        <p className="source-tag">
          <GitCommit aria-hidden="true" size={12} weight="bold" />
          <span>冻结来源: {displayBlock.sourceLabel}</span>
        </p>
      ) : null}
      {block.kind === "diff_preview"
        || block.kind === "file_reference"
        || block.kind === "handoff_card" ? (
          <>
            <button
              aria-label={block.kind === "file_reference"
                ? "打开 File Reference 安全来源"
                : block.kind === "diff_preview"
                  ? "加载 Diff Preview 安全来源"
                  : "加载 Handoff Card 安全来源"}
              className={block.kind === "file_reference" ? "source-tag" : undefined}
              disabled={sourcePending}
              onClick={() => void loadSource()}
              type="button"
            >
              {block.kind === "file_reference" ? (
                <>
                  <GitCommit aria-hidden="true" size={12} weight="bold" />
                  <span>
                    {sourcePending
                      ? "正在核对来源…"
                      : (block.fileName ?? "核对并查看安全来源")}
                  </span>
                </>
              ) : sourcePending ? "正在核对来源…" : "核对并查看安全来源"}
            </button>
            {sourcePending ? (
              <p className="muted" role="status">正在核对来源，请稍候…</p>
            ) : null}
            {!sourcePending && projection ? (
              <p className="muted" role="status">来源已核对，以下显示安全投影。</p>
            ) : null}
            {sourceError ? <p className="error-text" role="alert">{sourceError}</p> : null}
            {projection ? (
              <div className="structured-source-projection">
                <p className="muted">source version {projection.version}</p>
                {projection.display.preview ? (
                  <pre aria-label="脱敏 Diff Preview">{projection.display.preview}</pre>
                ) : null}
                {projection.display.name ? <p>{projection.display.name}</p> : null}
                {projection.display.summary ? (
                  <p>
                    {projection.display.fromAgentId} → {projection.display.toAgentId}
                    {" · "}{projection.display.summary}
                  </p>
                ) : null}
                {projection.executionId ? (
                  <div className="structured-block-actions">
                    <a
                      aria-label={projection.display.name
                        ? `在 execution 中查看 ${projection.display.name}`
                        : `前往 execution ${projection.executionId}`}
                      href={`${canonicalRunHref(
                        knownBlock,
                        knownBlock.source.runId ?? "",
                      )}#execution-${encodeURIComponent(projection.executionId)}-title`}
                    >
                      前往 execution
                    </a>
                    <a
                      aria-label="前往正式 Approval surface"
                      href={`${canonicalRunHref(
                        knownBlock,
                        knownBlock.source.runId ?? "",
                      )}#execution-${encodeURIComponent(projection.executionId)}-title`}
                    >
                      前往正式 Approval
                    </a>
                  </div>
                ) : null}
                {projection.runId ? (
                  <a
                    aria-label="查看既有 handoff 运行"
                    href={canonicalRunHref(knownBlock, projection.runId)}
                  >
                    查看既有 handoff 运行
                  </a>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      {conflict ? (
        <p className="error-text" ref={conflictRef} role="alert" tabIndex={-1}>
          {latest && !latestLoading && !latestError
            ? `决定未提交：服务端状态已变化。上方为最新完整 ${
              displayBlock.kind === "proposal" ? "Proposal" : "Checklist"
            }（状态版本 ${latest.stateVersion}），请核对最新事实后显式决定。`
            : latestError && !latestLoading
              ? latestError
              : "决定未提交：服务端状态已变化，正在读取最新状态…"}
        </p>
      ) : null}
      {conflict && latestError && !latestLoading ? (
        <button
          onClick={() => {
            const request = guard.capture();
            void loadLatest(request, conflict.minStateVersion);
          }}
          type="button"
        >
          重新读取最新状态
        </button>
      ) : null}
      {displayBlock.kind === "proposal" ? (
        <div className="structured-block-actions block-actions">
          <button
            aria-label="接受 Proposal"
            className="btn-block-primary"
            disabled={disabled}
            onClick={() => void decide("accept")}
            type="button"
          >
            批准方案
          </button>
          <button
            aria-label="拒绝 Proposal"
            className="btn-block-secondary"
            disabled={disabled}
            onClick={() => void decide("reject")}
            type="button"
          >
            驳回
          </button>
        </div>
      ) : null}
      {displayBlock.kind === "checklist" && displayBlock.items ? (
        <ul className="structured-checklist">
          {displayBlock.items.map((item) => (
            <li key={item.id}>
              <button
                aria-label={`${item.checked ? "取消勾选" : "勾选"} ${item.text}`}
                aria-pressed={item.checked}
                disabled={disabled}
                onClick={() =>
                  void decide(item.checked ? "uncheck_item" : "check_item", item.id)
                }
                type="button"
              >
                {item.checked ? "已完成" : "未完成"}
              </button>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {pending ? <p aria-live="polite">正在提交并等待事实回执…</p> : null}
      {terminalProposal ? (
        <p>Proposal 已决定为 {String(displayBlock.state.status)}，终态不可改写。</p>
      ) : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {receipt ? (
        <p
          aria-label={`${displayBlock.kind === "proposal" ? "Proposal" : "Checklist"} 决定结果`}
          ref={resultRef}
          role="status"
          tabIndex={-1}
        >
          已完成：Receipt {receipt.receiptId} · {receipt.action} · 状态版本{" "}
          {receipt.fromStateVersion} → {receipt.toStateVersion}
        </p>
      ) : null}
    </section>
  );
}
