import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const startPublicReview = vi.hoisted(() => vi.fn());
vi.mock("@/src/adapters/outbound/sqlite/review-delivery/review-application-service", () => ({
  startPublicReview,
}));

import { POST } from "@/app/api/work-items/[workItemId]/reviews/route";

const MAXIMUM_BYTES = 128 * 1024;
const ROUTE_CONTEXT = {
  params: Promise.resolve({ workItemId: "work-item" }),
};
const LIMIT_ERROR = {
  error: {
    code: "REQUEST_LIMIT_EXCEEDED",
    message: "请求超过既有限制",
  },
};

function exactSizedJson(bytes: number): string {
  const empty = JSON.stringify({ padding: "" });
  return JSON.stringify({ padding: "x".repeat(bytes - empty.length) });
}

function cancelAwareBody(chunks: Uint8Array[]): {
  body: ReadableStream<Uint8Array>;
  wasCanceled(): boolean;
} {
  let canceled = false;
  let index = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }),
    wasCanceled: () => canceled,
  };
}

function request(
  body: BodyInit,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/work-items/work-item/reviews", {
    body,
    duplex: "half",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  } as RequestInit & { duplex: "half" });
}

async function post(body: BodyInit, headers?: Record<string, string>): Promise<Response> {
  return POST(request(body, headers), ROUTE_CONTEXT);
}

describe("POST /api/work-items/:workItemId/reviews request body limit", () => {
  beforeEach(() => {
    startPublicReview.mockReset();
  });

  it("accepts exactly 128 KiB and continues to JSON and schema handling", async () => {
    const input = exactSizedJson(MAXIMUM_BYTES);
    startPublicReview.mockResolvedValueOnce({ accepted: true });

    const response = await post(input, { "content-length": String(MAXIMUM_BYTES) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(startPublicReview).toHaveBeenCalledWith(
      expect.any(String),
      "work-item",
      JSON.parse(input),
    );
  });

  it("rejects boundary plus one, cancels the body, and never enters the application", async () => {
    const encoder = new TextEncoder();
    const streamed = cancelAwareBody([encoder.encode(exactSizedJson(MAXIMUM_BYTES + 1))]);

    const response = await post(streamed.body, {
      "content-length": String(MAXIMUM_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(LIMIT_ERROR);
    expect(streamed.wasCanceled()).toBe(true);
    expect(startPublicReview).not.toHaveBeenCalled();
  });

  it("rejects chunked overflow as soon as the cumulative byte count crosses the limit", async () => {
    const encoder = new TextEncoder();
    const streamed = cancelAwareBody([
      encoder.encode(`{"padding":"${"x".repeat(64 * 1024)}`),
      encoder.encode("x".repeat(64 * 1024)),
      encoder.encode('","unread":"business-input"}'),
    ]);

    const response = await post(streamed.body, { "transfer-encoding": "chunked" });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(LIMIT_ERROR);
    expect(streamed.wasCanceled()).toBe(true);
    expect(startPublicReview).not.toHaveBeenCalled();
  });

  it("counts UTF-8 bytes rather than JavaScript characters for multibyte overflow", async () => {
    const text = JSON.stringify({ padding: "界".repeat(44_000) });
    expect(text.length).toBeLessThan(MAXIMUM_BYTES);
    const bytes = new TextEncoder().encode(text);
    expect(bytes.byteLength).toBeGreaterThan(MAXIMUM_BYTES);
    const streamed = cancelAwareBody([
      bytes.subarray(0, 64 * 1024),
      bytes.subarray(64 * 1024, MAXIMUM_BYTES + 1),
      bytes.subarray(MAXIMUM_BYTES + 1),
    ]);

    const response = await post(streamed.body);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(LIMIT_ERROR);
    expect(streamed.wasCanceled()).toBe(true);
    expect(startPublicReview).not.toHaveBeenCalled();
  });

  it("preserves the existing invalid JSON mapping", async () => {
    const response = await post("{");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_JSON", message: "请求格式无效" },
    });
    expect(startPublicReview).not.toHaveBeenCalled();
  });

  it("preserves the existing strict schema error mapping", async () => {
    startPublicReview.mockRejectedValueOnce(Object.assign(
      new Error("private schema detail"),
      { code: "REVIEW_MATERIAL_INVALID" },
    ));

    const response = await post("{}");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: { code: "REVIEW_MATERIAL_INVALID", message: "公开复核材料无效" },
    });
    expect(startPublicReview).toHaveBeenCalledTimes(1);
  });
});
