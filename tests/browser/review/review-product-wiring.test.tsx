import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ComponentType } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

type ReviewProductSurfaceProps = {
  missionId: string;
  projectId: string;
  workItemId: string;
};

type MissionDeliverySurfaceProps = {
  missionId: string;
};

type ProductSurfaceModule = {
  MissionDeliverySurface: ComponentType<MissionDeliverySurfaceProps>;
  ReviewProductSurface: ComponentType<ReviewProductSurfaceProps>;
};

const productSurfaceModules = import.meta.glob<ProductSurfaceModule>(
  "../../../components/review/review-product-surface.tsx",
);

const NOW = "2026-08-01T10:00:00.000Z";
const HASH = "a".repeat(64);

function workspace(
  state: "pending_review" | "waiting_owner" = "pending_review",
) {
  return {
    answeredEscalations: [],
    blockers: [],
    candidates: [{
      agent: {
        accentToken: "sage",
        avatarText: "R",
        id: "reviewer-1",
        name: "Reviewer",
        role: "独立复核",
      },
      provider: { id: "provider-1", model: "review-model", name: "Local" },
      qualification: ["current_member", "review_capable", "not_executor"],
    }],
    currentAttempt: state === "waiting_owner" ? {
      calls: [],
      decision: {
        choice: "escalate",
        evidenceRefs: [],
        findings: [],
        id: "decision-1",
        publicSummary: "需要 Owner 决定。",
      },
      errorCategory: null,
      finalize: {
        checkpoint: { checkpointedAt: NOW, publicOutputHash: HASH },
        lastErrorCode: null,
        mode: "none",
        retryRequiresProvider: false,
      },
      finishedAt: NOW,
      id: "attempt-1",
      material: { hash: HASH, resultVersion: 1, sourceCount: 1 },
      provider: {
        id: "provider-1",
        model: "review-model",
        name: "Local",
        version: 1,
      },
      result: { id: "result-1", version: 1 },
      reviewer: {
        accentToken: "sage",
        avatarText: "R",
        id: "reviewer-1",
        name: "Reviewer",
      },
      startedAt: NOW,
      status: "escalated",
      usageTotal: {
        completionTokens: 0,
        promptTokens: 0,
        repairCalls: 0,
        reportedCalls: 0,
        totalTokens: 0,
        unreportedCalls: 0,
      },
    } : null,
    currentEscalation: state === "waiting_owner" ? {
      attemptId: "attempt-1",
      createdAt: NOW,
      escalationId: "escalation-1",
      options: ["继续复核", "返工"],
      question: "下一步怎么处理？",
      resultId: "result-1",
    } : null,
    effectiveStatus: state,
    headVersion: 4,
    historyCount: state === "waiting_owner" ? 1 : 0,
    result: {
      createdAt: NOW,
      executorAgentId: "executor-1",
      id: "result-1",
      version: 1,
    },
    workItem: {
      boardStatus: "in_progress",
      id: "work-1",
      title: "接入产品树",
      version: 3,
    },
  };
}

async function productSurfaces(): Promise<ProductSurfaceModule> {
  const load = productSurfaceModules[
    "../../../components/review/review-product-surface.tsx"
  ];
  expect(load, "T-28 product review surface must exist").toBeTypeOf("function");
  return load!();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("review product wiring", () => {
  it("connects the actual page tree, keeps delivery mission-level, and opens review from merged execution", () => {
    const page = readFileSync(resolve("app/page.tsx"), "utf8");
    const project = readFileSync(resolve("components/project-panel.tsx"), "utf8");
    const task = readFileSync(resolve("components/task-panel.tsx"), "utf8");
    const execution = readFileSync(
      resolve("components/execution/execution-panel.tsx"),
      "utf8",
    );
    const mission = readFileSync(
      resolve("components/project-context/mission-board.tsx"),
      "utf8",
    );

    expect(page).toContain("<ProjectPanel");
    expect(project).toContain("<TaskPanel");
    expect(task).toContain("<ExecutionPanel");
    expect(execution).toContain("<ReviewProductSurface");
    expect(execution).toContain("打开复核闭环");
    expect(execution).not.toContain("<MissionDeliverySurface");
    expect(mission.match(/<MissionDeliverySurface/g)).toHaveLength(1);
  });

  it("keeps versioned memory source hrefs on a reachable product target", () => {
    const sourceTarget = readFileSync(
      resolve("app/projects/[projectId]/[[...resource]]/page.tsx"),
      "utf8",
    );

    expect(sourceTarget).toContain("export default");
    expect(sourceTarget).toContain("source-reference");
    expect(sourceTarget).toContain("version");
    expect(sourceTarget).toContain('href="/"');
  });

  it("uses the real review and answer route adapters, preserving owner draft and live focus", async () => {
    const { ReviewProductSurface } = await productSurfaces();
    let current = workspace("pending_review");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/work-items/work-1/review" && !init?.method) {
        return Response.json(current);
      }
      if (url === "/api/work-items/work-1/reviews?limit=20") {
        return Response.json({
          items: current.currentAttempt ? [current.currentAttempt] : [],
          nextCursor: null,
        });
      }
      if (url === "/api/projects/project-1/memories?includeInactive=0") {
        return Response.json({ memories: [] });
      }
      if (
        url === "/api/work-items/work-1/reviews"
        && init?.method === "POST"
      ) {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          expectedHeadVersion: 4,
          resultId: "result-1",
          reviewerAgentId: "reviewer-1",
        });
        expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/u);
        current = workspace("waiting_owner");
        return Response.json({
          attemptId: "attempt-1",
          decisionId: "decision-1",
          state: "completed",
        });
      }
      if (
        url === "/api/escalations/escalation-1/answer"
        && init?.method === "POST"
      ) {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          action: "continue_review",
          answer: "按补充说明继续。",
          expectedHeadVersion: 4,
        });
        expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/u);
        return Response.json({
          answer: {
            action: "continue_review",
            answer: body.answer,
            answerId: "answer-1",
            escalationId: "escalation-1",
            next: "new_review_attempt",
            resultId: "result-1",
            state: "pending_review",
            workItemId: "work-1",
          },
          workspace: workspace("pending_review"),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    const { rerender } = render(
      <ReviewProductSurface
        missionId="mission-1"
        projectId="project-1"
        workItemId="work-1"
      />,
    );
    await user.click(await screen.findByRole("radio", { name: /Reviewer/ }));
    await user.click(screen.getByRole("button", { name: "确认并发起真实复核" }));
    expect(await screen.findByRole("status")).toHaveTextContent("完成独立复核");

    rerender(
      <ReviewProductSurface
        key="waiting-owner"
        missionId="mission-1"
        projectId="project-1"
        workItemId="work-1"
      />,
    );
    const navigation = await screen.findByRole("tablist", { name: "接入产品树 复核闭环导航" });
    await user.click(within(navigation).getByRole("tab", { name: "回答" }));
    const draft = await screen.findByRole("textbox", { name: "Owner 回答" });
    await user.type(draft, "按补充说明继续。");
    await user.click(screen.getByRole("radio", { name: "继续复核" }));
    await user.click(screen.getByRole("button", { name: "提交 Owner 回答" }));

    expect(await screen.findByRole("status")).toHaveTextContent("已创建新复核");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Owner 动作已保存" })).toHaveFocus(),
    );
  });

  it("keeps rejected terminal history ready when no current attempt or escalation remains", async () => {
    const { ReviewProductSurface } = await productSurfaces();
    const current = {
      ...workspace("pending_review"),
      effectiveStatus: "rework",
      historyCount: 1,
    };
    const rejectedAttempt = {
      calls: [],
      decision: {
        choice: "reject",
        evidenceRefs: [],
        findings: [{
          requirement: "补齐失败路径测试",
          severity: "blocking",
        }],
        id: "decision-reject",
        publicSummary: "需要补齐失败路径后重新执行。",
      },
      errorCategory: null,
      finalize: {
        checkpoint: { checkpointedAt: NOW, publicOutputHash: HASH },
        lastErrorCode: null,
        mode: "none",
        retryRequiresProvider: false,
      },
      finishedAt: NOW,
      id: "attempt-reject",
      material: { hash: HASH, resultVersion: 1, sourceCount: 1 },
      provider: {
        id: "provider-1",
        model: "review-model",
        name: "Local",
        version: 1,
      },
      result: { id: "result-1", version: 1 },
      reviewer: {
        accentToken: "sage",
        avatarText: "R",
        id: "reviewer-1",
        name: "Reviewer",
      },
      startedAt: NOW,
      status: "rejected",
      usageTotal: {
        completionTokens: 0,
        promptTokens: 0,
        repairCalls: 0,
        reportedCalls: 0,
        totalTokens: 0,
        unreportedCalls: 0,
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/work-items/work-1/review") {
        return Response.json(current);
      }
      if (url === "/api/work-items/work-1/reviews?limit=20") {
        return Response.json({ items: [rejectedAttempt], nextCursor: null });
      }
      if (url === "/api/projects/project-1/memories?includeInactive=0") {
        return Response.json({ memories: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    render(
      <ReviewProductSurface
        missionId="mission-1"
        projectId="project-1"
        workItemId="work-1"
      />,
    );
    const navigation = await screen.findByRole("tablist", {
      name: "接入产品树 复核闭环导航",
    });
    await user.click(within(navigation).getByRole("tab", { name: "回答" }));

    expect(await screen.findByText("状态：ready")).toBeInTheDocument();
    expect(screen.getByRole("heading", {
      name: "复核结果与逐 attempt 历史",
    })).toBeInTheDocument();
    const rejected = screen.getByRole("listitem", {
      name: "attempt attempt-reject",
    });
    expect(within(rejected).getByText(/唯一裁决：reject/u)).toBeInTheDocument();
    expect(within(rejected).getByRole("heading", { name: "退回要求" }))
      .toBeInTheDocument();
    expect(within(rejected).getByText("补齐失败路径测试")).toBeInTheDocument();
  });

  it("loads and generates delivery through mission routes without fictional success", async () => {
    const { MissionDeliverySurface } = await productSurfaces();
    const completion = {
      blockers: [],
      currentDelivery: null,
      currentDeliveryId: null,
      lastErrorCode: null,
      missionId: "mission-1",
      retry: null,
      state: "ongoing",
      version: 2,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/missions/mission-1/delivery" && !init?.method) {
        return Response.json(completion);
      }
      if (url === "/api/missions/mission-1/deliveries?limit=20") {
        return Response.json({ items: [], nextCursor: null });
      }
      if (url === "/api/missions/mission-1/delivery" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.expectedHeadVersion).toBe(2);
        expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/u);
        return Response.json({
          delivery: null,
          missionCompletion: { ...completion, state: "completed", version: 4 },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MissionDeliverySurface missionId="mission-1" />);
    await userEvent.click(await screen.findByRole("button", {
      name: "生成最终交付",
    }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/missions/mission-1/delivery",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByRole("status", { name: "最终交付生成结果" }))
      .toHaveTextContent("最终交付已生成");
  });
});
