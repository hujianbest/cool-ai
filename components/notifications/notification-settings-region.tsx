"use client";

import { useEffect, useState } from "react";

import {
  emptyNotificationPrefs,
  isNotificationDegraded,
  NOTIFICATION_DEGRADED_COPY,
  readNotificationPrefs,
  requestNotificationPermission,
  writeNotificationPrefs,
  type NotificationPrefs,
} from "@/components/notifications/browser-notification-adapter";

export function NotificationSettingsRegion() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(emptyNotificationPrefs);
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    setPrefs(readNotificationPrefs());
    setDegraded(isNotificationDegraded());
  }, []);

  async function toggle(kind: "approval" | "mission") {
    const next = { ...prefs, [kind]: !prefs[kind] };
    writeNotificationPrefs(next);
    setPrefs(next);
    if (next[kind]) {
      const permission = await requestNotificationPermission();
      setDegraded(permission === "denied" || permission === "unsupported");
      return;
    }
    setDegraded(isNotificationDegraded());
  }

  return (
    <section
      aria-labelledby="notification-settings-heading"
      className="notification-settings stack"
    >
      <h2 id="notification-settings-heading">通知</h2>
      <button
        aria-checked={prefs.approval}
        className="nav-item notification-switch"
        onClick={() => {
          void toggle("approval");
        }}
        role="switch"
        type="button"
      >
        审批通知
      </button>
      <button
        aria-checked={prefs.mission}
        className="nav-item notification-switch"
        onClick={() => {
          void toggle("mission");
        }}
        role="switch"
        type="button"
      >
        任务通知
      </button>
      {degraded ? (
        <p className="muted">{NOTIFICATION_DEGRADED_COPY}</p>
      ) : null}
    </section>
  );
}
