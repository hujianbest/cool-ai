// @vitest-environment jsdom
import "./component-utils";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderList } from "../components/ProviderList";
import type { ProviderConfigDTO } from "../src/server/providerService";

const configs: ProviderConfigDTO[] = [
  { id: 1, name: "P", baseUrl: "https://x/v4", createdAt: new Date(), agentCount: 2 },
];

describe("ProviderList (presentational)", () => {
  it("loading state", () => {
    render(<ProviderList status="loading" configs={[]} onRetry={() => {}} />);
    expect(screen.getByText(/加载中/)).toBeInTheDocument();
  });

  it("empty state", () => {
    render(<ProviderList status="empty" configs={[]} onRetry={() => {}} />);
    expect(screen.getByText(/暂无 provider/)).toBeInTheDocument();
  });

  it("error state with retry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ProviderList status="error" configs={[]} onRetry={onRetry} />);
    expect(screen.getByText(/加载失败/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("success renders name + agentCount, and never shows apiKey", () => {
    render(<ProviderList status="success" configs={configs} onRetry={() => {}} />);
    expect(screen.getByText("P")).toBeInTheDocument();
    expect(screen.getByText(/被 2 个 agent 关联/)).toBeInTheDocument();
    expect(screen.queryByText(/secret|apiKey/i)).not.toBeInTheDocument();
  });
});
