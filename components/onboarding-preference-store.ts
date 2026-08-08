"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  GUIDE_STEPS,
  type GuideStep,
} from "@/src/shared/onboarding-guide-machine";

export type OnboardingStatus = "active" | "dismissed" | "completed";
export type OnboardingPreferenceAction =
  | "skip"
  | "reset"
  | "dismiss"
  | "resume"
  | "complete"
  | "drift";

export type OnboardingPreferenceRegister<T> = {
  value: T;
  clock: number;
  writerId: string;
  changedAt: string;
};

export type OnboardingPreferenceEvent = {
  action: OnboardingPreferenceAction;
  changedAt: string;
  clock: number;
  eventId: string;
  step: GuideStep | null;
  writerId: string;
};

export type OnboardingPreference = {
  version: 1;
  clock: number;
  status: OnboardingPreferenceRegister<OnboardingStatus>;
  skips: Record<GuideStep, OnboardingPreferenceRegister<boolean>>;
  events: OnboardingPreferenceEvent[];
};

export type OnboardingPreferenceSnapshot = {
  hydrated: boolean;
  preference: OnboardingPreference;
  repair: boolean;
  error: "read" | "write" | "invalid" | "conflict" | null;
};

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type WindowLike = {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void;
  dispatchEvent(event: Event): boolean;
};

type StoreOptions = {
  storage: StorageLike;
  window: WindowLike;
  writerId: string;
  uuid: () => string;
  now: () => Date;
};

type OnboardingPreferenceStore = {
  hydrate(): void;
  getSnapshot(): OnboardingPreferenceSnapshot;
  getServerSnapshot(): OnboardingPreferenceSnapshot;
  subscribe(listener: () => void): () => void;
  skip(step: GuideStep): boolean;
  reset(step?: GuideStep): boolean;
  dismiss(): boolean;
  resume(options?: { resetSkipped?: boolean }): boolean;
  complete(factsSatisfied: boolean): boolean;
  drift(factsSatisfied: boolean): boolean;
  destroy(): void;
};

type MergeResult = {
  preference: OnboardingPreference;
  conflict: boolean;
};

export const ONBOARDING_PREFERENCE_KEY =
  "cool-ai:onboarding-preference:v1";
export const ONBOARDING_PREFERENCE_EVENT =
  "cool-ai:onboarding-preference:v1";
export const MAX_ONBOARDING_EVENTS = 100;

const STATUS_VALUES = new Set<OnboardingStatus>([
  "active",
  "dismissed",
  "completed",
]);
const ACTION_VALUES = new Set<OnboardingPreferenceAction>([
  "skip",
  "reset",
  "dismiss",
  "resume",
  "complete",
  "drift",
]);
const STEP_VALUES = new Set<GuideStep>(GUIDE_STEPS);

function zeroStatus(): OnboardingPreferenceRegister<OnboardingStatus> {
  return {
    value: "active",
    clock: 0,
    writerId: "",
    changedAt: "",
  };
}

function zeroSkip(): OnboardingPreferenceRegister<boolean> {
  return {
    value: false,
    clock: 0,
    writerId: "",
    changedAt: "",
  };
}

function emptyPreference(): OnboardingPreference {
  return {
    version: 1,
    clock: 0,
    status: zeroStatus(),
    skips: {
      provider: zeroSkip(),
      agent: zeroSkip(),
      "project-select": zeroSkip(),
      workspace: zeroSkip(),
      members: zeroSkip(),
      goal: zeroSkip(),
    },
    events: [],
  };
}

const SERVER_SNAPSHOT: OnboardingPreferenceSnapshot = Object.freeze({
  hydrated: false,
  preference: emptyPreference(),
  repair: false,
  error: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index]);
}

function isSafeClock(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareVersion(
  left: Pick<OnboardingPreferenceRegister<unknown>, "clock" | "writerId">,
  right: Pick<OnboardingPreferenceRegister<unknown>, "clock" | "writerId">,
): number {
  return left.clock === right.clock
    ? compareText(left.writerId, right.writerId)
    : left.clock < right.clock
      ? -1
      : 1;
}

function canonicalRegister<T>(
  register: OnboardingPreferenceRegister<T>,
): string {
  return JSON.stringify({
    value: register.value,
    clock: register.clock,
    writerId: register.writerId,
    changedAt: register.changedAt,
  });
}

function canonicalEvent(event: OnboardingPreferenceEvent): string {
  return JSON.stringify({
    action: event.action,
    changedAt: event.changedAt,
    clock: event.clock,
    eventId: event.eventId,
    step: event.step,
    writerId: event.writerId,
  });
}

function compareEvents(
  left: OnboardingPreferenceEvent,
  right: OnboardingPreferenceEvent,
): number {
  return compareVersion(left, right) ||
    compareText(left.eventId, right.eventId) ||
    compareText(canonicalEvent(left), canonicalEvent(right));
}

function chooseRegister<T>(
  left: OnboardingPreferenceRegister<T>,
  right: OnboardingPreferenceRegister<T>,
): { register: OnboardingPreferenceRegister<T>; conflict: boolean } {
  const versionOrder = compareVersion(left, right);
  if (versionOrder !== 0) {
    return {
      register: versionOrder > 0 ? { ...left } : { ...right },
      conflict: false,
    };
  }
  const leftCanonical = canonicalRegister(left);
  const rightCanonical = canonicalRegister(right);
  return {
    register: leftCanonical >= rightCanonical ? { ...left } : { ...right },
    conflict: leftCanonical !== rightCanonical,
  };
}

function mergeDetailed(
  left: OnboardingPreference,
  right: OnboardingPreference,
): MergeResult {
  let conflict = false;
  const selectedStatus = chooseRegister(left.status, right.status);
  conflict ||= selectedStatus.conflict;

  const skips = {} as Record<
    GuideStep,
    OnboardingPreferenceRegister<boolean>
  >;
  for (const step of GUIDE_STEPS) {
    const selected = chooseRegister(left.skips[step], right.skips[step]);
    skips[step] = selected.register;
    conflict ||= selected.conflict;
  }

  const eventsById = new Map<string, OnboardingPreferenceEvent>();
  for (const event of [...left.events, ...right.events]) {
    const existing = eventsById.get(event.eventId);
    if (!existing) {
      eventsById.set(event.eventId, { ...event });
      continue;
    }
    const existingCanonical = canonicalEvent(existing);
    const candidateCanonical = canonicalEvent(event);
    if (existingCanonical !== candidateCanonical) conflict = true;
    if (candidateCanonical > existingCanonical) {
      eventsById.set(event.eventId, { ...event });
    }
  }
  const events = [...eventsById.values()]
    .sort(compareEvents)
    .slice(-MAX_ONBOARDING_EVENTS);
  const clock = Math.max(
    left.clock,
    right.clock,
    selectedStatus.register.clock,
    ...GUIDE_STEPS.map((step) => skips[step].clock),
    ...events.map((event) => event.clock),
  );

  return {
    preference: {
      version: 1,
      clock,
      status: selectedStatus.register,
      skips,
      events,
    },
    conflict,
  };
}

export function mergeOnboardingPreferences(
  left: OnboardingPreference,
  right: OnboardingPreference,
): OnboardingPreference {
  return mergeDetailed(left, right).preference;
}

function canonicalPreference(preference: OnboardingPreference): string {
  return JSON.stringify({
    version: 1,
    clock: preference.clock,
    status: preference.status,
    skips: {
      provider: preference.skips.provider,
      agent: preference.skips.agent,
      "project-select": preference.skips["project-select"],
      workspace: preference.skips.workspace,
      members: preference.skips.members,
      goal: preference.skips.goal,
    },
    events: preference.events,
  });
}

function parseRegister<T>(
  value: unknown,
  isValue: (candidate: unknown) => candidate is T,
  zeroValue: T,
): OnboardingPreferenceRegister<T> | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["value", "clock", "writerId", "changedAt"]) ||
    !isValue(value.value) ||
    !isSafeClock(value.clock) ||
    typeof value.writerId !== "string" ||
    typeof value.changedAt !== "string"
  ) {
    return null;
  }
  if (value.clock === 0) {
    if (
      value.value !== zeroValue ||
      value.writerId !== "" ||
      value.changedAt !== ""
    ) {
      return null;
    }
  } else if (value.writerId.length === 0 || !isIsoTime(value.changedAt)) {
    return null;
  }
  return {
    value: value.value,
    clock: value.clock,
    writerId: value.writerId,
    changedAt: value.changedAt,
  };
}

function parseEvent(value: unknown): OnboardingPreferenceEvent | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "action",
      "changedAt",
      "clock",
      "eventId",
      "step",
      "writerId",
    ]) ||
    typeof value.action !== "string" ||
    !ACTION_VALUES.has(value.action as OnboardingPreferenceAction) ||
    !isIsoTime(value.changedAt) ||
    !isSafeClock(value.clock) ||
    value.clock === 0 ||
    typeof value.eventId !== "string" ||
    value.eventId.length === 0 ||
    typeof value.writerId !== "string" ||
    value.writerId.length === 0 ||
    !(
      value.step === null ||
      (typeof value.step === "string" &&
        STEP_VALUES.has(value.step as GuideStep))
    )
  ) {
    return null;
  }
  const action = value.action as OnboardingPreferenceAction;
  const step = value.step as GuideStep | null;
  if (
    (action === "skip" && step === null) ||
    ((action === "dismiss" ||
      action === "resume" ||
      action === "complete" ||
      action === "drift") &&
      step !== null)
  ) {
    return null;
  }
  return {
    action,
    changedAt: value.changedAt,
    clock: value.clock,
    eventId: value.eventId,
    step,
    writerId: value.writerId,
  };
}

function parsePreference(value: string): OnboardingPreference | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["version", "clock", "status", "skips", "events"]) ||
    parsed.version !== 1 ||
    !isSafeClock(parsed.clock) ||
    !isRecord(parsed.skips) ||
    !hasExactKeys(parsed.skips, [...GUIDE_STEPS]) ||
    !Array.isArray(parsed.events) ||
    parsed.events.length > MAX_ONBOARDING_EVENTS
  ) {
    return null;
  }
  const status = parseRegister(
    parsed.status,
    (candidate): candidate is OnboardingStatus =>
      typeof candidate === "string" &&
      STATUS_VALUES.has(candidate as OnboardingStatus),
    "active",
  );
  if (!status) return null;

  const skips = {} as Record<
    GuideStep,
    OnboardingPreferenceRegister<boolean>
  >;
  for (const step of GUIDE_STEPS) {
    const register = parseRegister(
      parsed.skips[step],
      (candidate): candidate is boolean => typeof candidate === "boolean",
      false,
    );
    if (!register) return null;
    skips[step] = register;
  }

  const events: OnboardingPreferenceEvent[] = [];
  const eventIds = new Set<string>();
  for (const value of parsed.events) {
    const event = parseEvent(value);
    if (!event || eventIds.has(event.eventId)) return null;
    eventIds.add(event.eventId);
    events.push(event);
  }
  const preference: OnboardingPreference = {
    version: 1,
    clock: parsed.clock,
    status,
    skips,
    events,
  };
  const observedClock = Math.max(
    status.clock,
    ...GUIDE_STEPS.map((step) => skips[step].clock),
    ...events.map((event) => event.clock),
  );
  if (
    parsed.clock !== observedClock ||
    events.some((event, index) =>
      index > 0 && compareEvents(events[index - 1], event) >= 0
    ) ||
    canonicalPreference(preference) !== value
  ) {
    return null;
  }
  return preference;
}

function createOnboardingPreferenceStore(
  options: StoreOptions,
): OnboardingPreferenceStore {
  let snapshot = SERVER_SNAPSHOT;
  let serialized = canonicalPreference(snapshot.preference);
  let active = true;
  const listeners = new Set<() => void>();

  function publish(next: OnboardingPreferenceSnapshot) {
    if (
      snapshot.hydrated === next.hydrated &&
      snapshot.preference === next.preference &&
      snapshot.repair === next.repair &&
      snapshot.error === next.error
    ) {
      return;
    }
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  function publishError(
    error: Exclude<OnboardingPreferenceSnapshot["error"], null>,
  ) {
    publish({
      ...snapshot,
      hydrated: true,
      error,
    });
  }

  function persist(value: string): boolean {
    try {
      options.storage.setItem(ONBOARDING_PREFERENCE_KEY, value);
      return true;
    } catch {
      publishError("write");
      return false;
    }
  }

  function hydrate() {
    if (!active || snapshot.hydrated) return;
    let stored: string | null;
    try {
      stored = options.storage.getItem(ONBOARDING_PREFERENCE_KEY);
    } catch {
      const preference = emptyPreference();
      serialized = canonicalPreference(preference);
      publish({
        hydrated: true,
        preference,
        repair: false,
        error: "read",
      });
      return;
    }
    if (stored === null) {
      const preference = emptyPreference();
      serialized = canonicalPreference(preference);
      publish({
        hydrated: true,
        preference,
        repair: false,
        error: null,
      });
      return;
    }
    const preference = parsePreference(stored);
    if (!preference) {
      const fallback = emptyPreference();
      serialized = canonicalPreference(fallback);
      publish({
        hydrated: true,
        preference: fallback,
        repair: false,
        error: "invalid",
      });
      return;
    }
    serialized = stored;
    publish({
      hydrated: true,
      preference,
      repair: false,
      error: null,
    });
  }

  function acceptSerialized(value: string | null) {
    if (!active) return;
    if (!snapshot.hydrated) hydrate();
    const incoming = value === null ? emptyPreference() : parsePreference(value);
    if (!incoming) {
      publishError("invalid");
      return;
    }
    const merged = mergeDetailed(snapshot.preference, incoming);
    const canonical = canonicalPreference(merged.preference);
    const requiresWrite = value === null || canonical !== value;
    if (requiresWrite && !persist(canonical)) return;

    const changed = canonical !== serialized;
    if (!changed && !merged.conflict) return;
    serialized = canonical;
    publish({
      hydrated: true,
      preference: changed ? merged.preference : snapshot.preference,
      repair: snapshot.repair &&
        merged.preference.status.value === "completed",
      error: merged.conflict ? "conflict" : null,
    });
  }

  function transact(
    action: OnboardingPreferenceAction,
    step: GuideStep | null,
    update: (
      candidate: OnboardingPreference,
      register: {
        clock: number;
        writerId: string;
        changedAt: string;
      },
    ) => void,
  ): boolean {
    if (!active || !snapshot.hydrated) return false;
    const clock = snapshot.preference.clock + 1;
    if (!Number.isSafeInteger(clock)) return false;
    const changedAt = options.now().toISOString();
    const version = { clock, writerId: options.writerId, changedAt };
    const candidate: OnboardingPreference = {
      ...snapshot.preference,
      clock,
      status: { ...snapshot.preference.status },
      skips: Object.fromEntries(
        GUIDE_STEPS.map((candidateStep) => [
          candidateStep,
          { ...snapshot.preference.skips[candidateStep] },
        ]),
      ) as Record<GuideStep, OnboardingPreferenceRegister<boolean>>,
      events: [
        ...snapshot.preference.events,
        {
          action,
          changedAt,
          clock,
          eventId: `${options.writerId}:${clock}:${options.uuid()}`,
          step,
          writerId: options.writerId,
        },
      ],
    };
    update(candidate, version);
    candidate.events = candidate.events
      .sort(compareEvents)
      .slice(-MAX_ONBOARDING_EVENTS);
    const canonical = canonicalPreference(candidate);
    if (!persist(canonical)) return false;

    serialized = canonical;
    publish({
      hydrated: true,
      preference: candidate,
      repair: false,
      error: null,
    });
    options.window.dispatchEvent(
      new CustomEvent(ONBOARDING_PREFERENCE_EVENT, { detail: canonical }),
    );
    return true;
  }

  function skip(step: GuideStep): boolean {
    if (
      !STEP_VALUES.has(step) ||
      snapshot.preference.status.value !== "active" ||
      snapshot.preference.skips[step].value
    ) {
      return false;
    }
    return transact("skip", step, (candidate, version) => {
      candidate.skips[step] = { value: true, ...version };
    });
  }

  function reset(step?: GuideStep): boolean {
    if (step !== undefined && !STEP_VALUES.has(step)) return false;
    return transact("reset", step ?? null, (candidate, version) => {
      candidate.status = { value: "active", ...version };
      if (step === undefined) {
        for (const candidateStep of GUIDE_STEPS) {
          candidate.skips[candidateStep] = { value: false, ...version };
        }
      } else {
        candidate.skips[step] = { value: false, ...version };
      }
    });
  }

  function dismiss(): boolean {
    if (snapshot.preference.status.value !== "active") return false;
    return transact("dismiss", null, (candidate, version) => {
      candidate.status = { value: "dismissed", ...version };
    });
  }

  function resume(optionsValue: { resetSkipped?: boolean } = {}): boolean {
    if (snapshot.preference.status.value !== "dismissed") return false;
    return transact("resume", null, (candidate, version) => {
      candidate.status = { value: "active", ...version };
      if (optionsValue.resetSkipped === true) {
        for (const step of GUIDE_STEPS) {
          candidate.skips[step] = { value: false, ...version };
        }
      }
    });
  }

  function complete(factsSatisfied: boolean): boolean {
    if (
      factsSatisfied !== true ||
      snapshot.preference.status.value !== "active"
    ) {
      return false;
    }
    return transact("complete", null, (candidate, version) => {
      candidate.status = { value: "completed", ...version };
    });
  }

  function drift(factsSatisfied: boolean): boolean {
    if (snapshot.preference.status.value !== "completed") return false;
    if (factsSatisfied) {
      publish({ ...snapshot, repair: false, error: null });
      return true;
    }
    const committed = transact("drift", null, () => undefined);
    if (committed) publish({ ...snapshot, repair: true });
    return committed;
  }

  const customEventListener: EventListener = (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail === "string") acceptSerialized(detail);
  };
  const storageEventListener: EventListener = (event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key === ONBOARDING_PREFERENCE_KEY) {
      acceptSerialized(storageEvent.newValue);
    }
  };
  options.window.addEventListener(
    ONBOARDING_PREFERENCE_EVENT,
    customEventListener,
  );
  options.window.addEventListener("storage", storageEventListener);

  return {
    hydrate,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => SERVER_SNAPSHOT,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    skip,
    reset,
    dismiss,
    resume,
    complete,
    drift,
    destroy() {
      if (!active) return;
      active = false;
      options.window.removeEventListener(
        ONBOARDING_PREFERENCE_EVENT,
        customEventListener,
      );
      options.window.removeEventListener("storage", storageEventListener);
      listeners.clear();
    },
  };
}

const browserStore = typeof window === "undefined"
  ? null
  : createOnboardingPreferenceStore({
      storage: window.localStorage,
      window,
      writerId: crypto.randomUUID(),
      uuid: () => crypto.randomUUID(),
      now: () => new Date(),
    });

export function useOnboardingPreference(): OnboardingPreferenceSnapshot {
  const current = useSyncExternalStore(
    browserStore?.subscribe ?? (() => () => undefined),
    browserStore?.getSnapshot ?? (() => SERVER_SNAPSHOT),
    () => SERVER_SNAPSHOT,
  );
  useEffect(() => {
    browserStore?.hydrate();
  }, []);
  return current;
}

export function skipOnboardingStep(step: GuideStep): boolean {
  return browserStore?.skip(step) ?? false;
}

export function resetOnboarding(step?: GuideStep): boolean {
  return browserStore?.reset(step) ?? false;
}

export function dismissOnboarding(): boolean {
  return browserStore?.dismiss() ?? false;
}

export function resumeOnboarding(options?: { resetSkipped?: boolean }): boolean {
  return browserStore?.resume(options) ?? false;
}

export function completeOnboarding(factsSatisfied: boolean): boolean {
  return browserStore?.complete(factsSatisfied) ?? false;
}

export function updateOnboardingDrift(factsSatisfied: boolean): boolean {
  return browserStore?.drift(factsSatisfied) ?? false;
}

export const __onboardingPreferenceStoreTest =
  process.env.NODE_ENV === "test"
    ? {
        createStore: createOnboardingPreferenceStore,
        parse: parsePreference,
        canonical: canonicalPreference,
        empty: emptyPreference,
      }
    : undefined;
