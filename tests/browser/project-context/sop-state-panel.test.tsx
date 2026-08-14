// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import type { SopStateProjection } from "@/src/modules/mission-work";
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
): WorkItem {
  return {
    id,
    missionId: mission.id,
    title,
    description: `${title} description`,
    status,
    assigneeAgentId: "agent-a",
    dependencyIds: [],
    version: 1,
    createdAt: id,
    updatedAt: id,
  };
}

const items = [workItem("item-1", "Implement demo-sop query", "todo")];

const EMPTY_DEPENDENCIES = {
  nodes: [],
  edges: [],
  cycles: [],
  hasDependencies: false,
};

const EMPTY_SOP: SopStateProjection = {
  workspaceBound: true,
  readAt: "2026-08-15T00:00:00.000Z",
  items: [],
};

const UNBOUND_SOP: SopStateProjection = {
  workspaceBound: false,
  readAt: "2026-08-15T00:00:00.000Z",
  items: [],
};

const CURRENT_SOP: SopStateProjection = {
  workspaceBound: true,
  readAt: "2026-08-15T00:00:00.000Z",
  items: [
    {
      relativePath: "features/demo-sop/progress.md",
      title: "SOP 状态投影",
      declaredStage: "implement",
      freshness: "current",
      staleReason: null,
      workItems: [
        {
          workItemId: "item-1",
          title: "Implement demo-sop query",
          status: "todo",
        },
      ],
    },
  ],
};

const STALE_SOP: SopStateProjection = {
  workspaceBound: true,
  readAt: "2026-08-15T00:00:00.000Z",
  items: [
    {
      relativePath: "features/demo-sop/progress.md",
      title: "SOP 状态投影",
      declaredStage: "done",
      freshness: "stale",
      staleReason: "declared_stage_diverges",
      workItems: [
        {
          workItemId: "item-1",
          title: "Implement demo-sop query",
          status: "todo",
        },
      ],
    },
  ],
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

function stubBoardFetch(sopState: () => Promise<Response> | Response) {
  const fetchMock = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/members")) {
        return Promise.resolve(Response.json({ members, projectVersion: 3 }));
      }
      if (url.endsWith("/capability-insight") && !init?.method) {
        return Promise.resolve(Response.json({ portraits: [], suggestions: [] }));
      }
      if (url.endsWith("/mission") && !init?.method) {
        return Promise.resolve(Response.json({ mission, workItems: items }));
      }
      if (url.endsWith("/dependencies") && !init?.method) {
        return Promise.resolve(Response.json(EMPTY_DEPENDENCIES));
      }
      if (url.endsWith("/sop-state") && !init?.method) {
        return Promise.resolve(sopState());
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function sopRegion() {
  return screen.findByRole("region", { name: "流程状态" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SOP state panel", () => {
  it("renders source path, declared stage, matching statuses, and locates the task", async () => {
    const MissionBoard = await board();
    stubBoardFetch(() => Response.json(CURRENT_SOP));
    const user = userEvent.setup();
    render(<MissionBoard projectId="project-1" />);

    const region = await sopRegion();
    expect(
      await within(region).findByText("features/demo-sop/progress.md"),
    ).toBeInTheDocument();
    expect(within(region).getByText("implement")).toBeInTheDocument();
    expect(within(region).getByText("待办")).toBeInTheDocument();
    expect(within(region).queryByText("声明阶段与匹配任务状态不一致。")).toBeNull();

    const boardRegion = screen.getByRole("region", { name: "使命任务看板" });
    await user.click(
      within(region).getByRole("button", { name: "定位任务 Implement demo-sop query" }),
    );
    expect(
      within(boardRegion).getByRole("heading", { name: "Implement demo-sop query" }),
    ).toHaveFocus();

    const cockpitCss = readFileSync(join(process.cwd(), "app", "cockpit.css"), "utf8");
    expect(cockpitCss).toMatch(
      /\.mission-sop-state\s*\{[^}]*background:\s*var\(--surface-card\)[^}]*border:\s*var\(--border-width\)\s*solid\s*var\(--border-subtle\)/su,
    );
    expect(cockpitCss).toMatch(
      /button(?:\s*,\s*(?:input|select|textarea))*\s*\{[^}]*min-height:\s*var\(--control-min\)/su,
    );
  });

  it("shows stale copy when declared stage diverges", async () => {
    const MissionBoard = await board();
    stubBoardFetch(() => Response.json(STALE_SOP));
    render(<MissionBoard projectId="project-1" />);

    const region = await sopRegion();
    expect(
      await within(region).findByText("声明阶段与匹配任务状态不一致。"),
    ).toBeInTheDocument();
    expect(within(region).getByText("done")).toBeInTheDocument();
  });

  it("shows empty copy when no process files are discovered", async () => {
    const MissionBoard = await board();
    stubBoardFetch(() => Response.json(EMPTY_SOP));
    render(<MissionBoard projectId="project-1" />);

    const region = await sopRegion();
    expect(await within(region).findByText("未发现流程文件。")).toBeInTheDocument();
  });

  it("shows unbound copy when the workspace is not bound", async () => {
    const MissionBoard = await board();
    stubBoardFetch(() => Response.json(UNBOUND_SOP));
    render(<MissionBoard projectId="project-1" />);

    const region = await sopRegion();
    expect(
      await within(region).findByText("未绑定工作区，无法读取流程文件。"),
    ).toBeInTheDocument();
  });

  it("distinguishes loading, sanitized error with retry", async () => {
    const MissionBoard = await board();
    const first = deferred<Response>();
    let sopCalls = 0;
    stubBoardFetch(() => {
      sopCalls += 1;
      return sopCalls === 1 ? first.promise : Response.json(EMPTY_SOP);
    });
    const user = userEvent.setup();
    render(<MissionBoard projectId="project-1" />);

    const region = await sopRegion();
    const loading = within(region).getByText("正在加载流程状态…");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(within(region).queryByText("未发现流程文件。")).toBeNull();

    await act(async () => {
      first.resolve(
        Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "unavailable" } },
          { status: 503 },
        ),
      );
    });
    expect(await within(region).findByRole("alert")).toHaveTextContent(
      "无法加载流程状态，请重试。",
    );

    await user.click(
      within(region).getByRole("button", { name: "重试加载流程状态" }),
    );
    expect(await within(region).findByText("未发现流程文件。")).toBeInTheDocument();
    expect(sopCalls).toBe(2);
  });
});
