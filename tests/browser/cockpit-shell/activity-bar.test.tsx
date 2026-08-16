// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ActivityBar } from "@/components/activity-bar";

describe("ActivityBar", () => {
  it("renders a navigation landmark labeled 主导航 with at least two links", () => {
    render(<ActivityBar activePath="/" />);

    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(nav).toBeInTheDocument();

    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThanOrEqual(2);
  });

  it("follows the UCD rail: 对话 then governance, then 团队 / 设置 / 主题", () => {
    render(<ActivityBar activePath="/" />);

    const nav = screen.getByRole("navigation", { name: "主导航" });
    const labels = [...nav.querySelectorAll("a, button")]
      .map((node) => node.getAttribute("aria-label"))
      .filter((label): label is string => Boolean(label));
    expect(labels.slice(0, 8)).toEqual([
      "对话",
      "任务",
      "记忆",
      "审批",
      "审计",
      "团队",
      "设置",
      "当前为明色主题，切换到暗色主题",
    ]);
    expect(screen.queryByRole("link", { name: "工作" })).toBeNull();
    expect(screen.queryByRole("link", { name: "首次使用引导" })).toBeNull();
  });

  it("keeps 对话 on the current project when returnTo or activePath is a project", () => {
    const { rerender } = render(
      <ActivityBar activePath="/projects/project-1" />,
    );
    expect(screen.getByRole("link", { name: "对话" })).toHaveAttribute(
      "href",
      "/projects/project-1",
    );

    rerender(
      <ActivityBar activePath="/team" returnTo="/projects/project-1" />,
    );
    expect(screen.getByRole("link", { name: "对话" })).toHaveAttribute(
      "href",
      "/projects/project-1",
    );
    expect(screen.getByRole("link", { name: "对话" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("points 对话 at / and safely structures the 团队 and 设置 URLs", () => {
    render(<ActivityBar activePath="/" />);

    const chat = screen.getByRole("link", { name: "对话" });
    const team = screen.getByRole("link", { name: "团队" });
    const settings = screen.getByRole("link", { name: "设置" });
    expect(chat).toHaveAttribute("href", "/");
    expect(team).toHaveAttribute(
      "href",
      "/team?section=skills&returnTo=%2F",
    );
    expect(settings).toHaveAttribute(
      "href",
      "/team?section=providers&returnTo=%2F",
    );
  });

  it("marks the active route with aria-current=page", () => {
    render(<ActivityBar activePath="/" />);

    const chat = screen.getByRole("link", { name: "对话" });
    const team = screen.getByRole("link", { name: "团队" });
    expect(chat).toHaveAttribute("aria-current", "page");
    expect(team).not.toHaveAttribute("aria-current");
  });

  it("marks 团队 active when activePath is /team", () => {
    render(<ActivityBar activePath="/team" />);

    const team = screen.getByRole("link", { name: "团队" });
    const chat = screen.getByRole("link", { name: "对话" });
    expect(team).toHaveAttribute("aria-current", "page");
    expect(chat).not.toHaveAttribute("aria-current");
  });

  it("exposes a hover tooltip label on every icon-only entry", () => {
    render(<ActivityBar activePath="/" />);

    const chat = screen.getByRole("link", { name: "对话" });
    const team = screen.getByRole("link", { name: "团队" });
    expect(chat).toHaveAttribute("data-tooltip", "对话");
    expect(team).toHaveAttribute("data-tooltip", "团队");
    expect(chat).not.toHaveAttribute("title");
    expect(screen.getByRole("link", { name: "设置" })).toHaveAttribute(
      "data-tooltip",
      "设置",
    );
    expect(screen.getByRole("button", { name: "任务" })).toHaveAttribute(
      "data-tooltip",
      "任务",
    );
    expect(screen.getByRole("button", { name: "记忆" })).toHaveAttribute(
      "data-tooltip",
      "记忆",
    );
  });

  it("renders an inline svg icon per entry using currentColor", () => {
    const { container } = render(<ActivityBar activePath="/" />);

    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThanOrEqual(2);
    svgs.forEach((svg) => {
      expect(
        svg.getAttribute("fill") === "currentColor" ||
          svg.getAttribute("stroke") === "currentColor" ||
          svg.getAttribute("color") === "currentColor",
      ).toBe(true);
    });
  });

  it("is keyboard focusable in nav order", async () => {
    render(<ActivityBar activePath="/" />);
    const user = userEvent.setup();

    const chat = screen.getByRole("link", { name: "对话" });
    chat.focus();
    expect(chat).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "任务" })).toHaveFocus();
  });
});

describe("ActivityBar warm-terracotta rail chrome", () => {
  it("paints the rail with rail tokens and fills the current item with accent", () => {
    const cockpit = readFileSync("app/cockpit.css", "utf8");

    expect(cockpit).toMatch(
      /\.activity-bar\s*\{[^}]*background:\s*var\(--color-rail\)[^}]*color:\s*var\(--color-rail-ink\)/s,
    );
    expect(cockpit).toMatch(
      /\.activity-bar \.activity-bar-item\s*\{[^}]*min-height:\s*var\(--control-min\)[^}]*min-width:\s*var\(--control-min\)[^}]*color:\s*var\(--color-rail-ink\)/s,
    );
    expect(cockpit).toMatch(
      /\.activity-bar \.activity-bar-item\[aria-current="page"\]\s*\{[^}]*color:\s*var\(--interactive-primary\)/s,
    );
    expect(cockpit).toMatch(
      /\.activity-bar \.activity-bar-item::after\s*\{[^}]*content:\s*attr\(data-tooltip\)/s,
    );
    expect(cockpit).toMatch(
      /\.activity-bar \.activity-bar-item:is\(:hover, :focus-visible\)::after\s*\{[^}]*opacity:\s*1[^}]*transition:\s*opacity\s+150ms\s+linear\s+200ms/s,
    );
    expect(cockpit).toMatch(
      /\.activity-bar \.activity-bar-item:is\(\[aria-current="page"\], \[aria-pressed="true"\]\)::before\s*\{[^}]*width:\s*var\(--rail-indicator-width\)[^}]*border-radius:[^}]*var\(--rail-indicator-radius\)[^}]*background:\s*var\(--interactive-primary\)/s,
    );
  });
});
