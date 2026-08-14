export const NOTIFICATION_PREFS_KEY = "cool-ai:notification-prefs:v1";
export const MAX_SEEN_EVENT_IDS = 200;
export const AUDIT_POLL_INTERVAL_MS = 15_000;
export const NOTIFICATION_DEGRADED_COPY =
  "浏览器未授权系统通知，驾驶舱不会弹出提醒。";

export type NotificationPrefs = {
  version: 1;
  approval: boolean;
  mission: boolean;
  seenEventIds: string[];
};

export type NotificationKind = "approval" | "mission";

export function emptyNotificationPrefs(): NotificationPrefs {
  return {
    version: 1,
    approval: false,
    mission: false,
    seenEventIds: [],
  };
}

const MISSION_WORK_EVENT_TYPES = new Set([
  "mission_created",
  "task_completed",
  "task_created",
  "task_failed",
  "task_started",
  "work_item_created",
  "work_item_status_changed",
]);

const GOVERNANCE_EVENT_TYPES = new Set([
  "approval_approved",
  "approval_consumed",
  "approval_expired",
  "approval_rejected",
  "approval_requested",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyNotificationKind(
  eventType: string,
  payload: Record<string, unknown> = {},
): NotificationKind | null {
  if (eventType === "approval_requested" && Object.hasOwn(payload, "attemptNo")) {
    return null;
  }
  if (MISSION_WORK_EVENT_TYPES.has(eventType)) return "mission";
  if (GOVERNANCE_EVENT_TYPES.has(eventType)) return "approval";
  return null;
}

function localStorageOrUndefined(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function readNotificationPrefs(
  storage: Pick<Storage, "getItem"> | undefined = localStorageOrUndefined(),
): NotificationPrefs {
  if (!storage) return emptyNotificationPrefs();
  try {
    const raw = storage.getItem(NOTIFICATION_PREFS_KEY);
    if (raw === null) return emptyNotificationPrefs();
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed)
      || parsed.version !== 1
      || typeof parsed.approval !== "boolean"
      || typeof parsed.mission !== "boolean"
      || !Array.isArray(parsed.seenEventIds)
      || !parsed.seenEventIds.every((id) => typeof id === "string")
    ) {
      return emptyNotificationPrefs();
    }
    return {
      version: 1,
      approval: parsed.approval,
      mission: parsed.mission,
      seenEventIds: parsed.seenEventIds.slice(-MAX_SEEN_EVENT_IDS),
    };
  } catch {
    return emptyNotificationPrefs();
  }
}

export function writeNotificationPrefs(
  prefs: NotificationPrefs,
  storage: Pick<Storage, "setItem"> | undefined = localStorageOrUndefined(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      NOTIFICATION_PREFS_KEY,
      JSON.stringify({
        version: 1,
        approval: prefs.approval,
        mission: prefs.mission,
        seenEventIds: prefs.seenEventIds.slice(-MAX_SEEN_EVENT_IDS),
      } satisfies NotificationPrefs),
    );
    return true;
  } catch {
    return false;
  }
}

export function shouldNotify(input: {
  prefs: NotificationPrefs;
  eventId: string;
  eventType: string;
  payload?: Record<string, unknown>;
  permission: NotificationPermission | "unsupported";
}): boolean {
  if (input.permission !== "granted") return false;
  if (input.prefs.seenEventIds.includes(input.eventId)) return false;
  const kind = classifyNotificationKind(input.eventType, input.payload ?? {});
  if (kind === "approval") return input.prefs.approval;
  if (kind === "mission") return input.prefs.mission;
  return false;
}

export function notificationCopy(kind: NotificationKind): {
  title: string;
  body: string;
} {
  return {
    body: "",
    title: kind === "approval" ? "待处理审批" : "任务有更新",
  };
}

export function recordSeen(
  prefs: NotificationPrefs,
  eventId: string,
): NotificationPrefs {
  if (prefs.seenEventIds.includes(eventId)) return prefs;
  return {
    ...prefs,
    seenEventIds: [...prefs.seenEventIds, eventId].slice(-MAX_SEEN_EVENT_IDS),
  };
}

export function notificationPermissionState():
  | NotificationPermission
  | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export function isNotificationDegraded(): boolean {
  const state = notificationPermissionState();
  return state === "denied" || state === "unsupported";
}

export async function requestNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export function clickThroughHref(
  projectId: string,
  payload: Record<string, unknown>,
): string | null {
  if (projectId === "") return null;
  const project = encodeURIComponent(projectId);
  const approvalId = payload.approvalId;
  if (typeof approvalId === "string" && approvalId !== "") {
    return `/projects/${project}/approvals/${encodeURIComponent(approvalId)}`;
  }
  const workItemId = payload.workItemId;
  if (typeof workItemId === "string" && workItemId !== "") {
    return `/projects/${project}/tasks/${encodeURIComponent(workItemId)}`;
  }
  const missionId = payload.missionId;
  if (typeof missionId === "string" && missionId !== "") {
    return `/projects/${project}/missions/${encodeURIComponent(missionId)}`;
  }
  const taskId = payload.taskId;
  if (typeof taskId === "string" && taskId !== "") {
    return `/projects/${project}/task-runs/${encodeURIComponent(taskId)}`;
  }
  return null;
}

export type AuditNotificationEvent = {
  eventType: string;
  id: string;
  payload: Record<string, unknown>;
};

export function applyAuditNotificationPoll(
  events: readonly AuditNotificationEvent[],
  primed: boolean,
): { nextPrimed: true; toShow: AuditNotificationEvent[] } {
  if (!primed) {
    let prefs = readNotificationPrefs();
    for (const event of events) {
      prefs = recordSeen(prefs, event.id);
    }
    writeNotificationPrefs(prefs);
    return { nextPrimed: true, toShow: [] };
  }
  const prefs = readNotificationPrefs();
  const permission = notificationPermissionState();
  return {
    nextPrimed: true,
    toShow: events.filter((event) =>
      shouldNotify({
        eventId: event.id,
        eventType: event.eventType,
        payload: event.payload,
        permission,
        prefs,
      })
    ),
  };
}

export type ShowNotificationResult = "shown" | "degraded" | "skipped";

export async function requestPermissionAndShow(
  input: {
    eventId: string;
    eventType: string;
    payload?: Record<string, unknown>;
    projectId: string;
  },
  options: {
    assign?: (href: string) => void;
    requestIfNeeded?: boolean;
  } = {},
): Promise<ShowNotificationResult> {
  const NotificationCtor = typeof Notification === "undefined"
    ? undefined
    : Notification;
  if (!NotificationCtor) return "degraded";

  let permission: NotificationPermission = NotificationCtor.permission;
  if (permission === "denied") return "degraded";
  if (permission === "default" && options.requestIfNeeded !== false) {
    try {
      permission = await NotificationCtor.requestPermission();
    } catch {
      return "degraded";
    }
  }
  if (permission !== "granted") {
    return permission === "denied" ? "degraded" : "skipped";
  }

  const prefs = readNotificationPrefs();
  if (
    !shouldNotify({
      eventId: input.eventId,
      eventType: input.eventType,
      payload: input.payload,
      permission,
      prefs,
    })
  ) {
    return "skipped";
  }

  const kind = classifyNotificationKind(input.eventType, input.payload ?? {});
  if (!kind) return "skipped";

  try {
    const copy = notificationCopy(kind);
    const notification = new NotificationCtor(copy.title, {
      body: copy.body,
      tag: input.eventId,
    });
    const href = clickThroughHref(input.projectId, input.payload ?? {});
    if (href) {
      notification.onclick = () => {
        notification.close();
        (options.assign ?? ((next) => {
          window.location.assign(next);
        }))(href);
      };
    }
    writeNotificationPrefs(recordSeen(prefs, input.eventId));
    return "shown";
  } catch {
    return "degraded";
  }
}
