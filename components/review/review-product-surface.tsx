"use client";

import { useCallback, useEffect, useState } from "react";

import { MemoryPanel } from "@/components/project-context/memory-panel";
import { DeliveryPanel } from "@/components/review/delivery-panel";
import { ReviewAccessSurface } from "@/components/review/review-access-surface";
import { ReviewOutcomesPanel } from "@/components/review/review-outcomes-panel";
import { ReviewSlice } from "@/components/review/review-slice";
import { ReviewWorkspace } from "@/components/review/review-workspace";
import {
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";
import type {
  DeliveryVersionDto,
  MissionCompletionDto,
  ReviewAttemptDto,
  ReviewWorkspaceDto,
} from "@/src/shared/review-contracts";

type ReviewHistoryPage = {
  items: ReviewAttemptDto[];
  nextCursor: string | null;
};

type DeliveryHistoryPage = {
  items: DeliveryVersionDto[];
  nextCursor: string | null;
};

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    throw new Error(fallback);
  }
  return response.json() as Promise<T>;
}

function operationId(): string {
  return globalThis.crypto.randomUUID();
}

export function ReviewProductSurface({
  missionId,
  projectId,
  workItemId,
}: {
  missionId: string;
  projectId: string;
  workItemId: string;
}) {
  const [workspace, setWorkspace] = useState<ReviewWorkspaceDto | null>(null);
  const [history, setHistory] = useState<ReviewAttemptDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [answerSuccess, setAnswerSuccess] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    const next = await readJson<ReviewWorkspaceDto>(
      await fetch(`/api/work-items/${workItemId}/review`),
      "无法加载复核工作区。",
    );
    setWorkspace(next);
    return next;
  }, [workItemId]);

  const loadProductReview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadWorkspace();
      const historyPage = await readJson<ReviewHistoryPage>(
        await fetch(`/api/work-items/${workItemId}/reviews?limit=20`),
        "无法加载复核历史。",
      );
      setHistory(historyPage.items);
    } catch (cause: unknown) {
      setError(caughtApiErrorCopy(cause, "无法加载复核闭环，请重试。"));
    } finally {
      setLoading(false);
    }
  }, [loadWorkspace, workItemId]);

  useEffect(() => {
    void loadProductReview();
  }, [loadProductReview]);

  async function answerEscalation(input: {
    action: "continue_review" | "rework" | "terminate_mission";
    answer: string;
  }) {
    if (!workspace?.currentEscalation) throw new Error("没有待回答的升级问题。");
    const response = await readJson<{
      answer: { action: typeof input.action; state: string };
      workspace: ReviewWorkspaceDto;
    }>(
      await fetch(
        `/api/escalations/${workspace.currentEscalation.escalationId}/answer`,
        {
          body: JSON.stringify({
            ...input,
            expectedHeadVersion: workspace.headVersion,
            operationId: operationId(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
      "无法提交 Owner 回答。",
    );
    setWorkspace(response.workspace);
    setAnswerSuccess(
      response.answer.action === "continue_review"
        ? "已创建新复核 attempt"
        : response.answer.action === "rework"
        ? "已进入返工"
        : "使命已终止",
    );
    return {
      action: response.answer.action,
      state: response.answer.state,
    };
  }

  async function startReworkExecution() {
    const collaboration = await readJson<{
      run: { id: string; status: string } | null;
    }>(
      await fetch(`/api/projects/${projectId}/collaboration`),
      "无法读取当前协作运行。",
    );
    if (!collaboration.run || collaboration.run.status !== "planned") {
      throw new Error("需要最新的已规划协作运行。");
    }
    const response = await readJson<{ execution: { id: string } }>(
      await fetch(`/api/projects/${projectId}/executions`, {
        body: JSON.stringify({
          operationId: operationId(),
          sourceCollaborationRunId: collaboration.run.id,
          workItemId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      "无法创建返工 execution。",
    );
    return { executionId: response.execution.id };
  }

  const title = `${workspace?.workItem.title ?? "任务"} 复核闭环`;
  const currentResult = workspace?.result
    ? { id: workspace.result.id, version: workspace.result.version }
    : { id: "尚无结果", version: 0 };
  const escalation = workspace?.currentEscalation
    ? {
        answer: null,
        id: workspace.currentEscalation.escalationId,
        options: workspace.currentEscalation.options,
        question: workspace.currentEscalation.question,
      }
    : null;

  return (
    <ReviewAccessSurface
      sections={{
        answer: workspace?.result ? (
          <ReviewOutcomesPanel
            attempts={history}
            currentResult={currentResult}
            escalation={escalation}
            error={error}
            loading={loading}
            onAnswerEscalation={answerEscalation}
            onReload={() => void loadProductReview()}
            onStartExecution={startReworkExecution}
            workItemId={workItemId}
          />
        ) : <p>尚无可处理的复核结果。</p>,
        delivery: (
          <section className="stack">
            <h3>使命级最终交付</h3>
            <p>最终交付只在使命看板展示，不在每张 execution card 重复。</p>
            <a href={`#mission-delivery-${missionId}`}>前往使命最终交付</a>
          </section>
        ),
        memory: <MemoryPanel projectId={projectId} />,
        review: (
          <div className="stack">
            <ReviewSlice workItemId={workItemId} />
            <ReviewWorkspace
              history={history}
              load={loadWorkspace}
              projectId={projectId}
              workItemId={workItemId}
            />
          </div>
        ),
      }}
      states={{
        answer: loading
          ? { kind: "loading", message: "正在加载复核结果与升级问题" }
          : error
          ? { kind: "error", message: error }
          : answerSuccess
          ? { kind: "ready", message: answerSuccess }
          : escalation
          ? { kind: "ready", message: "有待 Owner 回答的升级问题" }
          : { kind: "empty", message: "尚无待回答问题" },
        delivery: { kind: "ready", message: "使命级交付入口可用" },
        memory: { kind: "ready", message: "共享记忆可查看与维护" },
        review: { kind: "ready", message: "复核工作区可用" },
      }}
      title={title}
    />
  );
}

export function MissionDeliverySurface({ missionId }: { missionId: string }) {
  const [completion, setCompletion] = useState<MissionCompletionDto | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryVersionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextCompletion, history] = await Promise.all([
        readJson<MissionCompletionDto>(
          await fetch(`/api/missions/${missionId}/delivery`),
          "无法加载最终交付进度。",
        ),
        readJson<DeliveryHistoryPage>(
          await fetch(`/api/missions/${missionId}/deliveries?limit=20`),
          "无法加载最终交付历史。",
        ),
      ]);
      setCompletion(nextCompletion);
      setDeliveries(history.items);
    } catch (cause: unknown) {
      setError(caughtApiErrorCopy(cause, "无法加载最终交付，请重试。"));
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !completion) {
    return <p aria-busy="true">正在加载最终交付…</p>;
  }
  if (!completion) {
    return (
      <section className="stack" id={`mission-delivery-${missionId}`}>
        <p className="error-text" role="status">{error ?? "最终交付不可用。"}</p>
        <button onClick={() => void load()} type="button">重试加载最终交付</button>
      </section>
    );
  }

  return (
    <div id={`mission-delivery-${missionId}`}>
      <DeliveryPanel
        completion={completion}
        deliveries={deliveries}
        error={error}
        loading={loading}
        onGenerate={async (input) => {
          const generated = await readJson<{
            delivery: DeliveryVersionDto | null;
            missionCompletion: MissionCompletionDto;
          }>(
            await fetch(`/api/missions/${missionId}/delivery`, {
              body: JSON.stringify({
                expectedHeadVersion: input.expectedVersion,
                operationId: input.operationId,
              }),
              headers: { "content-type": "application/json" },
              method: "POST",
            }),
            "无法生成最终交付。",
          );
          const nextDeliveries = generated.delivery
            ? [
                generated.delivery,
                ...deliveries.filter(({ id }) => id !== generated.delivery?.id),
              ]
            : deliveries;
          setCompletion(generated.missionCompletion);
          setDeliveries(nextDeliveries);
          return {
            completion: generated.missionCompletion,
            deliveries: nextDeliveries,
          };
        }}
        onReload={() => void load()}
      />
    </div>
  );
}
