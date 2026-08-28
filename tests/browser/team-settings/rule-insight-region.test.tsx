// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuleInsightRegion } from "@/components/team-settings/rule-insight-region";
import type { RuleInsight } from "@/src/shared/rule-insight-contracts";

const EMPTY_INSIGHT: RuleInsight = {
  agents: [{ id: "agent-a", name: "Alpha", scope: "project_member" }],
  findings: [],
};

const BLOCKED_INSIGHT: RuleInsight = {
  agents: [{ id: "agent-b", name: "Builder", scope: "project_member" }],
  findings: [
    {
      agentId: "agent-b",
      code: "elevate_write",
      conflictGroupId: null,
      excerpt: "…files.",
      id: "agent-b:agent_prompt:agent-b:elevate_write",
      reason: "该指令要求写入或编辑文件，但此 Agent 未获写文件权限。",
      severity: "block",
      sourceId: "agent-b",
      sourceName: "Builder prompt",
      sourceType: "agent_prompt",
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RuleInsightRegion", () => {
  it("covers no-project, loading, empty, retry, error, and blocked findings", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const noProject = render(<RuleInsightRegion returnTo="/" />);
    const noProjectRegion = screen.getByRole("region", {
      name: "规则与注入检查",
    });
    expect(
      within(noProjectRegion).getByText(
        "打开项目后可检查该项目成员的提示与技能。",
      ),
    ).toHaveClass("muted");
    expect(fetchMock).not.toHaveBeenCalled();
    noProject.unmount();

    let resolveEmpty!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveEmpty = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(Response.json(BLOCKED_INSIGHT));

    render(<RuleInsightRegion returnTo="/projects/project-a" />);
    const region = screen.getByRole("region", { name: "规则与注入检查" });
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(
      within(region).getByText("正在检查规则与注入风险…"),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/projects/project-a/rule-insight",
      expect.any(Object),
    );

    await act(async () => {
      resolveEmpty(Response.json(EMPTY_INSIGHT));
    });
    expect(
      await within(region).findByText("未发现规则冲突或注入风险。"),
    ).toBeInTheDocument();
    const emptyRetry = within(region).getByRole("button", { name: "重新检查" });
    expect(emptyRetry).toHaveClass("button-secondary");

    await user.click(emptyRetry);
    const error = await within(region).findByRole("alert");
    expect(error).toHaveTextContent("无法检查规则与注入风险。");
    const errorRetry = within(error).getByRole("button", { name: "重新检查" });
    expect(errorRetry).toHaveClass("button-secondary");

    await user.click(errorRetry);
    const block = await within(region).findByRole("alert");
    expect(within(region).getByRole("heading", { name: "Builder" })).toBeInTheDocument();
    expect(block).toHaveTextContent("elevate_write");
    expect(block).toHaveTextContent("阻断");
    expect(block).toHaveTextContent(
      "该指令要求写入或编辑文件，但此 Agent 未获写文件权限。",
    );
    expect(block).toHaveTextContent("来源：Builder prompt");
    expect(block).toHaveTextContent("…files.");
    expect(within(region).queryByText(/提议|编辑.*prompt/iu)).toBeNull();
  });

  it("fails closed when the API returns a malformed payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ nope: true })),
    );

    render(<RuleInsightRegion returnTo="/projects/project-a" />);

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("无法检查规则与注入风险。");
    expect(
      within(error).getByRole("button", { name: "重新检查" }),
    ).toBeInTheDocument();
  });
});
