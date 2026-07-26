// @vitest-environment jsdom
import "./component-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillForm } from "../components/SkillForm";

describe("SkillForm", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders labeled inputs", () => {
    render(<SkillForm onCreated={() => {}} />);
    expect(screen.getByLabelText("名字")).toBeInTheDocument();
    expect(screen.getByLabelText("描述")).toBeInTheDocument();
    expect(screen.getByLabelText("内容")).toBeInTheDocument();
    expect(screen.getByLabelText("分类")).toBeInTheDocument();
  });

  it("blocks submit on empty name (no fetch)", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<SkillForm onCreated={() => {}} />);

    await user.click(screen.getByRole("button", { name: /创建 skill/ }));

    expect(screen.getByRole("alert")).toHaveTextContent("必填");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits and calls onCreated on success", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ skill: { id: 1, name: "需求整理" } }),
      })
    );
    render(<SkillForm onCreated={onCreated} />);

    await user.type(screen.getByLabelText("名字"), "需求整理");
    await user.click(screen.getByRole("button", { name: /创建 skill/ }));

    expect(await screen.findByRole("button", { name: /创建 skill/ })).toBeEnabled();
    expect(onCreated).toHaveBeenCalled();
  });
});
