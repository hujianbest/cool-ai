// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import type {
  Mission,
  ProjectMember,
  WorkItem,
} from "@/src/shared/project-context-contracts";

type MissionBoardModule = {
  MissionBoard: ComponentType<{ projectId: string }>;
};

const boardModules =
  import.meta.glob<MissionBoardModule>("../../../components/project-context/mission-board.tsx");

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
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
    },
  },
  {
    agentId: "agent-b",
    joinedAt: "b",
    name: "Beta",
    role: "实现",
    model: "model-b",
    avatarText: "B",
    accentToken: "gold",
    skillNames: ["Build"],
    permissions: {
      readFiles: true,
      writeFiles: true,
      runCommands: true,
    },
  },
];

function workItem(
  id: string,
  title: string,
  status: WorkItem["status"],
  dependencyIds: string[] = [],
): WorkItem {
  return {
    id,
    missionId: mission.id,
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
  workItem("item-3", "Review", "blocked", ["item-2"]),
  workItem("item-4", "Ship", "done", ["item-3"]),
];

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Mission Board", () => {
  it("distinguishes loading, error and empty states and retries without showing a false empty", async () => {
    const MissionBoard = await board();
    const firstMission = deferred<Response>();
    let missionCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/members")) {
          return Promise.resolve(
            Response.json({ members, projectVersion: 3 }),
          );
        }
        if (url.endsWith("/mission")) {
          missionCalls += 1;
          return missionCalls === 1
            ? firstMission.promise
            : Promise.resolve(
                Response.json({ mission: null, workItems: [] }),
              );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    render(<MissionBoard projectId="project-1" />);

    expect(screen.getByText("正在加载使命看板…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.queryByText("尚未创建使命。")).toBeNull();
    await act(async () => {
      firstMission.resolve(
        Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "unavailable" } },
          { status: 503 },
        ),
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法加载使命看板",
    );
    await userEvent.setup().click(
      screen.getByRole("button", { name: "重试加载使命看板" }),
    );
    expect(await screen.findByText("尚未创建使命。")).toBeInTheDocument();
    expect(screen.getByLabelText("使命标题")).toBeEnabled();
  });

  it("creates and edits a mission with field focus and polite success", async () => {
    const MissionBoard = await board();
    let currentMission: Mission | null = null;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/members")) {
          return Response.json({ members, projectVersion: 3 });
        }
        if (url.endsWith("/mission") && !init?.method) {
          return Response.json({ mission: currentMission, workItems: [] });
        }
        if (url.endsWith("/dependencies") && !init?.method) {
          return Response.json({
            nodes: [],
            edges: [],
            cycles: [],
            hasDependencies: false,
          });
        }
        if (url.endsWith("/mission") && init?.method === "POST") {
          currentMission = mission;
          return Response.json({ mission }, { status: 201 });
        }
        if (url === "/api/missions/mission-1" && init?.method === "PATCH") {
          currentMission = {
            ...mission,
            title: "Updated mission",
            goal: "Updated goal",
            version: 3,
          };
          return Response.json({ mission: currentMission });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MissionBoard projectId="project-1" />);
    await screen.findByText("尚未创建使命。");

    await user.click(screen.getByRole("button", { name: "创建使命" }));
    expect(screen.getByLabelText("使命标题")).toHaveFocus();
    const titleError = screen.getByText("请输入使命标题。");
    expect(screen.getByLabelText("使命标题")).toHaveAttribute(
      "aria-describedby",
      titleError.id,
    );
    await user.type(screen.getByLabelText("使命标题"), mission.title);
    await user.type(screen.getByLabelText("使命目标"), mission.goal);
    await user.click(screen.getByRole("button", { name: "创建使命" }));

    const createCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/mission") && init?.method === "POST",
    );
    expect(createCall).toBeDefined();
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      expectedVersion: 0,
      goal: mission.goal,
      operationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      ),
      title: mission.title,
    });

    const title = await screen.findByRole("heading", {
      name: mission.title,
    });
    expect(title).toHaveFocus();
    expect(screen.getByRole("status", { name: "保存结果" })).toHaveTextContent(
      "使命已创建。",
    );

    await user.click(screen.getByRole("button", { name: "编辑使命" }));
    await user.clear(screen.getByLabelText("使命标题"));
    await user.type(screen.getByLabelText("使命标题"), "Updated mission");
    await user.clear(screen.getByLabelText("使命目标"));
    await user.type(screen.getByLabelText("使命目标"), "Updated goal");
    await user.click(screen.getByRole("button", { name: "保存使命" }));

    const updated = await screen.findByRole("heading", {
      name: "Updated mission",
    });
    expect(updated).toHaveFocus();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/missions/mission-1",
      expect.objectContaining({
        body: JSON.stringify({
          title: "Updated mission",
          goal: "Updated goal",
          expectedVersion: 2,
        }),
        method: "PATCH",
      }),
    );
  });

  it("renders four semantic status sections and creates work with member and dependency fields", async () => {
    const MissionBoard = await board();
    const created = workItem("item-5", "Document", "todo", ["item-1"]);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/members")) {
          return Response.json({ members, projectVersion: 3 });
        }
        if (url.endsWith("/mission") && !init?.method) {
          return Response.json({ mission, workItems: items });
        }
        if (url.endsWith("/dependencies") && !init?.method) {
          return Response.json({
            nodes: [],
            edges: [],
            cycles: [],
            hasDependencies: false,
          });
        }
        if (
          url === "/api/missions/mission-1/work-items" &&
          init?.method === "POST"
        ) {
          return Response.json({ workItem: created }, { status: 201 });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MissionBoard projectId="project-1" />);

    const boardRegion = await screen.findByRole("region", {
      name: "使命任务看板",
    });
    for (const label of ["待办", "进行中", "阻塞", "完成"]) {
      expect(
        within(boardRegion).getByRole("region", { name: label }),
      ).toBeInTheDocument();
    }
    expect(boardRegion.querySelector("[draggable]")).toBeNull();
    expect(within(boardRegion).getByText("等待: Plan")).toBeInTheDocument();

    await user.type(screen.getByLabelText("任务标题"), "Document");
    await user.type(screen.getByLabelText("任务说明"), "Write docs");
    await user.selectOptions(screen.getByLabelText("负责人"), "agent-b");
    const dependencies = screen.getByRole("group", { name: "前置依赖" });
    await user.click(
      within(dependencies).getByRole("checkbox", { name: "Plan" }),
    );
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    const createdTitle = await screen.findByRole("heading", {
      name: "Document",
    });
    expect(createdTitle).toHaveFocus();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/missions/mission-1/work-items",
      expect.objectContaining({
        body: JSON.stringify({
          title: "Document",
          description: "Write docs",
          assigneeAgentId: "agent-b",
          dependencyIds: ["item-1"],
        }),
        method: "POST",
      }),
    );

    const cockpitCss = readFileSync(
      join(process.cwd(), "app", "cockpit.css"),
      "utf8",
    );
    const tokensCss = readFileSync(
      join(process.cwd(), "app", "tokens.css"),
      "utf8",
    );
    expect(cockpitCss).toMatch(
      /\.mission-board-grid\s*\{[^}]*display:\s*grid[^}]*min-width:\s*0/s,
    );
    expect(tokensCss).toMatch(
      /@media\s*\(max-width:\s*56\.25rem\)[\s\S]*\.mission-board-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });

  it("edits metadata separately from transitions and exposes stable conflict recovery", async () => {
    const MissionBoard = await board();
    let transitionCalls = 0;
    const transitionResult = deferred<Response>();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/members")) {
          return Response.json({ members, projectVersion: 3 });
        }
        if (url.endsWith("/mission") && !init?.method) {
          return Response.json({ mission, workItems: items });
        }
        if (url.endsWith("/dependencies") && !init?.method) {
          return Response.json({
            nodes: [],
            edges: [],
            cycles: [],
            hasDependencies: false,
          });
        }
        if (url === "/api/work-items/item-1" && init?.method === "PATCH") {
          return Response.json({
            workItem: {
              ...items[0],
              title: "Plan carefully",
              description: "Updated",
              assigneeAgentId: "agent-b",
              version: 2,
            },
          });
        }
        if (
          url === "/api/work-items/item-1/transition" &&
          init?.method === "POST"
        ) {
          transitionCalls += 1;
          return transitionResult.promise;
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MissionBoard projectId="project-1" />);
    await screen.findByRole("heading", { name: "Plan" });

    await user.click(screen.getByRole("button", { name: "编辑任务 Plan" }));
    await user.clear(screen.getByLabelText("编辑任务标题 Plan"));
    await user.type(
      screen.getByLabelText("编辑任务标题 Plan"),
      "Plan carefully",
    );
    await user.clear(screen.getByLabelText("编辑任务说明 Plan"));
    await user.type(screen.getByLabelText("编辑任务说明 Plan"), "Updated");
    await user.selectOptions(
      screen.getByLabelText("编辑任务负责人 Plan"),
      "agent-b",
    );
    await user.click(screen.getByRole("button", { name: "保存任务 Plan" }));
    expect(
      await screen.findByRole("heading", { name: "Plan carefully" }),
    ).toHaveFocus();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/work-items/item-1",
      expect.objectContaining({
        body: JSON.stringify({
          title: "Plan carefully",
          description: "Updated",
          assigneeAgentId: "agent-b",
          dependencyIds: [],
          expectedVersion: 1,
        }),
        method: "PATCH",
      }),
    );

    const start = screen.getByRole("button", {
      name: "开始任务 Plan carefully",
    });
    await user.click(start);
    expect(transitionCalls).toBe(1);
    expect(start).toBeDisabled();
    await act(async () => {
      transitionResult.resolve(
        Response.json(
          {
            error: {
              code: "RESOURCE_CONFLICT",
              message: "stale",
              currentVersion: 3,
            },
          },
          { status: 409 },
        ),
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "数据已更新，请刷新后重试",
    );
    expect(
      screen.getByRole("button", { name: "刷新使命看板" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/work-items/item-1/transition",
      expect.objectContaining({
        body: JSON.stringify({
          toStatus: "in_progress",
          expectedVersion: 2,
        }),
        method: "POST",
      }),
    );
  });
});

describe("mission board chrome", () => {
  it("renders task cards on pearl surfaces with case radius", () => {
    const css = readFileSync(join(process.cwd(), "app", "cockpit.css"), "utf8");
    expect(css).toMatch(
      /\.mission-board \.task-summary\s*\{[^}]*background:\s*var\(--surface-card\)[^}]*border-radius:\s*var\(--rounded-md\)/s,
    );
    expect(css).toMatch(
      /\.mission-status\s*\{[^}]*background:\s*var\(--surface-card\)[^}]*border-radius:\s*var\(--rounded-md\)/s,
    );
  });
});
