import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  getPolicyProcessOutput: vi.fn(),
  listExecutionPolicyCommands: vi.fn(),
  startPolicyProcessSession: vi.fn(),
}));

vi.mock("@/src/composition", () => ({
  policyProcessReconciliation: {
    ensurePolicyProcessesReconciled: vi.fn(),
  },
  policyProcessService: services,
}));

describe("policy process API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.listExecutionPolicyCommands.mockReturnValue({
      commands: [],
      currentProcess: null,
      executionId: "execution",
      executionVersion: 3,
      policyRevisionId: "revision",
      projectId: "project",
    });
    services.startPolicyProcessSession.mockResolvedValue({
      id: "process",
      previewUrl: null,
      status: "running",
    });
  });

  it("returns the frozen safe catalog and validates exact start input strictly", async () => {
    const catalogRoute = await import(
      "@/app/api/executions/[executionId]/policy-commands/route"
    );
    const processRoute = await import(
      "@/app/api/executions/[executionId]/policy-processes/route"
    );
    const context = { params: Promise.resolve({ executionId: "execution" }) };
    const catalog = await catalogRoute.GET(new Request("http://localhost"), context);
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({
      commands: [],
      policyRevisionId: "revision",
    });

    const invalid = await processRoute.POST(new Request("http://localhost", {
      body: JSON.stringify({
        entryId: "entry",
        expectedExecutionVersion: 3,
        operationId: "10000000-0000-4000-8000-000000000001",
        url: "https://example.invalid",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), context);
    expect(invalid.status).toBe(400);
    expect(services.startPolicyProcessSession).not.toHaveBeenCalled();

    const started = await processRoute.POST(new Request("http://localhost", {
      body: JSON.stringify({
        entryId: "entry",
        expectedExecutionVersion: 3,
        operationId: "10000000-0000-4000-8000-000000000001",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), context);
    expect(started.status).toBe(201);
    expect(services.startPolicyProcessSession).toHaveBeenCalledWith(
      expect.any(String),
      "execution",
      {
        entryId: "entry",
        expectedExecutionVersion: 3,
        operationId: "10000000-0000-4000-8000-000000000001",
      },
    );
  });

  it("rejects arbitrary output query keys before reading output", async () => {
    const outputRoute = await import(
      "@/app/api/executions/[executionId]/policy-processes/[processId]/output/route"
    );
    const response = await outputRoute.GET(
      new Request("http://localhost?stdoutCursor=0&url=http://evil.invalid"),
      { params: Promise.resolve({ executionId: "execution", processId: "process" }) },
    );
    expect(response.status).toBe(400);
    expect(services.getPolicyProcessOutput).not.toHaveBeenCalled();
  });
});
