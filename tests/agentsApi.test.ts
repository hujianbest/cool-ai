import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/server/agentService", () => ({
  getAgents: vi.fn(),
}));

import { GET } from "../app/api/agents/route";
import { getAgents } from "../src/server/agentService";

const mockedGetAgents = vi.mocked(getAgents);

describe("GET /api/agents", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("calls service and returns 200 with agents", async () => {
    mockedGetAgents.mockResolvedValue([
      { id: 1, name: "骨架 Agent", role: "占位角色", createdAt: new Date() },
    ]);

    const res = await GET(new Request("http://localhost/api/agents"));

    expect(mockedGetAgents).toHaveBeenCalled();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe("骨架 Agent");
  });

  it("returns 200 with empty array when no agents", async () => {
    mockedGetAgents.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/agents"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [] });
  });

  it("returns 500 without leaking stack when service throws", async () => {
    mockedGetAgents.mockRejectedValue(new Error("db down"));

    const res = await GET(new Request("http://localhost/api/agents"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(JSON.stringify(body)).not.toMatch(/stack|at \//);
  });
});
