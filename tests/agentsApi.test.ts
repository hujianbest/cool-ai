import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/server/agentService", () => ({
  getAgents: vi.fn(),
  createAgent: vi.fn(),
  ValidationError: class ValidationError extends Error {},
}));

import { GET, POST } from "../app/api/agents/route";
import { getAgents, createAgent, ValidationError } from "../src/server/agentService";

const mockedGetAgents = vi.mocked(getAgents);
const mockedCreateAgent = vi.mocked(createAgent);

function agent(id: number, name: string) {
  return {
    id,
    name,
    systemPrompt: "",
    tools: ["shell"],
    providerConfigId: 1,
    model: "glm-4-plus",
    skills: [1],
    createdAt: new Date(),
  };
}

describe("GET /api/agents", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("calls service and returns 200 with agents", async () => {
    mockedGetAgents.mockResolvedValue([agent(1, "骨架 Agent")]);

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

describe("POST /api/agents", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates and returns 201 with agent (tools as array)", async () => {
    mockedCreateAgent.mockResolvedValue(agent(5, "PM"));

    const req = new Request("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "PM", tools: ["shell"], skills: ["requirements"] }),
    });
    const res = await POST(req);

    expect(mockedCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "PM" })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.name).toBe("PM");
    expect(Array.isArray(body.agent.tools)).toBe(true);
  });

  it("returns 400 when name empty", async () => {
    mockedCreateAgent.mockRejectedValue(new ValidationError("name 必填"));

    const req = new Request("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeDefined();
  });

  it("returns 400 when name missing", async () => {
    mockedCreateAgent.mockRejectedValue(new ValidationError("name 必填"));

    const req = new Request("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid JSON body", async () => {
    const req = new Request("http://localhost/api/agents", {
      method: "POST",
      body: "{not json",
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(mockedCreateAgent).not.toHaveBeenCalled();
  });

  it("returns 400 when a referenced skill id is unknown", async () => {
    mockedCreateAgent.mockRejectedValue(new ValidationError("unknown skill id"));

    const req = new Request("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "PM", skills: [9999] }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 when providerConfigId is unknown", async () => {
    mockedCreateAgent.mockRejectedValue(
      new ValidationError("unknown provider config")
    );

    const req = new Request("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "PM", providerConfigId: 9999 }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("returns 500 without leaking stack on non-validation error", async () => {
    mockedCreateAgent.mockRejectedValue(new Error("db down"));

    const req = new Request("http://localhost/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "PM" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(JSON.stringify(body)).not.toMatch(/stack|at \//);
  });
});
