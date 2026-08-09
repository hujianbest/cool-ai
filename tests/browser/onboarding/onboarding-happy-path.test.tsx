// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import { ActivityBar } from "@/components/activity-bar";
import { AgentPanel } from "@/components/agent-panel";
import { CollaborationPanel } from "@/components/collaboration/collaboration-panel";
import { ProjectPanel } from "@/components/project-panel";
import { ProviderPanel } from "@/components/provider-panel";
import { MembersSetup } from "@/components/project-context/members-setup";
import { MissionBoard } from "@/components/project-context/mission-board";
import { WorkspaceSetup } from "@/components/project-context/workspace-setup";
import {
  OnboardingGuide,
  ProviderOnboardingGuide,
} from "@/components/onboarding-guide";
import * as onboardingComponents from "@/components/onboarding-guide";
import * as onboardingMachine from "@/src/shared/onboarding-guide-machine";

const project = {
  createdAt: "2026-08-08T00:00:00.000Z",
  id: "project-onboarding",
  name: "Onboarding Project",
};
const threadId = "thread-onboarding";

function collaborationState(started = false) {
  const message = {
    authorAgentId: null,
    authorDisplayName: "项目所有者",
    authorType: "owner",
    content: "Prepare the verified release plan",
    createdAt: "2026-08-08T00:01:00.000Z",
    id: "message-1",
    mentionAgentId: null,
    mentionDisplayName: null,
    mentionMemberStatus: null,
    projectId: project.id,
    runId: started ? "run-1" : null,
    sequence: 1,
    threadId,
  };
  const run = {
    createdAt: "2026-08-08T00:01:00.000Z",
    currentAgentId: "agent-builder",
    id: "run-1",
    pauseCategory: null,
    projectId: project.id,
    roundCount: 0,
    status: "running",
    threadId,
    updatedAt: "2026-08-08T00:01:00.000Z",
    version: 1,
  };
  const ownerFact = {
    activitySequence: 3,
    actorId: null,
    actorType: "owner",
    createdAt: message.createdAt,
    id: "fact-owner",
    message,
    messageId: message.id,
    payload: { messageId: message.id },
    policyRevisionId: null,
    projectId: project.id,
    runEventId: null,
    runId: message.runId,
    sequence: 3,
    threadId,
    type: "owner_message",
  };
  return {
    activeRun: started ? { runId: run.id, threadId } : null,
    factsPage: {
      items: started
        ? [
            {
              activitySequence: 1,
              actorId: null,
              actorType: "system",
              createdAt: "2026-08-08T00:01:00.000Z",
              id: "fact-linked",
              message: null,
              messageId: null,
              payload: { runId: run.id },
              policyRevisionId: null,
              projectId: project.id,
              runEventId: null,
              runId: run.id,
              sequence: 1,
              threadId,
              type: "run_linked",
            },
            {
              activitySequence: 2,
              actorId: null,
              actorType: "system",
              createdAt: "2026-08-08T00:01:00.000Z",
              id: "fact-started",
              message: null,
              messageId: null,
              payload: { eventType: "run_started" },
              policyRevisionId: null,
              projectId: project.id,
              runEventId: "event-started",
              runId: run.id,
              sequence: 2,
              threadId,
              type: "run_event",
            },
            ownerFact,
          ]
        : [],
      nextAfter: null,
    },
    messagesPage: { items: started ? [message] : [], nextAfter: null },
    readiness: {
      dispatch: "ready",
      missingProjectFacts: [],
      selectedMemberId: "agent-builder",
    },
    runs: started ? [run] : [],
    selectedRun: started ? run : null,
    thread: {
      availability: "ready",
      createdAt: "2026-08-08T00:00:00.000Z",
      id: threadId,
      lastActivitySequence: started ? 3 : 1,
      policy: {
        availability: "ready",
        createdAt: "2026-08-08T00:00:00.000Z",
        members: [
          {
            agentId: "agent-builder",
            displayNameSnapshot: "Builder",
            live: "current",
            position: 0,
          },
          {
            agentId: "agent-reviewer",
            displayNameSnapshot: "Reviewer",
            live: "current",
            position: 1,
          },
        ],
        revisionId: "revision-1",
        unavailableMemberIds: [],
        version: 1,
      },
      policyVersion: 1,
      projectId: project.id,
      title: "Onboarding thread",
      updatedAt: "2026-08-08T00:01:00.000Z",
      version: 1,
    },
  };
}

function threadReadResponse(
  url: string,
  started: boolean,
): Response | null {
  return threadStateResponse(url, collaborationState(started));
}

function threadStateResponse(
  url: string,
  state: ReturnType<typeof collaborationState>,
): Response | null {
  const base = `/api/projects/${project.id}/threads/${threadId}`;
  if (url === base || url.startsWith(`${base}?run=`)) {
    const { factsPage: _facts, messagesPage: _messages, ...detail } = state;
    return Response.json(detail);
  }
  if (url === `${base}/messages` || url.startsWith(`${base}/messages?`)) {
    return Response.json(state.messagesPage);
  }
  if (url === `${base}/facts` || url.startsWith(`${base}/facts?`)) {
    return Response.json(state.factsPage);
  }
  if (url.startsWith(`${base}/runs/`) && url.includes("/timeline")) {
    return Response.json({ items: [], nextAfter: null });
  }
  return null;
}

function installHappyPathFetch() {
  let mission: null | Record<string, unknown> = null;
  let started = false;
  const requests: string[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/projects") return Response.json({ projects: [project] });
      if (url === "/api/providers") {
        return Response.json({
          providers: [
            {
              apiKeyMask: "••••ABCD",
              baseUrl: "https://example.test/v1",
              createdAt: "2026-08-08T00:00:00.000Z",
              defaultModel: "model",
              id: "provider-1",
              name: "Primary",
              status: "verified",
              updatedAt: "2026-08-08T00:00:00.000Z",
              verifiedAt: "2026-08-08T00:00:00.000Z",
              version: 1,
            },
          ],
        });
      }
      if (url === "/api/agents") {
        return Response.json({
          agents: [
            {
              accentToken: "sage",
              avatarText: "B",
              createdAt: "2026-08-08T00:00:00.000Z",
              id: "agent-builder",
              maxHandoffs: 5,
              maxTokens: 8_000,
              model: "model",
              name: "Builder",
              permissions: {
                readFiles: true,
                runCommands: true,
                writeFiles: true,
              },
              providerId: "provider-1",
              reviewCapable: false,
              role: "builder",
              skillIds: [],
              systemPrompt: "Build.",
              updatedAt: "2026-08-08T00:00:00.000Z",
              version: 1,
            },
            {
              accentToken: "gold",
              avatarText: "R",
              createdAt: "2026-08-08T00:00:00.000Z",
              id: "agent-reviewer",
              maxHandoffs: 5,
              maxTokens: 8_000,
              model: "model",
              name: "Reviewer",
              permissions: {
                readFiles: true,
                runCommands: false,
                writeFiles: false,
              },
              providerId: "provider-1",
              reviewCapable: true,
              role: "reviewer",
              skillIds: [],
              systemPrompt: "Review.",
              updatedAt: "2026-08-08T00:00:00.000Z",
              version: 1,
            },
          ],
        });
      }
      if (url === `/api/projects/${project.id}/workspace`) {
        return Response.json({
          projectVersion: 1,
          workspace: { path: "D:\\workspace", status: "ready" },
        });
      }
      if (url === `/api/projects/${project.id}/members`) {
        return Response.json({
          members: [
            {
              accentToken: "sage",
              agentId: "agent-builder",
              avatarText: "B",
              joinedAt: "2026-08-08T00:00:00.000Z",
              model: "model",
              name: "Builder",
              permissions: {
                readFiles: true,
                runCommands: true,
                writeFiles: true,
              },
              role: "builder",
              skillNames: [],
            },
            {
              accentToken: "gold",
              agentId: "agent-reviewer",
              avatarText: "R",
              joinedAt: "2026-08-08T00:00:00.000Z",
              model: "model",
              name: "Reviewer",
              permissions: {
                readFiles: true,
                runCommands: false,
                writeFiles: false,
              },
              role: "reviewer",
              skillNames: [],
            },
          ],
          projectVersion: 1,
        });
      }
      if (url === `/api/projects/${project.id}/mission`) {
        if (init?.method === "POST") {
          mission = {
            createdAt: "2026-08-08T00:00:00.000Z",
            goal: "Prepare a release plan",
            id: "mission-1",
            projectId: project.id,
            title: "Release mission",
            updatedAt: "2026-08-08T00:00:00.000Z",
            version: 1,
          };
          return Response.json({ mission }, { status: 201 });
        }
        return Response.json({ mission, workItems: [] });
      }
      const threadRead = !init?.method
        ? threadReadResponse(url, started)
        : null;
      if (threadRead) return threadRead;
      if (
        url === `/api/projects/${project.id}/threads/${threadId}/runs` &&
        init?.method === "POST"
      ) {
        started = true;
        const state = collaborationState(true);
        return Response.json(
          {
            created: true,
            facts: state.factsPage.items,
            message: state.messagesPage.items[0],
            run: state.selectedRun,
          },
          { status: 201 },
        );
      }
      if (url === `/api/projects/${project.id}/executions`) {
        return Response.json({ executions: [] });
      }
      if (url.includes("/advance")) {
        return Response.json({
          run: { ...collaborationState(true).selectedRun, status: "failed" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("progressive onboarding T-1", () => {
  it("exposes a keyboard-reachable ActivityBar entry to explicit project selection", () => {
    render(<ActivityBar activePath="/" />);

    const entry = screen.getByRole("link", { name: "首次使用引导" });
    expect(entry).toHaveAttribute(
      "href",
      "/team?section=providers&guide=provider&returnTo=/",
    );
    entry.focus();
    expect(entry).toHaveFocus();
  });

  it("rejects duplicate guide parameters instead of choosing one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/projects") {
          return Response.json({ projects: [project] });
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      }),
    );
    window.history.replaceState(
      null,
      "",
      "/?guide=project-select&guide=goal",
    );

    render(<ProjectPanel />);

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "首次使用引导" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("uses selected thread/run tuple routes without legacy collaboration, project-only, run-only, or tasks calls", async () => {
    const { requests } = installHappyPathFetch();
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?guide=project-select");
    render(<ProjectPanel />);

    const guide = await screen.findByRole("region", { name: "首次使用引导" });
    expect(guide).toHaveTextContent("选择要开始引导的项目");
    await user.click(within(guide).getByRole("button", { name: project.name }));

    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        `/projects/${project.id}?guide=workspace`,
      ),
    );
    window.history.pushState(
      null,
      "",
      `/projects/${project.id}?thread=${threadId}&guide=goal`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    const goalGuide = await screen.findByRole("region", {
      name: "首次使用引导",
    });
    expect(
      await within(goalGuide).findByText(
        "资源已就绪，可以创建使命并启动协作。",
      ),
    ).toBeInTheDocument();

    await user.click(
      within(goalGuide).getByRole("button", { name: "创建使命目标" }),
    );
    expect(screen.getByLabelText("使命标题")).toHaveFocus();
    await user.type(screen.getByLabelText("使命标题"), "Release mission");
    await user.type(screen.getByLabelText("使命目标"), "Prepare a release plan");
    await user.click(screen.getByRole("button", { name: "创建使命" }));
    expect(
      await screen.findByRole("heading", { name: "Release mission" }),
    ).toBeInTheDocument();
    expect(
      await within(goalGuide).findByText(
        "目标已受理。下一步可在项目群聊启动协作；尚未执行、复核或交付。",
      ),
    ).toBeInTheDocument();
    expect(goalGuide).toHaveTextContent("verified handle");
    expect(goalGuide).toHaveTextContent("sandbox");
    expect(goalGuide).toHaveTextContent("审批");
    expect(goalGuide).toHaveTextContent("非 executor");

    await user.click(
      within(goalGuide).getByRole("button", { name: "在项目群聊启动协作" }),
    );
    expect(screen.getByLabelText("发送给项目群聊")).toHaveFocus();
    await user.type(
      screen.getByLabelText("发送给项目群聊"),
      "Prepare the verified release plan",
    );
    await user.click(screen.getByRole("button", { name: "发送并开始首次运行" }));

    expect(await screen.findByText("协作已启动")).toBeInTheDocument();
    expect(await screen.findByText("所有者发来消息")).toBeInTheDocument();
    expect(
      await screen.findByText("Prepare the verified release plan"),
    ).toBeInTheDocument();
    expect(
      await within(goalGuide).findByText(
        "协作已启动且 owner message 与 run_started 已对账；尚未执行、复核或交付。",
      ),
    ).toBeInTheDocument();
    expect(requests.some((url) => /\/tasks(?:\/|$|\?)/.test(url))).toBe(false);
    expect(
      requests.some((url) =>
        url === `/api/projects/${project.id}/collaboration` ||
        url === `/api/projects/${project.id}/runs` ||
        url === `/api/projects/${project.id}/messages` ||
        url.startsWith("/api/runs/")
      ),
    ).toBe(false);
    expect(requests).toContain(
      `/api/projects/${project.id}/threads/${threadId}`,
    );
    expect(requests).toContain(
      `/api/projects/${project.id}/threads/${threadId}/facts`,
    );
    expect(requests).toContain(
      `/api/projects/${project.id}/threads/${threadId}/messages`,
    );
    expect(requests).toContain(
      `/api/projects/${project.id}/threads/${threadId}/runs`,
    );
  });

  it("fails closed when the required resources are incomplete", async () => {
    expect(
      onboardingMachine.parseCollaborationGuideEnvelope(
        collaborationState(false),
        project.id,
        threadId,
        null,
      ),
    ).toEqual({ kind: "success", started: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/projects") return Response.json({ projects: [project] });
        if (url === "/api/providers") return Response.json({ providers: [] });
        if (url === "/api/agents") return Response.json({ agents: [] });
        if (url.endsWith("/workspace")) {
          return Response.json({ projectVersion: 1, workspace: null });
        }
        if (url.endsWith("/members")) {
          return Response.json({ members: [], projectVersion: 1 });
        }
        if (url.endsWith("/mission")) {
          return Response.json({ mission: null, workItems: [] });
        }
        const threadRead = !init?.method
          ? threadReadResponse(url, false)
          : null;
        if (threadRead) return threadRead;
        if (url.endsWith("/executions")) return Response.json({ executions: [] });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    window.history.replaceState(
      null,
      "",
      `/projects/${project.id}?thread=${threadId}&guide=goal`,
    );
    render(<ProjectPanel />);

    const guide = await screen.findByRole("region", { name: "首次使用引导" });
    expect(await within(guide).findByRole("alert")).toHaveTextContent(
      "资源尚未就绪",
    );
    expect(
      within(guide).getByRole("button", { name: "创建使命目标" }),
    ).toBeDisabled();
    expect(
      within(guide).getByRole("button", { name: "在项目群聊启动协作" }),
    ).toBeDisabled();
  });
});

describe("progressive onboarding T-4 provider step", () => {
  const verifiedProvider = {
    apiKeyMask: "••••ABCD",
    baseUrl: "https://example.test/v1",
    createdAt: "2026-08-08T00:00:00.000Z",
    defaultModel: "model-a",
    id: "provider-1",
    name: "Primary",
    status: "verified",
    updatedAt: "2026-08-08T00:00:00.000Z",
    verifiedAt: "2026-08-08T00:00:00.000Z",
    version: 1,
  };

  it("strictly accepts only the real verified provider envelope and focuses the existing surface", async () => {
    let resolveLoad!: (response: Response) => void;
    const load = new Promise<Response>((resolve) => {
      resolveLoad = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => load));
    const user = userEvent.setup();

    render(<ProviderPanel guide="provider" />);
    const guide = screen.getByRole("region", { name: "Provider 首次使用引导" });
    expect(within(guide).getByText("正在核对模型服务…")).toHaveAttribute(
      "aria-busy",
      "true",
    );

    resolveLoad(Response.json({ providers: [verifiedProvider] }));
    expect(
      await within(guide).findByText("已检测到 verified 模型服务，可以继续。"),
    ).toBeInTheDocument();
    await user.click(
      within(guide).getByRole("button", { name: "聚焦已验证模型服务" }),
    );
    expect(screen.getByRole("heading", { name: "Primary" })).toHaveFocus();
  });

  it.each([
    [{ providers: [] }, "尚无模型服务", "创建模型服务"],
    [
      {
        providers: [
          { ...verifiedProvider, status: "key_unavailable" },
        ],
      },
      "模型服务凭据当前不可用",
      "修复模型服务",
    ],
    [
      { providers: [{ ...verifiedProvider, status: "verified", verifiedAt: null }] },
      "模型服务响应无效",
      "核对模型服务",
    ],
    [
      {
        providers: [
          {
            ...verifiedProvider,
            Authorization: "Bearer provider-secret-DO-NOT-LEAK",
          },
        ],
      },
      "模型服务响应无效",
      "核对模型服务",
    ],
  ])(
    "fails closed without duplicating the provider editor for %s",
    async (payload, message, actionName) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(payload)),
      );
      const user = userEvent.setup();

      render(<ProviderPanel guide="provider" />);
      const guide = screen.getByRole("region", {
        name: "Provider 首次使用引导",
      });
      expect(await within(guide).findByRole("alert")).toHaveTextContent(message);
      expect(within(guide).queryByLabelText("API key")).toBeNull();
      expect(document.body.textContent).not.toContain(
        "provider-secret-DO-NOT-LEAK",
      );
      await user.click(within(guide).getByRole("button", { name: actionName }));
      const existingCreate = screen
        .getAllByRole("button", { name: "创建模型服务" })
        .find((button) => !guide.contains(button));
      expect(existingCreate).toHaveFocus();
    },
  );

  it("retries detection with GET only after an error", async () => {
    const calls: Array<RequestInit | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init);
        if (calls.length === 1) {
          return Response.json({ error: { code: "STORAGE_UNAVAILABLE" } }, { status: 503 });
        }
        return Response.json({ providers: [verifiedProvider] });
      }),
    );
    const user = userEvent.setup();

    render(<ProviderPanel guide="provider" />);
    const guide = screen.getByRole("region", { name: "Provider 首次使用引导" });
    expect(await within(guide).findByRole("alert")).toHaveTextContent(
      "无法核对模型服务",
    );
    await user.click(within(guide).getByRole("button", { name: "重新检测" }));
    expect(
      await within(guide).findByText("已检测到 verified 模型服务，可以继续。"),
    ).toBeInTheDocument();
    expect(calls).toHaveLength(2);
    expect(calls.every((init) => !init?.method || init.method === "GET")).toBe(true);
  });
});

describe("progressive onboarding T-5 Agent join", () => {
  const verifiedProvider = {
    apiKeyMask: "••••ABCD",
    baseUrl: "https://example.test/v1",
    createdAt: "2026-08-08T00:00:00.000Z",
    defaultModel: "model-a",
    id: "provider-1",
    name: "Primary",
    status: "verified",
    updatedAt: "2026-08-08T00:00:00.000Z",
    verifiedAt: "2026-08-08T00:00:00.000Z",
    version: 1,
  };

  function guideAgent(
    id: string,
    reviewCapable: boolean,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      accentToken: "sage",
      avatarText: id === "agent-reviewer" ? "R" : "B",
      createdAt: "2026-08-08T00:00:00.000Z",
      id,
      maxHandoffs: 5,
      maxTokens: 8_000,
      model: "model-a",
      name: id === "agent-reviewer" ? "Reviewer" : "Builder",
      permissions: {
        readFiles: true,
        runCommands: id === "agent-builder",
        writeFiles: id === "agent-builder",
      },
      providerId: "provider-1",
      reviewCapable,
      role: id === "agent-reviewer" ? "reviewer" : "builder",
      skillIds: [],
      systemPrompt: "PRIVATE SYSTEM PROMPT MUST NOT APPEAR",
      updatedAt: "2026-08-08T00:00:00.000Z",
      version: 1,
      ...overrides,
    };
  }

  function agentResources(
    agents: unknown[],
    members: unknown[] = [
      {
        accentToken: "sage",
        agentId: "agent-builder",
        avatarText: "B",
        joinedAt: "2026-08-08T00:00:00.000Z",
        model: "model-a",
        name: "Builder",
        permissions: {
          readFiles: true,
          runCommands: true,
          writeFiles: true,
        },
        role: "builder",
        skillNames: [],
      },
      {
        accentToken: "sage",
        agentId: "agent-reviewer",
        avatarText: "R",
        joinedAt: "2026-08-08T00:00:00.000Z",
        model: "model-a",
        name: "Reviewer",
        permissions: {
          readFiles: true,
          runCommands: false,
          writeFiles: false,
        },
        role: "reviewer",
        skillNames: [],
      },
    ],
  ) {
    return (url: string) => {
      if (url === "/api/agent-templates") return { templates: [] };
      if (url === "/api/providers") return { providers: [verifiedProvider] };
      if (url === "/api/skills") return { skills: [] };
      if (url === "/api/agents") return { agents };
      if (url === `/api/projects/${project.id}/members`) {
        return { members, projectVersion: 1 };
      }
      throw new Error(`Unexpected GET: ${url}`);
    };
  }

  it("strictly joins current project members through verified Providers and only announces a future review candidate", async () => {
    const agents = [
      guideAgent("agent-builder", false),
      guideAgent("agent-reviewer", true),
    ];
    const payload = agentResources(agents);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        Response.json(payload(String(input))),
      ),
    );
    const user = userEvent.setup();

    render(<AgentPanel guide="agent" projectId={project.id} />);
    const guide = screen.getByRole("region", { name: "Agent 首次使用引导" });
    expect(within(guide).getByText("正在核对 Agent 与项目成员…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(
      await within(guide).findByText(
        "当前项目已有两名合格成员，未来复核候选存在。",
      ),
    ).toBeInTheDocument();
    expect(guide).toHaveTextContent(
      "正式运行时仍会动态排除 executor；这不表示已完成独立复核。",
    );
    expect(guide).not.toHaveTextContent("PRIVATE SYSTEM PROMPT MUST NOT APPEAR");

    await user.click(
      within(guide).getByRole("button", { name: "聚焦未来复核候选" }),
    );
    expect(screen.getByRole("heading", { name: "Reviewer" })).toHaveFocus();
  });

  it.each([
    {
      agents: [],
      message: "尚无 Agent",
    },
    {
      agents: [guideAgent("agent-builder", false)],
      message: "当前项目至少需要两名不同的合格 Agent",
      members: [
        {
          accentToken: "sage",
          agentId: "agent-builder",
          avatarText: "B",
          joinedAt: "2026-08-08T00:00:00.000Z",
          model: "model-a",
          name: "Builder",
          permissions: {
            readFiles: true,
            runCommands: true,
            writeFiles: true,
          },
          role: "builder",
          skillNames: [],
        },
      ],
    },
    {
      agents: [
        guideAgent("agent-builder", false),
        guideAgent("agent-reviewer", false),
      ],
      message: "当前项目还没有 reviewCapable 的未来复核候选",
    },
    {
      agents: [
        guideAgent("agent-builder", false),
        guideAgent("agent-reviewer", true, { providerId: "missing-provider" }),
      ],
      message: "项目成员必须全部引用 verified Provider",
    },
    {
      agents: [
        guideAgent("agent-builder", false),
        guideAgent("agent-reviewer", true, {
          Authorization: "Bearer agent-secret-DO-NOT-LEAK",
        }),
      ],
      message: "Agent 或成员响应无效",
    },
  ])(
    "fails closed and focuses the existing Agent surface for $message",
    async ({ agents, members, message }) => {
      const payload = agentResources(agents, members);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          Response.json(payload(String(input))),
        ),
      );
      const user = userEvent.setup();

      render(<AgentPanel guide="agent" projectId={project.id} />);
      const guide = screen.getByRole("region", {
        name: "Agent 首次使用引导",
      });
      expect(await within(guide).findByRole("alert")).toHaveTextContent(message);
      expect(document.body).not.toHaveTextContent("agent-secret-DO-NOT-LEAK");
      await user.click(
        within(guide).getByRole("button", { name: "修复 Agent 配置" }),
      );
      expect(screen.getByRole("button", { name: "创建 Agent" })).toHaveFocus();
    },
  );

  it("retries only GETs and never automatically resends an uncertain Agent write", async () => {
    const agents = [
      guideAgent("agent-builder", false),
      guideAgent("agent-reviewer", true),
    ];
    const payload = agentResources(agents);
    const calls: Array<{ method: string; url: string }> = [];
    let agentGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (url === "/api/agents" && method === "GET") {
          agentGets += 1;
          if (agentGets === 1) {
            return Response.json(
              { error: { code: "STORAGE_UNAVAILABLE" } },
              { status: 503 },
            );
          }
        }
        return Response.json(payload(url));
      }),
    );
    const user = userEvent.setup();

    render(<AgentPanel guide="agent" projectId={project.id} />);
    const guide = screen.getByRole("region", { name: "Agent 首次使用引导" });
    expect(await within(guide).findByRole("alert")).toHaveTextContent(
      "无法核对 Agent 与项目成员",
    );
    await user.click(within(guide).getByRole("button", { name: "重新检测" }));
    expect(
      await within(guide).findByText(
        "当前项目已有两名合格成员，未来复核候选存在。",
      ),
    ).toBeInTheDocument();
    expect(calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it("reconciles an uncertain Agent edit by GET without automatically resending it", async () => {
    const initialAgents = [
      guideAgent("agent-builder", false),
      guideAgent("agent-reviewer", true),
    ];
    const updatedReviewer = guideAgent("agent-reviewer", true, {
      role: "independent reviewer",
      version: 2,
    });
    let reconciled = false;
    let patchCount = 0;
    let agentGetCount = 0;
    const payload = agentResources(initialAgents);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/agents/agent-reviewer" && init?.method === "PATCH") {
          patchCount += 1;
          reconciled = true;
          throw new TypeError("network result unknown");
        }
        if (url === "/api/agents") {
          agentGetCount += 1;
          return Response.json({
            agents: reconciled
              ? [initialAgents[0], updatedReviewer]
              : initialAgents,
          });
        }
        return Response.json(payload(url));
      }),
    );
    const user = userEvent.setup();

    render(<AgentPanel guide="agent" projectId={project.id} />);
    await screen.findByText(
      "当前项目已有两名合格成员，未来复核候选存在。",
    );
    await user.click(screen.getByRole("button", { name: "编辑 Reviewer" }));
    await user.clear(screen.getByLabelText("职责"));
    await user.type(screen.getByLabelText("职责"), "independent reviewer");
    await user.click(screen.getByRole("button", { name: "保存 Agent" }));

    expect(
      await screen.findByText("已通过事实核对确认 Agent 已保存。"),
    ).toBeInTheDocument();
    expect(patchCount).toBe(1);
    expect(agentGetCount).toBe(2);
  });
});

describe("progressive onboarding T-6 explicit project selection", () => {
  const secondProject = {
    createdAt: "2026-08-08T00:00:01.000Z",
    id: "project-second",
    name: "Second Project",
  };

  function stubViewport(narrow: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: narrow,
        media: "(max-width: 56.25rem)",
        removeEventListener: vi.fn(),
      })),
    );
  }

  function emptyResourceResponse(url: string): Response | null {
    if (url.endsWith("/workspace")) {
      return Response.json({ projectVersion: 1, workspace: null });
    }
    if (url.endsWith("/members")) {
      return Response.json({ members: [], projectVersion: 1 });
    }
    if (url.endsWith("/mission")) {
      return Response.json({ mission: null, workItems: [] });
    }
    const threadRead = threadReadResponse(url, false);
    if (threadRead) return threadRead;
    if (url.endsWith("/executions")) {
      return Response.json({ executions: [] });
    }
    if (url.includes("/memories?")) {
      return Response.json({ memories: [] });
    }
    if (url.endsWith("/tasks")) {
      return Response.json({ events: [], tasks: [] });
    }
    return null;
  }

  it.each([false, true])(
    "keeps the zero-project create CTA on the existing form at %s narrow",
    async (narrow) => {
      stubViewport(narrow);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ projects: [] })),
      );
      const user = userEvent.setup();
      window.history.replaceState(null, "", "/?guide=project-select");

      render(<ProjectPanel />);

      const guide = await screen.findByRole("region", { name: "首次使用引导" });
      expect(within(guide).getByRole("alert")).toHaveTextContent("尚无可选项目");
      await user.click(
        within(guide).getByRole("button", { name: "使用现有表面创建项目" }),
      );
      expect(screen.getByLabelText("项目名称")).toHaveFocus();
      expect(within(guide).queryByLabelText("项目名称")).toBeNull();
    },
  );

  it.each([
    [[project], project.name],
    [[project, secondProject], secondProject.name],
  ])(
    "requires an explicit owner choice for %s projects and navigates to workspace",
    async (projects, selectedName) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          return emptyResourceResponse(url) ?? Response.json({ projects });
        }),
      );
      const user = userEvent.setup();
      window.history.replaceState(null, "", "/?guide=project-select");

      render(<ProjectPanel />);

      const guide = await screen.findByRole("region", { name: "首次使用引导" });
      const choices = within(guide).getByRole("list", { name: "可访问项目" });
      expect(window.location.pathname + window.location.search).toBe(
        "/?guide=project-select",
      );
      await user.click(within(choices).getByRole("button", { name: selectedName }));
      const selected = projects.find((candidate) => candidate.name === selectedName)!;
      await waitFor(() =>
        expect(window.location.pathname + window.location.search).toBe(
          `/projects/${selected.id}?guide=workspace`,
        ),
      );
      expect(
        window.localStorage.getItem("cool-ai:onboarding-preference:v1") ?? "",
      ).not.toContain(selected.id);
    },
  );

  it("uses the existing project form and navigates only from a strict POST project ID", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (method === "GET") {
          return emptyResourceResponse(url) ?? Response.json({ projects: [] });
        }
        return Response.json({ project }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?guide=project-select");

    render(<ProjectPanel />);
    const guide = await screen.findByRole("region", { name: "首次使用引导" });
    await user.click(
      within(guide).getByRole("button", { name: "使用现有表面创建项目" }),
    );
    await user.type(screen.getByLabelText("项目名称"), project.name);
    const projectForm = screen.getByLabelText("项目名称").closest("form");
    await user.click(
      within(projectForm!).getByRole("button", { name: "创建项目" }),
    );

    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        `/projects/${project.id}?guide=workspace`,
      ),
    );
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  it("reconciles a lost POST response with one new GET fact and never resends", async () => {
    let created = false;
    let postCount = 0;
    let getCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          postCount += 1;
          created = true;
          throw new TypeError("network result unknown");
        }
        const resource = emptyResourceResponse(url);
        if (resource) return resource;
        if (url === "/api/projects") {
          getCount += 1;
          return Response.json({ projects: created ? [project] : [] });
        }
        if (url === "/api/providers") return Response.json({ providers: [] });
        if (url === "/api/agents") return Response.json({ agents: [] });
        throw new Error(`Unexpected GET: ${url}`);
      }),
    );
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?guide=project-select");

    render(<ProjectPanel />);
    await screen.findByText("尚无可选项目。请先使用现有项目表面创建项目。");
    await user.type(screen.getByLabelText("项目名称"), project.name);
    const projectForm = screen.getByLabelText("项目名称").closest("form");
    await user.click(
      within(projectForm!).getByRole("button", { name: "创建项目" }),
    );

    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        `/projects/${project.id}?guide=workspace`,
      ),
    );
    expect(screen.getByText("已通过事实核对确认项目已创建。")).toBeInTheDocument();
    expect(postCount).toBe(1);
    expect(getCount).toBe(2);
  });

  it("fails closed when GET cannot uniquely reconcile an unknown POST result", async () => {
    let postCount = 0;
    let getCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          postCount += 1;
          throw new TypeError("network result unknown");
        }
        const resource = emptyResourceResponse(url);
        if (resource) return resource;
        if (url === "/api/projects") {
          getCount += 1;
          return Response.json({
            projects: getCount === 1 ? [] : [project, secondProject],
          });
        }
        if (url === "/api/providers") return Response.json({ providers: [] });
        if (url === "/api/agents") return Response.json({ agents: [] });
        throw new Error(`Unexpected GET: ${url}`);
      }),
    );
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?guide=project-select");

    render(<ProjectPanel />);
    await screen.findByText("尚无可选项目。请先使用现有项目表面创建项目。");
    await user.type(screen.getByLabelText("项目名称"), project.name);
    const projectForm = screen.getByLabelText("项目名称").closest("form");
    await user.click(
      within(projectForm!).getByRole("button", { name: "创建项目" }),
    );

    expect(
      await screen.findByText(/无法唯一确认项目是否已创建/, {
        selector: '[role="alert"]',
      }),
    ).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe(
      "/?guide=project-select",
    );
    expect(postCount).toBe(1);
    expect(getCount).toBe(2);
  });

  it("fails closed for a deleted guide project and returns to explicit selection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return emptyResourceResponse(url) ??
          Response.json({ projects: [project] });
      }),
    );
    const user = userEvent.setup();
    window.history.replaceState(
      null,
      "",
      "/projects/deleted-project?guide=workspace",
    );

    render(<ProjectPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("未找到该项目");
    await user.click(screen.getByRole("button", { name: "返回项目选择" }));
    expect(window.location.pathname + window.location.search).toBe(
      "/?guide=project-select",
    );
    expect(
      await screen.findByRole("region", { name: "首次使用引导" }),
    ).toBeInTheDocument();
  });

  it("replays project selection across back, forward, and refresh from URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return emptyResourceResponse(url) ??
          Response.json({ projects: [project] });
      }),
    );
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?guide=project-select");
    const view = render(<ProjectPanel />);

    const guide = await screen.findByRole("region", { name: "首次使用引导" });
    await user.click(within(guide).getByRole("button", { name: project.name }));
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        `/projects/${project.id}?guide=workspace`,
      ),
    );

    window.history.back();
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(
      await screen.findByRole("region", { name: "首次使用引导" }),
    ).toHaveTextContent("选择要开始引导的项目");

    window.history.forward();
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        `/projects/${project.id}?guide=workspace`,
      ),
    );

    view.unmount();
    render(<ProjectPanel />);
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        `/projects/${project.id}?guide=workspace`,
      ),
    );
    expect(screen.queryByText("未找到该项目。")).not.toBeInTheDocument();
  });
});

describe("progressive onboarding T-7 workspace binding", () => {
  function projectSurfaceResponse(url: string): Response | null {
    if (url === "/api/projects") return Response.json({ projects: [project] });
    if (url.endsWith("/members")) {
      return Response.json({ members: [], projectVersion: 1 });
    }
    if (url.endsWith("/mission")) {
      return Response.json({ mission: null, workItems: [] });
    }
    const threadRead = threadReadResponse(url, false);
    if (threadRead) return threadRead;
    if (url.endsWith("/executions")) {
      return Response.json({ executions: [] });
    }
    if (url.includes("/memories?")) return Response.json({ memories: [] });
    return null;
  }

  it("exports a strict workspace envelope parser", () => {
    expect(onboardingMachine).toHaveProperty(
      "parseWorkspaceGuideEnvelope",
      expect.any(Function),
    );
    const parse = onboardingMachine.parseWorkspaceGuideEnvelope;
    expect(
      parse({ projectVersion: 1, workspace: null }),
    ).toEqual({ kind: "empty", projectVersion: 1, workspace: null });
    expect(
      parse({
        projectVersion: 2,
        workspace: { path: "D:\\workspace", status: "ready" },
      }),
    ).toEqual({
      kind: "success",
      projectVersion: 2,
      workspace: { path: "D:\\workspace", status: "ready" },
    });
    for (const invalid of [
      null,
      { projectVersion: 0, workspace: null },
      { projectVersion: 1, workspace: { path: "D:\\workspace", status: "error" } },
      { projectVersion: 1, workspace: { path: "relative", status: "ready" } },
      {
        projectVersion: 1,
        workspace: {
          path: "D:\\private\\workspace",
          status: "ready",
          secret: "must-not-leak",
        },
      },
      { projectVersion: 1, workspace: null, path: "D:\\must-not-leak" },
    ]) {
      expect(parse(invalid)).toEqual({ kind: "invalid" });
    }
  });

  it("renders the workspace guide from the existing WorkspaceSetup and focuses that surface", async () => {
    let resolveWorkspace!: (response: Response) => void;
    const workspaceLoad = new Promise<Response>((resolve) => {
      resolveWorkspace = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/workspace")) return workspaceLoad;
        const response = projectSurfaceResponse(url);
        if (response) return response;
        throw new Error(`Unexpected GET: ${url}`);
      }),
    );
    const user = userEvent.setup();
    window.history.replaceState(
      null,
      "",
      `/projects/${project.id}?guide=workspace`,
    );

    render(<ProjectPanel />);

    const guide = await screen.findByRole("region", {
      name: "Workspace 首次使用引导",
    });
    expect(within(guide).getByText("正在核对工作区绑定…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    resolveWorkspace(
      Response.json({
        projectVersion: 3,
        workspace: { path: "D:\\private\\workspace", status: "ready" },
      }),
    );
    expect(
      await within(guide).findByText(
        "工作区已 bind ready：目录已规范化且当前可读。",
      ),
    ).toBeInTheDocument();
    expect(guide).toHaveTextContent(
      "真实执行仍会重新取得 verified handle、进入 sandbox，并遵守审批与审计。",
    );
    expect(guide).not.toHaveTextContent("D:\\private\\workspace");

    await user.click(
      within(guide).getByRole("button", { name: "聚焦工作区绑定" }),
    );
    expect(screen.getByRole("status", { name: "工作区绑定状态" })).toHaveFocus();
  });

  it("covers empty, invalid, error retry, and GET-only recovery without duplicating the form", async () => {
    const responses = [
      Response.json({ error: { code: "STORAGE_UNAVAILABLE" } }, { status: 503 }),
      Response.json({ projectVersion: 1, workspace: null }),
    ];
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url: String(input) });
        return responses.shift()!;
      }),
    );
    const user = userEvent.setup();

    render(<WorkspaceSetup projectId={project.id} showGuide />);
    const guide = screen.getByRole("region", {
      name: "Workspace 首次使用引导",
    });
    expect(await within(guide).findByRole("alert")).toHaveTextContent(
      "无法核对工作区",
    );
    await user.click(within(guide).getByRole("button", { name: "重新检测" }));
    expect(await within(guide).findByRole("alert")).toHaveTextContent(
      "尚未绑定工作区",
    );
    expect(within(guide).queryByLabelText("本地工作区路径")).toBeNull();
    await user.click(within(guide).getByRole("button", { name: "绑定工作区" }));
    expect(screen.getByLabelText("本地工作区路径")).toHaveFocus();
    expect(calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it("reconciles an uncertain initial bind by one GET and never automatically resends PUT", async () => {
    let ready = false;
    let getCount = 0;
    let putCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          putCount += 1;
          ready = true;
          throw new TypeError("network result unknown");
        }
        getCount += 1;
        return Response.json({
          projectVersion: ready ? 2 : 1,
          workspace: ready
            ? { path: "D:\\private\\workspace", status: "ready" }
            : null,
        });
      }),
    );
    const user = userEvent.setup();

    render(<WorkspaceSetup projectId={project.id} showGuide />);
    await screen.findByText("尚未绑定工作区。请使用现有 WorkspaceSetup 完成绑定。");
    await user.type(
      screen.getByLabelText("本地工作区路径"),
      "D:\\private\\workspace",
    );
    const workspaceForm = screen
      .getByLabelText("本地工作区路径")
      .closest("form");
    await user.click(
      within(workspaceForm!).getByRole("button", { name: "绑定工作区" }),
    );

    expect(
      await screen.findByText("已通过事实核对确认工作区已保存。"),
    ).toBeInTheDocument();
    expect(putCount).toBe(1);
    expect(getCount).toBe(2);
    expect(
      window.localStorage.getItem("cool-ai:onboarding-preference:v1") ?? "",
    ).not.toContain("D:\\private\\workspace");
  });

  it("requires rebind confirmation and reloads a version conflict with GET only", async () => {
    let version = 1;
    let workspacePath = "D:\\old";
    let getCount = 0;
    let putCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          putCount += 1;
          if (putCount === 2) {
            version = 3;
            workspacePath = "D:\\external";
            return Response.json(
              { error: { code: "RESOURCE_CONFLICT", currentVersion: version } },
              { status: 409 },
            );
          }
          version = 2;
          workspacePath = "D:\\new";
          return Response.json({
            projectVersion: version,
            workspace: { path: workspacePath, status: "ready" },
          });
        }
        getCount += 1;
        return Response.json({
          projectVersion: version,
          workspace: { path: workspacePath, status: "ready" },
        });
      }),
    );
    const user = userEvent.setup();

    render(<WorkspaceSetup projectId={project.id} showGuide />);
    await screen.findByText("工作区已 bind ready：目录已规范化且当前可读。");
    await user.clear(screen.getByLabelText("本地工作区路径"));
    await user.type(screen.getByLabelText("本地工作区路径"), "D:\\new");
    await user.click(screen.getByRole("button", { name: "保存工作区" }));
    const dialog = screen.getByRole("dialog", { name: "确认改绑工作区" });
    expect(
      within(dialog).getByRole("button", { name: "确认改绑" }),
    ).toHaveFocus();
    await user.click(
      within(dialog).getByRole("button", { name: "确认改绑" }),
    );
    expect(await screen.findByText("工作区已保存。")).toBeInTheDocument();
    expect(putCount).toBe(1);
    expect(getCount).toBe(1);

    await user.clear(screen.getByLabelText("本地工作区路径"));
    await user.type(screen.getByLabelText("本地工作区路径"), "D:\\third");
    await user.click(screen.getByRole("button", { name: "保存工作区" }));
    await user.click(
      within(
        screen.getByRole("dialog", { name: "确认改绑工作区" }),
      ).getByRole("button", { name: "确认改绑" }),
    );
    expect(
      await screen.findByText(/项目已更新/, { selector: '[role="alert"]' }),
    ).toBeInTheDocument();
    expect(putCount).toBe(2);
    await user.click(screen.getByRole("button", { name: "重新加载工作区" }));
    expect(await screen.findByText("D:\\external")).toBeInTheDocument();
    expect(getCount).toBe(2);
    expect(putCount).toBe(2);
  });
});

describe("progressive onboarding T-8 member readiness", () => {
  const GuideMembersSetup = MembersSetup as ComponentType<{
    projectId: string;
    showGuide?: boolean;
  }>;
  const verifiedProvider = {
    apiKeyMask: "••••ABCD",
    baseUrl: "https://example.test/v1",
    createdAt: "2026-08-08T00:00:00.000Z",
    defaultModel: "model-a",
    id: "provider-1",
    name: "Primary",
    status: "verified",
    updatedAt: "2026-08-08T00:00:00.000Z",
    verifiedAt: "2026-08-08T00:00:00.000Z",
    version: 1,
  };

  function memberAgent(id: string, reviewCapable: boolean) {
    return {
      accentToken: "sage",
      avatarText: id === "agent-reviewer" ? "R" : id === "agent-builder" ? "B" : "O",
      createdAt: "2026-08-08T00:00:00.000Z",
      id,
      maxHandoffs: 5,
      maxTokens: 8_000,
      model: "model-a",
      name: id === "agent-reviewer" ? "Reviewer" : id === "agent-builder" ? "Builder" : "Operator",
      permissions: {
        readFiles: true,
        runCommands: id !== "agent-reviewer",
        writeFiles: id !== "agent-reviewer",
      },
      providerId: "provider-1",
      reviewCapable,
      role: id === "agent-reviewer" ? "reviewer" : "builder",
      skillIds: [],
      systemPrompt: "PRIVATE MEMBER SYSTEM PROMPT",
      updatedAt: "2026-08-08T00:00:00.000Z",
      version: 1,
    };
  }

  function memberFrom(agent: ReturnType<typeof memberAgent>) {
    return {
      accentToken: agent.accentToken,
      agentId: agent.id,
      avatarText: agent.avatarText,
      joinedAt: "2026-08-08T00:00:00.000Z",
      model: agent.model,
      name: agent.name,
      permissions: agent.permissions,
      role: agent.role,
      skillNames: [],
    };
  }

  const builder = memberAgent("agent-builder", false);
  const reviewer = memberAgent("agent-reviewer", true);
  const operator = memberAgent("agent-operator", false);

  it("exports a strict members state/version parser that rejects private or extra data", () => {
    const machine = onboardingMachine as unknown as Record<string, unknown>;
    expect(machine).toHaveProperty(
      "parseMembershipGuideEnvelope",
      expect.any(Function),
    );
    const parse = machine.parseMembershipGuideEnvelope as (value: unknown) => unknown;
    expect(
      parse({
        members: [memberFrom(builder), memberFrom(reviewer)],
        projectVersion: 4,
      }),
    ).toEqual({
      kind: "success",
      members: [memberFrom(builder), memberFrom(reviewer)],
      projectVersion: 4,
    });
    for (const invalid of [
      null,
      { members: [], projectVersion: 0 },
      { members: [], projectVersion: 1, path: "D:\\private" },
      {
        members: [
          { ...memberFrom(builder), systemPrompt: "PRIVATE MEMBER SYSTEM PROMPT" },
        ],
        projectVersion: 1,
      },
      {
        members: [memberFrom(builder), memberFrom(builder)],
        projectVersion: 1,
      },
    ]) {
      expect(parse(invalid)).toEqual({ kind: "invalid" });
    }
  });

  it.each([
    {
      agents: [builder, reviewer],
      expected: "至少需要两名不同的合格成员",
      members: [memberFrom(builder)],
      action: "选择更多项目成员",
    },
    {
      agents: [builder, { ...reviewer, providerId: "provider-missing" }],
      expected: "成员 Agent 必须关联 verified Provider",
      members: [memberFrom(builder), memberFrom(reviewer)],
      action: "修复成员 Provider",
    },
    {
      agents: [builder, { ...reviewer, reviewCapable: false }],
      expected: "缺少 reviewCapable 的未来复核候选",
      members: [memberFrom(builder), memberFrom(reviewer)],
      action: "选择未来复核候选",
    },
  ])(
    "shows a precise $action gap and focuses the existing member surface",
    async ({ action, agents, expected, members }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "/api/agents") return Response.json({ agents });
          if (url === "/api/providers") {
            return Response.json({ providers: [verifiedProvider] });
          }
          if (url.endsWith("/members")) {
            return Response.json({ members, projectVersion: 2 });
          }
          throw new Error(`Unexpected GET: ${url}`);
        }),
      );
      const user = userEvent.setup();

      render(<GuideMembersSetup projectId={project.id} showGuide />);
      const guide = screen.getByRole("region", {
        name: "Members 首次使用引导",
      });
      expect(await within(guide).findByRole("alert")).toHaveTextContent(expected);
      expect(guide).not.toHaveTextContent("PRIVATE MEMBER SYSTEM PROMPT");
      expect(within(guide).queryByRole("checkbox")).toBeNull();
      await user.click(within(guide).getByRole("button", { name: action }));
      expect(screen.getByRole("group", { name: "平等项目成员" })).toHaveFocus();
    },
  );

  it("accepts existing qualified resources without a write and keeps formal review dynamic", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ method: init?.method ?? "GET", url });
        if (url === "/api/agents") {
          return Response.json({ agents: [builder, reviewer] });
        }
        if (url === "/api/providers") {
          return Response.json({ providers: [verifiedProvider] });
        }
        return Response.json({
          members: [memberFrom(builder), memberFrom(reviewer)],
          projectVersion: 3,
        });
      }),
    );
    const user = userEvent.setup();

    render(<GuideMembersSetup projectId={project.id} showGuide />);
    const guide = screen.getByRole("region", {
      name: "Members 首次使用引导",
    });
    expect(
      await within(guide).findByText(
        "两名合格成员与未来复核候选已就绪，无需重新保存。",
      ),
    ).toBeInTheDocument();
    expect(guide).toHaveTextContent("正式复核仍会动态排除 executor");
    await user.click(
      within(guide).getByRole("button", { name: "聚焦合格成员名册" }),
    );
    expect(screen.getByRole("heading", { name: "成员名册" })).toHaveFocus();
    expect(calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it("shows loading and error states, then retries detection with GET only", async () => {
    let memberGets = 0;
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ method: init?.method ?? "GET", url });
        if (url === "/api/agents") {
          return Response.json({ agents: [builder, reviewer] });
        }
        if (url === "/api/providers") {
          return Response.json({ providers: [verifiedProvider] });
        }
        memberGets += 1;
        if (memberGets === 1) {
          return Response.json(
            { error: { code: "STORAGE_UNAVAILABLE" } },
            { status: 503 },
          );
        }
        return Response.json({
          members: [memberFrom(builder), memberFrom(reviewer)],
          projectVersion: 3,
        });
      }),
    );
    const user = userEvent.setup();

    render(<GuideMembersSetup projectId={project.id} showGuide />);
    const guide = screen.getByRole("region", {
      name: "Members 首次使用引导",
    });
    expect(
      within(guide).getByText("正在核对成员、Provider 与未来复核资格…"),
    ).toHaveAttribute("aria-busy", "true");
    expect(await within(guide).findByRole("alert")).toHaveTextContent(
      "无法核对项目成员",
    );
    await user.click(
      within(guide).getByRole("button", { name: "重新检测成员" }),
    );
    expect(
      await within(guide).findByText(
        "两名合格成员与未来复核候选已就绪，无需重新保存。",
      ),
    ).toBeInTheDocument();
    expect(calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it("adds and removes members, reloads conflicts with GET only, and reconciles one unknown PUT without resending", async () => {
    let currentMembers = [memberFrom(builder), memberFrom(reviewer)];
    let version = 5;
    let putCount = 0;
    let getCount = 0;
    let conflictNext = false;
    let unknownNext = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/agents") {
          return Response.json({ agents: [builder, reviewer, operator] });
        }
        if (url === "/api/providers") {
          return Response.json({ providers: [verifiedProvider] });
        }
        if (url.endsWith("/members") && init?.method === "PUT") {
          putCount += 1;
          const body = JSON.parse(String(init.body)) as {
            agentIds: string[];
            expectedProjectVersion: number;
          };
          if (conflictNext) {
            conflictNext = false;
            version += 1;
            return Response.json(
              { error: { code: "RESOURCE_CONFLICT", currentVersion: version } },
              { status: 409 },
            );
          }
          currentMembers = body.agentIds.map((id) =>
            memberFrom([builder, reviewer, operator].find((agent) => agent.id === id)!),
          );
          version += 1;
          if (unknownNext) {
            unknownNext = false;
            throw new TypeError("network result unknown");
          }
          return Response.json({ members: currentMembers, projectVersion: version });
        }
        if (url.endsWith("/members")) {
          getCount += 1;
          return Response.json({ members: currentMembers, projectVersion: version });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<GuideMembersSetup projectId={project.id} showGuide />);
    const group = await screen.findByRole("group", { name: "平等项目成员" });
    await user.click(within(group).getByRole("checkbox", { name: /Operator/ }));
    await user.click(within(group).getByRole("checkbox", { name: /Builder/ }));
    await user.click(screen.getByRole("button", { name: "保存成员" }));
    expect(await screen.findByText("项目成员已保存。")).toBeInTheDocument();
    expect(currentMembers.map(({ agentId }) => agentId)).toEqual([
      "agent-reviewer",
      "agent-operator",
    ]);

    conflictNext = true;
    await user.click(within(group).getByRole("checkbox", { name: /Builder/ }));
    await user.click(screen.getByRole("button", { name: "保存成员" }));
    expect(
      await screen.findByText(/项目已更新/, { selector: '[role="alert"]' }),
    ).toBeInTheDocument();
    const putsBeforeReload = putCount;
    await user.click(screen.getByRole("button", { name: "重新加载成员" }));
    expect(putCount).toBe(putsBeforeReload);

    unknownNext = true;
    const reloadedGroup = await screen.findByRole("group", {
      name: "平等项目成员",
    });
    await user.click(
      within(reloadedGroup).getByRole("checkbox", { name: /Builder/ }),
    );
    await user.click(screen.getByRole("button", { name: "保存成员" }));
    expect(
      await screen.findByText("已通过事实核对确认项目成员已保存。"),
    ).toBeInTheDocument();
    expect(putCount).toBe(3);
    expect(getCount).toBe(3);
  });
});

describe("progressive onboarding T-9 formal goal intake", () => {
  const mission = {
    createdAt: "2026-08-08T00:00:00.000Z",
    goal: "PRIVATE MISSION BODY MUST NOT ENTER A RECEIPT",
    id: "mission-accepted",
    projectId: project.id,
    title: "Accepted mission",
    updatedAt: "2026-08-08T00:00:00.000Z",
    version: 1,
  };

  it("covers goal loading/error/empty and retries all fact checks with GET only", async () => {
    installHappyPathFetch();
    const happyFetch = fetch;
    let providerGets = 0;
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (url === "/api/providers" && providerGets++ === 0) {
          return Response.json(
            { error: { code: "STORAGE_UNAVAILABLE" } },
            { status: 503 },
          );
        }
        return happyFetch(input, init);
      }),
    );
    const user = userEvent.setup();

    render(
      <OnboardingGuide
        onCreateProject={vi.fn()}
        onFocusChat={vi.fn()}
        onFocusMission={vi.fn()}
        onSelectProject={vi.fn()}
        projectId={project.id}
        projects={[project]}
        selectedRunId={null}
        step="goal"
        threadId={threadId}
      />,
    );
    const guide = screen.getByRole("region", { name: "首次使用引导" });
    expect(
      within(guide).getByText("正在核对 Provider、Agent、工作区与成员…"),
    ).toHaveAttribute("aria-busy", "true");
    expect(await within(guide).findByRole("alert")).toHaveTextContent(
      "无法核对资源",
    );
    await user.click(
      within(guide).getByRole("button", { name: "仅重新核对目标事实" }),
    );
    expect(
      await within(guide).findByText("资源已就绪，可以创建使命并启动协作。"),
    ).toBeInTheDocument();
    expect(
      within(guide).getByRole("button", { name: "在项目群聊启动协作" }),
    ).toBeDisabled();
    expect(calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it("reconciles every explicit Mission success through GET before accepting the goal", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let missionGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (url.endsWith("/members")) {
          return Response.json({ members: [], projectVersion: 1 });
        }
        if (url.endsWith("/mission") && method === "GET") {
          missionGets += 1;
          return Response.json({
            mission: missionGets === 1 ? null : mission,
            workItems: [],
          });
        }
        if (url.endsWith("/mission") && method === "POST") {
          return Response.json({ mission }, { status: 201 });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<MissionBoard projectId={project.id} />);
    await screen.findByText("尚未创建使命。");
    await user.type(screen.getByLabelText("使命标题"), mission.title);
    await user.type(screen.getByLabelText("使命目标"), mission.goal);
    await user.click(screen.getByRole("button", { name: "创建使命" }));

    expect(
      await screen.findByText(/目标已受理；尚未执行、复核或交付。/),
    ).toBeInTheDocument();
    expect(missionGets).toBe(2);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  it("GET-reconciles an uncertain Mission POST and never resends without an explicit choice", async () => {
    let created = false;
    let postCount = 0;
    let missionGetCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/members")) {
          return Response.json({ members: [], projectVersion: 1 });
        }
        if (url.endsWith("/mission") && init?.method === "POST") {
          postCount += 1;
          created = postCount > 1;
          throw new TypeError("network result unknown");
        }
        if (url.endsWith("/mission")) {
          missionGetCount += 1;
          return Response.json({
            mission: created ? mission : null,
            workItems: [],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<MissionBoard projectId={project.id} />);
    await screen.findByText("尚未创建使命。");
    await user.type(screen.getByLabelText("使命标题"), mission.title);
    await user.type(screen.getByLabelText("使命目标"), mission.goal);
    await user.click(screen.getByRole("button", { name: "创建使命" }));

    const receipt = await screen.findByRole("alert");
    expect(receipt).toHaveTextContent("无法唯一确认使命是否已创建");
    expect(receipt).not.toHaveTextContent(mission.goal);
    expect(postCount).toBe(1);
    await user.click(screen.getByRole("button", { name: "仅重新核对使命" }));
    expect(postCount).toBe(1);
    await user.click(screen.getByRole("button", { name: "明确重试创建使命" }));
    expect(
      await screen.findByText("已通过事实核对确认目标已受理；尚未执行、复核或交付。"),
    ).toBeInTheDocument();
    expect(postCount).toBe(2);
    expect(missionGetCount).toBeGreaterThanOrEqual(3);
  });

  it("reconciles CollaborationRun, owner message, and run_started before announcing startup", async () => {
    let started = false;
    let collaborationGets = 0;
    let runPosts = 0;
    let advancePosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const threadRead = !init?.method
          ? threadReadResponse(url, started)
          : null;
        if (threadRead) {
          if (url === `/api/projects/${project.id}/threads/${threadId}` ||
            url.startsWith(`/api/projects/${project.id}/threads/${threadId}?run=`)) {
            collaborationGets += 1;
          }
          return threadRead;
        }
        if (
          url === `/api/projects/${project.id}/threads/${threadId}/runs` &&
          init?.method === "POST"
        ) {
          runPosts += 1;
          started = true;
          const state = collaborationState(true);
          return Response.json(
            {
              created: true,
              facts: state.factsPage.items,
              message: state.messagesPage.items[0],
              run: state.selectedRun,
            },
            { status: 201 },
          );
        }
        if (url.includes("/advance")) {
          advancePosts += 1;
          return Response.json({ run: collaborationState(true).selectedRun });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <CollaborationPanel
        projectId={project.id}
        selectedRunId={null}
        startOnly
        threadId={threadId}
      />,
    );
    await screen.findByText("尚无协作消息。请发送第一条消息。");
    await user.type(
      screen.getByLabelText("发送给项目群聊"),
      "Accept this goal for collaboration.",
    );
    await user.click(screen.getByRole("button", { name: "发送并开始首次运行" }));

    expect(
      await screen.findByText("协作已启动；目标已受理，但尚未执行、复核或交付。"),
    ).toBeInTheDocument();
    expect(collaborationGets).toBe(2);
    expect(runPosts).toBe(1);
    expect(advancePosts).toBe(0);
  });

  it("shows a non-sensitive operation receipt and retries a run POST only by owner choice", async () => {
    let postCount = 0;
    let getCount = 0;
    const operationIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes(`/threads/${threadId}/operations/`)) {
          getCount += 1;
          return Response.json(
            { error: { code: "RESOURCE_NOT_FOUND", message: "Not found." } },
            { status: 404 },
          );
        }
        const threadRead = !init?.method
          ? threadReadResponse(url, false)
          : null;
        if (threadRead) {
          if (url === `/api/projects/${project.id}/threads/${threadId}`) {
            getCount += 1;
          }
          return threadRead;
        }
        if (
          url === `/api/projects/${project.id}/threads/${threadId}/runs` &&
          init?.method === "POST"
        ) {
          postCount += 1;
          operationIds.push(
            (JSON.parse(String(init.body)) as { operationId: string }).operationId,
          );
          throw new TypeError("network result unknown");
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <CollaborationPanel
        projectId={project.id}
        selectedRunId={null}
        startOnly
        threadId={threadId}
      />,
    );
    await screen.findByText("尚无协作消息。请发送第一条消息。");
    await user.type(
      screen.getByLabelText("发送给项目群聊"),
      "PRIVATE OWNER MESSAGE MUST NOT ENTER RECEIPT",
    );
    await user.click(screen.getByRole("button", { name: "发送并开始首次运行" }));

    const receipt = await screen.findByRole("alert");
    expect(receipt).toHaveTextContent("operation receipt");
    expect(receipt).not.toHaveTextContent("PRIVATE OWNER MESSAGE");
    expect(postCount).toBe(1);
    await user.click(screen.getByRole("button", { name: "仅重新核对协作事实" }));
    expect(postCount).toBe(1);
    await user.click(
      screen.getByRole("button", {
        name: "使用同一 operation receipt 明确重试启动",
      }),
    );
    expect(postCount).toBe(2);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(getCount).toBeGreaterThanOrEqual(3);
  });
});

describe("progressive onboarding T-14 unknown-write reconciliation", () => {
  const mission = {
    createdAt: "2026-08-08T00:00:00.000Z",
    goal: "Original private goal",
    id: "mission-reconcile",
    projectId: project.id,
    title: "Original mission",
    updatedAt: "2026-08-08T00:00:00.000Z",
    version: 1,
  };

  function stateWithOwnerMessages(
    messages: Array<{ content: string; id: string; sequence: number }>,
  ) {
    const state = collaborationState(true);
    const extraMessages = messages.map((message) => ({
      authorAgentId: null,
      authorDisplayName: "项目所有者",
      authorType: "owner" as const,
      content: message.content,
      createdAt: "2026-08-08T00:02:00.000Z",
      id: message.id,
      mentionAgentId: null,
      mentionDisplayName: null,
      mentionMemberStatus: null,
      projectId: project.id,
      runId: null,
      sequence: message.sequence,
      threadId,
    }));
    const extraFacts = extraMessages.map((message, index) => ({
      activitySequence: 4 + index,
      actorId: null,
      actorType: "owner" as const,
      createdAt: message.createdAt,
      id: `fact-owner-${message.id}`,
      message,
      messageId: message.id,
      payload: { messageId: message.id },
      policyRevisionId: null,
      projectId: project.id,
      runEventId: null,
      runId: null,
      sequence: 4 + index,
      threadId,
      type: "owner_message" as const,
    }));
    return {
      ...state,
      factsPage: {
        items: [...state.factsPage.items, ...extraFacts],
        nextAfter: null,
      },
      messagesPage: {
        items: [...state.messagesPage.items, ...extraMessages],
        nextAfter: null,
      },
    };
  }

  it("GET-reconciles a committed Mission PATCH with a lost response and never resends", async () => {
    let currentMission = mission;
    let patchCount = 0;
    let missionGetCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/members")) {
          return Response.json({ members: [], projectVersion: 1 });
        }
        if (url.endsWith("/mission") && !init?.method) {
          missionGetCount += 1;
          return Response.json({ mission: currentMission, workItems: [] });
        }
        if (url.includes(`/api/missions/${mission.id}`) && init?.method === "PATCH") {
          patchCount += 1;
          currentMission = {
            ...mission,
            goal: "Updated private goal",
            title: "Updated mission",
            updatedAt: "2026-08-08T00:01:00.000Z",
            version: 2,
          };
          throw new TypeError("response lost after commit");
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<MissionBoard projectId={project.id} />);
    await screen.findByRole("heading", { name: mission.title });
    await user.click(screen.getByRole("button", { name: "编辑使命" }));
    await user.clear(screen.getByLabelText("使命标题"));
    await user.type(screen.getByLabelText("使命标题"), "Updated mission");
    await user.clear(screen.getByLabelText("使命目标"));
    await user.type(screen.getByLabelText("使命目标"), "Updated private goal");
    await user.click(screen.getByRole("button", { name: "保存使命" }));

    expect(
      await screen.findByText("已通过事实核对确认使命已保存。"),
    ).toBeInTheDocument();
    expect(patchCount).toBe(1);
    expect(missionGetCount).toBe(2);
  });

  it("keeps an uncommitted Mission PATCH uncertain, rechecks with GET only, and requires explicit resubmission", async () => {
    let currentMission = mission;
    let patchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/members")) {
          return Response.json({ members: [], projectVersion: 1 });
        }
        if (url.endsWith("/mission") && !init?.method) {
          return Response.json({ mission: currentMission, workItems: [] });
        }
        if (url.includes(`/api/missions/${mission.id}`) && init?.method === "PATCH") {
          patchCount += 1;
          if (patchCount === 1) throw new TypeError("request outcome unknown");
          currentMission = {
            ...mission,
            title: "Explicitly resubmitted mission",
            updatedAt: "2026-08-08T00:01:00.000Z",
            version: 2,
          };
          return Response.json({ mission: currentMission });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(<MissionBoard projectId={project.id} />);
    await screen.findByRole("heading", { name: mission.title });
    await user.click(screen.getByRole("button", { name: "编辑使命" }));
    await user.clear(screen.getByLabelText("使命标题"));
    await user.type(
      screen.getByLabelText("使命标题"),
      "Explicitly resubmitted mission",
    );
    await user.click(screen.getByRole("button", { name: "保存使命" }));

    const receipt = await screen.findByRole("alert");
    expect(receipt).toHaveTextContent("无法唯一确认使命更新结果");
    expect(receipt).toHaveTextContent("receipt");
    expect(receipt).not.toHaveTextContent("Original private goal");
    await user.click(screen.getByRole("button", { name: "仅重新核对使命更新" }));
    expect(patchCount).toBe(1);
    await user.click(screen.getByRole("button", { name: "明确重新提交使命更新" }));
    expect(
      await screen.findByText("使命已保存。"),
    ).toBeInTheDocument();
    expect(patchCount).toBe(2);
  });

  it("uniquely GET-reconciles a committed active-run owner message after response loss", async () => {
    const content = "PRIVATE ACTIVE MESSAGE";
    let persisted = false;
    let messagePosts = 0;
    let collaborationGets = 0;
    let operationId = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes(`/threads/${threadId}/operations/`) && operationId) {
          const state = stateWithOwnerMessages([
            { content, id: "message-active", sequence: 2 },
          ]);
          const message = state.messagesPage.items[1];
          return Response.json({
            httpStatus: 201,
            kind: "message",
            operationId,
            response: {
              fact: state.factsPage.items.find(
                (fact) => fact.messageId === message.id,
              ),
              message,
              run: state.selectedRun,
            },
            status: "completed",
          });
        }
        const threadRead = !init?.method
          ? threadStateResponse(
              url,
              persisted
                ? stateWithOwnerMessages([
                    { content, id: "message-active", sequence: 2 },
                  ])
                : collaborationState(true),
            )
          : null;
        if (threadRead) {
          if (url.startsWith(
            `/api/projects/${project.id}/threads/${threadId}?run=`,
          )) collaborationGets += 1;
          return threadRead;
        }
        if (
          url === `/api/projects/${project.id}/threads/${threadId}/messages` &&
          init?.method === "POST"
        ) {
          messagePosts += 1;
          operationId = (
            JSON.parse(String(init.body)) as { operationId: string }
          ).operationId;
          persisted = true;
          throw new TypeError("response lost after commit");
        }
        if (url.endsWith("/members")) {
          return Response.json({ members: [], projectVersion: 1 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <CollaborationPanel
        projectId={project.id}
        selectedRunId="run-1"
        startOnly
        threadId={threadId}
      />,
    );
    const composer = await screen.findByLabelText("发送给项目群聊");
    await user.type(composer, content);
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(
      await screen.findByText("已通过事实核对确认消息已发送。"),
    ).toBeInTheDocument();
    expect(messagePosts).toBe(1);
    expect(collaborationGets).toBe(2);
  });

  it("treats an invalid success envelope plus zero or multiple message matches as uncertain and only GET-rechecks", async () => {
    const content = "PRIVATE AMBIGUOUS MESSAGE";
    let messagePosts = 0;
    let ambiguous = false;
    const operationIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const threadRead = !init?.method
          ? threadStateResponse(
              url,
              ambiguous
                ? stateWithOwnerMessages([
                    { content, id: "message-ambiguous-a", sequence: 2 },
                    { content, id: "message-ambiguous-b", sequence: 3 },
                  ])
                : collaborationState(true),
            )
          : null;
        if (threadRead) {
          return threadRead;
        }
        if (
          url === `/api/projects/${project.id}/threads/${threadId}/messages` &&
          init?.method === "POST"
        ) {
          messagePosts += 1;
          operationIds.push(
            (JSON.parse(String(init.body)) as { operationId: string }).operationId,
          );
          if (messagePosts === 1) {
            return Response.json({
              extra: "invalid-envelope",
              message: { id: "forged-message" },
              run: null,
            });
          }
          const explicitState = stateWithOwnerMessages([
            { content, id: "message-explicit", sequence: 2 },
          ]);
          const explicitMessage = explicitState.messagesPage.items[1];
          return Response.json({
            fact: explicitState.factsPage.items.find(
              (fact) => fact.messageId === explicitMessage.id,
            ),
            message: explicitMessage,
            run: null,
          });
        }
        if (url.endsWith("/members")) {
          return Response.json({ members: [], projectVersion: 1 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <CollaborationPanel
        projectId={project.id}
        selectedRunId="run-1"
        startOnly
        threadId={threadId}
      />,
    );
    await user.type(await screen.findByLabelText("发送给项目群聊"), content);
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    const receipt = await screen.findByRole("alert");
    expect(receipt).toHaveTextContent("无法唯一确认消息是否已发送");
    expect(receipt).toHaveTextContent("operation receipt");
    expect(receipt).not.toHaveTextContent(content);
    await user.click(screen.getByRole("button", { name: "仅重新核对消息事实" }));
    expect(messagePosts).toBe(1);

    ambiguous = true;
    await user.click(screen.getByRole("button", { name: "仅重新核对消息事实" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法唯一确认");
    expect(messagePosts).toBe(1);

    ambiguous = false;
    await user.click(screen.getByRole("button", { name: "明确重新提交消息" }));
    expect(messagePosts).toBe(2);
    expect(operationIds[1]).toBe(operationIds[0]);
  });

  it("recovers a committed start after refresh without issuing a second run POST", async () => {
    let persisted = false;
    let runPosts = 0;
    let failReconciliationGet = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes(`/threads/${threadId}/operations/`)) {
          if (failReconciliationGet) {
            failReconciliationGet = false;
            throw new TypeError("reconciliation GET interrupted");
          }
          return Response.json(
            { error: { code: "RESOURCE_NOT_FOUND", message: "Not found." } },
            { status: 404 },
          );
        }
        const threadRead = !init?.method
          ? threadReadResponse(url, persisted)
          : null;
        if (threadRead) {
          if (failReconciliationGet) {
            failReconciliationGet = false;
            throw new TypeError("reconciliation GET interrupted");
          }
          return threadRead;
        }
        if (
          url === `/api/projects/${project.id}/threads/${threadId}/runs` &&
          init?.method === "POST"
        ) {
          runPosts += 1;
          persisted = true;
          failReconciliationGet = true;
          throw new TypeError("response lost after commit");
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    const view = render(
      <CollaborationPanel
        projectId={project.id}
        selectedRunId={null}
        startOnly
        threadId={threadId}
      />,
    );
    await user.type(
      await screen.findByLabelText("发送给项目群聊"),
      "Refresh-safe start",
    );
    await user.click(screen.getByRole("button", { name: "发送并开始首次运行" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法唯一确认");

    view.unmount();
    render(
      <CollaborationPanel
        projectId={project.id}
        selectedRunId="run-1"
        startOnly
        threadId={threadId}
      />,
    );
    expect(await screen.findByText("所有者发来消息")).toBeInTheDocument();
    expect(runPosts).toBe(1);
  });
});

describe("progressive onboarding T-10 accessibility and safety closure", () => {
  const verifiedProvider = {
    apiKeyMask: "••••ABCD",
    baseUrl: "https://example.test/v1",
    createdAt: "2026-08-08T00:00:00.000Z",
    defaultModel: "model-a",
    id: "provider-1",
    name: "Primary",
    status: "verified" as const,
    updatedAt: "2026-08-08T00:00:00.000Z",
    verifiedAt: "2026-08-08T00:00:00.000Z",
    version: 1,
  };

  it("renders loading, a single empty CTA, assertive error retry, and textual success", async () => {
    const onFocusProvider = vi.fn();
    const onRetry = vi.fn();
    const view = render(
      <ProviderOnboardingGuide
        facts={null}
        loading
        loadError={false}
        onFocusProvider={onFocusProvider}
        onRetry={onRetry}
      />,
    );
    const guide = screen.getByRole("region", {
      name: "Provider 首次使用引导",
    });
    expect(guide).toHaveAttribute("aria-busy", "true");

    view.rerender(
      <ProviderOnboardingGuide
        facts={{ kind: "empty", providers: [] }}
        loading={false}
        loadError={false}
        onFocusProvider={onFocusProvider}
        onRetry={onRetry}
      />,
    );
    expect(within(guide).getAllByRole("button")).toHaveLength(1);
    expect(
      within(guide).getByRole("button", { name: "创建模型服务" }),
    ).toBeInTheDocument();

    view.rerender(
      <ProviderOnboardingGuide
        facts={null}
        loading={false}
        loadError
        onFocusProvider={onFocusProvider}
        onRetry={onRetry}
      />,
    );
    const alert = within(guide).getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(
      within(guide).getByRole("button", { name: "重新检测" }),
    ).toBeInTheDocument();

    view.rerender(
      <ProviderOnboardingGuide
        facts={{
          kind: "success",
          providers: [verifiedProvider],
          verifiedProviderId: verifiedProvider.id,
        }}
        loading={false}
        loadError={false}
        onFocusProvider={onFocusProvider}
        onRetry={onRetry}
      />,
    );
    expect(guide).toHaveTextContent("状态：成功");
    expect(guide).toHaveTextContent("ready 不等于 verified handle");
    expect(within(guide).queryByRole("status")).toBeNull();
  });

  it("updates the document title, announces once politely, then focuses the route target", async () => {
    document.title = "旧标题";
    render(
      <ProviderOnboardingGuide
        facts={{
          kind: "success",
          providers: [verifiedProvider],
          verifiedProviderId: verifiedProvider.id,
        }}
        loading={false}
        loadError={false}
        onFocusProvider={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(document.title).toBe("连接模型服务 · Cool AI 协作驾驶舱"),
    );
    const politeRegions = screen.getAllByRole("status");
    expect(politeRegions).toHaveLength(1);
    expect(politeRegions[0]).toHaveAttribute("aria-live", "polite");
    expect(politeRegions[0]).toHaveTextContent(
      "已进入 Provider 引导：连接模型服务",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "连接模型服务" }),
      ).toHaveFocus(),
    );
  });

  it("exposes accessible skip, reset, dismiss, resume, and drift controls without sensitive summaries", () => {
    expect(onboardingComponents).toHaveProperty(
      "OnboardingPreferenceControls",
      expect.any(Function),
    );
    const Controls = (
      onboardingComponents as unknown as {
        OnboardingPreferenceControls: ComponentType<{
          step: "provider";
        }>;
      }
    ).OnboardingPreferenceControls;
    render(<Controls step="provider" />);

    const controls = screen.getByRole("group", { name: "引导控制" });
    expect(
      within(controls).getByRole("button", { name: "跳过此步骤" }),
    ).toBeInTheDocument();
    expect(
      within(controls).getByRole("button", { name: "重置此步骤" }),
    ).toBeInTheDocument();
    expect(
      within(controls).getByRole("button", { name: "暂时关闭引导" }),
    ).toBeInTheDocument();
    expect(controls.textContent).not.toMatch(
      /provider-secret|workspace-path|mission body|system prompt|raw response/i,
    );
  });
});

describe("progressive onboarding T-12 continue and dismiss/resume", () => {
  const verifiedProvider = {
    apiKeyMask: "••••ABCD",
    baseUrl: "https://example.test/v1",
    createdAt: "2026-08-08T00:00:00.000Z",
    defaultModel: "model-a",
    id: "provider-1",
    name: "Primary",
    status: "verified" as const,
    updatedAt: "2026-08-08T00:00:00.000Z",
    verifiedAt: "2026-08-08T00:00:00.000Z",
    version: 1,
  };

  it("continues a satisfied Provider without recording a skip", async () => {
    const onContinue = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderOnboardingGuide
        facts={{
          kind: "success",
          providers: [verifiedProvider],
          verifiedProviderId: verifiedProvider.id,
        }}
        loading={false}
        loadError={false}
        onContinue={onContinue}
        onFocusProvider={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "继续" }));

    expect(onContinue).toHaveBeenCalledOnce();
    const stored = window.localStorage.getItem(
      "cool-ai:onboarding-preference:v1",
    );
    if (stored) {
      expect(JSON.parse(stored).skips.provider.value).toBe(false);
    }
  });

  it("hides the guide body after dismiss and restores it on resume", async () => {
    const user = userEvent.setup();
    render(
      <ProviderOnboardingGuide
        facts={{ kind: "empty", providers: [] }}
        loading={false}
        loadError={false}
        onContinue={vi.fn()}
        onFocusProvider={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "重置此步骤" }));
    await user.click(
      screen.getByRole("button", { name: "暂时关闭引导" }),
    );
    expect(
      screen.queryByRole("region", { name: "Provider 首次使用引导" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "跳过此步骤" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "恢复引导" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "恢复引导" }));
    expect(
      screen.getByRole("region", { name: "Provider 首次使用引导" }),
    ).toBeInTheDocument();
  });
});
