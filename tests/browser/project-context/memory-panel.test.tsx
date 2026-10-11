// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import type { CurationCandidateListItemDto } from "@/src/modules/knowledge-provenance";
import type { MemoryEntryV6 } from "@/src/shared/memory-contracts";
import type { MemoryEntry } from "@/src/shared/project-context-contracts";

type MemoryPanelModule = {
  MemoryPanel: ComponentType<{ projectId: string }>;
};

const modules =
  import.meta.glob<MemoryPanelModule>("../../../components/project-context/memory-panel.tsx");

const activeGoal: MemoryEntry = {
  id: "memory-active",
  projectId: "project-1",
  type: "goal",
  content: "Current goal",
  sourceType: "owner_input",
  sourceRef: "Owner",
  createdBy: "owner",
  supersedesId: "memory-old",
  active: true,
  createdAt: "2026-07-29T00:01:00.000Z",
};
const oldGoal: MemoryEntry = {
  ...activeGoal,
  id: "memory-old",
  content: "Old goal",
  supersedesId: null,
  active: false,
  createdAt: "2026-07-29T00:00:00.000Z",
};
const pendingCandidate: CurationCandidateListItemDto = {
  agentId: "agent-curator",
  agentName: "Curator Lin",
  content: "Adopt durable retries",
  createdAt: "2026-08-27T12:00:00.000Z",
  diff: [
    { kind: "removed", text: "Retry once" },
    { kind: "added", text: "Retry with bounded backoff" },
  ],
  id: "candidate-1",
  projectId: "project-1",
  sources: [{
    href: null,
    id: "work-item-7",
    type: "work_item",
    version: null,
  }],
  status: "pending",
  supersedesId: null,
  type: "decision",
};
const publishedAgentMemory: MemoryEntryV6 = {
  active: true,
  actor: {
    confirmer: null,
    persistedBy: "platform",
    proposerAgent: {
      accentToken: "gold",
      avatarText: "C",
      id: "agent-curator",
      name: "Curator Lin",
    },
    proposerType: "agent",
  },
  chainId: "memory-curated",
  content: pendingCandidate.content,
  createdAt: "2026-08-27T12:01:00.000Z",
  id: "memory-curated",
  projectId: "project-1",
  source: {
    href: null,
    id: "work-item-7",
    type: "work_item",
    version: null,
  },
  supersedesId: null,
  type: "decision",
  version: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function memoryIndexHealthResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({
    coverage: { active: 1, indexed: 1, ratio: 1, valid: 1 },
    freshness: { pending: 0, status: "caught_up" },
    lastErrorCode: null,
    projectId: "project-1",
    searchMode: "source_fallback",
    status: "caught_up",
    updatedAt: "2026-08-19T00:00:00.000Z",
    version: 1,
    ...overrides,
  });
}

function emptyCurationResponse(input: RequestInfo | URL): Response | null {
  return String(input).includes("/memory-curation-candidates")
    ? Response.json({ candidates: [] })
    : null;
}

async function memoryPanel() {
  const load = modules["../../../components/project-context/memory-panel.tsx"];
  expect(load, "the shared memory panel must exist").toBeTypeOf("function");
  return (await load()).MemoryPanel;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Shared Memory panel", () => {
  it("shows candidate loading then an actionable Agent-signed diff", async () => {
    const MemoryPanel = await memoryPanel();
    const candidates = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/memory-curation-candidates")) return candidates.promise;
        if (url.includes("/memory-index/health")) {
          return Promise.resolve(memoryIndexHealthResponse());
        }
        if (url.includes("/memory-collections")) {
          return Promise.resolve(Response.json({ collections: [] }));
        }
        if (url.includes("/knowledge-graph")) {
          return Promise.resolve(Response.json({ edges: [], nodes: [] }));
        }
        return Promise.resolve(Response.json({ memories: [] }));
      }),
    );
    render(<MemoryPanel projectId="project-1" />);

    const region = screen.getByRole("region", { name: "提炼候选" });
    const loading = within(region).getByRole("status", {
      name: "正在加载提炼候选…",
    });
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveClass("memory-curation-skeleton");
    expect(within(region).getByText("正在加载提炼候选…")).toHaveClass("sr-only");
    await act(async () => {
      candidates.resolve(Response.json({ candidates: [pendingCandidate] }));
    });

    expect(await within(region).findByText(/Curator Lin/)).toBeInTheDocument();
    expect(within(region).getByText("Adopt durable retries")).toBeInTheDocument();
    const sources = within(region).getByRole("list", {
      name: "Adopt durable retries 来源",
    });
    expect(within(sources).getByText("work-item-7")).toBeInTheDocument();
    expect(within(sources).getByText("原有来源（无版本）")).toBeInTheDocument();
    expect(within(sources).queryByRole("link")).toBeNull();
    expect(within(region).getByText("+ Retry with bounded backoff"))
      .toHaveClass("memory-curation-diff-added");
    expect(within(region).getByRole("button", { name: "批准发布" })).toBeEnabled();
    expect(within(region).getByRole("button", { name: "驳回" })).toBeEnabled();
  });

  it("shows the candidate empty state without an Agent proposal action", async () => {
    const MemoryPanel = await memoryPanel();
    let candidateLoads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/memory-curation-candidates")) {
          candidateLoads += 1;
          return Response.json({ candidates: [] });
        }
        if (url.includes("/memory-index/health")) return memoryIndexHealthResponse();
        if (url.includes("/memory-collections")) {
          return Response.json({ collections: [] });
        }
        if (url.includes("/knowledge-graph")) {
          return Response.json({ edges: [], nodes: [] });
        }
        return Response.json({ memories: [] });
      }),
    );
    const user = userEvent.setup();
    render(<MemoryPanel projectId="project-1" />);

    const region = await screen.findByRole("region", { name: "提炼候选" });
    expect(await within(region).findByText("暂无待发布的提炼候选。"))
      .toHaveClass("muted");
    expect(within(region).queryByRole("button", { name: "批准发布" })).toBeNull();
    expect(within(region).queryByRole("button", { name: /提议|新建候选/ })).toBeNull();
    const refresh = within(region).getByRole("button", { name: "刷新提炼候选" });
    expect(refresh).toHaveClass("memory-curation-action");
    await user.click(refresh);
    await waitFor(() => expect(candidateLoads).toBe(2));
  });

  it("publishes a candidate, reloads memories and focuses the approved Agent memory", async () => {
    const MemoryPanel = await memoryPanel();
    const decision = deferred<Response>();
    const calls: Array<{ body?: unknown; method: string; url: string }> = [];
    let candidateLoads = 0;
    let memoryLoads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          method,
          url,
        });
        if (url.includes("/memory-curation-candidates")) {
          if (method === "POST") return decision.promise;
          candidateLoads += 1;
          return Response.json({
            candidates: candidateLoads === 1 ? [pendingCandidate] : [],
          });
        }
        if (url.includes("/memory-index/health")) return memoryIndexHealthResponse();
        if (url.includes("/memory-collections")) {
          return Response.json({ collections: [] });
        }
        if (url.includes("/knowledge-graph")) {
          return Response.json({ edges: [], nodes: [] });
        }
        memoryLoads += 1;
        return Response.json({
          memories: memoryLoads === 1 ? [] : [publishedAgentMemory],
        });
      }),
    );
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "63000000-0000-4000-8000-000000000501",
    );
    const user = userEvent.setup();
    render(<MemoryPanel projectId="project-1" />);

    const region = await screen.findByRole("region", { name: "提炼候选" });
    await within(region).findByText("Adopt durable retries");
    const publish = within(region).getByRole("button", { name: "批准发布" });
    await user.click(publish);
    const busyPublish = within(region).getByRole("button", { name: "正在发布…" });
    expect(busyPublish).toBeDisabled();
    expect(within(region).getByRole("button", { name: "驳回" })).toBeDisabled();
    expect(busyPublish.closest(".memory-curation-actions"))
      .toHaveAttribute("aria-busy", "true");
    expect(calls).toContainEqual({
      body: { operationId: "63000000-0000-4000-8000-000000000501" },
      method: "POST",
      url: "/api/projects/project-1/memory-curation-candidates/candidate-1/publish",
    });

    await act(async () => {
      decision.resolve(Response.json({
        candidate: { ...pendingCandidate, status: "published" },
        memory: publishedAgentMemory,
      }));
    });

    expect(await within(region).findByText("暂无待发布的提炼候选。"))
      .toBeInTheDocument();
    const memoryHeading = await screen.findByRole("heading", {
      name: "Adopt durable retries",
    });
    expect(memoryHeading).toHaveFocus();
    expect(screen.getByText(
      "Agent Curator Lin 提议 · Owner 经审批发布 · 平台持久化",
    )).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("提炼候选已发布。");
  });

  it("rejects a candidate, leaves memories unchanged and focuses the region", async () => {
    const MemoryPanel = await memoryPanel();
    const decision = deferred<Response>();
    const calls: Array<{ body?: unknown; method: string; url: string }> = [];
    let candidateLoads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          method,
          url,
        });
        if (url.includes("/memory-curation-candidates")) {
          if (method === "POST") return decision.promise;
          candidateLoads += 1;
          return Response.json({
            candidates: candidateLoads === 1 ? [pendingCandidate] : [],
          });
        }
        if (url.includes("/memory-index/health")) return memoryIndexHealthResponse();
        if (url.includes("/memory-collections")) {
          return Response.json({ collections: [] });
        }
        if (url.includes("/knowledge-graph")) {
          return Response.json({ edges: [], nodes: [] });
        }
        return Response.json({ memories: [activeGoal] });
      }),
    );
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "63000000-0000-4000-8000-000000000502",
    );
    const user = userEvent.setup();
    render(<MemoryPanel projectId="project-1" />);

    const region = await screen.findByRole("region", { name: "提炼候选" });
    await within(region).findByText("Adopt durable retries");
    await user.click(within(region).getByRole("button", { name: "驳回" }));
    const busyReject = within(region).getByRole("button", { name: "正在驳回…" });
    expect(busyReject).toBeDisabled();
    expect(within(region).getByRole("button", { name: "批准发布" })).toBeDisabled();
    expect(busyReject.closest(".memory-curation-actions"))
      .toHaveAttribute("aria-busy", "true");

    await act(async () => {
      decision.resolve(Response.json({
        candidate: { ...pendingCandidate, status: "rejected" },
        memory: null,
      }));
    });

    expect(await within(region).findByText("暂无待发布的提炼候选。"))
      .toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("提炼候选已驳回。");
    expect(screen.getByRole("heading", { name: "Current goal" })).toBeInTheDocument();
    expect(region).toHaveFocus();
    expect(calls).toContainEqual({
      body: { operationId: "63000000-0000-4000-8000-000000000502" },
      method: "POST",
      url: "/api/projects/project-1/memory-curation-candidates/candidate-1/reject",
    });
  });

  it("shows a sanitized candidate load error and retries", async () => {
    const MemoryPanel = await memoryPanel();
    let candidateLoads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/memory-curation-candidates")) {
          candidateLoads += 1;
          return candidateLoads === 1
            ? Response.json(
                { error: { code: "STORAGE_UNAVAILABLE", message: "raw path" } },
                { status: 503 },
              )
            : Response.json({ candidates: [] });
        }
        if (url.includes("/memory-index/health")) return memoryIndexHealthResponse();
        if (url.includes("/memory-collections")) {
          return Response.json({ collections: [] });
        }
        if (url.includes("/knowledge-graph")) {
          return Response.json({ edges: [], nodes: [] });
        }
        return Response.json({ memories: [] });
      }),
    );
    const user = userEvent.setup();
    render(<MemoryPanel projectId="project-1" />);

    const region = await screen.findByRole("region", { name: "提炼候选" });
    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent("无法加载提炼候选，请稍后重试。");
    expect(alert).not.toHaveTextContent("raw path");
    await user.click(within(region).getByRole("button", { name: "重试加载提炼候选" }));
    expect(await within(region).findByText("暂无待发布的提炼候选。"))
      .toBeInTheDocument();
  });

  it("shows loading, load error, retry and actionable empty states", async () => {
    const MemoryPanel = await memoryPanel();
    const first = deferred<Response>();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const curation = emptyCurationResponse(input);
        if (curation) return Promise.resolve(curation);
        if (String(input).includes("/memory-index/health")) {
          return Promise.resolve(memoryIndexHealthResponse({
            coverage: { active: 0, indexed: 0, ratio: 1, valid: 0 },
          }));
        }
        if (String(input).includes("/memory-collections")) {
          return Promise.resolve(Response.json({ collections: [] }));
        }
        if (String(input).includes("/knowledge-graph")) {
          return Promise.resolve(Response.json({ edges: [], nodes: [] }));
        }
        calls += 1;
        return calls === 1
          ? first.promise
          : Promise.resolve(Response.json({ memories: [] }));
      }),
    );
    render(<MemoryPanel projectId="project-1" />);

    expect(screen.getByText("正在加载共享记忆…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.queryByText("尚无共享记忆。")).toBeNull();
    await act(async () => {
      first.resolve(
        Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "unavailable" } },
          { status: 503 },
        ),
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法加载共享记忆",
    );
    await userEvent.setup().click(
      screen.getByRole("button", { name: "重试加载共享记忆" }),
    );
    expect(await screen.findByText("尚无共享记忆。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "＋ 沉淀新记忆" })).toBeEnabled();
  }, 15_000);

  it("leads the memory view with search, type chips, then the card list (U-08)", async () => {
    const MemoryPanel = await memoryPanel();
    const decisionMemory: MemoryEntry = {
      ...activeGoal,
      id: "memory-decision",
      type: "decision",
      content: "Adopt durable retries",
      supersedesId: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const curation = emptyCurationResponse(input);
      if (curation) return curation;
      if (url.includes("/memory-index/health")) return memoryIndexHealthResponse();
      if (url.includes("/memory-collections")) return Response.json({ collections: [] });
      if (url.includes("/knowledge-graph")) return Response.json({ edges: [], nodes: [] });
      return Response.json({ memories: [activeGoal, decisionMemory] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemoryPanel projectId="project-1" />);
    await screen.findByRole("heading", { name: "Current goal" });

    // IA：索引健康条 → 搜索行 → 卡片列表 → 提炼候选（附加区块在后）。
    const search = screen.getByLabelText("搜索记忆");
    const list = screen.getByRole("list", { name: "Active 共享记忆" });
    const indexBar = screen.getByLabelText("记忆索引健康");
    const curation = screen.getByLabelText("提炼候选");
    expect(
      indexBar.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      search.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      list.compareDocumentPosition(curation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // 类型胶囊：切到决策只剩决策卡片，回全部恢复。
    await user.click(screen.getByRole("button", { name: "决策" }));
    expect(within(list).getByText("Adopt durable retries")).toBeInTheDocument();
    expect(within(list).queryByText("Current goal")).toBeNull();
    await user.click(screen.getByRole("button", { name: "全部" }));
    expect(within(list).getByText("Current goal")).toBeInTheDocument();

    // 关键字过滤命中正文。
    await user.type(screen.getByLabelText("搜索记忆"), "durable");
    expect(within(list).queryByText("Current goal")).toBeNull();
    expect(within(list).getByText("Adopt durable retries")).toBeInTheDocument();
  });

  it("creates sourced memory, labels artifact references, supersedes active entries and displays history", async () => {
    const MemoryPanel = await memoryPanel();
    const save = deferred<Response>();
    const created: MemoryEntry = {
      ...activeGoal,
      id: "memory-new",
      content: "Next goal",
      supersedesId: activeGoal.id,
      createdAt: "2026-07-29T00:02:00.000Z",
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const curation = emptyCurationResponse(input);
        if (curation) return curation;
        if (url.includes("/memory-index/health")) return memoryIndexHealthResponse();
        if (url.includes("/memory-collections")) {
          return Response.json({ collections: [] });
        }
        if (url.includes("/knowledge-graph")) {
          return Response.json({ edges: [], nodes: [] });
        }
        if (init?.method === "POST") return save.promise;
        if (url.endsWith("includeInactive=1")) {
          return Response.json({ memories: [oldGoal, activeGoal, created] });
        }
        return Response.json({ memories: [activeGoal] });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemoryPanel projectId="project-1" />);
    await screen.findByRole("heading", { name: "Current goal" });

    await user.click(screen.getByRole("button", { name: "＋ 沉淀新记忆" }));
    await user.click(screen.getByRole("button", { name: "保存记忆" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请输入记忆正文");
    expect(screen.getByLabelText("记忆正文")).toHaveFocus();
    await user.selectOptions(screen.getByLabelText("来源类型"), "artifact_path");
    expect(screen.getByText("仅引用，尚未读取")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("来源类型"), "owner_input");
    const content = screen.getByLabelText("记忆正文");
    content.focus();
    await user.type(content, "Next goal", { skipClick: true });
    const sourceRef = screen.getByLabelText("来源引用");
    sourceRef.focus();
    await user.type(sourceRef, "Owner update", { skipClick: true });
    await user.selectOptions(
      screen.getByLabelText("取代旧记忆"),
      activeGoal.id,
    );
    const submit = screen.getByRole("button", { name: "保存记忆" });
    await user.click(submit);
    expect(submit).toBeDisabled();
    await act(async () => {
      save.resolve(Response.json({ memory: created }, { status: 201 }));
    });

    const heading = await screen.findByRole("heading", { name: "Next goal" });
    expect(heading).toHaveFocus();
    expect(screen.getByRole("status", { name: "保存结果" })).toHaveTextContent(
      "共享记忆已保存。",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/memories",
      expect.objectContaining({
        body: JSON.stringify({
          type: "goal",
          content: "Next goal",
          sourceType: "owner_input",
          sourceRef: "Owner update",
          supersedesId: activeGoal.id,
        }),
        method: "POST",
      }),
    );

    await user.click(screen.getByRole("button", { name: "查看历史记忆" }));
    const history = await screen.findByRole("list", { name: "共享记忆历史" });
    expect(within(history).getByText("Old goal")).toBeInTheDocument();
    expect(within(history).getByText("已失效")).toBeInTheDocument();
  });
});

describe("memory panel search", () => {
  it("keeps the feed, searches on 检索, and locates the memory card", async () => {
    const MemoryPanel = await memoryPanel();
    const search = deferred<Response>();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const curation = emptyCurationResponse(input);
        if (curation) return curation;
        if (url.includes("/memory-index/health")) return memoryIndexHealthResponse();
        if (url.includes("/memory-collections")) {
          return Response.json({ collections: [] });
        }
        if (url.includes("/knowledge-graph")) {
          return Response.json({ edges: [], nodes: [] });
        }
        if (url.includes("/memories/search")) return search.promise;
        if (init?.method === "POST") {
          return Response.json({ memory: activeGoal }, { status: 201 });
        }
        return Response.json({ memories: [activeGoal] });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemoryPanel projectId="project-1" />);
    await screen.findByRole("heading", { name: "Current goal" });

    await user.click(screen.getByRole("button", { name: "打开记忆检索" }));
    expect(screen.getByLabelText("检索记忆")).toBeInTheDocument();
    expect(screen.getByLabelText("检索类型")).toBeInTheDocument();
    expect(screen.getByLabelText("检索来源")).toBeInTheDocument();
    expect(screen.getByLabelText("检索版本")).toBeInTheDocument();

    const searchInput = screen.getByLabelText("检索记忆");
    searchInput.focus();
    await user.type(searchInput, "Current", { skipClick: true });
    await user.selectOptions(screen.getByLabelText("检索类型"), "goal");
    await user.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText("正在检索记忆…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("list", { name: "Active 共享记忆" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/memories/search?q=Current&type=goal",
    );

    await act(async () => {
      search.resolve(
        Response.json({
          results: [
            {
              memory: {
                active: true,
                actor: {
                  confirmer: null,
                  persistedBy: "platform",
                  proposerAgent: null,
                  proposerType: "owner",
                },
                chainId: "memory-active",
                content: "Current goal",
                createdAt: activeGoal.createdAt,
                id: activeGoal.id,
                projectId: "project-1",
                source: {
                  href: null,
                  id: "Owner",
                  type: "owner_input",
                  version: null,
                },
                supersedesId: "memory-old",
                type: "goal",
                version: 2,
              },
              snippet: "Current goal",
            },
          ],
        }),
      );
    });

    const results = await screen.findByRole("list", { name: "记忆检索结果" });
    expect(within(results).getByText("Current goal")).toBeInTheDocument();
    expect(within(results).queryByText("Old goal")).toBeNull();
    expect(screen.getByRole("list", { name: "Active 共享记忆" })).toBeInTheDocument();

    await user.click(within(results).getByRole("button", { name: "定位记忆 Current goal" }));
    expect(screen.getByRole("heading", { name: "Current goal" })).toHaveFocus();
  });

  it("shows search empty and error states without replacing the feed", async () => {
    const MemoryPanel = await memoryPanel();
    const firstSearch = deferred<Response>();
    let searchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const curation = emptyCurationResponse(input);
        if (curation) return curation;
        if (url.includes("/memory-index/health")) return memoryIndexHealthResponse();
        if (url.includes("/memory-collections")) {
          return Promise.resolve(Response.json({ collections: [] }));
        }
        if (url.includes("/knowledge-graph")) {
          return Promise.resolve(Response.json({ edges: [], nodes: [] }));
        }
        if (url.includes("/memories/search")) {
          searchCalls += 1;
          return searchCalls === 1
            ? firstSearch.promise
            : Promise.resolve(Response.json({ results: [] }));
        }
        return Response.json({ memories: [activeGoal] });
      }),
    );
    const user = userEvent.setup();
    render(<MemoryPanel projectId="project-1" />);
    await screen.findByRole("heading", { name: "Current goal" });

    await user.click(screen.getByRole("button", { name: "打开记忆检索" }));
    const missingQuery = screen.getByLabelText("检索记忆");
    missingQuery.focus();
    await user.type(missingQuery, "missing", { skipClick: true });
    await user.click(screen.getByRole("button", { name: "检索" }));
    await act(async () => {
      firstSearch.resolve(
        Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "unavailable" } },
          { status: 503 },
        ),
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("无法检索记忆");
    expect(screen.getByRole("list", { name: "Active 共享记忆" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开记忆检索" }));
    await user.click(screen.getByRole("button", { name: "检索" }));
    expect(await screen.findByText("没有匹配的记忆。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current goal" })).toBeInTheDocument();
  });
});

describe("memory index health", () => {
  it("shows coverage and strongly confirms a rebuild while source memories remain available", async () => {
    const MemoryPanel = await memoryPanel();
    let version = 1;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const curation = emptyCurationResponse(input);
      if (curation) return curation;
      if (url.includes("/memory-index/rebuild")) {
        version = 2;
        return Response.json({
          operationId: "operation",
          replayed: 1,
          status: "caught_up",
          version,
        });
      }
      if (url.includes("/memory-index/health")) {
        return Response.json({
          coverage: { active: 1, indexed: 0, ratio: 0, valid: 0 },
          freshness: { pending: 1, status: "behind" },
          lastErrorCode: null,
          projectId: "project-1",
          searchMode: "source_fallback",
          status: "behind",
          updatedAt: "2026-08-19T00:00:00.000Z",
          version,
        });
      }
      if (url.includes("/memory-collections")) {
        return Response.json({ collections: [] });
      }
      if (url.includes("/knowledge-graph")) {
        return Response.json({ edges: [], nodes: [] });
      }
      if (init?.method === "POST") {
        return Response.json({ memory: activeGoal }, { status: 201 });
      }
      return Response.json({ memories: [activeGoal] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemoryPanel projectId="project-1" />);

    expect(await screen.findByText("索引落后 1 条")).toBeInTheDocument();
    expect(screen.getByText("来源记忆与检索仍可用。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current goal" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重建索引" }));
    expect(screen.getByRole("dialog", { name: "重建记忆索引" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "确认重建" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/memory-index/rebuild",
      expect.objectContaining({
        body: expect.stringContaining("\"expectedVersion\":1"),
        method: "POST",
      }),
    ));
    expect(await screen.findByText("索引已追平 · 1/1 有效")).toBeInTheDocument();
  });
});

describe("memory collection directory", () => {
  it("lists collections and only deletes after confirm", async () => {
    const MemoryPanel = await memoryPanel();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const curation = emptyCurationResponse(input);
      if (curation) return curation;
      if (url.includes("/memory-index/health")) return memoryIndexHealthResponse();
      if (url.includes("/memory-collections")) {
        if (init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return Response.json({
          collections: [{
            id: "collection-1",
            members: [],
            name: "架构决策",
            projectId: "project-1",
          }],
        });
      }
      if (url.includes("/knowledge-graph")) {
        return Response.json({ edges: [], nodes: [] });
      }
      return Response.json({ memories: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemoryPanel projectId="project-1" />);

    const directory = await screen.findByRole("region", { name: "知识集合" });
    expect(within(directory).getByText("架构决策")).toBeInTheDocument();
    await user.click(within(directory).getByRole("button", { name: "删除集合 架构决策" }));
    const dialog = screen.getByRole("dialog", { name: "删除集合" });
    expect(within(dialog).getByText("不会删除来源记忆。")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    await user.click(within(directory).getByRole("button", { name: "删除集合 架构决策" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/project-1/memory-collections/collection-1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});

describe("knowledge graph relation list", () => {
  it("lists sourced supersedes edges and jumps to the memory card", async () => {
    const MemoryPanel = await memoryPanel();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const curation = emptyCurationResponse(input);
      if (curation) return curation;
      if (url.includes("/memory-index/health")) return memoryIndexHealthResponse();
      if (url.includes("/memory-collections")) {
        return Response.json({ collections: [] });
      }
      if (url.includes("/knowledge-graph")) {
        return Response.json({
          edges: [
            { fromId: activeGoal.id, kind: "supersedes", toId: oldGoal.id },
            { fromId: "ghost", kind: "collection", toId: activeGoal.id },
          ],
          nodes: [
            { id: activeGoal.id, title: activeGoal.content },
            { id: oldGoal.id, title: oldGoal.content },
          ],
        });
      }
      return Response.json({ memories: [activeGoal] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemoryPanel projectId="project-1" />);

    const relations = await screen.findByRole("region", { name: "关系列表" });
    expect(within(relations).getByText("Current goal 取代 Old goal")).toBeInTheDocument();
    expect(within(relations).queryByText(/ghost/i)).toBeNull();
    await user.click(within(relations).getByRole("button", { name: "定位记忆 Current goal" }));
    expect(screen.getByRole("heading", { name: "Current goal" })).toHaveFocus();
  });
});

describe("memory panel chrome", () => {
  it("renders memory cards on pearl surfaces with case radius", () => {
    const css = readFileSync("app/cockpit.css", "utf8");
    expect(css).toMatch(
      /\.memory-list \.task-summary\s*\{[^}]*background:\s*var\(--surface-card\)[^}]*border-radius:\s*var\(--rounded-md\)/s,
    );
  });
});
