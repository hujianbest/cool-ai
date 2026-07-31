import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamPanel } from "@/components/team-panel";

function stubMobile() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: true,
      media: "(max-width: 56.25rem)",
      removeEventListener: vi.fn(),
    })),
  );
}

function stubResources() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method) throw new Error(`Unexpected mutation: ${input.toString()}`);
    const payloads: Record<string, unknown> = {
      "/api/agent-templates": { templates: [] },
      "/api/agents": { agents: [] },
      "/api/providers": { providers: [] },
      "/api/skills": { skills: [] },
    };
    const payload = payloads[input.toString()];
    if (!payload) throw new Error(`Unexpected request: ${input.toString()}`);
    return Response.json(payload);
  }));
}

afterEach(() => {
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("narrow Team resource and editor paths", () => {
  it("opens and closes resource navigation as a restoring inert modal", async () => {
    stubMobile();
    stubResources();
    const user = userEvent.setup();
    render(<TeamPanel />);
    const opener = screen.getByRole("button", { name: "打开团队资源" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "团队导航" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("tabpanel", { hidden: true })).toHaveAttribute(
      "inert",
    );
    const close = within(dialog).getByRole("button", { name: "关闭团队资源" });
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  it.each([
    ["模型服务", "创建模型服务", "创建模型服务", "关闭模型服务编辑器"],
    ["技能", "创建新技能", "创建技能", "关闭技能编辑器"],
    ["Agent", "创建 Agent", "创建 Agent", "关闭 Agent 编辑器"],
  ])(
    "opens the %s editor as a focus-restoring modal",
    async (resource, createName, dialogName, closeName) => {
      stubMobile();
      stubResources();
      const user = userEvent.setup();
      render(<TeamPanel />);
      const resources = screen.getByRole("button", { name: "打开团队资源" });
      await user.click(resources);
      await user.click(screen.getByRole("tab", { name: resource }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "团队导航" })).not.toBeInTheDocument(),
      );

      const opener = await screen.findByRole("button", { name: createName });
      await user.click(opener);
      const editor = screen.getByRole("dialog", { name: dialogName });
      expect(editor).toHaveAttribute("aria-modal", "true");
      expect(screen.getByRole("tabpanel", { hidden: true })).toHaveAttribute(
        "inert",
      );
      const close = within(editor).getByRole("button", { name: closeName });
      expect(close).toHaveFocus();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(opener).toHaveFocus();
      expect(document.body.style.overflow).toBe("");
    },
  );
});
