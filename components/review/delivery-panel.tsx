"use client";

import { useEffect, useRef, useState } from "react";

import type { DeliveryBundle } from "@/src/server/review/delivery-service";

export type MissionCompletionDto = {
  blockers: Array<{ code: string; refId: string | null; workItemId: string | null }>;
  currentDeliveryId: string | null;
  lastErrorCode: string | null;
  missionId: string;
  state: "ongoing" | "generating" | "completed" | "owner_terminated";
  version: number;
};

export type DeliveryVersionDto = {
  bundle: DeliveryBundle;
  id: string;
  invalidatedReason: string | null;
  invalidatedWorkItemIds: string[];
  state: "completed" | "invalidated";
  version: number;
};

export type DeliveryPanelProps = {
  completion: MissionCompletionDto;
  deliveries: DeliveryVersionDto[];
  error?: string | null;
  loading?: boolean;
  onGenerate: (input: {
    expectedVersion: number;
    operationId: string;
  }) => Promise<{
    completion: MissionCompletionDto;
    deliveries: DeliveryVersionDto[];
  }>;
  onReload?: () => void;
};

const blockerLabels: Record<string, string> = {
  DELIVERY_CONTEXT_CHANGED: "交付上下文已变化",
  DELIVERY_INTERRUPTED: "交付生成已中断",
  LEGACY_DONE_UNREVIEWED: "旧完成状态未经独立复核",
  MEMORY_NOT_ACTIVE: "关联记忆已被取代",
  MISSION_COMPLETION_BLOCKED: "使命尚未满足最终完成条件",
  RESULT_SUPERSEDED: "结果版本已被取代",
  REVIEW_REQUIRED: "任务尚未通过独立复核",
  VALIDATION_REQUIRED: "必需验证或证据不可用",
};

const evidenceKindLabels: Record<DeliveryBundle["manifest"]["entries"][number]["kind"], string> = {
  artifact: "Artifact",
  diff: "Diff",
  execution_event: "Event",
  memory: "Memory",
  result: "Result",
  review: "Review",
  validation: "Validation",
};

function versionRef(
  label: string,
  reference: { href: string; id: string; version: string | number },
) {
  return (
    <a href={reference.href}>
      {label} {reference.id} · v{reference.version}
    </a>
  );
}

function blockerText(
  blocker: MissionCompletionDto["blockers"][number],
): string {
  const task = blocker.workItemId ? `任务 ${blocker.workItemId}` : "使命";
  const reference = blocker.refId ? ` · 引用 ${blocker.refId}` : "";
  return `${task} · ${blocker.code} · ${
    blockerLabels[blocker.code] ?? "尚未满足完成条件"
  }${reference}`;
}

function evidenceImpact(
  entry: DeliveryBundle["manifest"]["entries"][number],
): string {
  const ready = entry.status === "available" || entry.status === "passed";
  if (entry.required) {
    return ready ? "已满足完成条件" : "阻断最终完成";
  }
  return ready ? "可选证据已记录" : "不阻断完成，但限制已记录";
}

function DeliverySummary({ delivery }: { delivery: DeliveryVersionDto }) {
  const { manifest, summary } = delivery.bundle;
  return (
    <section aria-labelledby={`delivery-${delivery.id}-title`} className="stack">
      <h3 id={`delivery-${delivery.id}-title`} tabIndex={-1}>
        最终交付 v{delivery.version}
      </h3>
      {delivery.state === "invalidated" ? (
        <p className="error-text">
          已被后续任务变化取代
          {delivery.invalidatedReason ? ` · ${delivery.invalidatedReason}` : ""}
          {delivery.invalidatedWorkItemIds.length > 0
            ? ` · 受影响任务 ${delivery.invalidatedWorkItemIds.join("、")}`
            : ""}
        </p>
      ) : null}
      <p>使命结论：已完成</p>
      <p>{summary.mission.title} · {summary.mission.goal}</p>
      <p>完成时间：{summary.mission.completedAt}</p>

      <section aria-labelledby={`delivery-${delivery.id}-tasks`}>
        <h4 id={`delivery-${delivery.id}-tasks`}>逐任务交付事实</h4>
        <ul>
          {summary.tasks.map((task) => (
            <li
              aria-label={`交付任务 ${task.workItem.id}`}
              className="stack"
              key={task.workItem.id}
            >
              <h5>{task.workItem.title}</h5>
              <p>
                执行者：{task.executor.name} · 复核者：{task.reviewer.name}
              </p>
              <p>
                裁决：{task.decision.choice} · {task.decision.id} ·{" "}
                {task.decision.publicSummary}
              </p>
              <p>
                变更：{task.changes.mergeFileCount} 个文件 ·{" "}
                {task.changes.mergeFinalBytes} bytes · staged{" "}
                <code>{task.changes.stagedHash.slice(0, 12)}</code>
              </p>
              <p>{versionRef("Result", task.result)}</p>
              <p>
                验证：{task.validations.passedCount}/{task.validations.requiredCount} 必需项通过
              </p>
              <ul aria-label={`任务 ${task.workItem.id} 验证引用`}>
                {task.validations.refs.map((reference) => (
                  <li key={`${reference.id}-${reference.version}`}>
                    {versionRef("Validation", reference)}
                  </li>
                ))}
              </ul>
              <ul aria-label={`任务 ${task.workItem.id} 产物引用`}>
                {task.artifacts.map((reference) => (
                  <li key={`${reference.id}-${reference.version}`}>
                    {versionRef("Artifact", reference)}
                  </li>
                ))}
              </ul>
              <ul aria-label={`任务 ${task.workItem.id} 记忆引用`}>
                {task.memories.map((reference) => (
                  <li key={`${reference.id}-${reference.version}`}>
                    {versionRef("Memory", reference)}
                  </li>
                ))}
              </ul>
              {task.limitations.length > 0 ? (
                <div>
                  <p>已记录限制</p>
                  <ul>
                    {task.limitations.map((limitation) => (
                      <li key={limitation}>{limitation}</li>
                    ))}
                  </ul>
                </div>
              ) : <p>没有已记录限制。</p>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby={`delivery-${delivery.id}-evidence`}>
        <h4 id={`delivery-${delivery.id}-evidence`}>证据清单与影响</h4>
        <ul>
          {manifest.entries.map((entry) => (
            <li
              aria-label={`evidence ${entry.kind} ${entry.id}`}
              key={`${entry.kind}-${entry.id}-${entry.version}`}
            >
              <a href={entry.href}>
                {evidenceKindLabels[entry.kind]} {entry.id} · v{entry.version}
              </a>
              {" · "}{entry.status} · {entry.required ? "必需" : "可选"} ·{" "}
              {evidenceImpact(entry)}
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

export function DeliveryPanel({
  completion: completionProp,
  deliveries: deliveriesProp,
  error = null,
  loading = false,
  onGenerate,
  onReload,
}: DeliveryPanelProps) {
  const [completion, setCompletion] = useState(completionProp);
  const [deliveries, setDeliveries] = useState(deliveriesProp);
  const [selectedDeliveryId, setSelectedDeliveryId] = useState(
    completionProp.currentDeliveryId ?? deliveriesProp[0]?.id ?? null,
  );
  const [pending, setPending] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const completedHeading = useRef<HTMLHeadingElement>(null);
  const generateButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setCompletion(completionProp);
    setDeliveries(deliveriesProp);
    setSelectedDeliveryId((current) =>
      current && deliveriesProp.some(({ id }) => id === current)
        ? current
        : completionProp.currentDeliveryId ?? deliveriesProp[0]?.id ?? null);
  }, [completionProp, deliveriesProp]);

  if (loading) {
    return <p aria-busy="true">正在加载最终交付…</p>;
  }

  const selectedDelivery = deliveries.find(({ id }) => id === selectedDeliveryId)
    ?? (completion.currentDeliveryId
      ? deliveries.find(({ id }) => id === completion.currentDeliveryId)
      : undefined);
  const isGenerating = completion.state === "generating";
  const disabledReasons = completion.blockers.map(blockerText);
  if (completion.state === "owner_terminated") {
    disabledReasons.push("使命已由 Owner 终止");
  }
  const disabled = pending || isGenerating || disabledReasons.length > 0;
  const failureMessage = completion.lastErrorCode
    ? `${completion.lastErrorCode} · ${
        blockerLabels[completion.lastErrorCode] ?? "交付生成失败，请显式重试"
      }${completion.lastErrorCode === "DELIVERY_INTERRUPTED" ? "，请显式重试" : ""}`
    : null;
  const shownError = operationError ?? error ?? failureMessage;
  const isRetry = completion.lastErrorCode !== null;

  async function generate() {
    if (disabled) return;
    setPending(true);
    setOperationError(null);
    setAnnouncement(null);
    try {
      const result = await onGenerate({
        expectedVersion: completion.version,
        operationId: crypto.randomUUID(),
      });
      setCompletion(result.completion);
      setDeliveries(result.deliveries);
      const current = result.deliveries.find(
        ({ id }) => id === result.completion.currentDeliveryId,
      ) ?? result.deliveries[0];
      setSelectedDeliveryId(current?.id ?? null);
      setAnnouncement(
        current ? `最终交付 v${current.version} 已生成` : "最终交付已生成",
      );
      requestAnimationFrame(() => completedHeading.current?.focus());
    } catch {
      setOperationError("重试失败；已保留当前查看的交付版本，请显式重试。");
      generateButton.current?.focus();
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby={`delivery-${completion.missionId}-title`} className="stack">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">使命交付</p>
          <h2 id={`delivery-${completion.missionId}-title`}>最终交付进度</h2>
        </div>
        <span className="status-label">{completion.state}</span>
      </div>

      {isGenerating ? <p aria-busy="true">正在生成最终交付…</p> : null}
      {shownError ? <p className="error-text" role="alert">{shownError}</p> : null}
      {onReload ? (
        <button onClick={onReload} type="button">重新加载最终交付</button>
      ) : null}

      {completion.blockers.length > 0 ? (
        <section aria-labelledby={`delivery-${completion.missionId}-blockers`}>
          <h3 id={`delivery-${completion.missionId}-blockers`}>阻断项</h3>
          <ul aria-label="最终交付阻断项">
            {completion.blockers.map((blocker, index) => (
              <li key={`${blocker.code}-${blocker.workItemId}-${blocker.refId}-${index}`}>
                {blockerText(blocker)}
              </li>
            ))}
          </ul>
        </section>
      ) : completion.state === "ongoing" && !completion.lastErrorCode ? (
        <p>完成条件已具备，可以生成最终交付。</p>
      ) : null}

      {completion.state !== "completed" ? (
        <div className="stack">
          <p>尚未生成最终交付摘要；这里只显示真实完成状态与阻断事实。</p>
          <p id={`delivery-${completion.missionId}-disabled`}>
            {disabledReasons.length > 0
              ? `当前不可生成：${disabledReasons.join("；")}`
              : isGenerating
              ? "生成进行中；刷新不会自动继续或创建新生成。"
              : ""}
          </p>
          <button
            aria-describedby={`delivery-${completion.missionId}-disabled`}
            disabled={disabled}
            onClick={() => void generate()}
            ref={generateButton}
            type="button"
          >
            {isGenerating
              ? "正在生成最终交付"
              : pending
              ? "正在提交生成请求"
              : isRetry
              ? "显式重试生成最终交付"
              : "生成最终交付"}
          </button>
        </div>
      ) : null}

      {deliveries.length > 0 ? (
        <nav aria-label="最终交付版本">
          {deliveries.map((delivery) => {
            const isCurrent = delivery.id === completion.currentDeliveryId;
            const stateLabel = isCurrent ? "当前" : delivery.state === "invalidated"
              ? "已失效"
              : "历史";
            return (
              <button
                aria-current={isCurrent && selectedDeliveryId === delivery.id ? "page" : undefined}
                key={delivery.id}
                onClick={() => setSelectedDeliveryId(delivery.id)}
                type="button"
              >
                查看交付 v{delivery.version}（{stateLabel}）
              </button>
            );
          })}
        </nav>
      ) : null}

      {selectedDelivery ? (
        <div ref={(node) => {
          completedHeading.current = node?.querySelector("h3") ?? null;
        }}>
          <DeliverySummary delivery={selectedDelivery} />
        </div>
      ) : null}
      {announcement ? (
        <p aria-label="最终交付生成结果" aria-live="polite" role="status">
          {announcement}
        </p>
      ) : null}
    </section>
  );
}
