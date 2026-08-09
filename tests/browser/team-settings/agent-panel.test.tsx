// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamPanel } from "@/components/team-panel";

const templates = [
  {
    accentToken: "sage",
    avatarText: "规",
    id: "planner",
    name: "规划",
    role: "拆解目标",
    systemPrompt: "制定可验证计划。",
  },
  {
    accentToken: "terracotta",
    avatarText: "实",
    id: "builder",
    name: "实施",
    role: "实现计划",
    systemPrompt: "实施并测试。",
  },
  {
    accentToken: "slate",
    avatarText: "复",
    id: "reviewer",
    name: "复核",
    role: "独立复核",
    systemPrompt: "检查风险。",
  },
];

const providers = [
  {
    apiKeyMask: "••••ABCD",
    baseUrl: "https://provider.example/v1",
    createdAt: "2026-07-29T00:00:00.000Z",
    defaultModel: "model-a",
    id: "provider-1",
    name: "Primary",
    status: "verified",
    updatedAt: "2026-07-29T00:00:00.000Z",
    verifiedAt: "2026-07-29T00:00:00.000Z",
    version: 1,
  },
];

const skills = [
  {
    createdAt: "2026-07-29T00:00:00.000Z",
    description: "",
    id: "skill-1",
    instructions: "Plan",
    name: "规划技能",
    updatedAt: "2026-07-29T00:00:00.000Z",
    version: 1,
  },
  {
    createdAt: "2026-07-29T00:00:01.000Z",
    description: "",
    id: "skill-2",
    instructions: "Review",
    name: "复核技能",
    updatedAt: "2026-07-29T00:00:01.000Z",
    version: 1,
  },
];

function agent(overrides: Record<string, unknown> = {}) {
  return {
    accentToken: "sage",
    avatarText: "规",
    createdAt: "2026-07-29T00:00:00.000Z",
    id: "agent-1",
    maxHandoffs: 6,
    maxTokens: 12_000,
    model: "model-a",
    name: "规划",
    permissions: {
      readFiles: true,
      runCommands: false,
      writeFiles: false,
    },
    providerId: "provider-1",
    role: "拆解目标",
    skillIds: ["skill-1"],
    systemPrompt: "制定可验证计划。",
    updatedAt: "2026-07-29T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function jsonForGet(url: string, agents: unknown[] = []) {
  if (url === "/api/agent-templates") return { templates };
  if (url === "/api/providers") return { providers };
  if (url === "/api/skills") return { skills };
  if (url === "/api/agents") return { agents };
  throw new Error(`Unexpected GET: ${url}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Agent panel", () => {
  it("shows loading, retry, empty and disabled no-provider states", async () => {
    let agentLoads = 0;
    let noProviders = false;
    let resolveFirstAgent!: (response: Response) => void;
    const firstAgent = new Promise<Response>((resolve) => {
      resolveFirstAgent = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method) throw new Error(`Unexpected mutation: ${url}`);
      if (url === "/api/agents") {
        agentLoads += 1;
        if (agentLoads === 1) {
          return firstAgent;
        }
      }
      if (url === "/api/providers" && noProviders) {
        return Promise.resolve(Response.json({ providers: [] }));
      }
      return Promise.resolve(Response.json(jsonForGet(url)));
    }));
    const user = userEvent.setup();
    render(<TeamPanel section="agents" />);

    expect(screen.getByText("正在加载 Agent…")).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      resolveFirstAgent(
        Response.json(
          { error: { code: "STORAGE_UNAVAILABLE" } },
          { status: 503 },
        ),
      );
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("暂时无法加载 Agent");
    expect(alert).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "重试加载 Agent" }));
    expect(await screen.findByText("暂无 Agent。")).toBeInTheDocument();

    noProviders = true;
    await user.click(screen.getByRole("button", { name: "重试加载 Agent" }));
    expect(
      await screen.findAllByText("请先创建并验证模型服务。"),
    ).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "保存 Agent" })).toBeDisabled();
  });

  it("uses detached template or blank defaults and creates a complete Agent", async () => {
    let posted: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (!init?.method) return Response.json(jsonForGet(url));
      if (url === "/api/agents" && init.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json(
          { agent: agent({ ...posted, id: "agent-created" }) },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<TeamPanel section="agents" />);
    await screen.findByText("暂无 Agent。");
    await user.click(screen.getByRole("button", { name: "创建 Agent" }));

    await user.selectOptions(screen.getByLabelText("创建方式"), "planner");
    expect(screen.getByLabelText("Agent 名称")).toHaveValue("规划");
    await user.clear(screen.getByLabelText("Agent 名称"));
    await user.type(screen.getByLabelText("Agent 名称"), "污染尝试");
    await user.selectOptions(screen.getByLabelText("创建方式"), "blank");
    expect(screen.getByLabelText("Agent 名称")).toHaveValue("");
    await user.selectOptions(screen.getByLabelText("创建方式"), "planner");
    expect(screen.getByLabelText("Agent 名称")).toHaveValue("规划");

    await user.click(screen.getByRole("checkbox", { name: "规划技能" }));
    await user.clear(screen.getByLabelText("Agent 名称"));
    await user.type(screen.getByLabelText("Agent 名称"), "计划员");
    await user.selectOptions(screen.getByLabelText("模型服务"), "provider-1");
    expect(screen.getByLabelText("模型")).toHaveValue("model-a");
    await user.click(screen.getByRole("checkbox", { name: "复核技能" }));
    await user.click(screen.getByRole("checkbox", { name: "写入文件" }));
    await user.clear(screen.getByLabelText("Token 预算"));
    await user.type(screen.getByLabelText("Token 预算"), "20000");
    await user.clear(screen.getByLabelText("接力轮次"));
    await user.type(screen.getByLabelText("接力轮次"), "9");
    await user.clear(screen.getByLabelText("头像文字"));
    await user.type(screen.getByLabelText("头像文字"), "🧭");
    await user.selectOptions(screen.getByLabelText("强调色"), "gold");
    await user.click(screen.getByRole("button", { name: "保存 Agent" }));

    expect(posted).toMatchObject({
      accentToken: "gold",
      avatarText: "🧭",
      maxHandoffs: 9,
      maxTokens: 20_000,
      model: "model-a",
      name: "计划员",
      permissions: {
        readFiles: true,
        runCommands: false,
        writeFiles: true,
      },
      providerId: "provider-1",
      skillIds: ["skill-1", "skill-2"],
    });
    const heading = await screen.findByRole("heading", { name: "计划员" });
    expect(heading).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Agent 已保存。");
    expect(screen.getByText("复核技能")).toBeInTheDocument();
  });

  it("edits with expectedVersion and preserves a failed draft with field errors", async () => {
    let patchBody: Record<string, unknown> | undefined;
    let saveAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (!init?.method) return Response.json(jsonForGet(url, [agent()]));
      if (url === "/api/agents/agent-1" && init.method === "PATCH") {
        saveAttempts += 1;
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (saveAttempts === 1) {
          return Response.json(
            {
              error: {
                code: "INVALID_INPUT",
                fields: [{ code: "out_of_range", field: "maxTokens" }],
              },
            },
            { status: 400 },
          );
        }
        return Response.json({ agent: agent({ ...patchBody, name: "Updated", version: 2 }) });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<TeamPanel section="agents" />);
    await user.click(await screen.findByRole("button", { name: "编辑 规划" }));
    expect(screen.getByLabelText("规划技能")).toBeChecked();
    expect(screen.getByLabelText("读取文件")).toBeChecked();
    await user.clear(screen.getByLabelText("Agent 名称"));
    await user.type(screen.getByLabelText("Agent 名称"), "Draft name");
    await user.click(screen.getByRole("button", { name: "保存 Agent" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(screen.getByLabelText("Token 预算")).toHaveFocus();
    expect(screen.getByLabelText("Agent 名称")).toHaveValue("Draft name");
    expect(screen.getByLabelText("Token 预算")).toHaveAccessibleDescription(
      "Token 预算必须是 1–1000000 的整数。",
    );
    expect(patchBody).toMatchObject({ expectedVersion: 1, name: "Draft name" });

    await user.clear(screen.getByLabelText("Agent 名称"));
    await user.type(screen.getByLabelText("Agent 名称"), "Updated");
    await user.click(screen.getByRole("button", { name: "保存 Agent" }));
    expect(await screen.findByRole("heading", { name: "Updated" })).toHaveFocus();
  });
});
