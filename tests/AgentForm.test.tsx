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

  it("renders five labeled inputs", () => {
    render(<AgentForm onCreated={() => {}} />);
    expect(screen.getByLabelText("名字")).toBeInTheDocument();
    expect(screen.getByLabelText("角色描述")).toBeInTheDocument();
    expect(screen.getByLabelText("模型供应商")).toBeInTheDocument();
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
});
