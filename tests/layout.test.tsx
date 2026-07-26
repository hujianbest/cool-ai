// @vitest-environment jsdom
import "./component-utils";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "../app/page";

describe("home layout", () => {
  it("renders aside and main landmarks", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<Home />);
    expect(screen.getByRole("complementary")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });
});
