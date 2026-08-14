"use client";

import { useEffect, useRef } from "react";

import {
  applyAuditNotificationPoll,
  AUDIT_POLL_INTERVAL_MS,
  requestPermissionAndShow,
  type AuditNotificationEvent,
} from "@/components/notifications/browser-notification-adapter";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuditEvents(payload: unknown): AuditNotificationEvent[] {
  if (!isRecord(payload) || !Array.isArray(payload.events)) return [];
  const events: AuditNotificationEvent[] = [];
  for (const candidate of payload.events) {
    if (
      !isRecord(candidate)
      || typeof candidate.id !== "string"
      || candidate.id === ""
      || typeof candidate.eventType !== "string"
      || !isRecord(candidate.payload)
    ) {
      continue;
    }
    events.push({
      eventType: candidate.eventType,
      id: candidate.id,
      payload: candidate.payload,
    });
  }
  return events;
}

function isStalePoll(options: {
  isCurrent: () => boolean;
  signal: AbortSignal;
}): boolean {
  return !options.isCurrent() || options.signal.aborted;
}

async function pollProjectAuditEvents(
  projectId: string,
  primed: boolean,
  options: { isCurrent: () => boolean; signal: AbortSignal },
): Promise<boolean | null> {
  if (document.visibilityState !== "visible") return primed;
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/audit-events?limit=20`,
      { signal: options.signal },
    );
    if (isStalePoll(options)) return null;
    if (!response.ok) return primed;
    const page: unknown = await response.json();
    if (isStalePoll(options)) return null;
    const applied = applyAuditNotificationPoll(parseAuditEvents(page), primed);
    if (primed) {
      for (const event of applied.toShow) {
        if (isStalePoll(options)) return null;
        await requestPermissionAndShow(
          {
            eventId: event.id,
            eventType: event.eventType,
            payload: event.payload,
            projectId,
          },
          { requestIfNeeded: false },
        );
      }
    }
    if (isStalePoll(options)) return null;
    return applied.nextPrimed;
  } catch {
    if (isStalePoll(options)) return null;
    return primed;
  }
}

export function ProjectNotificationPoller({
  projectId,
}: {
  projectId: string | null;
}) {
  const primedRef = useRef(false);
  const epochRef = useRef(0);

  useEffect(() => {
    primedRef.current = false;
    const epoch = ++epochRef.current;
    if (!projectId) return undefined;

    const pollControllers = new Set<AbortController>();
    const tick = () => {
      const controller = new AbortController();
      pollControllers.add(controller);
      void pollProjectAuditEvents(projectId, primedRef.current, {
        isCurrent: () => epochRef.current === epoch,
        signal: controller.signal,
      }).then((next) => {
        pollControllers.delete(controller);
        if (next === null || epochRef.current !== epoch || controller.signal.aborted) {
          return;
        }
        primedRef.current = next;
      });
    };
    const intervalId = window.setInterval(tick, AUDIT_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
      for (const controller of pollControllers) {
        controller.abort();
      }
    };
  }, [projectId]);

  return null;
}
