import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState, type ComponentType, type ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as reviewComponents from "@/components/review/review-slice";

type SurfaceKey = "review" | "answer" | "memory" | "delivery";
type SurfaceState = {
  kind: "disabled" | "empty" | "error" | "loading" | "ready" | "success";
  message: string;
};
type ReviewAccessSurfaceProps = {
  initialSurface?: SurfaceKey;
  sections: Record<SurfaceKey, ReactNode>;
  states?: Partial<Record<SurfaceKey, SurfaceState>>;
  title: string;
};

const optionalComponents = reviewComponents as typeof reviewComponents & {
  ReviewAccessSurface?: ComponentType<ReviewAccessSurfaceProps>;
};

function ReviewAccessSurface(props: ReviewAccessSurfaceProps) {
  const Component = optionalComponents.ReviewAccessSurface;
  expect(Component, "T-23 accessible review surface must exist").toBeTypeOf("function");
  return <Component {...props} />;
}

function stubNarrowMode(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({
    addEventListener: vi.fn(),
    matches,
    media: "(max-width: var(--breakpoint-cockpit))",
    onchange: null,
    removeEventListener: vi.fn(),
  })));
}

function KeyboardJourney() {
  const [done, setDone] = useState<string[]>([]);
  const action = (name: SurfaceKey, label: string) => (
    <button onClick={() => setDone((current) => [...current, name])} type="button">
      {label}
    </button>
  );
  return (
    <>
      <ReviewAccessSurface
        sections={{
          answer: action("answer", "提交回答"),
          delivery: action("delivery", "生成交付"),
          memory: action("memory", "保存记忆"),
          review: action("review", "发起复核"),
        }}
        title="复核闭环"
      />
      <output aria-label="已完成步骤">{done.join(",")}</output>
    </>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("review accessibility and responsive single surface", () => {
  it("completes review, answer, memory and delivery with keyboard on desktop", async () => {
    stubNarrowMode(false);
    const user = userEvent.setup();
    render(<KeyboardJourney />);

    const tabs = screen.getByRole("tablist", { name: "复核闭环导航" });
    const reviewTab = within(tabs).getByRole("tab", { name: "复核" });
    reviewTab.focus();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.keyboard("{Enter}");

    await user.keyboard("{Shift>}{Tab}{/Shift}{ArrowRight}");
    expect(within(tabs).getByRole("tab", { name: "回答" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.keyboard("{Enter}");

    await user.keyboard("{Shift>}{Tab}{/Shift}{ArrowRight}{Enter}");
    await user.tab();
    await user.keyboard("{Enter}");
    await user.keyboard("{Shift>}{Tab}{/Shift}{ArrowRight}{Enter}");
    await user.tab();
    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("已完成步骤")).toHaveTextContent(
      "review,answer,memory,delivery",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses one narrow modal with inert background, trap, Escape and focus restore", async () => {
    stubNarrowMode(true);
    const user = userEvent.setup();
    render(<KeyboardJourney />);

    const opener = screen.getByRole("button", { name: "打开复核" });
    opener.focus();
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog", { name: "复核闭环" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("review-access-background")).toHaveAttribute("inert");
    const close = within(dialog).getByRole("button", { name: "关闭复核闭环" });
    expect(close).toHaveFocus();

    close.focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(within(dialog).getByRole("button", { name: "发起复核" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(screen.getByTestId("review-access-background")).not.toHaveAttribute("inert");
  });

  it("completes narrow review, answer, memory and delivery in one keyboard-owned modal", async () => {
    stubNarrowMode(true);
    const user = userEvent.setup();
    render(<KeyboardJourney />);

    screen.getByRole("button", { name: "打开复核" }).focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "复核闭环" });
    const navigation = within(dialog).getByRole("tablist", { name: "复核闭环导航" });
    await user.tab();
    expect(within(navigation).getByRole("tab", { name: "复核" })).toHaveFocus();

    for (const [tab, action] of [
      ["复核", "发起复核"],
      ["回答", "提交回答"],
      ["记忆", "保存记忆"],
      ["交付", "生成交付"],
    ] as const) {
      expect(within(navigation).getByRole("tab", { name: tab })).toHaveFocus();
      await user.keyboard("{Enter}");
      await user.tab();
      expect(within(dialog).getByRole("button", { name: action })).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      await user.keyboard("{Shift>}{Tab}{/Shift}");
      if (tab !== "交付") await user.keyboard("{ArrowRight}");
    }
    expect(screen.getByLabelText("已完成步骤")).toHaveTextContent(
      "review,answer,memory,delivery",
    );
  });

  it("exposes loading, empty, error, disabled and success as text and live semantics", () => {
    stubNarrowMode(false);
    const { rerender } = render(
      <ReviewAccessSurface
        initialSurface="review"
        sections={{
          answer: <button type="button">回答动作</button>,
          delivery: <button type="button">交付动作</button>,
          memory: <button type="button">记忆动作</button>,
          review: <button type="button">复核动作</button>,
        }}
        states={{
          answer: { kind: "empty", message: "尚无待回答问题" },
          delivery: { kind: "success", message: "最终交付已生成" },
          memory: { kind: "error", message: "记忆加载失败" },
          review: { kind: "loading", message: "正在加载复核" },
        }}
        title="状态检查"
      />,
    );

    const loadingPanel = screen.getByRole("tabpanel", { name: "复核" });
    expect(loadingPanel).toHaveAttribute("aria-busy", "true");
    expect(within(loadingPanel).getByText("正在加载复核")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "回答" })).toHaveAccessibleDescription(
      "尚无待回答问题",
    );
    expect(screen.getByRole("tab", { name: "记忆" })).toHaveAccessibleDescription(
      "记忆加载失败",
    );
    expect(screen.getByRole("status")).toHaveTextContent("最终交付已生成");
    expect(screen.getByText("状态：loading")).toBeInTheDocument();

    rerender(
      <ReviewAccessSurface
        sections={{
          answer: <button type="button">回答动作</button>,
          delivery: <button type="button">交付动作</button>,
          memory: <button type="button">记忆动作</button>,
          review: <button type="button">复核动作</button>,
        }}
        states={{
          review: { kind: "disabled", message: "当前结果版本已失效" },
        }}
        title="状态检查"
      />,
    );
    const disabled = screen.getByRole("tab", { name: "复核" });
    expect(disabled).toHaveAttribute("aria-disabled", "true");
    expect(disabled).toHaveAccessibleDescription("当前结果版本已失效");
  });

  it("uses 44px token targets, AA palette pairs and token-only surface styles", () => {
    const tokens = readFileSync(resolve("app/tokens.css"), "utf8");
    const cockpit = readFileSync(resolve("app/cockpit.css"), "utf8");
    const component = readFileSync(
      resolve("components/review/review-access-surface.tsx"),
      "utf8",
    );

    expect(tokens).toMatch(/--control-min:\s*2\.75rem/);
    expect(cockpit).toMatch(
      /\.review-access-surface[\s\S]*?min-height:\s*var\(--control-min\)/,
    );
    expect(cockpit).toMatch(
      /\.review-access-state[\s\S]*?color:\s*var\(--text(?:-muted)?\)/,
    );
    expect(component).not.toMatch(/#[0-9a-f]{3,8}|style=\{\{[^}]*\d/iu);

    const colors = Object.fromEntries(
      [...tokens.matchAll(/--([\w-]+):\s*(#[0-9A-F]{6})/g)]
        .map((match) => [match[1], match[2]]),
    );
    const luminance = (hex: string) => {
      const channels = [1, 3, 5].map((index) =>
        Number.parseInt(hex.slice(index, index + 2), 16) / 255)
        .map((value) =>
          value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (foreground: string, background: string) => {
      const values = [luminance(foreground), luminance(background)].sort(
        (left, right) => right - left,
      );
      return (values[0] + 0.05) / (values[1] + 0.05);
    };

    expect(
      contrast(colors["text-primary"], colors["surface-card"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(colors["text-subtle"], colors["surface-card"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(colors["interactive-primary"], colors["surface-card"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(colors.danger, colors["surface-card"]),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
