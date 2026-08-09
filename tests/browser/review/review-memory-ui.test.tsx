// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryPanel } from "@/components/project-context/memory-panel";
import * as reviewComponents from "@/components/review/review-slice";
import type { MemoryEntryV6 } from "@/src/shared/memory-contracts";

type MemoryAssociation = {
  candidateId: string;
  decisionId: string;
  memoryId: string;
  memoryVersion: number;
  outcome: "created" | "reused" | "superseded";
};
type ReviewMemoryAssociationsProps = {
  associations: MemoryAssociation[];
  projectId: string;
};
const optionalReviewComponents = reviewComponents as typeof reviewComponents & {
  ReviewMemoryAssociations?: React.ComponentType<ReviewMemoryAssociationsProps>;
};

function ReviewMemoryAssociations(props: ReviewMemoryAssociationsProps) {
  const Component = optionalReviewComponents.ReviewMemoryAssociations;
  expect(Component, "T-21 review memory association UI must exist").toBeTypeOf("function");
  return <Component {...props} />;
}

const NOW = "2026-08-01T10:00:00.000Z";
const sourceVersions = {
  artifact: "b".repeat(64),
  result: "4",
  review: "material-v2",
  task: "7",
  validation: "a".repeat(64),
} as const;

function ownerMemory(
  id: string,
  type: MemoryEntryV6["type"],
  content: string,
): MemoryEntryV6 {
  return {
    active: true,
    actor: {
      confirmer: null,
      persistedBy: "platform",
      proposerAgent: null,
      proposerType: "owner",
    },
    chainId: id,
    content,
    createdAt: NOW,
    id,
    projectId: "project-1",
    source: {
      href: null,
      id: "Owner brief",
      type: "owner_input",
      version: null,
    },
    supersedesId: null,
    type,
    version: 1,
  };
}

function agentMemory(
  id: string,
  type: MemoryEntryV6["type"],
  sourceType: keyof typeof sourceVersions,
  overrides: Partial<MemoryEntryV6> = {},
): MemoryEntryV6 {
  const version = sourceVersions[sourceType];
  return {
    active: true,
    actor: {
      confirmer: {
        decisionId: "decision-pass",
        reviewAttemptId: "attempt-2",
      },
      persistedBy: "platform",
      proposerAgent: {
        accentToken: "sage",
        avatarText: "R",
        id: "reviewer-1",
        name: "Reviewer Lin",
      },
      proposerType: "agent",
    },
    chainId: id,
    content: `${type} from ${sourceType}`,
    createdAt: NOW,
    id,
    projectId: "project-1",
    source: {
      href: `/projects/project-1/${sourceType}s/${sourceType}-1?version=${encodeURIComponent(version)}`,
      id: `${sourceType}-1`,
      type: sourceType,
      version,
    },
    supersedesId: null,
    type,
    version: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("review memory UI", () => {
  it("shows all five types, actor responsibility, and exact source type/id/version links", async () => {
    const memories = [
      ownerMemory("goal-1", "goal", "Ship a reviewable result"),
      agentMemory("decision-1", "decision", "task"),
      agentMemory("fact-1", "fact", "result"),
      agentMemory("artifact-1", "artifact", "artifact"),
      agentMemory("experience-1", "experience", "validation"),
      agentMemory("review-1", "fact", "review"),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ memories })));

    render(<MemoryPanel projectId="project-1" />);

    expect(await screen.findByRole("heading", { name: "Ship a reviewable result" }))
      .toBeInTheDocument();
    for (const label of ["目标", "决策", "事实", "产物", "经验"]) {
      expect(screen.getAllByText(label, { exact: true }).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Owner 提议 · 平台持久化")).toBeInTheDocument();
    expect(screen.getAllByText(
      "Agent Reviewer Lin 提议 · 通过裁决 decision-pass 确认 · 平台持久化",
    )).toHaveLength(5);
    expect(screen.getByText("原有来源（无版本）")).toBeInTheDocument();

    for (const memory of memories.slice(1)) {
      const item = screen.getByRole("listitem", { name: `memory ${memory.id}` });
      const link = within(item).getByRole("link", {
        name: `${memory.source.type} · ${memory.source.id} · version ${memory.source.version}`,
      });
      expect(link).toHaveAttribute("href", memory.source.href);
    }
  });

  it("orders immutable history and exposes supersedes and superseded-by navigation", async () => {
    const oldMemory = {
      ...agentMemory("fact-old", "fact", "result"),
      active: false,
    };
    const currentMemory = agentMemory("fact-current", "fact", "result", {
      chainId: oldMemory.chainId,
      content: "Current reviewed fact",
      supersedesId: oldMemory.id,
      version: 2,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      Response.json({
        memories: String(input).endsWith("includeInactive=1")
          ? [currentMemory, oldMemory]
          : [currentMemory],
      }));
    vi.stubGlobal("fetch", fetchMock);

    render(<MemoryPanel projectId="project-1" />);
    await screen.findByRole("heading", { name: "Current reviewed fact" });
    await userEvent.click(screen.getByRole("button", { name: "查看历史记忆" }));

    const history = await screen.findByRole("list", { name: "共享记忆历史" });
    const items = within(history).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "memory fact-old",
      "memory fact-current",
    ]);
    expect(within(items[0]).getByText("已被 v2 取代")).toBeInTheDocument();
    expect(within(items[0]).getByRole("link", { name: "后继 memory fact-current · v2" }))
      .toHaveAttribute("href", "#memory-fact-current");
    expect(within(items[1]).getByText("Active · 当前版本")).toBeInTheDocument();
    expect(within(items[1]).getByRole("link", { name: "取代 memory fact-old · v1" }))
      .toHaveAttribute("href", "#memory-fact-old");
  });

  it("shows created, dedup reused, and superseded review outcomes", () => {
    render(
      <ReviewMemoryAssociations
        associations={[
          {
            candidateId: "candidate-1",
            decisionId: "decision-pass",
            memoryId: "memory-created",
            memoryVersion: 1,
            outcome: "created",
          },
          {
            candidateId: "candidate-2",
            decisionId: "decision-pass",
            memoryId: "memory-reused",
            memoryVersion: 3,
            outcome: "reused",
          },
          {
            candidateId: "candidate-3",
            decisionId: "decision-pass",
            memoryId: "memory-superseded",
            memoryVersion: 2,
            outcome: "superseded",
          },
        ]}
        projectId="project-1"
      />,
    );

    expect(screen.getByText("已创建 · memory-created · v1")).toBeInTheDocument();
    expect(screen.getByText("精确去重，复用既有记忆 · memory-reused · v3"))
      .toBeInTheDocument();
    expect(screen.getByText("已创建后继版本 · memory-superseded · v2"))
      .toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /memory-.* · v/ })).toHaveLength(3);
  });

  it("keeps owner creation actor-proof and covers loading, empty, error, disabled, success and focus", async () => {
    let resolveLoad!: (value: Response) => void;
    const pendingLoad = new Promise<Response>((resolve) => {
      resolveLoad = resolve;
    });
    const created = ownerMemory("experience-owner", "experience", "Keep review evidence");
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => pendingLoad)
      .mockResolvedValueOnce(Response.json({ memory: created }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<MemoryPanel projectId="project-1" />);
    expect(screen.getByText("正在加载共享记忆…")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "保存记忆" })).toBeDisabled();
    await act(async () => resolveLoad(Response.json({ memories: [] })));
    expect(await screen.findByText("尚无共享记忆。")).toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole("radio", { name: "目标" })).toHaveFocus();
    expect(screen.queryByRole("radio", { name: /Agent|review confirmation/i })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "经验" }));
    await user.type(screen.getByLabelText("记忆正文"), "Keep review evidence");
    await user.type(screen.getByLabelText("来源引用"), "Owner note");
    await user.click(screen.getByRole("button", { name: "保存记忆" }));

    const post = fetchMock.mock.calls.find((call) =>
      (call[1] as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      content: "Keep review evidence",
      sourceRef: "Owner note",
      sourceType: "owner_input",
      type: "experience",
    });
    expect(await screen.findByRole("status", { name: "保存结果" }))
      .toHaveTextContent("共享记忆已保存");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Keep review evidence" })).toHaveFocus());
  });

  it("preserves the draft on load/save errors and offers keyboard-reachable retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { error: { code: "STORAGE_UNAVAILABLE" } },
        { status: 503 },
      ))
      .mockResolvedValueOnce(Response.json({ memories: [] }))
      .mockResolvedValueOnce(Response.json(
        { error: { code: "RESOURCE_CONFLICT" } },
        { status: 409 },
      ));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<MemoryPanel projectId="project-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法加载共享记忆");
    await user.click(screen.getByRole("button", { name: "重试加载共享记忆" }));
    await screen.findByText("尚无共享记忆。");
    await user.type(screen.getByLabelText("记忆正文"), "Draft survives");
    await user.type(screen.getByLabelText("来源引用"), "Owner note");
    await user.click(screen.getByRole("button", { name: "保存记忆" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("数据已更新");
    expect(screen.getByLabelText("记忆正文")).toHaveValue("Draft survives");
    expect(screen.getByLabelText("记忆正文")).toHaveFocus();
  });
});
