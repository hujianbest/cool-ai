import { vi } from "vitest";

type QueuedResponse = Response | Promise<Response>;

export function cockpitFetch(responses: QueuedResponse[]) {
  let index = 0;
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/api\/projects\/[^/]+\/workspace$/.test(url)) {
      return Promise.resolve(
        Response.json({ projectVersion: 1, workspace: null }),
      );
    }
    if (url === "/api/agents") {
      return Promise.resolve(Response.json({ agents: [] }));
    }
    if (/\/api\/projects\/[^/]+\/members$/.test(url)) {
      return Promise.resolve(
        Response.json({ members: [], projectVersion: 1 }),
      );
    }
    if (/\/api\/projects\/[^/]+\/mission$/.test(url)) {
      return Promise.resolve(
        Response.json({ mission: null, workItems: [] }),
      );
    }
    if (/\/api\/projects\/[^/]+\/memories\?includeInactive=[01]$/.test(url)) {
      return Promise.resolve(Response.json({ memories: [] }));
    }
    if (/\/api\/projects\/[^/]+\/collaboration$/.test(url)) {
      return Promise.resolve(
        Response.json({
          pendingDecision: null,
          projectMessagesPage: { items: [], nextAfter: null },
          readiness: { missing: ["workspace", "members", "mission"], ready: false },
          run: null,
          timelinePage: { items: [], nextAfter: null },
          usage: {
            byAgent: [],
            completionTokens: 0,
            promptTokens: 0,
            repairCalls: 0,
            totalTokens: 0,
            unreportedCalls: 0,
          },
        }),
      );
    }
    if (/\/api\/projects\/[^/]+\/executions$/.test(url)) {
      return Promise.resolve(Response.json({ executions: [] }));
    }
    const response = responses[index++];
    if (!response) {
      return Promise.reject(new Error(`Unexpected cockpit test request: ${url}`));
    }
    return Promise.resolve(response);
  });
}
