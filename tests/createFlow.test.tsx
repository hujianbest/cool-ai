// @vitest-environment jsdom
import "./component-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "../app/page";

describe("create flow (page wiring)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creating an agent refreshes the list via version bump", async () => {
    const user = userEvent.setup();
    let createdCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/api/skills")) {
          return { ok: true, status: 200, json: () => Promise.resolve({ skills: [] }) };
        }
        if (init?.method === "POST") {
          createdCount += 1;
          return {
            ok: true,
            status: 201,
            json: () =>
              Promise.resolve({ agent: { id: createdCount, name: "架构师" } }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              createdCount > 0
                ? { agents: [{ id: createdCount, name: "架构师" }] }
                : { agents: [] }
            ),
        };
      })
    );

    render(<Home />);

    expect(await screen.findByText(/暂无 Agent/)).toBeInTheDocument();
    const agentForm = within(screen.getByRole("form", { name: "创建 Agent" }));
    await user.type(agentForm.getByLabelText("名字"), "架构师");
    await user.click(agentForm.getByRole("button", { name: /创建 Agent/ }));

    expect(await screen.findByText("架构师")).toBeInTheDocument();
  });
});
