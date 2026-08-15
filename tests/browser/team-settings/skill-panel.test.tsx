// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamPanel } from "@/components/team-panel";

function skill(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: "2026-07-29T00:00:00.000Z",
    description: "Notes",
    id: "skill-1",
    instructions: "<strong>literal text</strong>",
    name: "Planning",
    updatedAt: "2026-07-29T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Skill panel", () => {
  it("shows loading, focused error, retry and empty states", async () => {
    const firstLoad = deferred<Response>();
    let gets = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString() !== "/api/skills" || init?.method) {
        throw new Error(`Unexpected request: ${input.toString()}`);
      }
      gets += 1;
      return gets === 1
        ? firstLoad.promise
        : Promise.resolve(Response.json({ skills: [] }));
    }));
    const user = userEvent.setup();
    render(<TeamPanel />);

    expect(screen.getByText("正在加载技能…")).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      firstLoad.resolve(
        Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "raw detail" } },
          { status: 503 },
        ),
      );
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("暂时无法加载技能，请稍后重试。");
    expect(alert).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "重试加载技能" }));
    expect(await screen.findByText("暂无技能。")).toBeInTheDocument();
  });

  it("edits with full replacement, pure-text rendering and success focus", async () => {
    let current = skill();
    let patchBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/skills" && !init?.method) {
        return Response.json({ skills: [current] });
      }
      if (url === "/api/skills/skill-1" && init?.method === "PATCH") {
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        current = skill({ ...patchBody, version: 2 });
        return Response.json({ skill: current });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<TeamPanel />);

    expect(await screen.findByText("<strong>literal text</strong>")).toBeInTheDocument();
    expect(document.querySelector("strong")).toBeNull();
    await user.click(screen.getByRole("button", { name: "编辑 Planning" }));
    expect(screen.getByLabelText("技能名称")).toHaveValue("Planning");
    expect(screen.getByLabelText("技能说明")).toHaveValue("Notes");
    expect(screen.getByLabelText("指令正文")).toHaveValue(
      "<strong>literal text</strong>",
    );
    await user.clear(screen.getByLabelText("技能名称"));
    await user.type(screen.getByLabelText("技能名称"), "Reviewer");
    await user.clear(screen.getByLabelText("技能说明"));
    await user.type(screen.getByLabelText("技能说明"), "Updated");
    await user.clear(screen.getByLabelText("指令正文"));
    await user.type(screen.getByLabelText("指令正文"), "<em>still text</em>");
    await user.click(screen.getByRole("button", { name: "保存技能" }));

    expect(patchBody).toEqual({
      description: "Updated",
      expectedVersion: 1,
      instructions: "<em>still text</em>",
      name: "Reviewer",
    });
    const heading = await screen.findByRole("heading", { name: "Reviewer" });
    expect(heading).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("技能已保存。");
    expect(screen.getByText("<em>still text</em>")).toBeInTheDocument();
    expect(document.querySelector("em")).toBeNull();
  });

  it("preserves a failed draft and supports a keyboard-only create path", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/skills" && !init?.method) {
        return Response.json({ skills: [] });
      }
      if (url === "/api/skills" && init?.method === "POST") {
        return Response.json(
          { error: { code: "INTERNAL_ERROR", message: "raw detail" } },
          { status: 500 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<TeamPanel />);
    await screen.findByText("暂无技能。");

    await user.click(screen.getByRole("button", { name: "创建新技能" }));
    expect(screen.getByLabelText("技能名称")).toHaveFocus();
    await user.type(screen.getByLabelText("技能名称"), "Builder", { skipClick: true });
    await user.tab();
    expect(screen.getByLabelText("技能说明")).toHaveFocus();
    await user.type(screen.getByLabelText("技能说明"), "Draft notes", { skipClick: true });
    await user.tab();
    expect(screen.getByLabelText("指令正文")).toHaveFocus();
    await user.type(screen.getByLabelText("指令正文"), "Draft instructions", { skipClick: true });
    screen.getByRole("button", { name: "创建技能" }).focus();
    expect(screen.getByRole("button", { name: "创建技能" })).toHaveFocus();
    await user.keyboard("{Enter}");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法保存技能，请稍后重试。");
    expect(alert).toHaveFocus();
    expect(screen.getByLabelText("技能名称")).toHaveValue("Builder");
    expect(screen.getByLabelText("技能说明")).toHaveValue("Draft notes");
    expect(screen.getByLabelText("指令正文")).toHaveValue("Draft instructions");
  });
});
