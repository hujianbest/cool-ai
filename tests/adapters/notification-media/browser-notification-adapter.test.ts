// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clickThroughHref,
  MAX_SEEN_EVENT_IDS,
  NOTIFICATION_PREFS_KEY,
  notificationCopy,
  readNotificationPrefs,
  recordSeen,
  requestPermissionAndShow,
  shouldNotify,
  writeNotificationPrefs,
} from "@/components/notifications/browser-notification-adapter";

class MockNotification {
  static permission: NotificationPermission = "default";
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

beforeEach(() => {
  window.localStorage.clear();
  MockNotification.permission = "granted";
  MockNotification.instances = [];
  MockNotification.requestPermission = vi.fn(
    async (): Promise<NotificationPermission> => MockNotification.permission,
  );
  vi.stubGlobal("Notification", MockNotification);
});

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser notification adapter", () => {
  it("defaults both type switches off and does not notify", () => {
    const prefs = readNotificationPrefs();

    expect(prefs).toEqual({
      approval: false,
      mission: false,
      seenEventIds: [],
      version: 1,
    });
    expect(
      shouldNotify({
        eventId: "evt-1",
        eventType: "approval_requested",
        permission: "granted",
        prefs,
      }),
    ).toBe(false);
  });

  it("notifies a new governance approval only after the approval switch is on", () => {
    expect(
      writeNotificationPrefs({
        approval: true,
        mission: false,
        seenEventIds: [],
        version: 1,
      }),
    ).toBe(true);

    const prefs = readNotificationPrefs();
    expect(prefs.approval).toBe(true);
    expect(
      shouldNotify({
        eventId: "evt-approval",
        eventType: "approval_requested",
        permission: "granted",
        prefs,
      }),
    ).toBe(true);
    expect(
      shouldNotify({
        eventId: "evt-exec",
        eventType: "approval_requested",
        payload: { attemptNo: 1 },
        permission: "granted",
        prefs,
      }),
    ).toBe(false);
    expect(
      shouldNotify({
        eventId: "evt-task",
        eventType: "work_item_status_changed",
        permission: "granted",
        prefs,
      }),
    ).toBe(false);
  });

  it("notifies mission-work events only when the mission switch is on", () => {
    writeNotificationPrefs({
      approval: false,
      mission: true,
      seenEventIds: [],
      version: 1,
    });
    const prefs = readNotificationPrefs();

    expect(
      shouldNotify({
        eventId: "evt-mission",
        eventType: "work_item_created",
        permission: "granted",
        prefs,
      }),
    ).toBe(true);
    expect(
      shouldNotify({
        eventId: "evt-approval",
        eventType: "approval_requested",
        permission: "granted",
        prefs,
      }),
    ).toBe(false);
  });

  it("dedupes by event id and drops the oldest seen ids after 200", () => {
    const first = recordSeen(
      {
        approval: true,
        mission: true,
        seenEventIds: [],
        version: 1,
      },
      "evt-1",
    );
    expect(
      shouldNotify({
        eventId: "evt-1",
        eventType: "approval_requested",
        permission: "granted",
        prefs: first,
      }),
    ).toBe(false);

    const overflow = Array.from({ length: MAX_SEEN_EVENT_IDS }, (_, index) => `old-${index}`);
    const capped = recordSeen(
      {
        approval: true,
        mission: false,
        seenEventIds: overflow,
        version: 1,
      },
      "evt-new",
    );
    expect(capped.seenEventIds).toHaveLength(MAX_SEEN_EVENT_IDS);
    expect(capped.seenEventIds[0]).toBe("old-1");
    expect(capped.seenEventIds.at(-1)).toBe("evt-new");
    expect(capped.seenEventIds).not.toContain("old-0");
  });

  it("uses fixed titles and never copies project body, path, or secrets", () => {
    const secretPayload = {
      approvalId: "apr-1",
      body: "sk-secret-key",
      memory: "owner private note",
      path: "D:\\\\work\\\\secrets.env",
    };

    expect(notificationCopy("approval")).toEqual({
      body: "",
      title: "待处理审批",
    });
    expect(notificationCopy("mission")).toEqual({
      body: "",
      title: "任务有更新",
    });
    expect(JSON.stringify(notificationCopy("approval"))).not.toMatch(
      /sk-secret|private note|secrets\.env|D:\\\\work/u,
    );
    expect(JSON.stringify(secretPayload)).toContain("sk-secret-key");
  });

  it("returns degraded without throwing when permission is denied or Notification is missing", async () => {
    writeNotificationPrefs({
      approval: true,
      mission: false,
      seenEventIds: [],
      version: 1,
    });
    MockNotification.permission = "denied";

    await expect(
      requestPermissionAndShow({
        eventId: "evt-denied",
        eventType: "approval_requested",
        projectId: "project-1",
      }),
    ).resolves.toBe("degraded");
    expect(MockNotification.instances).toHaveLength(0);
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();

    vi.stubGlobal("Notification", undefined);
    await expect(
      requestPermissionAndShow({
        eventId: "evt-missing",
        eventType: "approval_requested",
        projectId: "project-1",
      }),
    ).resolves.toBe("degraded");
  });

  it("shows a tagged toast and clicks through only to a real approval or task id", async () => {
    writeNotificationPrefs({
      approval: true,
      mission: true,
      seenEventIds: [],
      version: 1,
    });
    const assign = vi.fn();

    await expect(
      requestPermissionAndShow(
        {
          eventId: "evt-show",
          eventType: "approval_requested",
          payload: {
            approvalId: "apr-9",
            body: "do not leak this memory",
            path: "C:\\\\hidden\\\\key",
          },
          projectId: "project-1",
        },
        { assign },
      ),
    ).resolves.toBe("shown");

    expect(MockNotification.instances).toHaveLength(1);
    const toast = MockNotification.instances[0]!;
    expect(toast.title).toBe("待处理审批");
    expect(toast.options).toEqual({ body: "", tag: "evt-show" });
    expect(JSON.stringify(toast.options)).not.toMatch(/do not leak|hidden\\\\key/u);

    toast.onclick?.call(toast as unknown as Notification, new Event("click"));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/projects/project-1/approvals/apr-9");
    expect(assign.mock.calls[0]?.[0]).not.toMatch(/\/approvals\/undefined|\/tasks\/undefined/u);

    assign.mockClear();
    await requestPermissionAndShow(
      {
        eventId: "evt-task",
        eventType: "work_item_created",
        payload: { workItemId: "work-3" },
        projectId: "project-1",
      },
      { assign },
    );
    MockNotification.instances.at(-1)?.onclick?.call(
      MockNotification.instances.at(-1) as unknown as Notification,
      new Event("click"),
    );
    expect(assign).toHaveBeenCalledWith("/projects/project-1/tasks/work-3");

    assign.mockClear();
    await requestPermissionAndShow(
      {
        eventId: "evt-no-id",
        eventType: "approval_approved",
        payload: { note: "no identity" },
        projectId: "project-1",
      },
      { assign },
    );
    const last = MockNotification.instances.at(-1)!;
    expect(last.onclick).toBeNull();
    last.onclick?.call(last as unknown as Notification, new Event("click"));
    expect(assign).not.toHaveBeenCalled();
  });

  it("routes click-through to mission and task-run ids without fabricating", () => {
    expect(clickThroughHref("project-1", { missionId: "mission-9" })).toBe(
      "/projects/project-1/missions/mission-9",
    );
    expect(clickThroughHref("project-1", { taskId: "run-4" })).toBe(
      "/projects/project-1/task-runs/run-4",
    );
    expect(
      clickThroughHref("project-1", {
        missionId: "mission-9",
        taskId: "run-4",
        workItemId: "work-3",
      }),
    ).toBe("/projects/project-1/tasks/work-3");
    expect(clickThroughHref("project-1", { missionId: "", taskId: 12 })).toBeNull();
    expect(clickThroughHref("project-1", { note: "no identity" })).toBeNull();
    expect(clickThroughHref("", { missionId: "mission-9" })).toBeNull();
  });
});
