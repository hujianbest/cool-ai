// @vitest-environment jsdom
import "./component-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentList } from "../components/AgentList";

function mockOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  });
}

describe("AgentList states", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows loading before fetch resolves", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<AgentList />);
    expect(screen.getByText("加载中…")).toBeInTheDocument();
  });

  it("renders agents on success", async () => {
    vi.stubGlobal(
      "fetch",
      mockOk({
        agents: [{ id: 1, name: "骨架 Agent" }],
      })
    );
    render(<AgentList />);
    expect(await screen.findByText("骨架 Agent")).toBeInTheDocument();
  });

  it("shows empty state when no agents", async () => {
    vi.stubGlobal("fetch", mockOk({ agents: [] }));
    render(<AgentList />);
    expect(await screen.findByText(/暂无 Agent/)).toBeInTheDocument();
  });

  it("shows error state with retry button on fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
    render(<AgentList />);
    expect(await screen.findByText(/加载失败/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重试" })
    ).toBeInTheDocument();
  });

  it("reloads on retry click", async () => {
    const user = userEvent.setup();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("net"));
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              agents: [{ id: 1, name: "骨架 Agent" }],
            }),
        });
      })
    );
    render(<AgentList />);
    await screen.findByText(/加载失败/);
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("骨架 Agent")).toBeInTheDocument();
  });

  it("shows associated skill names resolved via skills prop", async () => {
    vi.stubGlobal(
      "fetch",
      mockOk({ agents: [{ id: 1, name: "PM", skills: [5] }] })
    );
    render(
      <AgentList
        version={0}
        skills={[
          { id: 5, name: "需求整理", description: "", category: "", agentCount: 1 },
        ]}
      />
    );

    expect(await screen.findByText("PM")).toBeInTheDocument();
    expect(screen.getByText("需求整理")).toBeInTheDocument();
  });
});
