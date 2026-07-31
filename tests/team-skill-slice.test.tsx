import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RouteModule = {
  GET: () => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
};

type PageModule = {
  default: ComponentType;
};

const routeModules = import.meta.glob<RouteModule>("../app/api/skills/route.ts");
const pageModules = import.meta.glob<PageModule>("../app/team/page.tsx");

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cockpit-team-skill-"));
  process.env.COCKPIT_DB_PATH = join(directory, "cockpit.sqlite");
});

afterEach(() => {
  delete process.env.COCKPIT_DB_PATH;
  vi.unstubAllGlobals();
  rmSync(directory, { force: true, recursive: true });
});

describe("/team skill vertical slice", () => {
  it("creates a text skill through the real API and renders it after reload", async () => {
    const loadRoute = routeModules["../app/api/skills/route.ts"];
    const loadPage = pageModules["../app/team/page.tsx"];

    expect(loadRoute, "the real /api/skills endpoint must exist").toBeTypeOf("function");
    expect(loadPage, "the real /team page must exist").toBeTypeOf("function");

    const route = await loadRoute();
    const { default: TeamPage } = await loadPage();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url !== "/api/skills") throw new Error(`Unexpected request: ${url}`);
      if (init?.method === "POST") {
        return route.POST(new Request("http://localhost/api/skills", init));
      }
      return route.GET();
    });

    const user = userEvent.setup();
    const firstRender = render(<TeamPage />);

    expect(screen.getByRole("link", { name: "工作" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "团队" })).toHaveAttribute("href", "/team");
    expect(await screen.findByText("暂无技能。")).toBeInTheDocument();
    await user.type(screen.getByLabelText("技能名称"), "需求拆解");
    await user.type(screen.getByLabelText("技能说明"), "把目标拆成可验证步骤");
    await user.type(
      screen.getByLabelText("指令正文"),
      "<strong>只作为文本</strong>\n先定义完成标准。",
    );
    await user.click(screen.getByRole("button", { name: "创建技能" }));

    expect(await screen.findByRole("heading", { name: "需求拆解" })).toBeInTheDocument();
    expect(screen.getByText("<strong>只作为文本</strong>")).toBeInTheDocument();
    expect(document.querySelector("strong")).toBeNull();
    expect(existsSync(process.env.COCKPIT_DB_PATH!)).toBe(true);
    const database = new DatabaseSync(process.env.COCKPIT_DB_PATH!);
    expect(
      database.prepare("SELECT name, instructions FROM skills").all(),
    ).toEqual([
      {
        instructions: "<strong>只作为文本</strong>\n先定义完成标准。",
        name: "需求拆解",
      },
    ]);
    database.close();

    firstRender.unmount();
    render(<TeamPage />);

    expect(await screen.findByRole("heading", { name: "需求拆解" })).toBeInTheDocument();
    expect(screen.getByText("把目标拆成可验证步骤")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("<strong>只作为文本</strong>")).toBeInTheDocument(),
    );
  });
});
