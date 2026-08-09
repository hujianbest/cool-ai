// @vitest-environment jsdom
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

  it("renders 工作 and 团队 entries", () => {
    render(<ActivityBar activePath="/" />);

    expect(screen.getByRole("link", { name: /工作/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /团队/ })).toBeInTheDocument();
  });

  it("points 工作 at / and safely structures the 团队 settings URL", () => {
    render(<ActivityBar activePath="/" />);

    const work = screen.getByRole("link", { name: /工作/ });
    const team = screen.getByRole("link", { name: /团队/ });
    expect(work).toHaveAttribute("href", "/");
    expect(team).toHaveAttribute(
      "href",
      "/team?section=skills&returnTo=%2F",
    );
  });

  it("marks the active route with aria-current=page", () => {
    render(<ActivityBar activePath="/" />);

    const work = screen.getByRole("link", { name: /工作/ });
    const team = screen.getByRole("link", { name: /团队/ });
    expect(work).toHaveAttribute("aria-current", "page");
    expect(team).not.toHaveAttribute("aria-current");
  });

  it("marks 团队 active when activePath is /team", () => {
    render(<ActivityBar activePath="/team" />);

    const team = screen.getByRole("link", { name: /团队/ });
    const work = screen.getByRole("link", { name: /工作/ });
    expect(team).toHaveAttribute("aria-current", "page");
    expect(work).not.toHaveAttribute("aria-current");
  });

  it("exposes a tooltip via title on every entry", () => {
    render(<ActivityBar activePath="/" />);

    const work = screen.getByRole("link", { name: /工作/ });
    const team = screen.getByRole("link", { name: /团队/ });
    expect(work).toHaveAttribute("title", "工作");
    expect(team).toHaveAttribute("title", "团队");
  });

  it("renders an inline svg icon per entry using currentColor", () => {
    const { container } = render(<ActivityBar activePath="/" />);

    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThanOrEqual(2);
    svgs.forEach((svg) => {
      expect(svg).toHaveAttribute("stroke", "currentColor");
    });
  });

  it("is keyboard focusable in nav order", async () => {
    render(<ActivityBar activePath="/" />);
    const user = userEvent.setup();

    const work = screen.getByRole("link", { name: /工作/ });
    work.focus();
    expect(work).toHaveFocus();

    await user.tab();
    const team = screen.getByRole("link", { name: /团队/ });
    expect(team).toHaveFocus();
  });
});
