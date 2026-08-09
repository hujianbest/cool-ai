// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import * as reviewComponents from "@/components/review/review-slice";
import type { DeliveryBundle } from "@/src/modules/review-delivery";

type CompletionDto = {
  blockers: Array<{ code: string; refId: string | null; workItemId: string | null }>;
  currentDeliveryId: string | null;
  lastErrorCode: string | null;
  missionId: string;
  state: "ongoing" | "generating" | "completed" | "owner_terminated";
  version: number;
};

type DeliveryVersionDto = {
  bundle: DeliveryBundle;
  id: string;
  invalidatedReason: string | null;
  invalidatedWorkItemIds: string[];
  state: "completed" | "invalidated";
  version: number;
};

type DeliveryPanelProps = {
  completion: CompletionDto;
  deliveries: DeliveryVersionDto[];
  error?: string | null;
  loading?: boolean;
  onGenerate: (input: {
    expectedVersion: number;
    operationId: string;
  }) => Promise<{ completion: CompletionDto; deliveries: DeliveryVersionDto[] }>;
  onReload?: () => void;
};

const optionalComponents = reviewComponents as typeof reviewComponents & {
  DeliveryPanel?: React.ComponentType<DeliveryPanelProps>;
};

function DeliveryPanel(props: DeliveryPanelProps) {
  const Component = optionalComponents.DeliveryPanel;
  expect(Component, "T-22 delivery panel must exist").toBeTypeOf("function");
  return <Component {...props} />;
}

const NOW = "2026-08-01T12:00:00.000Z";
const HASH = "a".repeat(64);

const bundle: DeliveryBundle = {
  blockers: [],
  inputFingerprint: "b".repeat(64),
  manifest: {
    entries: [
      {
        href: "/results/result-1?version=2",
        id: "result-1",
        kind: "result",
        required: true,
        sha256: HASH,
        status: "available",
        version: "2",
      },
      {
        href: "/reviews/review-1?version=review-v2",
        id: "review-1",
        kind: "review",
        required: true,
        sha256: HASH,
        status: "passed",
        version: "review-v2",
      },
      {
        href: "/validations/validation-1?version=policy-v3",
        id: "validation-1",
        kind: "validation",
        required: true,
        sha256: HASH,
        status: "passed",
        version: "policy-v3",
      },
      {
        href: "/artifacts/artifact-optional?version=sha256%3Aartifact",
        id: "artifact-optional",
        kind: "artifact",
        required: false,
        sha256: null,
        status: "missing",
        version: "sha256:artifact",
      },
      {
        href: "/memories/memory-1?version=4",
        id: "memory-1",
        kind: "memory",
        required: true,
        sha256: HASH,
        status: "available",
        version: "4",
      },
    ],
    inputFingerprint: "b".repeat(64),
    schemaVersion: 1,
  },
  summary: {
    mission: {
      completedAt: NOW,
      conclusion: "completed",
      goal: "交付可核验结果",
      id: "mission-1",
      title: "最终交付",
    },
    tasks: [{
      artifacts: [{
        href: "/artifacts/artifact-optional?version=sha256%3Aartifact",
        id: "artifact-optional",
        version: "sha256:artifact",
      }],
      changes: {
        mergeFileCount: 3,
        mergeFinalBytes: 2048,
        stagedHash: HASH,
      },
      decision: {
        choice: "pass",
        id: "decision-1",
        publicSummary: "公开复核已通过。",
      },
      execution: {
        id: "execution-1",
        sourceCollaborationRunId: "run-1",
        sourceCollaborationThreadId: "thread-1",
        sourceHref: "/projects/project-1?thread=thread-1&run=run-1",
      },
      executor: { agentId: "executor-1", name: "执行 Agent" },
      limitations: ["可选产物来源缺失"],
      memories: [{
        href: "/memories/memory-1?version=4",
        id: "memory-1",
        version: "4",
      }],
      result: {
        href: "/results/result-1?version=2",
        id: "result-1",
        version: 2,
      },
      reviewer: { agentId: "reviewer-1", name: "复核 Agent" },
      validations: {
        passedCount: 1,
        refs: [{
          href: "/validations/validation-1?version=policy-v3",
          id: "validation-1",
          version: "policy-v3",
        }],
        requiredCount: 1,
      },
      workItem: { id: "work-1", title: "完成公开交付" },
    }],
  },
};

const completedDelivery: DeliveryVersionDto = {
  bundle,
  id: "delivery-2",
  invalidatedReason: null,
  invalidatedWorkItemIds: [],
  state: "completed",
  version: 2,
};

function completion(
  overrides: Partial<CompletionDto> = {},
): CompletionDto {
  return {
    blockers: [],
    currentDeliveryId: null,
    lastErrorCode: null,
    missionId: "mission-1",
    state: "ongoing",
    version: 7,
    ...overrides,
  };
}

function props(overrides: Partial<DeliveryPanelProps> = {}): DeliveryPanelProps {
  return {
    completion: completion(),
    deliveries: [],
    onGenerate: vi.fn().mockResolvedValue({
      completion: completion({
        currentDeliveryId: completedDelivery.id,
        state: "completed",
        version: 8,
      }),
      deliveries: [completedDelivery],
    }),
    ...overrides,
  };
}

describe("final delivery UI", () => {
  it("shows stable blockers and never invents a summary while ongoing", () => {
    render(<DeliveryPanel {...props({
      completion: completion({
        blockers: [
          { code: "REVIEW_REQUIRED", refId: "result-2", workItemId: "work-2" },
          { code: "VALIDATION_REQUIRED", refId: "validation-1", workItemId: "work-1" },
          { code: "MEMORY_NOT_ACTIVE", refId: "memory-4", workItemId: "work-1" },
        ],
      }),
    })} />);

    expect(screen.getByRole("heading", { name: "最终交付进度" })).toBeInTheDocument();
    const blockers = screen.getByRole("list", { name: "最终交付阻断项" });
    expect(within(blockers).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("work-2"),
      expect.stringContaining("work-1"),
      expect.stringContaining("work-1"),
    ]);
    expect(screen.getByText(/尚未生成最终交付摘要/)).toBeInTheDocument();
    expect(screen.queryByText("公开复核已通过。")).not.toBeInTheDocument();
    const generate = screen.getByRole("button", { name: "生成最终交付" });
    expect(generate).toBeDisabled();
    expect(generate).toHaveAttribute("aria-describedby");
  });

  it("renders generating and failed states with explicit retry only", () => {
    const { rerender } = render(<DeliveryPanel {...props({
      completion: completion({ state: "generating" }),
    })} />);
    expect(screen.getByText("正在生成最终交付…")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "正在生成最终交付" })).toBeDisabled();

    rerender(<DeliveryPanel {...props({
      completion: completion({ lastErrorCode: "DELIVERY_INTERRUPTED" }),
    })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "DELIVERY_INTERRUPTED · 交付生成已中断，请显式重试",
    );
    expect(screen.getByRole("button", { name: "显式重试生成最终交付" })).toBeEnabled();
  });

  it("shows completed task facts, exact refs, evidence status and impact", () => {
    render(<DeliveryPanel {...props({
      completion: completion({
        currentDeliveryId: completedDelivery.id,
        state: "completed",
      }),
      deliveries: [completedDelivery],
    })} />);

    expect(screen.getByRole("heading", { name: "最终交付 v2" })).toBeInTheDocument();
    expect(screen.getByText("使命结论：已完成")).toBeInTheDocument();
    const task = screen.getByRole("listitem", { name: "交付任务 work-1" });
    expect(task).toHaveTextContent("执行 Agent");
    expect(task).toHaveTextContent("复核 Agent");
    expect(task).toHaveTextContent("decision-1");
    expect(task).toHaveTextContent("3 个文件 · 2048 bytes");
    expect(within(task).getByRole("link", { name: "Result result-1 · v2" }))
      .toHaveAttribute("href", "/results/result-1?version=2");
    expect(within(task).getByRole("link", { name: "Validation validation-1 · vpolicy-v3" }))
      .toHaveAttribute("href", "/validations/validation-1?version=policy-v3");
    expect(within(task).getByRole("link", { name: "Memory memory-1 · v4" }))
      .toHaveAttribute("href", "/memories/memory-1?version=4");

    const optional = screen.getByRole("listitem", { name: "evidence artifact artifact-optional" });
    expect(optional).toHaveTextContent("missing · 可选 · 不阻断完成，但限制已记录");
    const required = screen.getByRole("listitem", { name: "evidence review review-1" });
    expect(required).toHaveTextContent("passed · 必需 · 已满足完成条件");
  });

  it("navigates immutable versions and marks invalidated history", async () => {
    const invalidated = {
      ...completedDelivery,
      id: "delivery-1",
      invalidatedReason: "TASK_REOPENED",
      invalidatedWorkItemIds: ["work-1"],
      state: "invalidated" as const,
      version: 1,
    };
    render(<DeliveryPanel {...props({
      completion: completion({
        currentDeliveryId: completedDelivery.id,
        state: "completed",
      }),
      deliveries: [completedDelivery, invalidated],
    })} />);

    const navigation = screen.getByRole("navigation", { name: "最终交付版本" });
    expect(within(navigation).getByRole("button", { name: "查看交付 v2（当前）" }))
      .toHaveAttribute("aria-current", "page");
    await userEvent.click(within(navigation).getByRole("button", { name: "查看交付 v1（已失效）" }));
    expect(screen.getByRole("heading", { name: "最终交付 v1" })).toBeInTheDocument();
    expect(screen.getByText(
      "已被后续任务变化取代 · TASK_REOPENED · 受影响任务 work-1",
    )).toBeInTheDocument();
  });

  it("preserves selected version on mutation error and supports reload", async () => {
    const old = {
      ...completedDelivery,
      id: "delivery-1",
      state: "invalidated" as const,
      version: 1,
    };
    const onGenerate = vi.fn().mockRejectedValue(new Error("offline"));
    const onReload = vi.fn();
    render(<DeliveryPanel {...props({
      completion: completion({ lastErrorCode: "DELIVERY_INTERRUPTED" }),
      deliveries: [completedDelivery, old],
      onGenerate,
      onReload,
    })} />);

    await userEvent.click(screen.getByRole("button", { name: "查看交付 v1（已失效）" }));
    await userEvent.click(screen.getByRole("button", { name: "显式重试生成最终交付" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "重试失败；已保留当前查看的交付版本",
    );
    expect(screen.getByRole("heading", { name: "最终交付 v1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显式重试生成最终交付" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "重新加载最终交付" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("announces generation success and moves focus to the completed heading", async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      completion: completion({
        currentDeliveryId: completedDelivery.id,
        state: "completed",
        version: 8,
      }),
      deliveries: [completedDelivery],
    });
    render(<DeliveryPanel {...props({ onGenerate })} />);

    await userEvent.click(screen.getByRole("button", { name: "生成最终交付" }));
    expect(onGenerate).toHaveBeenCalledWith({
      expectedVersion: 7,
      operationId: expect.any(String),
    });
    expect(await screen.findByRole("status", { name: "最终交付生成结果" }))
      .toHaveTextContent("最终交付 v2 已生成");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "最终交付 v2" })).toHaveFocus());
  });

  it("covers loading and read error without showing false empty content", async () => {
    const onReload = vi.fn();
    const { rerender } = render(<DeliveryPanel {...props({ loading: true, onReload })} />);
    expect(screen.getByText("正在加载最终交付…")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(/尚未生成最终交付摘要/)).not.toBeInTheDocument();

    rerender(<DeliveryPanel {...props({
      error: "最终交付读取失败",
      loading: false,
      onReload,
    })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("最终交付读取失败");
    await userEvent.click(screen.getByRole("button", { name: "重新加载最终交付" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
