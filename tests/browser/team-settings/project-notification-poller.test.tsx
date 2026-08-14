// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectNotificationPoller } from "@/components/notifications/project-notification-poller";
import {
  AUDIT_POLL_INTERVAL_MS,
  readNotificationPrefs,
  writeNotificationPrefs,
} from "@/components/notifications/browser-notification-adapter";

class MockNotification {
  static permission: NotificationPermission = "granted";
  static instances: MockNotification[] = [];
  static requestPermission = vi.fn(
    async (): Promise<NotificationPermission> => MockNotification.permission,
  );

  onclick: ((this: Notification, ev: Event) => void) | null = null;
  readonly options: NotificationOptions | undefined;
  readonly title: string;

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    MockNotification.instances.push(this);
  }

  close(): void {}
}

function auditPage(events: Array<Record<string, unknown>>) {
  return {
    events,
    freshness: { lag: 0, status: "caught_up" },
    nextBeforeSeq: null,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  MockNotification.permission = "granted";
  MockNotification.instances = [];
  MockNotification.requestPermission = vi.fn(
    async (): Promise<NotificationPermission> => MockNotification.permission,
  );
  vi.stubGlobal("Notification", MockNotification);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project notification poller", () => {
  it("does not poll without a selected project or when the document is hidden", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const hidden = render(<ProjectNotificationPoller projectId="project-1" />);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await vi.advanceTimersByTimeAsync(AUDIT_POLL_INTERVAL_MS);
    expect(fetchMock).not.toHaveBeenCalled();
    hidden.unmount();

    render(<ProjectNotificationPoller projectId={null} />);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await vi.advanceTimersByTimeAsync(AUDIT_POLL_INTERVAL_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GETs audit-events after 15s, seeds seen ids, then notifies new matching events without POSTing", async () => {
    writeNotificationPrefs({
      approval: true,
      mission: false,
      seenEventIds: [],
      version: 1,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const url = String(input);
      expect(url).toBe("/api/projects/project-1/audit-events?limit=20");
      if (fetchMock.mock.calls.length === 1) {
        return Response.json(
          auditPage([
            {
              actorType: "owner",
              eventType: "approval_requested",
              executionId: null,
              id: "evt-existing",
              occurredAt: "2026-08-15T00:00:00.000Z",
              outboxSeq: 1,
              payload: { approvalId: "apr-old" },
            },
          ]),
        );
      }
      return Response.json(
        auditPage([
          {
            actorType: "owner",
            eventType: "approval_requested",
            executionId: null,
            id: "evt-new",
            occurredAt: "2026-08-15T00:00:20.000Z",
            outboxSeq: 2,
            payload: { approvalId: "apr-new", body: "secret memory" },
          },
          {
            actorType: "agent",
            eventType: "work_item_created",
            executionId: null,
            id: "evt-mission",
            occurredAt: "2026-08-15T00:00:21.000Z",
            outboxSeq: 3,
            payload: { workItemId: "work-1" },
          },
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectNotificationPoller projectId="project-1" />);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUDIT_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockNotification.instances).toHaveLength(0);
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUDIT_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url, init]) => {
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      return method === "GET" && !String(url).includes("/approvals/");
    })).toBe(true);
    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]?.title).toBe("待处理审批");
    expect(MockNotification.instances[0]?.options).toEqual({
      body: "",
      tag: "evt-new",
    });
    expect(JSON.stringify(MockNotification.instances[0]?.options)).not.toContain(
      "secret memory",
    );
  });

  it("ignores a stale in-flight poll after switching projects", async () => {
    writeNotificationPrefs({
      approval: true,
      mission: true,
      seenEventIds: [],
      version: 1,
    });

    let resolveProjectA!: (response: Response) => void;
    const projectAResponse = new Promise<Response>((resolve) => {
      resolveProjectA = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/project-a/audit-events?limit=20") {
        return projectAResponse;
      }
      if (url === "/api/projects/project-b/audit-events?limit=20") {
        return Response.json(
          auditPage([
            {
              actorType: "owner",
              eventType: "approval_requested",
              executionId: null,
              id: "evt-from-b",
              occurredAt: "2026-08-15T00:01:00.000Z",
              outboxSeq: 2,
              payload: { approvalId: "apr-b" },
            },
          ]),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ProjectNotificationPoller projectId="project-a" />);
    await vi.advanceTimersByTimeAsync(AUDIT_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/projects/project-a/audit-events?limit=20",
    );

    view.rerender(<ProjectNotificationPoller projectId="project-b" />);
    resolveProjectA(
      Response.json(
        auditPage([
          {
            actorType: "owner",
            eventType: "approval_requested",
            executionId: null,
            id: "evt-from-a",
            occurredAt: "2026-08-15T00:00:00.000Z",
            outboxSeq: 1,
            payload: { approvalId: "apr-a" },
          },
        ]),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(MockNotification.instances).toHaveLength(0);
    expect(readNotificationPrefs().seenEventIds).not.toContain("evt-from-a");

    await vi.advanceTimersByTimeAsync(AUDIT_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "/api/projects/project-b/audit-events?limit=20",
    );
    expect(MockNotification.instances).toHaveLength(0);
    expect(readNotificationPrefs().seenEventIds).toContain("evt-from-b");
    expect(readNotificationPrefs().seenEventIds).not.toContain("evt-from-a");
  });
});
