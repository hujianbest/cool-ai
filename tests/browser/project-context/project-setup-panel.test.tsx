// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

type SetupModule = {
  ProjectSetupPanel: ComponentType<{ projectId: string }>;
};

const setupModules =
  import.meta.glob<SetupModule>("../../../components/project-context/project-setup-panel.tsx");

const agents = [
  {
    id: "agent-a",
    name: "Alpha",
    role: "规划",
    systemPrompt: "Plan",
    providerId: "provider",
    model: "model-a",
    skillIds: [],
    permissions: { readFiles: true, writeFiles: false, runCommands: false },
    maxTokens: 1000,
    maxHandoffs: 1,
    avatarText: "A",
    accentToken: "sage",
    version: 1,
    createdAt: "a",
    updatedAt: "a",
  },
  {
    id: "agent-b",
    name: "Beta",
    role: "实现",
    systemPrompt: "Build",
    providerId: "provider",
    model: "model-b",
    skillIds: [],
    permissions: { readFiles: true, writeFiles: true, runCommands: true },
    maxTokens: 1000,
    maxHandoffs: 1,
    avatarText: "B",
    accentToken: "gold",
    version: 1,
    createdAt: "b",
    updatedAt: "b",
  },
  {
    id: "agent-c",
    name: "Gamma",
    role: "评审",
    systemPrompt: "Review",
    providerId: "provider",
    model: "model-c",
    skillIds: [],
    permissions: { readFiles: true, writeFiles: false, runCommands: false },
    maxTokens: 1000,
    maxHandoffs: 1,
    avatarText: "G",
    accentToken: "slate",
    version: 1,
    createdAt: "c",
    updatedAt: "c",
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function setupPanel() {
  const load =
    setupModules["../../../components/project-context/project-setup-panel.tsx"];
  expect(load, "the complete project setup panel must exist").toBeTypeOf("function");
  return (await load()).ProjectSetupPanel;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workspace and equal-member setup", () => {
  it("isolates coordinated versions when switching from a high to low version project", async () => {
    const ProjectSetupPanel = await setupPanel();
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const projectId = url.includes("project-high")
          ? "project-high"
          : "project-low";
        const version = projectId === "project-high" ? 9 : 2;
        if (url === "/api/agents") return Response.json({ agents });
        if (url.includes("/workspace/files")) {
          return Response.json({ entries: [], path: "." });
        }
        if (url.endsWith("/workspace") && !init?.method) {
          return Response.json({ workspace: null, projectVersion: version });
        }
        if (url.endsWith("/members") && !init?.method) {
          return Response.json({
            members: agents.slice(0, 2).map((agent, index) => ({
              agentId: agent.id,
              joinedAt: String(index),
              name: agent.name,
              role: agent.role,
              model: agent.model,
              avatarText: agent.avatarText,
              accentToken: agent.accentToken,
              skillNames: [],
              permissions: agent.permissions,
            })),
            projectVersion: version,
          });
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push({ url, body });
        if (url.endsWith("/workspace")) {
          return Response.json({
            workspace: { path: "D:\\low", status: "ready" },
            projectVersion: 3,
          });
        }
        if (url.endsWith("/members")) {
          return Response.json({
            members: agents.slice(0, 2).map((agent, index) => ({
              agentId: agent.id,
              joinedAt: String(index),
              name: agent.name,
              role: agent.role,
              model: agent.model,
              avatarText: agent.avatarText,
              accentToken: agent.accentToken,
              skillNames: [],
              permissions: agent.permissions,
            })),
            projectVersion: 4,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    const view = render(<ProjectSetupPanel projectId="project-high" />);
    await screen.findByText("尚未绑定本地工作区。");

    view.rerender(<ProjectSetupPanel projectId="project-low" />);
    const path = await screen.findByLabelText("本地工作区路径");
    await user.type(path, "D:\\low");
    await user.click(screen.getByRole("button", { name: "绑定工作区" }));
    await screen.findByText("工作区已保存。");
    await user.click(screen.getByRole("button", { name: "保存成员" }));
    await screen.findByText("项目成员已保存。");

    expect(writes).toEqual([
      {
        url: "/api/projects/project-low/workspace",
        body: {
          path: "D:\\low",
          expectedVersion: 2,
          confirmRebind: false,
        },
      },
      {
        url: "/api/projects/project-low/members",
        body: {
          agentIds: ["agent-a", "agent-b"],
          expectedProjectVersion: 3,
        },
      },
    ]);
  });

  it("distinguishes loading, empty and load-error states with retry", async () => {
    const ProjectSetupPanel = await setupPanel();
    const workspace = deferred<Response>();
    let workspaceCalls = 0;
    let memberCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/project-1/workspace") {
          workspaceCalls += 1;
          return workspaceCalls === 1
            ? workspace.promise
            : Promise.resolve(
                Response.json({ workspace: null, projectVersion: 3 }),
              );
        }
        if (url === "/api/projects/project-1/members") {
          memberCalls += 1;
          return Promise.resolve(
            memberCalls === 1
              ? Response.json(
                  {
                    error: {
                      code: "STORAGE_UNAVAILABLE",
                      message: "unavailable",
                    },
                  },
                  { status: 503 },
                )
              : Response.json({ members: [], projectVersion: 3 }),
          );
        }
        if (url === "/api/agents") {
          return Promise.resolve(Response.json({ agents: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    render(<ProjectSetupPanel projectId="project-1" />);

    expect(screen.getByText("正在加载工作区…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await act(async () => {
      workspace.resolve(Response.json({ workspace: null, projectVersion: 3 }));
    });
    expect(await screen.findByText("尚未绑定本地工作区。")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法加载项目成员",
    );
    expect(screen.getByLabelText("本地工作区路径")).toBeEnabled();
    expect(screen.getByText(/Agent 库为空，请先/)).toBeInTheDocument();

    await userEvent.setup().click(
      screen.getByRole("button", { name: "重试加载成员" }),
    );
    expect(await screen.findByText("尚未组建项目成员。")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "重试加载成员" })).toBeNull(),
    );
  });

  it("binds, confirms rebind, announces success and focuses the path summary", async () => {
    const ProjectSetupPanel = await setupPanel();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/workspace/files")) {
          return Response.json({ entries: [], path: "." });
        }
        if (url.endsWith("/workspace") && !init?.method) {
          return Response.json({
            workspace: { path: "D:\\old", status: "ready" },
            projectVersion: 4,
          });
        }
        if (url.endsWith("/members")) {
          return Response.json({ members: [], projectVersion: 4 });
        }
        if (url === "/api/agents") return Response.json({ agents });
        if (url.endsWith("/workspace") && init?.method === "PUT") {
          return Response.json({
            workspace: { path: "D:\\new", status: "ready" },
            projectVersion: 5,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ProjectSetupPanel projectId="project-1" />);

    const path = await screen.findByLabelText("本地工作区路径");
    await user.clear(path);
    await user.type(path, "D:\\new");
    await user.click(screen.getByRole("button", { name: "保存工作区" }));

    const dialog = screen.getByRole("dialog", { name: "确认改绑工作区" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(
      screen
        .getByRole("heading", { hidden: true, name: "项目设置" })
        .closest("section"),
    ).toHaveAttribute("inert");
    await user.click(
      within(dialog).getByRole("button", { name: "确认改绑" }),
    );

    const summary = await screen.findByRole("status", {
      name: "工作区绑定状态",
    });
    expect(summary).toHaveTextContent("D:\\new");
    expect(summary).toHaveFocus();
    expect(screen.getByRole("status", { name: "保存结果" })).toHaveTextContent(
      "工作区已保存。",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/workspace",
      expect.objectContaining({
        body: JSON.stringify({
          path: "D:\\new",
          expectedVersion: 4,
          confirmRebind: true,
        }),
        method: "PUT",
      }),
    );
  });

  it("uses an equal checkbox fieldset, enforces two members, and preserves selection on assigned errors", async () => {
    const ProjectSetupPanel = await setupPanel();
    let saveCalls = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/workspace")) {
          return Response.json({ workspace: null, projectVersion: 7 });
        }
        if (url === "/api/agents") return Response.json({ agents });
        if (url.endsWith("/members") && !init?.method) {
          return Response.json({
            members: agents.map((agent, index) => ({
              agentId: agent.id,
              joinedAt: String(index),
              name: agent.name,
              role: agent.role,
              model: agent.model,
              avatarText: agent.avatarText,
              accentToken: agent.accentToken,
              skillNames: [],
              permissions: agent.permissions,
            })),
            projectVersion: 7,
          });
        }
        if (url.endsWith("/members") && init?.method === "PUT") {
          saveCalls += 1;
          if (saveCalls === 1) {
            return Response.json(
              {
                error: {
                  code: "MEMBER_HAS_ASSIGNMENTS",
                  message: "assigned",
                  agentIds: ["agent-c"],
                },
              },
              { status: 409 },
            );
          }
          return Response.json({
            members: agents.map((agent, index) => ({
              agentId: agent.id,
              joinedAt: String(index),
              name: agent.name,
              role: agent.role,
              model: agent.model,
              avatarText: agent.avatarText,
              accentToken: agent.accentToken,
              skillNames: [],
              permissions: agent.permissions,
            })),
            projectVersion: 8,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ProjectSetupPanel projectId="project-1" />);

    const group = await screen.findByRole("group", { name: "平等项目成员" });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.queryByText(/leader|rank/i)).not.toBeInTheDocument();

    await user.click(within(group).getByRole("checkbox", { name: /Gamma/ }));
    await user.click(within(group).getByRole("checkbox", { name: /Beta/ }));
    expect(screen.getByRole("button", { name: "保存成员" })).toBeDisabled();
    expect(screen.getByText("请至少选择 2 名成员。")).toBeInTheDocument();
    await user.click(within(group).getByRole("checkbox", { name: /Beta/ }));
    await user.click(screen.getByRole("button", { name: "保存成员" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gamma 仍有已分配任务",
    );
    expect(
      within(group).getByRole("checkbox", { name: /Gamma/ }),
    ).toBeChecked();
    expect(
      within(group).getByRole("checkbox", { name: /Gamma/ }),
    ).toBeDisabled();
    expect(screen.getByRole("link", { name: "查看已分配任务" })).toHaveAttribute(
      "href",
      "#mission-board",
    );

    await user.click(screen.getByRole("button", { name: "保存成员" }));
    expect(await screen.findByRole("status", { name: "保存结果" })).toHaveTextContent(
      "项目成员已保存。",
    );
    expect(screen.getByRole("heading", { name: "成员名册" })).toHaveFocus();
  });
});
