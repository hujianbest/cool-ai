// @vitest-environment jsdom
import "./component-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentRun } from "../components/AgentRun";

describe("AgentRun", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders labeled inputs; agent select populated from /api/agents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [{ id: 1, name: "PM" }] }),
      })
    );
    render(<AgentRun />);

    expect(screen.getByLabelText("选择 Agent")).toBeInTheDocument();
    expect(screen.getByLabelText("任务")).toBeInTheDocument();
    expect(await screen.findByText("PM")).toBeInTheDocument();
  });

  it("runs and shows output + trace on success", async () => {
    const user = userEvent.setup();
    let runCalled = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/run")) {
          runCalled++;
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                output: "回答内容",
                trace: [
                  { role: "system", content: "s" },
                  { role: "user", content: "你好" },
                  { role: "assistant", content: "回答内容" },
                ],
              }),
          };
        }
        return {
          ok: true,
          json: () => Promise.resolve({ agents: [{ id: 1, name: "PM" }] }),
        };
      })
    );

    render(<AgentRun />);
    await screen.findByText("PM");
    await user.type(screen.getByLabelText("任务"), "你好");
    await user.click(screen.getByRole("button", { name: /^运行$/ }));

    expect((await screen.findAllByText("回答内容")).length).toBeGreaterThan(0);
    expect(runCalled).toBe(1);
  });

  it("shows error on 400 (no provider)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/run")) {
          return { ok: false, status: 400, json: () => Promise.resolve({ error: "agent has no provider config" }) };
        }
        return { ok: true, json: () => Promise.resolve({ agents: [{ id: 1, name: "PM" }] }) };
      })
    );

    render(<AgentRun />);
    await screen.findByText("PM");
    await user.type(screen.getByLabelText("任务"), "x");
    await user.click(screen.getByRole("button", { name: /^运行$/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/provider/i);
  });

  it("disables button and shows 运行中… while running", async () => {
    const user = userEvent.setup();
    let resolveRun!: (v: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/run")) {
          return new Promise((r) => {
            resolveRun = r as (v: unknown) => void;
          });
        }
        return {
          ok: true,
          json: () => Promise.resolve({ agents: [{ id: 1, name: "PM" }] }),
        };
      })
    );

    render(<AgentRun />);
    await screen.findByText("PM");
    await user.type(screen.getByLabelText("任务"), "x");
    await user.click(screen.getByRole("button", { name: /^运行$/ }));

    const runningBtn = await screen.findByRole("button", { name: /运行中/ });
    expect(runningBtn).toBeDisabled();

    resolveRun({
      ok: true,
      json: () => Promise.resolve({ output: "o", trace: [] }),
    });
    await screen.findByText("o");
  });
});
