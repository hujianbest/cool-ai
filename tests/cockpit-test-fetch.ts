import { vi } from "vitest";
import type {
  ThreadFactDto,
  ThreadMessageDto,
  ThreadRunDto,
} from "@/src/shared/collaboration-contracts";

type QueuedResponse = Response | Promise<Response>;

export const TEST_THREAD_ID = "thread-1";
export const TEST_RUN_ID = "run-1";

export function threadRun(
  projectId: string,
  status: ThreadRunDto["status"] = "paused",
): ThreadRunDto {
  return {
    createdAt: "2026-07-30T00:00:00.000Z",
    currentAgentId: "agent-a",
    id: TEST_RUN_ID,
    pauseCategory: status === "paused" ? "manual" : null,
    projectId,
    roundCount: 2,
    status,
    threadId: TEST_THREAD_ID,
    updatedAt: "2026-07-30T00:00:00.000Z",
    version: 3,
  };
}

export function threadSummary(projectId: string) {
  return {
    availability: "ready" as const,
    createdAt: "2026-07-30T00:00:00.000Z",
    id: TEST_THREAD_ID,
    lastActivitySequence: 4,
    policyVersion: 1,
    projectId,
    title: "Launch discussion",
    updatedAt: "2026-07-30T00:00:00.000Z",
    version: 1,
  };
}

export function threadPolicy() {
  return {
    availability: "ready" as const,
    createdAt: "2026-07-30T00:00:00.000Z",
    members: [
      {
        agentId: "agent-a",
        displayNameSnapshot: "Alpha",
        live: "current" as const,
        position: 0,
      },
      {
        agentId: "agent-b",
        displayNameSnapshot: "Beta",
        live: "current" as const,
        position: 1,
      },
    ],
    revisionId: "revision-1",
    unavailableMemberIds: [],
    version: 1,
  };
}

export function threadListPayload(projectId: string) {
  return {
    nextCursor: null,
    threads: [
      { ...threadSummary(projectId), favoritedAt: null, isFavorite: false, tags: [] },
    ],
  };
}

export function threadDetailPayload(
  projectId: string,
  status: ThreadRunDto["status"] = "paused",
) {
  const run = threadRun(projectId, status);
  return {
    activeRun: { runId: run.id, threadId: run.threadId },
    readiness: {
      dispatch: "ready" as const,
      missingProjectFacts: [],
      selectedMemberId: "agent-a",
    },
    runs: [run],
    selectedRun: run,
    thread: { ...threadSummary(projectId), policy: threadPolicy() },
  };
}

export function threadMessage(projectId: string): ThreadMessageDto {
  return {
    attachments: [],
    authorAgentId: null,
    authorDisplayName: "项目所有者",
    authorType: "owner",
    content: "Prepare launch",
    createdAt: "2026-07-30T00:00:00.000Z",
    id: "message-1",
    mentionAgentId: null,
    mentionDisplayName: null,
    mentionMemberStatus: null,
    projectId,
    replyTo: null,
    runId: TEST_RUN_ID,
    sequence: 1,
    threadId: TEST_THREAD_ID,
  };
}

export function threadFactsPayload(projectId: string): {
  items: ThreadFactDto[];
  nextAfter: null;
} {
  const message = threadMessage(projectId);
  return {
    items: [
      {
        activitySequence: 3,
        actorId: null,
        actorType: "owner",
        createdAt: message.createdAt,
        id: "fact-message-1",
        message,
        messageId: message.id,
        payload: { messageId: message.id },
        policyRevisionId: null,
        projectId,
        runEventId: null,
        runId: TEST_RUN_ID,
        sequence: 3,
        threadId: TEST_THREAD_ID,
        type: "owner_message",
      },
      {
        activitySequence: 4,
        actorId: null,
        actorType: "owner",
        createdAt: message.createdAt,
        id: "fact-run-started",
        message: null,
        messageId: null,
        payload: { eventType: "run_started" },
        policyRevisionId: null,
        projectId,
        runEventId: "event-run-started",
        runId: TEST_RUN_ID,
        sequence: 4,
        threadId: TEST_THREAD_ID,
        type: "run_event",
      },
    ],
    nextAfter: null,
  };
}

export function threadMessagesPayload(projectId: string) {
  return { items: [threadMessage(projectId)], nextAfter: null };
}

export function threadTimelinePayload(
  projectId: string,
  decision?: {
    id: string;
    options: string[];
    question: string;
    requestingAgentId: string;
    turnId: string;
  },
) {
  return {
    items: [
      {
        actorId: null,
        actorType: "owner",
        createdAt: "2026-07-30T00:00:00.000Z",
        id: "event-run-started",
        payload: {
          currentAgentId: "agent-a",
          messageId: "message-1",
          messageSequence: 1,
        },
        projectId,
        runId: TEST_RUN_ID,
        sequence: 1,
        threadId: TEST_THREAD_ID,
        type: "run_started",
      },
      ...(decision
        ? [
            {
              actorId: decision.requestingAgentId,
              actorType: "agent",
              createdAt: "2026-07-30T00:01:00.000Z",
              id: "event-decision-requested",
              payload: {
                agentId: decision.requestingAgentId,
                decisionId: decision.id,
                options: decision.options,
                question: decision.question,
                turnId: decision.turnId,
              },
              projectId,
              runId: TEST_RUN_ID,
              sequence: 2,
              threadId: TEST_THREAD_ID,
              type: "decision_requested",
            },
          ]
        : []),
    ],
    nextAfter: null,
  };
}

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
    if (/\/api\/projects\/[^/]+\/capability-insight$/.test(url)) {
      return Promise.resolve(
        Response.json({ portraits: [], suggestions: [] }),
      );
    }
    if (/\/api\/projects\/[^/]+\/thread-tags\?limit=100$/.test(url)) {
      return Promise.resolve(Response.json({ tags: [] }));
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
    const threadListMatch = url.match(
      /^\/api\/projects\/([^/]+)\/threads\?limit=100$/,
    );
    if (threadListMatch) {
      return Promise.resolve(
        Response.json(threadListPayload(decodeURIComponent(threadListMatch[1]!))),
      );
    }
    const threadDetailMatch = url.match(
      /^\/api\/projects\/([^/]+)\/threads\/thread-1(?:\?run=run-1)?$/,
    );
    if (threadDetailMatch) {
      return Promise.resolve(
        Response.json(threadDetailPayload(decodeURIComponent(threadDetailMatch[1]!))),
      );
    }
    const threadMessagesMatch = url.match(
      /^\/api\/projects\/([^/]+)\/threads\/thread-1\/messages$/,
    );
    if (threadMessagesMatch) {
      return Promise.resolve(
        Response.json(threadMessagesPayload(decodeURIComponent(threadMessagesMatch[1]!))),
      );
    }
    const threadFactsMatch = url.match(
      /^\/api\/projects\/([^/]+)\/threads\/thread-1\/facts$/,
    );
    if (threadFactsMatch) {
      return Promise.resolve(
        Response.json(threadFactsPayload(decodeURIComponent(threadFactsMatch[1]!))),
      );
    }
    const threadTimelineMatch = url.match(
      /^\/api\/projects\/([^/]+)\/threads\/thread-1\/runs\/run-1\/timeline$/,
    );
    if (threadTimelineMatch) {
      return Promise.resolve(
        Response.json(threadTimelinePayload(decodeURIComponent(threadTimelineMatch[1]!))),
      );
    }
    if (/\/api\/projects\/[^/]+\/executions$/.test(url)) {
      return Promise.resolve(Response.json({ executions: [] }));
    }
    if (/\/api\/projects\/[^/]+\/audit-events(?:\?|$)/.test(url)) {
      return Promise.resolve(
        Response.json({
          events: [],
          freshness: { lag: 0, status: "caught_up" },
          nextBeforeSeq: null,
        }),
      );
    }
    if (/\/api\/projects\/[^/]+\/approvals\/pending$/.test(url)) {
      return Promise.resolve(Response.json({ approvals: [] }));
    }
    const response = responses[index++];
    if (!response) {
      return Promise.reject(new Error(`Unexpected cockpit test request: ${url}`));
    }
    return Promise.resolve(response);
  });
}
