// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import type { MissionDependencyInsight } from "@/src/modules/mission-work";
import type {
  Mission,
  ProjectMember,
  WorkItem,
} from "@/src/shared/project-context-contracts";

type MissionBoardModule = {
  MissionBoard: ComponentType<{ projectId: string }>;
};

const boardModules = import.meta.glob<MissionBoardModule>(
  "../../../components/project-context/mission-board.tsx",
);

const mission: Mission = {
  id: "mission-1",
  projectId: "project-1",
  title: "Ship the cockpit",
  goal: "Deliver deterministic collaboration",
  version: 2,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

const members: ProjectMember[] = [
  {
    agentId: "agent-a",
    joinedAt: "a",
    name: "Alpha",
    role: "规划",
    model: "model-a",
    avatarText: "A",
    accentToken: "sage",
    skillNames: ["Plan"],
    permissions: { readFiles: true, writeFiles: false, runCommands: false },
  },
];

function workItem(
  id: string,
  title: string,
  status: WorkItem["status"],
  dependencyIds: string[] = [],
  missionId = mission.id,
): WorkItem {
  return {
    id,
    missionId,
    title,
    description: `${title} description`,
    status,
    assigneeAgentId: "agent-a",
    dependencyIds,
    version: 1,
    createdAt: id,
    updatedAt: id,
  };
}

const items = [
  workItem("item-1", "Plan", "todo"),
  workItem("item-2", "Build", "in_progress", ["item-1"]),
  workItem("item-3", "Review", "blocked", ["item-2", "item-4"]),
  workItem("item-4", "Ship", "done", ["item-3"]),
];

function node(
  workItemId: string,
  title: string,
  status: WorkItem["status"],
  overrides: Partial<MissionDependencyInsight["nodes"][number]> = {},
): MissionDependencyInsight["nodes"][number] {
  return {
    workItemId,
    title,
    status,
    blockedByIds: [],
    blockingIds: [],
    blockedReason: null,
    cycleId: null,
    missingDependencyIds: [],
    ...overrides,
  };
}

const insight: MissionDependencyInsight = {
  nodes: [
    node("item-1", "Plan", "todo", { blockingIds: ["item-2"] }),
    node("item-2", "Build", "in_progress", {
      blockedByIds: ["item-1"],
      blockingIds: ["item-3"],
      blockedReason: "前置依赖未完成：待办 1 项",
    }),
    node("item-3", "Review", "blocked", {
      blockedByIds: ["item-2", "item-4"],
      blockingIds: ["item-4"],
      blockedReason: "前置依赖未完成：进行中 1 项",
      cycleId: "cycle-1",
    }),
    node("item-4", "Ship", "done", {
      blockedByIds: ["item-3"],
      blockingIds: ["item-3"],
      cycleId: "cycle-1",
    }),
  ],
  edges: [
    { fromWorkItemId: "item-1", toWorkItemId: "item-2" },
    { fromWorkItemId: "item-2", toWorkItemId: "item-3" },
    { fromWorkItemId: "item-3", toWorkItemId: "item-4" },
    { fromWorkItemId: "item-4", toWorkItemId: "item-3" },
  ],
  cycles: [
    {
      cycleId: "cycle-1",
      memberWorkItemIds: ["item-3", "item-4"],
      path: "Review → Ship → Review",
    },
  ],
  hasDependencies: true,
};

const EMPTY_INSIGHT: MissionDependencyInsight = {
  nodes: [],
  edges: [],
  cycles: [],
  hasDependencies: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function board() {
  const load =
    boardModules["../../../components/project-context/mission-board.tsx"];
  expect(load, "the semantic mission board must exist").toBeTypeOf("function");
  return (await load()).MissionBoard;
}

function stubBoardFetch(
  dependencies: () => Promise<Response> | Response,
  options: { workItems?: WorkItem[] } = {},
) {
  const fetchMock = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/members")) {
        return Promise.resolve(
          Response.json({ members, projectVersion: 3 }),
        );
      }
      if (url.endsWith("/capability-insight") && !init?.method) {
        return Promise.resolve(Response.json({ portraits: [], suggestions: [] }));
      }
      if (url.endsWith("/mission") && !init?.method) {
        return Promise.resolve(
          Response.json({
            mission,
            workItems: options.workItems ?? items,
          }),
        );
      }
      if (url.endsWith("/dependencies") && !init?.method) {
        return Promise.resolve(dependencies());
      }
      if (url.endsWith("/sop-state") && !init?.method) {
        return Promise.resolve(
          Response.json({
            workspaceBound: true,
            readAt: "2026-08-15T00:00:00.000Z",
            items: [],
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function dependencyRegion() {
  return screen.findByRole("region", { name: "依赖全景" });
}

function nodeCard(region: HTMLElement, title: string) {
  const heading = within(region).getByRole("heading", {
    name: new RegExp(`^${title}`, "u"),
  });
  const card = heading.closest("li");
  expect(card, `node card for ${title}`).not.toBeNull();
  return card!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Mission dependency insight", () => {
  it("renders nodes with statuses, blocked reasons and cycle annotations, and locates tasks via click and Enter", async () => {
    const MissionBoard = await board();
    stubBoardFetch(() => Response.json(insight));
    const user = userEvent.setup();
    render(<MissionBoard projectId="project-1" />);

    const region = await dependencyRegion();
    const list = await within(region).findByRole("list", {
      name: "任务依赖关系",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);

    const buildCard = nodeCard(region, "Build");
    expect(within(buildCard).getByText("进行中")).toBeInTheDocument();
    expect(
      within(buildCard).getByText("前置依赖未完成：待办 1 项"),
    ).toBeInTheDocument();
    expect(within(buildCard).getByText(/被阻塞于：/u)).toBeInTheDocument();
    expect(
      within(buildCard).getByRole("button", { name: "定位任务 Plan" }),
    ).toBeInTheDocument();
    expect(within(buildCard).getByText(/阻塞：/u)).toBeInTheDocument();
    expect(
      within(buildCard).getByRole("button", { name: "定位任务 Review" }),
    ).toBeInTheDocument();

    const reviewCard = nodeCard(region, "Review");
    expect(within(reviewCard).getByText("循环 cycle-1")).toBeInTheDocument();
    expect(
      within(region).getByText("循环依赖 cycle-1：Review → Ship → Review"),
    ).toBeInTheDocument();

    expect(within(region).queryByRole("textbox")).toBeNull();
    expect(within(region).queryByRole("checkbox")).toBeNull();
    expect(
      within(region).queryByRole("button", { name: /编辑/u }),
    ).toBeNull();

    const boardRegion = screen.getByRole("region", { name: "使命任务看板" });
    await user.click(
      within(buildCard).getByRole("button", { name: "定位任务 Build" }),
    );
    expect(
      within(boardRegion).getByRole("heading", { name: "Build" }),
    ).toHaveFocus();

    const planCard = nodeCard(region, "Plan");
    within(planCard)
      .getByRole("button", { name: "定位任务 Build" })
      .focus();
    await user.keyboard("{Enter}");
    expect(
      within(boardRegion).getByRole("heading", { name: "Build" }),
    ).toHaveFocus();

    const cockpitCss = readFileSync(
      join(process.cwd(), "app", "cockpit.css"),
      "utf8",
    );
    expect(cockpitCss).toMatch(
      /\.mission-dependencies\s*\{[^}]*background:\s*var\(--surface-card\)[^}]*border:\s*var\(--border-width\)\s*solid\s*var\(--border-subtle\)/su,
    );
  });

  it("distinguishes loading, sanitized error with retry and the no-dependency empty state", async () => {
    const MissionBoard = await board();
    const first = deferred<Response>();
    let dependencyCalls = 0;
    stubBoardFetch(() => {
      dependencyCalls += 1;
      return dependencyCalls === 1
        ? first.promise
        : Response.json(EMPTY_INSIGHT);
    });
    const user = userEvent.setup();
    render(<MissionBoard projectId="project-1" />);

    const region = await dependencyRegion();
    const loading = within(region).getByText("正在加载依赖全景…");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(within(region).queryByText("该 Mission 暂无依赖关系。")).toBeNull();

    await act(async () => {
      first.resolve(
        Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "unavailable" } },
          { status: 503 },
        ),
      );
    });
    expect(await within(region).findByRole("alert")).toHaveTextContent(
      "无法加载依赖全景，请重试。",
    );

    await user.click(
      within(region).getByRole("button", { name: "重试加载依赖全景" }),
    );
    expect(
      await within(region).findByText("该 Mission 暂无依赖关系。"),
    ).toBeInTheDocument();
    expect(dependencyCalls).toBe(2);
  });

  it("does not leak stale insight across a project/mission target switch", async () => {
    const MissionBoard = await board();
    const secondMission: Mission = {
      ...mission,
      id: "mission-2",
      projectId: "project-2",
      title: "Second mission",
    };
    const secondItems = [
      workItem("item-9", "Fresh Node", "todo", [], secondMission.id),
    ];
    const stale = deferred<Response>();
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/members")) {
          return Promise.resolve(
            Response.json({ members, projectVersion: 3 }),
          );
        }
        if (url.endsWith("/capability-insight") && !init?.method) {
          return Promise.resolve(Response.json({ portraits: [], suggestions: [] }));
        }
        if (url === "/api/projects/project-1/mission" && !init?.method) {
          return Promise.resolve(
            Response.json({ mission, workItems: items }),
          );
        }
        if (url === "/api/projects/project-2/mission" && !init?.method) {
          return Promise.resolve(
            Response.json({ mission: secondMission, workItems: secondItems }),
          );
        }
        if (
          url === "/api/projects/project-1/missions/mission-1/dependencies"
        ) {
          return stale.promise;
        }
        if (
          url === "/api/projects/project-2/missions/mission-2/dependencies"
        ) {
          return Promise.resolve(
            Response.json({
              nodes: [node("item-9", "Fresh Node", "todo")],
              edges: [],
              cycles: [],
              hasDependencies: true,
            } satisfies MissionDependencyInsight),
          );
        }
        if (url.endsWith("/sop-state") && !init?.method) {
          return Promise.resolve(
            Response.json({
              workspaceBound: true,
              readAt: "2026-08-15T00:00:00.000Z",
              items: [],
            }),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<MissionBoard projectId="project-1" />);
    const region = await dependencyRegion();
    expect(
      within(region).getByText("正在加载依赖全景…"),
    ).toBeInTheDocument();

    rerender(<MissionBoard projectId="project-2" />);
    const secondRegion = await screen.findByRole("region", {
      name: "依赖全景",
    });
    expect(
      await within(secondRegion).findByText("Fresh Node"),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-2/missions/mission-2/dependencies",
    );

    await act(async () => {
      stale.resolve(
        Response.json({
          nodes: [node("item-1", "陈旧节点", "todo")],
          edges: [],
          cycles: [],
          hasDependencies: true,
        } satisfies MissionDependencyInsight),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("陈旧节点")).toBeNull();
    });
    expect(
      within(
        screen.getByRole("region", { name: "依赖全景" }),
      ).getByText("Fresh Node"),
    ).toBeInTheDocument();
  });

  it("refreshes the read model after a work item transition", async () => {
    const MissionBoard = await board();
    let dependencyCalls = 0;
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/members")) {
          return Promise.resolve(
            Response.json({ members, projectVersion: 3 }),
          );
        }
        if (url.endsWith("/capability-insight") && !init?.method) {
          return Promise.resolve(Response.json({ portraits: [], suggestions: [] }));
        }
        if (url.endsWith("/mission") && !init?.method) {
          return Promise.resolve(
            Response.json({ mission, workItems: items }),
          );
        }
        if (url.endsWith("/dependencies") && !init?.method) {
          dependencyCalls += 1;
          return Promise.resolve(Response.json(insight));
        }
        if (url.endsWith("/sop-state") && !init?.method) {
          return Promise.resolve(
            Response.json({
              workspaceBound: true,
              readAt: "2026-08-15T00:00:00.000Z",
              items: [],
            }),
          );
        }
        if (
          url === "/api/work-items/item-1/transition" &&
          init?.method === "POST"
        ) {
          return Promise.resolve(
            Response.json({
              workItem: {
                ...items[0],
                status: "in_progress",
                version: 2,
              },
            }),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MissionBoard projectId="project-1" />);
    await dependencyRegion();
    await waitFor(() => expect(dependencyCalls).toBe(1));

    const boardRegion = screen.getByRole("region", { name: "使命任务看板" });
    await user.click(
      within(boardRegion).getByRole("button", { name: "开始任务 Plan" }),
    );
    await screen.findByRole("status", { name: "保存结果" });
    await waitFor(() => expect(dependencyCalls).toBe(2));
  });
});
