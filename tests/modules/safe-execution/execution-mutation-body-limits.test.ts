import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as postAdvance } from "@/app/api/executions/[executionId]/advance/route";
import { POST as postApproval } from "@/app/api/executions/[executionId]/approvals/[approvalId]/route";
import { POST as postControl } from "@/app/api/executions/[executionId]/control/route";
import { POST as postMerge } from "@/app/api/executions/[executionId]/merge/route";
import { POST as postRecoveryResolve } from "@/app/api/executions/[executionId]/recovery/resolve/route";
import { POST as postStart } from "@/app/api/projects/[projectId]/executions/route";
import { PUT as putValidationPolicy } from "@/app/api/projects/[projectId]/validation-policy/route";

const MAXIMUM_BYTES = 128 * 1024;
const OVERSIZED_ERROR = {
  error: {
    code: "INVALID_INPUT",
    message: "Request body exceeds its limit.",
  },
};

type MutationRoute = {
  invoke(request: Request): Promise<Response>;
  name: string;
  schemaMessage: string;
};

const routes: MutationRoute[] = [
  {
    invoke: (request) => postStart(request, {
      params: Promise.resolve({ projectId: "missing-project" }),
    }),
    name: "start",
    schemaMessage: "Execution input is invalid.",
  },
  {
    invoke: (request) => postAdvance(request, {
      params: Promise.resolve({ executionId: "missing-execution" }),
    }),
    name: "advance",
    schemaMessage: "Advance input is invalid.",
  },
  {
    invoke: (request) => postControl(request, {
      params: Promise.resolve({ executionId: "missing-execution" }),
    }),
    name: "control",
    schemaMessage: "Execution control input is invalid.",
  },
  {
    invoke: (request) => postApproval(request, {
      params: Promise.resolve({
        approvalId: "missing-approval",
        executionId: "missing-execution",
      }),
    }),
    name: "approval",
    schemaMessage: "Approval input is invalid.",
  },
  {
    invoke: (request) => postRecoveryResolve(request, {
      params: Promise.resolve({ executionId: "missing-execution" }),
    }),
    name: "recovery resolve",
    schemaMessage: "Manual recovery input is invalid.",
  },
  {
    invoke: (request) => putValidationPolicy(request, {
      params: Promise.resolve({ projectId: "missing-project" }),
    }),
    name: "validation policy",
    schemaMessage: "Validation policy input is invalid.",
  },
  {
    invoke: (request) => postMerge(request, {
      params: Promise.resolve({ executionId: "missing-execution" }),
    }),
    name: "merge",
    schemaMessage: "Merge input is invalid.",
  },
];

function sizedJsonString(bytes: number): string {
  return `"${"x".repeat(bytes - 2)}"`;
}

function requestWithBody(
  body: BodyInit,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/execution-mutation", {
    body,
    duplex: "half",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  } as RequestInit & { duplex: "half" });
}

function cancelAwareStreamedBody(chunks: Uint8Array[]): {
  body: ReadableStream<Uint8Array>;
  wasCanceled(): boolean;
} {
  let index = 0;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
  });
  return { body, wasCanceled: () => canceled };
}

describe("S-5 execution mutation request body boundary", () => {
  for (const route of routes) {
    it(`${route.name} accepts Content-Length one byte below 128 KiB for schema validation`, async () => {
      const body = sizedJsonString(MAXIMUM_BYTES - 1);
      const response = await route.invoke(requestWithBody(body, {
        "content-length": String(MAXIMUM_BYTES - 1),
      }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "INVALID_INPUT", message: route.schemaMessage },
      });
    });

    it(`${route.name} rejects Content-Length one byte above 128 KiB before schema validation`, async () => {
      const body = sizedJsonString(MAXIMUM_BYTES + 1);
      const response = await route.invoke(requestWithBody(body, {
        "content-length": String(MAXIMUM_BYTES + 1),
      }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(OVERSIZED_ERROR);
    });

    it(`${route.name} rejects an oversized body without Content-Length before schema validation`, async () => {
      const body = sizedJsonString(MAXIMUM_BYTES + 1);
      const response = await route.invoke(requestWithBody(body));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(OVERSIZED_ERROR);
    });

    it(`${route.name} rejects oversized chunked transfer before schema validation`, async () => {
      const encoder = new TextEncoder();
      const streamed = cancelAwareStreamedBody([
        encoder.encode(`"${"x".repeat(64 * 1024)}`),
        encoder.encode("x".repeat(64 * 1024)),
        encoder.encode('"'),
      ]);
      const response = await route.invoke(requestWithBody(streamed.body, {
        "transfer-encoding": "chunked",
      }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(OVERSIZED_ERROR);
      expect(streamed.wasCanceled()).toBe(true);
    });
  }
});
