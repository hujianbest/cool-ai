// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentPanel } from "@/components/agent-panel";

const templates = [
  {
    accentToken: "sage",
    avatarText: "规",
    id: "planner",
    name: "规划",
    reviewCapable: false,
    role: "拆解目标",
    systemPrompt: "制定可验证计划。",
  },
  {
    accentToken: "slate",
    avatarText: "复",
    id: "reviewer",
    name: "复核",
    reviewCapable: true,
    role: "独立复核",
    systemPrompt: "检查证据与风险。",
  },
];

const providers = [{
  apiKeyMask: "••••ABCD",
  baseUrl: "https://provider.example/v1",
  createdAt: "2026-08-01T00:00:00.000Z",
  defaultModel: "model-a",
  id: "provider",
  name: "Provider",
  status: "verified",
  updatedAt: "2026-08-01T00:00:00.000Z",
  verifiedAt: "2026-08-01T00:00:00.000Z",
  version: 1,
}];

function agent(reviewCapable: boolean) {
  return {
    accentToken: "sage",
    avatarText: "A",
    createdAt: "2026-08-01T00:00:00.000Z",
    id: "agent",
    maxHandoffs: 4,
    maxTokens: 8_000,
    model: "model-a",
    name: "Agent",
    permissions: { readFiles: true, runCommands: false, writeFiles: false },
    providerId: "provider",
    reviewCapable,
    role: "Role",
    skillIds: [],
    systemPrompt: "Prompt",
    updatedAt: "2026-08-01T00:00:00.000Z",
    version: 1,
  };
}

function getPayload(url: string, agents: unknown[] = []) {
  if (url === "/api/agent-templates") return { templates };
  if (url === "/api/providers") return { providers };
  if (url === "/api/skills") return { skills: [] };
  if (url === "/api/agents") return { agents };
  throw new Error(`Unexpected GET ${url}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Agent review capability UI", () => {
  it("shows loading, empty, and error states without fabricating capability", async () => {
    let resolveAgents!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveAgents = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/api/agents") return pending;
      return Promise.resolve(Response.json(getPayload(url)));
    }));
    const view = render(<AgentPanel />);
    expect(screen.getByText("正在加载 Agent…")).toHaveAttribute("aria-busy", "true");
    resolveAgents(Response.json({ agents: [] }));
    expect(await screen.findByText("暂无 Agent。")).toBeInTheDocument();
    view.unmount();

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString() === "/api/agents") {
        return Response.json({ error: { code: "STORAGE_UNAVAILABLE" } }, { status: 503 });
      }
      return Response.json(getPayload(input.toString()));
    }));
    render(<AgentPanel />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("暂时无法加载 Agent");
    expect(alert).toHaveFocus();
  });

  it("preselects only the reviewer template, resets blank to false, and saves a strict boolean", async () => {
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (!init?.method) return Response.json(getPayload(url));
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push(body);
      return Response.json({ agent: { ...agent(Boolean(body.reviewCapable)), ...body } }, { status: 201 });
    }));
    const user = userEvent.setup();
    render(<AgentPanel />);
    await screen.findByText("暂无 Agent。");
    await user.click(screen.getByRole("button", { name: "创建 Agent" }));
    const capability = screen.getByRole("checkbox", { name: "可独立复核结果" });
    expect(capability).not.toBeChecked();
    expect(capability).toHaveAccessibleDescription(
      "仅明确开启后，且 Agent 当前属于项目并非结果执行者时，才可成为复核候选。",
    );

    await user.selectOptions(screen.getByLabelText("创建方式"), "reviewer");
    expect(capability).toBeChecked();
    await user.selectOptions(screen.getByLabelText("创建方式"), "blank");
    expect(capability).not.toBeChecked();
    await user.selectOptions(screen.getByLabelText("创建方式"), "reviewer");
    await user.selectOptions(screen.getByLabelText("模型服务"), "provider");
    await user.click(screen.getByRole("button", { name: "保存 Agent" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ reviewCapable: true });
    expect(typeof writes[0]!.reviewCapable).toBe("boolean");
  });

  it("loads owner-edited false, preserves a failed true draft, and restores focus after save", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (!init?.method) return Response.json(getPayload(url, [agent(false)]));
      attempts += 1;
      if (attempts === 1) {
        return Response.json({ error: { code: "RESOURCE_CONFLICT" } }, { status: 409 });
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ agent: { ...agent(true), ...body, version: 2 } });
    }));
    const user = userEvent.setup();
    render(<AgentPanel />);
    await user.click(await screen.findByRole("button", { name: "编辑 Agent" }));
    const capability = screen.getByRole("checkbox", { name: "可独立复核结果" });
    expect(capability).not.toBeChecked();
    await user.click(capability);
    await user.click(screen.getByRole("button", { name: "保存 Agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Agent 已被更新");
    expect(capability).toBeChecked();

    await user.click(screen.getByRole("button", { name: "保存 Agent" }));
    const heading = await screen.findByRole("heading", { level: 3, name: "Agent" });
    await waitFor(() => expect(heading).toHaveFocus());
  });
});
