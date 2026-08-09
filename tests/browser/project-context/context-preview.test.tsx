import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import type {
  ProjectContextSnapshot,
  ProjectMember,
} from "@/src/shared/project-context-contracts";

type ContextPreviewModule = {
  ContextPreview: ComponentType<{ projectId: string }>;
};

const modules =
  import.meta.glob<ContextPreviewModule>("../../../components/project-context/context-preview.tsx");

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

function snapshot(agentId: string): ProjectContextSnapshot {
  return {
    schemaVersion: 1,
    shared: {
      project: {
        id: "project-1",
        name: "Launch",
        workspacePath: "D:\\workspace",
      },
      roster: members,
      mission: {
        id: "mission-1",
        projectId: "project-1",
        title: "Ship",
        goal: "Deliver",
        version: 1,
        createdAt: "a",
        updatedAt: "a",
      },
      workItems: [
        {
          id: "item-1",
          missionId: "mission-1",
          title: "Plan",
          description: "",
          status: "todo",
          assigneeAgentId: "agent-a",
          dependencyIds: [],
          version: 1,
          createdAt: "a",
          updatedAt: "a",
        },
      ],
      memories: [
        {
          id: "memory-1",
          projectId: "project-1",
          type: "fact",
          content: "Shared fact",
          sourceType: "owner_input",
          sourceRef: "Owner",
          createdBy: "owner",
          supersedesId: null,
          active: true,
          createdAt: "a",
        },
      ],
    },
    currentAgent: {
      id: agentId,
      name: agentId === "agent-a" ? "Alpha" : "Beta",
      role: agentId === "agent-a" ? "规划" : "实现",
      systemPrompt:
        agentId === "agent-a" ? "Alpha private prompt" : "Beta private prompt",
      skills: [
        {
          id: agentId === "agent-a" ? "plan" : "build",
          name: agentId === "agent-a" ? "Plan" : "Build",
          instructions:
            agentId === "agent-a" ? "Plan carefully" : "Build carefully",
        },
      ],
      permissions:
        agentId === "agent-a"
          ? { readFiles: true, writeFiles: false, runCommands: false }
          : { readFiles: true, writeFiles: true, runCommands: true },
    },
  };
}

async function contextPreview() {
  const load = modules["../../../components/project-context/context-preview.tsx"];
  expect(load, "the readable context preview must exist").toBeTypeOf("function");
  return (await load()).ContextPreview;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Context Preview", () => {
  it("retries context errors into the fixed readiness checklist without a false empty snapshot", async () => {
    const ContextPreview = await contextPreview();
    let contextCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/members")) {
          return Response.json({ members, projectVersion: 3 });
        }
        contextCalls += 1;
        if (contextCalls === 1) {
          return Response.json(
            { error: { code: "INTERNAL_ERROR", message: "failed" } },
            { status: 500 },
          );
        }
        return Response.json(
          {
            error: {
              code: "CONTEXT_NOT_READY",
              message: "not ready",
              missing: ["workspace", "members", "mission"],
            },
          },
          { status: 409 },
        );
      }),
    );
    render(<ContextPreview projectId="project-1" />);

    expect(screen.getByText("正在加载上下文预览…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法加载上下文预览",
    );
    await userEvent.setup().click(
      screen.getByRole("button", { name: "重试加载上下文" }),
    );
    const checklist = await screen.findByRole("list", {
      name: "上下文缺失条件",
    });
    expect(
      within(checklist).getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["工作区", "至少两名成员", "使命"]);
    expect(screen.queryByText("共享项目上下文")).toBeNull();
  });

  it("renders readable shared/current sections, structured details and member-identical shared visibility", async () => {
    const ContextPreview = await contextPreview();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname.endsWith("/members")) {
          return Response.json({ members, projectVersion: 3 });
        }
        return Response.json(snapshot(url.searchParams.get("agentId")!));
      }),
    );
    const user = userEvent.setup();
    render(<ContextPreview projectId="project-1" />);

    const shared = await screen.findByRole("region", {
      name: "共享项目上下文",
    });
    expect(within(shared).getByText("Launch")).toBeInTheDocument();
    expect(within(shared).getByText("Ship")).toBeInTheDocument();
    expect(
      within(within(shared).getByRole("list", { name: "共享任务" })).getByText(
        /^Plan ·/,
      ),
    ).toBeInTheDocument();
    expect(
      within(
        within(shared).getByRole("list", { name: "共享 Active 记忆" }),
      ).getByText(/^Shared fact ·/),
    ).toBeInTheDocument();
    const sharedBefore = shared.textContent;
    expect(screen.getByText("Alpha private prompt")).toBeInTheDocument();
    expect(screen.queryByText("Beta private prompt")).toBeNull();
    const details = screen.getByText("查看结构化快照").closest("details");
    expect(details).not.toBeNull();
    expect(within(details!).getByText(/"schemaVersion": 1/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("预览成员"), "agent-b");
    expect(await screen.findByText("Beta private prompt")).toBeInTheDocument();
    expect(screen.queryByText("Alpha private prompt")).toBeNull();
    expect(
      screen.getByRole("region", { name: "共享项目上下文" }).textContent,
    ).toBe(sharedBefore);
  });
});
