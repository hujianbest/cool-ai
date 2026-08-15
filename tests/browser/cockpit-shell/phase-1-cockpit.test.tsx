// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectPanel } from "@/components/project-panel";
import { cockpitFetch } from "@/tests/cockpit-test-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("phase-1 usable cockpit", () => {
  it("opens folders without a path field and hides mission, memory, and HelpTip chrome", async () => {
    vi.stubGlobal(
      "fetch",
      cockpitFetch([
        Response.json({
          projects: [
            {
              createdAt: "2026-07-29T00:00:00.000Z",
              id: "project-1",
              name: "Launch plan",
            },
          ],
        }),
        Response.json({ events: [], tasks: [] }),
      ]),
    );

    render(<ProjectPanel />);

    const cockpit = await screen.findByTestId("collaboration-cockpit");
    expect(within(cockpit).getByRole("button", { name: "打开文件夹" })).toBeInTheDocument();
    expect(within(cockpit).queryByLabelText("文件夹路径")).toBeNull();
    expect(within(cockpit).queryByRole("button", { name: "如何打开项目" })).toBeNull();
    expect(within(cockpit).queryByRole("tab", { name: "共享记忆" })).toBeNull();
    expect(within(cockpit).queryByRole("tab", { name: "使命看板" })).toBeNull();
    expect(within(cockpit).queryByRole("heading", { name: "使命看板" })).toBeNull();
  });
});
