// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import * as reviewComponents from "@/components/review/review-slice";
import type {
  ReviewAttemptPanelProps,
  ReviewMaterialView,
  ReviewWorkspaceProps,
} from "@/components/review/review-slice";
import type { ReviewAttemptDto, ReviewWorkspaceDto } from "@/src/shared/review-contracts";

const HASH = "a".repeat(64);
const CHECKPOINT_HASH = "b".repeat(64);
const NOW = "2026-08-01T07:00:00.000Z";

type ReviewMaterialPanelProps = { material: ReviewMaterialView };

const optionalComponents = reviewComponents as typeof reviewComponents & {
  ReviewAttemptPanel?: React.ComponentType<ReviewAttemptPanelProps>;
  ReviewMaterialPanel?: React.ComponentType<ReviewMaterialPanelProps>;
  ReviewWorkspace?: React.ComponentType<ReviewWorkspaceProps>;
};

function ReviewAttemptPanel(props: ReviewAttemptPanelProps) {
  const Component = optionalComponents.ReviewAttemptPanel;
  expect(Component, "T-19 attempt panel must exist").toBeTypeOf("function");
  return <Component {...props} />;
}

function ReviewMaterialPanel(props: ReviewMaterialPanelProps) {
  const Component = optionalComponents.ReviewMaterialPanel;
  expect(Component, "T-19 material panel must exist").toBeTypeOf("function");
  return <Component {...props} />;
}

function ReviewWorkspace(props: ReviewWorkspaceProps) {
  const Component = optionalComponents.ReviewWorkspace;
  expect(Component, "T-19 workspace must exist").toBeTypeOf("function");
  return <Component {...props} />;
}

const content = (
  id: string,
  type: "result" | "validation" | "artifact" | "execution",
  version: string,
  text: string,
  status: "complete" | "truncated" | "missing" | "unreadable" = "complete",
) => ({
  chunks: text ? [{ bytes: text.length, offset: 0, sha256: HASH, text }] : [],
  includedBytes: text.length,
  mediaType: type === "result" ? "text/x-diff" as const : "text/plain" as const,
  originalBytes: text.length,
  reasonCode: status === "complete" ? null : "SOURCE_MISSING" as const,
  sha256: HASH,
  source: { id, type, version },
  status,
});

const material: ReviewMaterialView = {
  artifacts: [{
    content: content("artifact-1", "artifact", "sha256:artifact-v4", "artifact body"),
    id: "artifact-1",
    name: "report.txt",
    required: false,
  }],
  auditEvents: [{
    payload: content("event-1", "execution", "42", "{\"type\":\"merged\"}"),
    type: "merged",
  }],
  changes: {
    observations: [{
      path: "src/review.ts",
      publicDiff: content("result-1", "result", "7", "-old\n+new"),
      required: true,
    }],
  },
  validations: [{
    id: "validation-1",
    required: true,
    stderr: content("validation-1", "validation", "policy-v3", ""),
    stdout: content("validation-1", "validation", "policy-v3", "all checks passed"),
    succeeded: true,
  }],
};

function attempt(
  finalize: NonNullable<ReviewAttemptDto["finalize"]>,
  status: ReviewAttemptDto["status"] = "finalizing",
): ReviewAttemptDto {
  return {
    calls: [{
      callIndex: 1,
      failure: null,
      finishedAt: NOW,
      id: "primary",
      kind: "primary",
      startedAt: NOW,
      status: "succeeded",
      usage: {
        completionTokens: 13,
        promptTokens: 21,
        reported: true,
        totalTokens: 34,
      },
    }, {
      callIndex: 2,
      failure: { apiErrorCode: null, category: "usage" },
      finishedAt: NOW,
      id: "repair",
      kind: "repair",
      startedAt: NOW,
      status: "usage_invalid",
      usage: {
        completionTokens: null,
        promptTokens: null,
        reported: false,
        totalTokens: null,
      },
    }],
    decision: null,
    errorCategory: null,
    finalize,
    finishedAt: null,
    id: "attempt-1",
    material: { hash: HASH, resultVersion: 7, sourceCount: 4 },
    provider: { id: "provider", model: "review-model", name: "Local", version: 3 },
    result: { id: "result-1", version: 7 },
    reviewer: {
      accentToken: "slate",
      avatarText: "R",
      id: "reviewer",
      name: "Reviewer",
    },
    startedAt: NOW,
    status,
    usageTotal: {
      completionTokens: 13,
      promptTokens: 21,
      repairCalls: 1,
      reportedCalls: 1,
      totalTokens: 34,
      unreportedCalls: 1,
    },
  };
}

const localFinalize = {
  checkpoint: { checkpointedAt: NOW, publicOutputHash: CHECKPOINT_HASH },
  lastErrorCode: "REVIEW_FINALIZE_FAILED" as const,
  mode: "local-finalize-only" as const,
  retryRequiresProvider: false as const,
};

const workspace: ReviewWorkspaceDto = {
  blockers: [],
  candidates: [],
  currentAttempt: attempt(localFinalize),
  effectiveStatus: "reviewing",
  headVersion: 4,
  historyCount: 1,
  result: {
    executorAgentId: "executor",
    id: "result-1",
    source: {
      contextHash: HASH,
      projectId: "project",
      runId: "run-a",
      threadId: "thread-a",
    },
    version: 7,
  },
  workItem: { id: "work-1", title: "公开复核工作区" },
};

function attemptProps(
  finalize: NonNullable<ReviewAttemptDto["finalize"]>,
  surface: ReviewAttemptPanelProps["surface"],
) {
  return {
    attempt: attempt(finalize, finalize.mode === "new-provider-attempt" ? "interrupted" : "finalizing"),
    onLocalFinalize: vi.fn().mockResolvedValue(undefined),
    onNewProviderAttempt: vi.fn().mockResolvedValue(undefined),
    surface,
  } satisfies ReviewAttemptPanelProps;
}

describe("desktop review workspace", () => {
  it("links review provenance to the exact frozen thread and run", async () => {
    render(<ReviewWorkspace load={async () => workspace} workItemId="work-1" />);

    expect(await screen.findByRole("link", { name: "打开来源协作运行" })).toHaveAttribute(
      "href",
      "/projects/project?thread=thread-a&run=run-a",
    );
  });

  it("shows real diff, validation, artifact and event bodies with source/version/status", () => {
    render(<ReviewMaterialPanel material={material} />);

    expect(screen.getByText("-old")).toBeInTheDocument();
    expect(screen.getByText("+new")).toBeInTheDocument();
    expect(screen.getByText("all checks passed")).toBeInTheDocument();
    expect(screen.getByText("artifact body")).toBeInTheDocument();
    expect(screen.getByText("{\"type\":\"merged\"}")).toBeInTheDocument();
    expect(screen.getByText(/result · result-1 · v7/)).toBeInTheDocument();
    expect(screen.getAllByText(/validation · validation-1 · vpolicy-v3/))
      .toHaveLength(2);
    expect(screen.getAllByText("正文完整").length).toBeGreaterThanOrEqual(4);
  });

  it("shows primary/repair calling/terminal failures and nullable reported usage", () => {
    render(<ReviewAttemptPanel {...attemptProps(localFinalize, "workspace")} />);

    const primary = screen.getByRole("listitem", { name: /primary call 1/ });
    expect(within(primary).getByText("succeeded")).toBeInTheDocument();
    expect(within(primary).getByText("21 + 13 = 34 tokens")).toBeInTheDocument();
    const repair = screen.getByRole("listitem", { name: /repair call 2/ });
    expect(within(repair).getByText("usage_invalid")).toBeInTheDocument();
    expect(within(repair).getByText("usage · 未报告")).toBeInTheDocument();
    expect(within(repair).getByText("failure · usage · 无公开错误码")).toBeInTheDocument();
    expect(screen.getByText("1 次已报告 · 1 次未报告 · 合计 34 tokens"))
      .toBeInTheDocument();
  });

  it.each(["workspace", "history", "detail"] as const)(
    "%s uses finalize mode as the only retry authority",
    async (surface) => {
      const local = attemptProps(localFinalize, surface);
      const created = attemptProps({
        checkpoint: null,
        lastErrorCode: "PROVIDER_TIMEOUT",
        mode: "new-provider-attempt",
        retryRequiresProvider: true,
      }, surface);
      const none = attemptProps({
        checkpoint: { checkpointedAt: NOW, publicOutputHash: CHECKPOINT_HASH },
        lastErrorCode: null,
        mode: "none",
        retryRequiresProvider: false,
      }, surface);
      const { rerender } = render(<ReviewAttemptPanel {...local} />);

      expect(screen.getByText("仅继续本地提交、不调用模型")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "继续提交裁决" }));
      expect(local.onLocalFinalize).toHaveBeenCalledWith("attempt-1", CHECKPOINT_HASH);
      expect(local.onNewProviderAttempt).not.toHaveBeenCalled();

      rerender(<ReviewAttemptPanel {...created} />);
      expect(screen.getByText("将创建新 attempt，并再次调用模型")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "重新发起复核" }));
      expect(created.onNewProviderAttempt).toHaveBeenCalledWith("attempt-1");

      rerender(<ReviewAttemptPanel {...none} />);
      expect(screen.queryByRole("button", { name: /继续提交|重新发起/ })).not.toBeInTheDocument();
    },
  );

  it("keeps finalizing checkpoint on refresh and can continue local finalize", async () => {
    const load = vi.fn().mockResolvedValue(workspace);
    const finalize = vi.fn().mockResolvedValue(workspace);
    render(
      <ReviewWorkspace
        detail={{ attempt: workspace.currentAttempt!, material }}
        history={[workspace.currentAttempt!]}
        load={load}
        onLocalFinalize={finalize}
        workItemId="work-1"
      />,
    );

    expect(await screen.findByText("公开输出已保存，待提交")).toBeInTheDocument();
    expect(screen.getAllByText(CHECKPOINT_HASH.slice(0, 12)).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "刷新复核工作区" }));
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByText("仅继续本地提交、不调用模型")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "继续提交裁决" }));
    expect(finalize).toHaveBeenCalledWith("attempt-1", CHECKPOINT_HASH);
  });

  it("disables pass for hash/header-only or incomplete required content", () => {
    const incomplete: ReviewMaterialView = {
      ...material,
      changes: {
        observations: [{
          path: "src/header-only.ts",
          publicDiff: content("result-2", "result", "8", "", "missing"),
          required: true,
        }],
      },
    };
    render(<ReviewMaterialPanel material={incomplete} />);

    const pass = screen.getByRole("button", { name: "通过复核" });
    expect(pass).toBeDisabled();
    expect(pass).toHaveAttribute("aria-describedby");
    expect(screen.getByText(/REVIEW_CONTENT_INCOMPLETE/)).toBeInTheDocument();
  });

  it("covers loading, empty, error, disabled, success, focus and live states", async () => {
    let resolve!: (value: ReviewWorkspaceDto) => void;
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise<ReviewWorkspaceDto>((done) => {
        resolve = done;
      }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(workspace);
    const finalize = vi.fn().mockResolvedValue({
      ...workspace,
      currentAttempt: {
        ...workspace.currentAttempt!,
        decision: { choice: "pass", id: "decision", publicSummary: "复核已通过" },
        finalize: {
          checkpoint: { checkpointedAt: NOW, publicOutputHash: CHECKPOINT_HASH },
          lastErrorCode: null,
          mode: "none",
          retryRequiresProvider: false,
        },
        finishedAt: NOW,
        status: "passed",
      },
      effectiveStatus: "passed",
    });
    const { rerender } = render(
      <ReviewWorkspace load={load} onLocalFinalize={finalize} workItemId="work-1" />,
    );
    expect(screen.getByText("正在加载复核工作区…")).toHaveAttribute("aria-busy", "true");
    resolve({ ...workspace, currentAttempt: null, historyCount: 0 });
    expect(await screen.findByText("还没有复核 attempt。")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "刷新复核工作区" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法加载复核工作区");

    await userEvent.click(screen.getByRole("button", { name: "重试加载复核工作区" }));
    await userEvent.click(await screen.findByRole("button", { name: "继续提交裁决" }));
    const success = await screen.findByRole("status");
    expect(success).toHaveTextContent("本地裁决提交成功");
    await waitFor(() => expect(screen.getByRole("heading", { name: /唯一裁决：pass/ })).toHaveFocus());

    rerender(
      <ReviewWorkspace
        load={async () => workspace}
        onLocalFinalize={finalize}
        operationDisabledReason="任务版本已变化"
        workItemId="work-1"
      />,
    );
    expect(await screen.findByRole("button", { name: "继续提交裁决" })).toBeDisabled();
    expect(screen.getByText("任务版本已变化")).toBeInTheDocument();
  });
});
