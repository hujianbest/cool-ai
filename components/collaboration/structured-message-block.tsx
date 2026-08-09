"use client";

import { useEffect, useRef, useState } from "react";

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
  const [staleVersion, setStaleVersion] = useState<number | null>(null);
  const [staleAction, setStaleAction] = useState<{
    action: DecisionAction;
    itemId?: string;
  } | null>(null);
  const [projection, setProjection] = useState<SourceProjection | null>(null);
  const [sourcePending, setSourcePending] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    setPending(false);
    setError(null);
    setReceipt(null);
    setStaleVersion(null);
    setStaleAction(null);
    setProjection(null);
    setSourcePending(false);
    setSourceError(null);
  }, [targetKey, block.id]);

  useEffect(() => {
    if (receipt) resultRef.current?.focus();
  }, [receipt]);

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

  const terminalProposal = knownBlock.kind === "proposal"
    && knownBlock.state.status !== "pending";
  const disabled = pending || receipt !== null || staleVersion !== null || terminalProposal;

  async function readHead(version: number, request: ReturnType<typeof guard.capture>) {
    try {
      const response = await fetch(endpoint(knownBlock), { signal: request.signal });
      const payload = await response.json() as unknown;
      if (
        !response.ok
        || !record(payload)
        || !record(payload.block)
        || payload.block.kind !== "known"
        || payload.block.blockRevision !== knownBlock.blockRevision
        || !record(payload.block.state)
        || payload.block.stateVersion !== version
      ) throw new Error("invalid head");
      if (request.isCurrent()) {
        setStaleVersion(version);
        setError(`状态版本已变为 ${version}。请核对后显式重新提交。`);
      }
    } catch {
      if (request.isCurrent()) setError("状态已变化，但无法安全读取当前版本。");
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
      if (version !== null && request.isCurrent()) {
        setStaleAction({ action, ...(itemId ? { itemId } : {}) });
        await readHead(version, request);
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
    expectedStateVersion = block.stateVersion,
  ) {
    if (pending || receipt || terminalProposal) return;
    const operationId = crypto.randomUUID();
    const request = guard.capture();
    setPending(true);
    setError(null);
    setStaleVersion(null);
    setStaleAction(null);
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
            knownBlock,
            operationId,
            action,
            itemId,
            expectedStateVersion,
          )
        : null;
      if (completed) {
        if (request.isCurrent()) setReceipt(completed);
        return;
      }
      const version = conflictVersion(payload);
      if (version !== null) {
        if (request.isCurrent()) setStaleAction({ action, ...(itemId ? { itemId } : {}) });
        await readHead(version, request);
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

  return (
    <section
      aria-busy={pending}
      aria-label={block.title}
      className="structured-block"
    >
      <h5>{block.title}</h5>
      <p className="muted">
        {block.actorLabel} · schema {block.blockSchemaVersion} · revision{" "}
        {block.blockRevision} · state {staleVersion ?? block.stateVersion} ·{" "}
        {block.sourceLabel}
      </p>
      {block.body ? <p>{block.body}</p> : null}
      {block.kind === "file_reference" && block.fileName ? <p>{block.fileName}</p> : null}
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
              disabled={sourcePending}
              onClick={() => void loadSource()}
              type="button"
            >
              {sourcePending ? "正在核对来源…" : "核对并查看安全来源"}
            </button>
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
      {block.kind === "proposal" ? (
        <div className="structured-block-actions">
          <button
            aria-label="接受 Proposal"
            disabled={disabled}
            onClick={() => void decide("accept")}
            type="button"
          >
            接受
          </button>
          <button
            aria-label="拒绝 Proposal"
            disabled={disabled}
            onClick={() => void decide("reject")}
            type="button"
          >
            拒绝
          </button>
        </div>
      ) : null}
      {block.kind === "checklist" && block.items ? (
        <ul className="structured-checklist">
          {block.items.map((item) => (
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
        <p>Proposal 已决定为 {String(block.state.status)}，终态不可改写。</p>
      ) : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {staleVersion !== null && staleAction ? (
        <button
          onClick={() =>
            void decide(staleAction.action, staleAction.itemId, staleVersion)
          }
          type="button"
        >
          按状态版本 {staleVersion} 重新提交
          {staleAction.action === "accept"
            ? "接受"
            : staleAction.action === "reject"
              ? "拒绝"
              : staleAction.action === "check_item"
                ? "勾选"
                : "取消勾选"}
        </button>
      ) : null}
      {receipt ? (
        <p
          aria-label={`${block.kind === "proposal" ? "Proposal" : "Checklist"} 决定结果`}
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
