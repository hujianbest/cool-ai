// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentPanel } from "@/components/agent-panel";
import { ProviderPanel } from "@/components/provider-panel";

const provider = {
  apiKeyMask: "••••ABCD",
  baseUrl: "https://provider.example/v1",
  createdAt: "now",
  defaultModel: "model-a",
  id: "provider-1",
  name: "Primary",
  status: "verified",
  updatedAt: "now",
  verifiedAt: "now",
  version: 1,
};

const skill = {
  createdAt: "now",
  description: "",
  id: "skill-1",
  instructions: "Plan",
  name: "Planning",
  updatedAt: "now",
  version: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stable field errors", () => {
  it("associates and focuses every Provider field returned by verification", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/providers" && !init?.method) {
        return Response.json({ providers: [] });
      }
      if (url === "/api/providers/verify" && init?.method === "POST") {
        return Response.json(
          {
            error: {
              code: "INVALID_INPUT",
              fields: [
                { code: "too_long", field: "name" },
                { code: "invalid_format", field: "baseUrl" },
                { code: "too_long", field: "defaultModel" },
                { code: "required", field: "apiKey" },
                { code: "confirmation_required", field: "allowInsecureHttp" },
              ],
            },
          },
          { status: 400 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<ProviderPanel />);
    await screen.findByText("暂无模型服务。");
    await user.click(screen.getByRole("button", { name: "创建模型服务" }));
    await user.type(screen.getByLabelText("服务名称"), "Provider");
    await user.type(screen.getByLabelText("Base URL"), "http://provider.test/v1");
    await user.type(screen.getByLabelText("默认模型"), "model-a");
    await user.type(screen.getByLabelText("API key"), "temporary");
    await user.click(
      screen.getByRole("checkbox", { name: /HTTP 会明文传输凭据/ }),
    );
    await user.click(screen.getByRole("button", { name: "验证连接" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    const fields = [
      screen.getByLabelText("服务名称"),
      screen.getByLabelText("Base URL"),
      screen.getByLabelText("默认模型"),
      screen.getByLabelText("API key"),
      screen.getByRole("checkbox", { name: /HTTP 会明文传输凭据/ }),
    ];
    for (const field of fields) {
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAccessibleDescription();
    }
    expect(screen.getByLabelText("服务名称")).toHaveFocus();
    expect(screen.getByText("服务名称超过长度限制。")).toBeInTheDocument();
    expect(screen.getByText("Base URL 格式无效。")).toBeInTheDocument();
    expect(screen.getByText("请确认 HTTP 明文传输风险。")).toBeInTheDocument();
  });

  it("associates and focuses every Agent field returned by save", async () => {
    const fields = [
      "name",
      "role",
      "systemPrompt",
      "providerId",
      "model",
      "skillIds",
      "permissions.readFiles",
      "permissions.writeFiles",
      "permissions.runCommands",
      "maxTokens",
      "maxHandoffs",
      "avatarText",
      "accentToken",
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (!init?.method) {
        if (url === "/api/agent-templates") {
          return Response.json({
            templates: [
              {
                accentToken: "sage",
                avatarText: "规",
                id: "planner",
                name: "Planner",
                role: "Plan",
                systemPrompt: "Plan carefully",
              },
            ],
          });
        }
        if (url === "/api/providers") return Response.json({ providers: [provider] });
        if (url === "/api/skills") return Response.json({ skills: [skill] });
        if (url === "/api/agents") return Response.json({ agents: [] });
      }
      if (url === "/api/agents" && init?.method === "POST") {
        return Response.json(
          {
            error: {
              code: "INVALID_INPUT",
              fields: fields.map((field) => ({
                code: field === "name" ? "too_long" : "invalid_format",
                field,
              })),
            },
          },
          { status: 400 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<AgentPanel />);
    await screen.findByText("暂无 Agent。");
    await user.click(screen.getByRole("button", { name: "创建 Agent" }));
    await user.selectOptions(screen.getByLabelText("创建方式"), "planner");
    await user.selectOptions(screen.getByLabelText("模型服务"), "provider-1");
    await user.click(screen.getByRole("checkbox", { name: "Planning" }));
    await user.click(screen.getByRole("button", { name: "保存 Agent" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent 名称")).toHaveFocus();
    for (const control of [
      screen.getByLabelText("Agent 名称"),
      screen.getByLabelText("职责"),
      screen.getByLabelText("系统提示"),
      screen.getByLabelText("模型服务"),
      screen.getByLabelText("模型"),
      screen.getByLabelText("Token 预算"),
      screen.getByLabelText("接力轮次"),
      screen.getByLabelText("头像文字"),
      screen.getByLabelText("强调色"),
      screen.getByRole("checkbox", { name: "读取文件" }),
      screen.getByRole("checkbox", { name: "写入文件" }),
      screen.getByRole("checkbox", { name: "运行命令" }),
    ]) {
      expect(control).toHaveAttribute("aria-invalid", "true");
      expect(control).toHaveAccessibleDescription();
    }
    for (const group of [
      screen.getByRole("group", { name: "技能" }),
      screen.getByRole("group", { name: "工具权限" }),
    ]) {
      expect(group).toHaveAttribute("aria-invalid", "true");
      expect(group).toHaveAccessibleDescription();
    }
    expect(within(screen.getByRole("group", { name: "技能" })).getByText(
      "所选技能无效。",
    )).toBeInTheDocument();
  });
});
