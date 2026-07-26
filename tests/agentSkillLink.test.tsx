// @vitest-environment jsdom
import "./component-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "../app/page";

describe("agent ↔ skill association flow", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("create skill, link it to a new agent, card shows the skill name", async () => {
    const user = userEvent.setup();
    let skillCreated = false;
    let agentCreated = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === "POST" && u.includes("/api/skills")) {
          skillCreated = true;
          return {
            ok: true,
            status: 201,
            json: () => Promise.resolve({ skill: { id: 1, name: "需求整理" } }),
          };
        }
        if (init?.method === "POST" && u.includes("/api/agents")) {
          agentCreated = true;
          return {
            ok: true,
            status: 201,
            json: () => Promise.resolve({ agent: { id: 1, name: "PM", skills: [1] } }),
          };
        }
        if (u.includes("/api/skills")) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                skills: skillCreated
                  ? [{ id: 1, name: "需求整理", description: "", category: "", agentCount: agentCreated ? 1 : 0 }]
                  : [],
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              agents: agentCreated ? [{ id: 1, name: "PM", skills: [1] }] : [],
            }),
        };
      })
    );

    render(<Home />);

    const skillForm = within(screen.getByRole("form", { name: "创建 skill" }));
    await user.type(skillForm.getByLabelText("名字"), "需求整理");
    await user.click(skillForm.getByRole("button", { name: /创建 skill/ }));

    const agentForm = await screen.findByRole("form", { name: "创建 Agent" });
    const af = within(agentForm);
    await user.type(af.getByLabelText("名字"), "PM");
    await user.click(af.getByRole("checkbox", { name: "需求整理" }));
    await user.click(af.getByRole("button", { name: /创建 Agent/ }));

    expect(await screen.findByText("PM")).toBeInTheDocument();
    expect(screen.getAllByText(/需求整理/).length).toBeGreaterThan(0);
  });
});
