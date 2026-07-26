// @vitest-environment jsdom
import "./component-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentForm } from "../components/AgentForm";

describe("AgentForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders labeled inputs", () => {
    render(<AgentForm onCreated={() => {}} />);
    expect(screen.getByLabelText("名字")).toBeInTheDocument();
    expect(screen.getByLabelText("角色描述")).toBeInTheDocument();
    expect(screen.getByLabelText("provider 配置")).toBeInTheDocument();
    expect(screen.getByLabelText("模型")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "可用工具" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "skills" })).toBeInTheDocument();
  });

  it("blocks submit and shows error when name empty (no fetch)", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<AgentForm onCreated={() => {}} />);

    await user.click(screen.getByRole("button", { name: /创建 Agent/ }));

    expect(screen.getByRole("alert")).toHaveTextContent("必填");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits and calls onCreated on success", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ agent: { id: 1, name: "架构师" } }),
      })
    );
    render(<AgentForm onCreated={onCreated} />);

    await user.type(screen.getByLabelText("名字"), "架构师");
    await user.click(screen.getByRole("button", { name: /创建 Agent/ }));

    expect(await screen.findByRole("button", { name: /创建 Agent/ })).toBeEnabled();
    expect(onCreated).toHaveBeenCalled();
  });

  it("stores selected skill id in the submit body", async () => {
    const user = userEvent.setup();
    let captured: { skills?: number[] } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.body) captured = JSON.parse(init.body as string);
        return { ok: true, status: 201, json: () => Promise.resolve({ agent: { id: 1 } }) };
      })
    );
    render(
      <AgentForm
        onCreated={() => {}}
        skills={[
          { id: 5, name: "需求整理", description: "", category: "", agentCount: 0 },
        ]}
      />
    );

    await user.type(screen.getByLabelText("名字"), "PM");
    await user.click(screen.getByRole("checkbox", { name: "需求整理" }));
    await user.click(screen.getByRole("button", { name: /创建 Agent/ }));

    await screen.findByRole("button", { name: /创建 Agent/ });
    expect(captured?.skills).toEqual([5]);
  });

  it("queries models after selecting provider and stores providerConfigId + model", async () => {
    const user = userEvent.setup();
    let captured: { providerConfigId?: number; model?: string } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/models")) {
          return {
            ok: true,
            json: () => Promise.resolve({ models: ["glm-4-plus", "glm-4-plus-lite"] }),
          };
        }
        if (init?.body) captured = JSON.parse(init.body as string);
        return { ok: true, status: 201, json: () => Promise.resolve({ agent: { id: 1 } }) };
      })
    );
    render(
      <AgentForm
        onCreated={() => {}}
        providerConfigs={[
          { id: 5, name: "P", baseUrl: "", createdAt: new Date(), agentCount: 0 },
        ]}
      />
    );

    await user.selectOptions(screen.getByLabelText("provider 配置"), "5");
    const modelSelect = await screen.findByLabelText("模型");
    await user.selectOptions(modelSelect, "glm-4-plus");
    await user.type(screen.getByLabelText("名字"), "PM");
    await user.click(screen.getByRole("button", { name: /创建 Agent/ }));

    await screen.findByRole("button", { name: /创建 Agent/ });
    expect(captured?.providerConfigId).toBe(5);
    expect(captured?.model).toBe("glm-4-plus");
  });
});
