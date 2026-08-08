import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const themeState = vi.hoisted(() => ({
  snapshot: {
    hydrated: true,
    theme: "light" as "light" | "dark",
    error: null as "read" | "invalid" | "write" | null,
  },
}));

vi.mock("@/components/theme-preference-store", () => ({
  setThemePreference: vi.fn(),
  useThemePreference: () => themeState.snapshot,
}));

import { ActivityBar } from "@/components/activity-bar";

beforeEach(() => {
  themeState.snapshot = {
    hydrated: true,
    theme: "light",
    error: null,
  };
});

describe("ActivityBar theme status announcements", () => {
  it.each([
    ["read", "主题偏好读取失败，已使用明色主题"],
    ["invalid", "主题偏好数据无效，已使用明色主题"],
    ["write", "主题偏好保存失败，仍保持当前主题"],
  ] as const)("announces a non-blocking %s failure", (error, message) => {
    themeState.snapshot = {
      hydrated: true,
      theme: "light",
      error,
    };

    render(<ActivityBar activePath="/" />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(message);
    expect(status).toHaveClass("activity-bar-status");
    expect(
      screen.getByRole("button", {
        name: "当前为明色主题，切换到暗色主题",
      }),
    ).toBeEnabled();
  });
});
