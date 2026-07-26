// @vitest-environment jsdom
import "./component-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderForm } from "../components/ProviderForm";

describe("ProviderForm", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders labeled inputs; apiKey is type=password", () => {
    render(<ProviderForm onCreated={() => {}} />);
    expect(screen.getByLabelText("名字")).toBeInTheDocument();
    expect(screen.getByLabelText("base URL")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
  });

  it("blocks submit on empty name (no fetch)", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<ProviderForm onCreated={() => {}} />);

    await user.click(screen.getByRole("button", { name: /创建 provider/ }));

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
        json: () => Promise.resolve({ config: { id: 1 } }),
      })
    );
    render(<ProviderForm onCreated={onCreated} />);

    await user.type(screen.getByLabelText("名字"), "P");
    await user.type(screen.getByLabelText("base URL"), "https://x/v4");
    await user.click(screen.getByRole("button", { name: /创建 provider/ }));

    expect(await screen.findByRole("button", { name: /创建 provider/ })).toBeEnabled();
    expect(onCreated).toHaveBeenCalled();
  });
});
