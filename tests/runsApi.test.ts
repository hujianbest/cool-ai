import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/server/agentService", () => ({
  ValidationError: class ValidationError extends Error {},
}));
vi.mock("../src/server/agentRunner", () => ({
  runAgent: vi.fn(),
  NotFoundError: class NotFoundError extends Error {},
  UpstreamError: class UpstreamError extends Error {},
}));

import { POST } from "../app/api/agents/[id]/run/route";
import { runAgent, NotFoundError, UpstreamError } from "../src/server/agentRunner";
import { ValidationError } from "../src/server/agentService";

const mockedRunAgent = vi.mocked(runAgent);

function req(task: string) {
  return new Request("http://localhost/api/agents/1/run", {
    method: "POST",
    body: JSON.stringify({ task }),
  });
}

function ctx(id = "1") {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/agents/:id/run", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 200 with output + trace, no apiKey in body", async () => {
    mockedRunAgent.mockResolvedValue({
      output: "回答",
      trace: [
        { role: "system", content: "s" },
        { role: "user", content: "你好" },
        { role: "assistant", content: "回答" },
      ],
    });

    const res = await POST(req("你好"), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.output).toBe("回答");
    expect(body.trace).toHaveLength(3);
    expect(JSON.stringify(body)).not.toMatch(/apiKey/i);
  });

  it("returns 404 when agent not found", async () => {
    mockedRunAgent.mockRejectedValue(new NotFoundError("agent not found"));
    const res = await POST(req("x"), ctx());
    expect(res.status).toBe(404);
  });

  it("returns 400 when agent has no provider", async () => {
    mockedRunAgent.mockRejectedValue(new ValidationError("agent has no provider config"));
    const res = await POST(req("x"), ctx());
    expect(res.status).toBe(400);
  });

  it("returns 502 with exactly {error} on upstream failure (no passthrough, no apiKey)", async () => {
    mockedRunAgent.mockRejectedValue(new UpstreamError("upstream 500"));
    const res = await POST(req("x"), ctx());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: "upstream error" });
    expect(JSON.stringify(body)).not.toMatch(/apiKey|upstream 500/i);
  });
});
