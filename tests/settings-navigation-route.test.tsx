import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import TeamPage from "@/app/team/page";
import { TeamPanel } from "@/components/team-panel";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function stubResources() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const payloads: Record<string, unknown> = {
        "/api/agent-templates": { templates: [] },
        "/api/agents": { agents: [] },
        "/api/providers": { providers: [] },
        "/api/skills": { skills: [] },
      };
      const payload = payloads[input.toString()];
      if (!payload) throw new Error(`Unexpected request: ${input.toString()}`);
      return Response.json(payload);
    }),
  );
}

function stubNarrow(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches,
      media: "(max-width: 56.25rem)",
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  document.body.style.overflow = "";
  pushMock.mockReset();
  vi.unstubAllGlobals();
});

describe("settings URL route", () => {
  it("normalizes server parameters before passing them to TeamPanel", async () => {
    const valid = await TeamPage({
      searchParams: Promise.resolve({
        returnTo: "/projects/Project_1",
        section: "providers",
      }),
    });
    expect(valid.props).toMatchObject({
      returnTo: "/projects/Project_1",
      section: "providers",
    });

    const invalid = await TeamPage({
      searchParams: Promise.resolve({
        returnTo: ["https://example.com", "/projects/project-1"],
        section: ["agents", "providers"],
      }),
    });
    expect(invalid.props).toMatchObject({
      returnTo: "/",
      section: "skills",
    });
  });

  it("derives selection from props, pushes a structured URL, and follows new props", async () => {
    stubResources();
    stubNarrow(false);
    const user = userEvent.setup();
    const view = render(
      <TeamPanel returnTo="/projects/project-1" section="providers" />,
    );

    expect(screen.getByRole("tab", { name: "模型服务" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("link", { name: "返回原位置" })).toHaveAttribute(
      "href",
      "/projects/project-1",
    );

    await user.click(screen.getByRole("tab", { name: "Agent" }));
    expect(pushMock).toHaveBeenCalledWith(
      "/team?section=agents&returnTo=%2Fprojects%2Fproject-1",
    );
    expect(screen.getByRole("tab", { name: "模型服务" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    view.rerender(
      <TeamPanel returnTo="/projects/project-1" section="agents" />,
    );
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    view.rerender(
      <TeamPanel returnTo="/projects/project-1" section="skills" />,
    );
    expect(screen.getByRole("tab", { name: "技能" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("restores the narrow navigation trigger after Escape, close, and return", async () => {
    stubResources();
    stubNarrow(true);
    const user = userEvent.setup();
    render(<TeamPanel returnTo="/" section="skills" />);

    const opener = screen.getByRole("button", { name: "打开团队资源" });
    await user.click(opener);
    let dialog = screen.getByRole("dialog", { name: "团队导航" });
    let close = within(dialog).getByRole("button", {
      name: "关闭团队资源",
    });

    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();

    await user.click(opener);
    dialog = screen.getByRole("dialog", { name: "团队导航" });
    close = within(dialog).getByRole("button", { name: "关闭团队资源" });
    await user.click(close);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();

    await user.click(opener);
    dialog = screen.getByRole("dialog", { name: "团队导航" });
    const back = within(dialog).getByRole("link", { name: "返回原位置" });
    expect(back).toHaveAttribute("href", "/");
    back.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await user.click(back);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();
  });

  it("searches only normalized static section metadata and clears back to all results", async () => {
    stubResources();
    stubNarrow(false);
    const user = userEvent.setup();
    render(<TeamPanel returnTo="/" section="skills" />);

    const search = screen.getByRole("searchbox", { name: "搜索设置分区" });
    expect(screen.getAllByRole("button", { name: /打开.+设置/ })).toHaveLength(3);

    await user.type(search, "  MODEL  ");
    expect(screen.getByRole("button", { name: "打开模型服务设置" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开技能设置" })).toBeNull();
    expect(screen.queryByRole("button", { name: "打开 Agent 设置" })).toBeNull();

    await user.clear(search);
    await user.type(search, "  管理   aGeNt  ");
    expect(screen.getByRole("button", { name: "打开 Agent 设置" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开模型服务设置" })).toBeNull();

    await user.clear(search);
    await user.type(search, "sk-live-entity-secret");
    expect(screen.getByText("没有匹配的设置分区。")).toBeInTheDocument();
    const clear = screen.getByRole("button", { name: "清除检索" });
    await user.click(clear);

    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(screen.getAllByRole("button", { name: /打开.+设置/ })).toHaveLength(3);
  });

  it.each([false, true])(
    "opens a search result and focuses its routed panel title (narrow=%s)",
    async (narrow) => {
    stubResources();
    stubNarrow(narrow);
    const user = userEvent.setup();
    const view = render(
      <TeamPanel returnTo="/projects/project-1" section="skills" />,
    );

    if (narrow) {
      await user.click(screen.getByRole("button", { name: "打开团队资源" }));
    }
    const navigation = narrow
      ? screen.getByRole("dialog", { name: "团队导航" })
      : screen.getByRole("complementary", { name: "团队导航" });
    await user.type(
      within(navigation).getByRole("searchbox", { name: "搜索设置分区" }),
      "provider",
    );
    await user.click(
      within(navigation).getByRole("button", { name: "打开模型服务设置" }),
    );

    expect(pushMock).toHaveBeenCalledWith(
      "/team?section=providers&returnTo=%2Fprojects%2Fproject-1",
    );
    if (narrow) {
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }

    view.rerender(
      <TeamPanel returnTo="/projects/project-1" section="providers" />,
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "模型服务", level: 2 })).toHaveFocus(),
    );
    },
  );
});
