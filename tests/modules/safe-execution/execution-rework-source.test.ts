import { describe, expect, it, vi } from "vitest";

import { createReworkExecution } from "@/components/review/review-product-surface";

describe("execution rework source tuple", () => {
  it("reuses the frozen result tuple after a newer collaboration run appears", async () => {
    const source = {
      projectId: "project",
      runId: "selected-planned-run",
      threadId: "selected-thread",
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("/api/projects/project/executions");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        source,
        workItemId: "work",
      });
      return Response.json({ execution: { id: "rework-execution" } }, { status: 201 });
    });

    await expect(
      createReworkExecution("project", "work", source, fetcher),
    ).resolves.toEqual({ executionId: "rework-execution" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects a cross-project frozen tuple before any request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createReworkExecution("project", "work", {
      projectId: "other-project",
      runId: "run",
      threadId: "thread",
    }, fetcher)).rejects.toThrow("来源协作运行不可用");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
