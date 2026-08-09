"use client";

import { useEffect, useSyncExternalStore } from "react";

export type InputHistoryRecordingPreference = {
  version: 1;
  record: boolean;
  revision: number;
  updatedAt: string;
};

export type InputHistoryRecordingSnapshot = {
  hydrated: boolean;
  record: boolean;
  error: "read" | "write" | "invalid" | null;
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
  now: () => Date;
};

type InputHistoryRecordingStore = {
  hydrate(): void;
  setRecording(record: boolean): boolean;
  getSnapshot(): InputHistoryRecordingSnapshot;
  getServerSnapshot(): InputHistoryRecordingSnapshot;
  subscribe(listener: () => void): () => void;
  destroy(): void;
};

export const INPUT_HISTORY_RECORDING_KEY = "cool-ai:input-history-recording:v1";
export const INPUT_HISTORY_RECORDING_EVENT =
  "cool-ai:input-history-recording-event:v1";

const EXPECTED_KEYS = ["record", "revision", "updatedAt", "version"];
const SERVER_SNAPSHOT: InputHistoryRecordingSnapshot = Object.freeze({
  hydrated: false,
  record: true,
  error: null,
});

function isExactPreference(
  value: unknown,
): value is InputHistoryRecordingPreference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).sort();
  if (
    keys.length !== EXPECTED_KEYS.length ||
    keys.some((key, index) =>
      typeof key !== "string" || key !== EXPECTED_KEYS[index]
    )
  ) {
    return false;
  }

  const fields: Record<string, unknown> = {};
  for (const key of EXPECTED_KEYS) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      return false;
    }
    fields[key] = descriptor.value;
  }

  if (
    fields.version !== 1 ||
    typeof fields.record !== "boolean" ||
    !Number.isSafeInteger(fields.revision) ||
    (fields.revision as number) < 0 ||
    typeof fields.updatedAt !== "string"
  ) {
    return false;
  }

  const date = new Date(fields.updatedAt);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString() === fields.updatedAt
  );
}

function parsePreference(value: string): InputHistoryRecordingPreference | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isExactPreference(parsed)) return null;
  return {
    version: 1,
    record: parsed.record,
    revision: parsed.revision,
    updatedAt: parsed.updatedAt,
  };
}

function canonicalPreference(
  preference: InputHistoryRecordingPreference,
): string {
  return JSON.stringify({
    version: 1,
    record: preference.record,
    revision: preference.revision,
    updatedAt: preference.updatedAt,
  });
}

function comparePreferences(
  left: InputHistoryRecordingPreference,
  right: InputHistoryRecordingPreference,
): number {
  if (left.revision !== right.revision) {
    return left.revision > right.revision ? 1 : -1;
  }
  const leftCanonical = canonicalPreference(left);
  const rightCanonical = canonicalPreference(right);
  return leftCanonical < rightCanonical
    ? -1
    : leftCanonical > rightCanonical
      ? 1
      : 0;
}

function createInputHistoryRecordingStore(
  options: StoreOptions,
): InputHistoryRecordingStore {
  let snapshot = SERVER_SNAPSHOT;
  let preference: InputHistoryRecordingPreference | null = null;
  let serialized: string | null = null;
  let active = true;
  const listeners = new Set<() => void>();

  function publish(next: InputHistoryRecordingSnapshot) {
    if (
      snapshot.hydrated === next.hydrated &&
      snapshot.record === next.record &&
      snapshot.error === next.error
    ) {
      return;
    }
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  function publishError(error: "read" | "write" | "invalid") {
    publish({
      hydrated: true,
      record: snapshot.record,
      error,
    });
  }

  function readStored(): string | null | undefined {
    try {
      return options.storage.getItem(INPUT_HISTORY_RECORDING_KEY);
    } catch {
      return undefined;
    }
  }

  function persistIfDifferent(value: string): boolean {
    const stored = readStored();
    if (stored === value) return true;
    try {
      options.storage.setItem(INPUT_HISTORY_RECORDING_KEY, value);
      return true;
    } catch {
      publishError("write");
      return false;
    }
  }

  function apply(
    nextPreference: InputHistoryRecordingPreference,
    nextSerialized: string,
  ) {
    preference = nextPreference;
    serialized = nextSerialized;
    publish({
      hydrated: true,
      record: nextPreference.record,
      error: null,
    });
  }

  function hydrate() {
    if (snapshot.hydrated || !active) return;

    const stored = readStored();
    if (stored === undefined) {
      preference = null;
      serialized = null;
      publish({ hydrated: true, record: true, error: "read" });
      return;
    }
    if (stored === null) {
      preference = null;
      serialized = null;
      publish({ hydrated: true, record: true, error: null });
      return;
    }

    const parsed = parsePreference(stored);
    if (!parsed) {
      preference = null;
      serialized = null;
      publish({ hydrated: true, record: true, error: "invalid" });
      return;
    }

    const canonical = canonicalPreference(parsed);
    if (canonical !== stored && !persistIfDifferent(canonical)) {
      preference = null;
      serialized = null;
      return;
    }
    apply(parsed, canonical);
  }

  function acceptSerialized(value: string | null) {
    if (!active) return;
    if (!snapshot.hydrated) hydrate();
    if (value === null) return;

    const incoming = parsePreference(value);
    if (!incoming) {
      publishError("invalid");
      return;
    }
    const incomingCanonical = canonicalPreference(incoming);
    const current = preference;
    const winner = current && comparePreferences(current, incoming) >= 0
      ? current
      : incoming;
    const winnerCanonical = canonicalPreference(winner);

    if (!persistIfDifferent(winnerCanonical)) return;
    if (winnerCanonical === serialized) return;
    apply(winner, winnerCanonical);
  }

  function setRecording(record: boolean): boolean {
    if (!active || !snapshot.hydrated || typeof record !== "boolean") {
      return false;
    }

    const revision = (preference?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) return false;
    const candidate: InputHistoryRecordingPreference = {
      version: 1,
      record,
      revision,
      updatedAt: options.now().toISOString(),
    };
    const candidateCanonical = canonicalPreference(candidate);
    try {
      options.storage.setItem(INPUT_HISTORY_RECORDING_KEY, candidateCanonical);
    } catch {
      publishError("write");
      return false;
    }

    apply(candidate, candidateCanonical);
    options.window.dispatchEvent(
      new CustomEvent(INPUT_HISTORY_RECORDING_EVENT, {
        detail: candidateCanonical,
      }),
    );
    return true;
  }

  const customEventListener: EventListener = (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail === "string") acceptSerialized(detail);
  };
  const storageEventListener: EventListener = (event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key === INPUT_HISTORY_RECORDING_KEY) {
      acceptSerialized(storageEvent.newValue);
    }
  };

  options.window.addEventListener(
    INPUT_HISTORY_RECORDING_EVENT,
    customEventListener,
  );
  options.window.addEventListener("storage", storageEventListener);

  return {
    hydrate,
    setRecording,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => SERVER_SNAPSHOT,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (!active) return;
      active = false;
      options.window.removeEventListener(
        INPUT_HISTORY_RECORDING_EVENT,
        customEventListener,
      );
      options.window.removeEventListener("storage", storageEventListener);
      listeners.clear();
    },
  };
}

let browserStore = typeof window === "undefined"
  ? null
  : createBrowserStore();

function createBrowserStore(): InputHistoryRecordingStore | null {
  if (typeof window === "undefined") return null;
  return createInputHistoryRecordingStore({
    storage: {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    },
    window,
    now: () => new Date(),
  });
}

export function useInputHistoryRecording(): InputHistoryRecordingSnapshot {
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

export function setInputHistoryRecording(record: boolean): boolean {
  return browserStore?.setRecording(record) ?? false;
}

/**
 * Injectable controls for deterministic tests. Production callers only receive
 * the hook and mutation API.
 */
export const __inputHistoryRecordingStoreTest =
  process.env.NODE_ENV === "test"
    ? {
        createStore: createInputHistoryRecordingStore,
        parse: parsePreference,
        canonical: canonicalPreference,
        resetBrowserStore() {
          browserStore?.destroy();
          browserStore = createBrowserStore();
        },
      }
    : undefined;
