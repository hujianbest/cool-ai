"use client";

import { useEffect, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

export type ThemePreference = {
  version: 1;
  theme: Theme;
  revision: number;
  updatedAt: string;
};

export type ThemePreferenceSnapshot = {
  hydrated: boolean;
  theme: Theme;
  error: "read" | "write" | "invalid" | null;
};

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type WindowLike = {
  document: {
    documentElement: {
      dataset: DOMStringMap | Record<string, string>;
      style: { colorScheme?: string };
    };
  };
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

type ThemePreferenceStore = {
  hydrate(): void;
  setTheme(theme: Theme): boolean;
  getSnapshot(): ThemePreferenceSnapshot;
  getServerSnapshot(): ThemePreferenceSnapshot;
  subscribe(listener: () => void): () => void;
  destroy(): void;
};

export const THEME_PREFERENCE_KEY = "cool-ai:theme:v1";
export const THEME_PREFERENCE_EVENT = "cool-ai:theme-preference:v1";

const EXPECTED_KEYS = ["revision", "theme", "updatedAt", "version"];
const SERVER_SNAPSHOT: ThemePreferenceSnapshot = Object.freeze({
  hydrated: false,
  theme: "light",
  error: null,
});

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function isExactPreference(value: unknown): value is ThemePreference {
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
    !isTheme(fields.theme) ||
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

function parsePreference(value: string): ThemePreference | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isExactPreference(parsed)) return null;
  return {
    version: 1,
    theme: parsed.theme,
    revision: parsed.revision,
    updatedAt: parsed.updatedAt,
  };
}

function canonicalPreference(preference: ThemePreference): string {
  return JSON.stringify({
    version: 1,
    theme: preference.theme,
    revision: preference.revision,
    updatedAt: preference.updatedAt,
  });
}

function comparePreferences(
  left: ThemePreference,
  right: ThemePreference,
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

function createThemePreferenceStore(
  options: StoreOptions,
): ThemePreferenceStore {
  let snapshot = SERVER_SNAPSHOT;
  let preference: ThemePreference | null = null;
  let serialized: string | null = null;
  let active = true;
  const listeners = new Set<() => void>();

  function updateRoot(theme: Theme) {
    const root = options.window.document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  }

  function publish(next: ThemePreferenceSnapshot) {
    if (
      snapshot.hydrated === next.hydrated &&
      snapshot.theme === next.theme &&
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
      theme: snapshot.theme,
      error,
    });
  }

  function readStored(): string | null | undefined {
    try {
      return options.storage.getItem(THEME_PREFERENCE_KEY);
    } catch {
      return undefined;
    }
  }

  function persistIfDifferent(value: string): boolean {
    const stored = readStored();
    if (stored === value) return true;
    try {
      options.storage.setItem(THEME_PREFERENCE_KEY, value);
      return true;
    } catch {
      publishError("write");
      return false;
    }
  }

  function apply(
    nextPreference: ThemePreference,
    nextSerialized: string,
  ) {
    preference = nextPreference;
    serialized = nextSerialized;
    updateRoot(nextPreference.theme);
    publish({
      hydrated: true,
      theme: nextPreference.theme,
      error: null,
    });
  }

  function hydrate() {
    if (snapshot.hydrated || !active) return;

    const stored = readStored();
    if (stored === undefined) {
      preference = null;
      serialized = null;
      updateRoot("light");
      publish({ hydrated: true, theme: "light", error: "read" });
      return;
    }
    if (stored === null) {
      preference = null;
      serialized = null;
      updateRoot("light");
      publish({ hydrated: true, theme: "light", error: null });
      return;
    }

    const parsed = parsePreference(stored);
    if (!parsed) {
      preference = null;
      serialized = null;
      updateRoot("light");
      publish({ hydrated: true, theme: "light", error: "invalid" });
      return;
    }

    const canonical = canonicalPreference(parsed);
    if (canonical !== stored && !persistIfDifferent(canonical)) {
      preference = null;
      serialized = null;
      updateRoot("light");
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

  function setTheme(theme: Theme): boolean {
    if (!active || !snapshot.hydrated || !isTheme(theme)) return false;

    const revision = (preference?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) return false;
    const candidate: ThemePreference = {
      version: 1,
      theme,
      revision,
      updatedAt: options.now().toISOString(),
    };
    const candidateCanonical = canonicalPreference(candidate);
    try {
      options.storage.setItem(THEME_PREFERENCE_KEY, candidateCanonical);
    } catch {
      publishError("write");
      return false;
    }

    apply(candidate, candidateCanonical);
    options.window.dispatchEvent(
      new CustomEvent(THEME_PREFERENCE_EVENT, {
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
    if (storageEvent.key === THEME_PREFERENCE_KEY) {
      acceptSerialized(storageEvent.newValue);
    }
  };

  options.window.addEventListener(
    THEME_PREFERENCE_EVENT,
    customEventListener,
  );
  options.window.addEventListener("storage", storageEventListener);

  return {
    hydrate,
    setTheme,
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
        THEME_PREFERENCE_EVENT,
        customEventListener,
      );
      options.window.removeEventListener("storage", storageEventListener);
      listeners.clear();
    },
  };
}

const browserStore = typeof window === "undefined"
  ? null
  : createThemePreferenceStore({
      storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
      },
      window,
      now: () => new Date(),
    });

export function useThemePreference(): ThemePreferenceSnapshot {
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

export function setThemePreference(theme: Theme): boolean {
  return browserStore?.setTheme(theme) ?? false;
}

/**
 * Injectable controls for deterministic tests. Production callers only receive
 * the hook and mutation API.
 */
export const __themePreferenceStoreTest =
  process.env.NODE_ENV === "test"
    ? {
        createStore: createThemePreferenceStore,
        parse: parsePreference,
        canonical: canonicalPreference,
      }
    : undefined;
