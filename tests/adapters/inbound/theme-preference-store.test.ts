import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Theme = "light" | "dark";
type ThemePreference = {
  version: 1;
  theme: Theme;
  revision: number;
  updatedAt: string;
};
type ThemeSnapshot = {
  hydrated: boolean;
  theme: Theme;
  error?: "read" | "write" | "invalid" | null;
};
type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};
type BrowserLike = {
  document: {
    documentElement: {
      dataset: Record<string, string>;
      style: { colorScheme?: string };
    };
  };
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  dispatchEvent(event: Event): boolean;
};
type Store = {
  hydrate(): void;
  setTheme(theme: Theme): boolean;
  getSnapshot(): ThemeSnapshot;
  getServerSnapshot(): ThemeSnapshot;
  subscribe(listener: () => void): () => void;
  destroy(): void;
};
type StoreModule = {
  THEME_PREFERENCE_KEY?: string;
  THEME_PREFERENCE_EVENT?: string;
  setThemePreference?: (theme: Theme) => boolean;
  __themePreferenceStoreTest?: {
    createStore(options: {
      storage: StorageLike;
      window: BrowserLike;
      now: () => Date;
    }): Store;
    parse(value: string): ThemePreference | null;
    canonical(preference: ThemePreference): string;
  };
};

const modulePath = pathToFileURL(
  join(process.cwd(), "components", "theme-preference-store.ts"),
).href;
const loaded = await import(/* @vite-ignore */ modulePath)
  .then((module) => module as StoreModule)
  .catch(() => ({} as StoreModule));

const KEY = "cool-ai:theme:v1";
const EVENT = "cool-ai:theme-preference:v1";

function preference(
  theme: Theme,
  revision = 1,
  updatedAt = "2026-08-08T00:00:01.000Z",
): ThemePreference {
  return { version: 1, theme, revision, updatedAt };
}

function canonical(value: ThemePreference): string {
  return JSON.stringify({
    version: 1,
    theme: value.theme,
    revision: value.revision,
    updatedAt: value.updatedAt,
  });
}

class BrowserContext extends EventTarget implements BrowserLike {
  document = {
    documentElement: {
      dataset: { theme: "light" },
      style: { colorScheme: "light" },
    },
  };
}

class SharedStorage implements StorageLike {
  value: string | null = null;
  writes: string[] = [];
  setCalls = 0;
  pending: Array<{ target: BrowserContext; value: string | null }> = [];
  contexts: BrowserContext[] = [];
  source: BrowserContext | null = null;
  failRead = false;
  failWrite = false;

  getItem(key: string) {
    expect(key).toBe(KEY);
    if (this.failRead) throw new DOMException("denied", "SecurityError");
    return this.value;
  }

  setItem(key: string, value: string) {
    expect(key).toBe(KEY);
    this.setCalls += 1;
    if (this.failWrite) throw new DOMException("quota", "QuotaExceededError");
    if (this.value === value) return;
    this.value = value;
    this.writes.push(value);
    for (const target of this.contexts) {
      if (target !== this.source) this.pending.push({ target, value });
    }
  }

  deliver(index: number) {
    const [{ target, value }] = this.pending.splice(index, 1);
    target.dispatchEvent(
      new StorageEvent("storage", { key: KEY, newValue: value }),
    );
  }

  deliverAll(reverse = false) {
    while (this.pending.length > 0) {
      this.deliver(reverse ? this.pending.length - 1 : 0);
    }
  }
}

function createStore(
  storage: SharedStorage,
  context: BrowserContext,
  timestamp: string,
): Store {
  const factory = loaded.__themePreferenceStoreTest?.createStore;
  expect(factory).toBeTypeOf("function");
  storage.contexts.push(context);
  return factory!({
    storage,
    window: context,
    now: () => new Date(timestamp),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("theme preference store", () => {
  it("keeps the public contract narrow and exposes injected controls only in tests", () => {
    expect(loaded.THEME_PREFERENCE_KEY).toBe(KEY);
    expect(loaded.THEME_PREFERENCE_EVENT).toBe(EVENT);
    expect(loaded.setThemePreference).toBeTypeOf("function");
    expect(loaded.__themePreferenceStoreTest).toBeDefined();
  });

  it("uses a stable unhydrated light server snapshot", () => {
    const store = createStore(
      new SharedStorage(),
      new BrowserContext(),
      "2026-08-08T00:00:01.000Z",
    );
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
    expect(store.getServerSnapshot()).toMatchObject({
      hydrated: false,
      theme: "light",
    });
    store.destroy();
  });

  it("accepts only exact safe canonical envelopes", () => {
    const parse = loaded.__themePreferenceStoreTest?.parse;
    expect(parse).toBeTypeOf("function");
    expect(parse!(canonical(preference("dark")))).toEqual(preference("dark"));

    const invalid = [
      "null",
      "{}",
      JSON.stringify({ ...preference("dark"), version: 0 }),
      JSON.stringify({ ...preference("dark"), theme: "sepia" }),
      JSON.stringify({ ...preference("dark"), revision: -1 }),
      JSON.stringify({ ...preference("dark"), revision: 1.5 }),
      JSON.stringify({
        ...preference("dark"),
        revision: Number.MAX_SAFE_INTEGER + 1,
      }),
      JSON.stringify({ ...preference("dark"), updatedAt: "2026-08-08" }),
      JSON.stringify({ ...preference("dark"), updatedAt: "invalid" }),
      JSON.stringify({ ...preference("dark"), extra: true }),
    ];
    for (const value of invalid) expect(parse!(value), value).toBeNull();
  });

  it("hydrates from storage and html, canonicalizes once, and updates the root", () => {
    const storage = new SharedStorage();
    storage.value = JSON.stringify({
      updatedAt: "2026-08-08T00:00:02.000Z",
      revision: 2,
      theme: "dark",
      version: 1,
    });
    const context = new BrowserContext();
    context.document.documentElement.dataset.theme = "dark";
    context.document.documentElement.style.colorScheme = "dark";
    const store = createStore(
      storage,
      context,
      "2026-08-08T00:00:03.000Z",
    );

    store.hydrate();

    expect(store.getSnapshot()).toMatchObject({
      hydrated: true,
      theme: "dark",
      error: null,
    });
    expect(storage.value).toBe(canonical(preference(
      "dark",
      2,
      "2026-08-08T00:00:02.000Z",
    )));
    expect(context.document.documentElement.dataset.theme).toBe("dark");
    expect(context.document.documentElement.style.colorScheme).toBe("dark");
    expect(storage.writes).toHaveLength(1);
    store.destroy();
  });

  it("falls back safely for missing, invalid, and throwing reads", () => {
    for (const setup of [
      (storage: SharedStorage) => { storage.value = null; },
      (storage: SharedStorage) => { storage.value = "{damaged"; },
      (storage: SharedStorage) => { storage.failRead = true; },
    ]) {
      const storage = new SharedStorage();
      setup(storage);
      const context = new BrowserContext();
      context.document.documentElement.dataset.theme = "dark";
      const store = createStore(
        storage,
        context,
        "2026-08-08T00:00:01.000Z",
      );
      store.hydrate();
      expect(store.getSnapshot()).toMatchObject({
        hydrated: true,
        theme: "light",
      });
      expect(context.document.documentElement.dataset.theme).toBe("light");
      store.destroy();
    }
  });

  it("publishes revision+1 only after a successful write and rolls back failure", () => {
    const storage = new SharedStorage();
    storage.value = canonical(preference("light", 4));
    const context = new BrowserContext();
    const store = createStore(
      storage,
      context,
      "2026-08-08T00:00:05.000Z",
    );
    store.hydrate();
    const listener = vi.fn();
    store.subscribe(listener);
    storage.failWrite = true;

    expect(store.setTheme("dark")).toBe(false);

    expect(store.getSnapshot()).toMatchObject({
      hydrated: true,
      theme: "light",
      error: "write",
    });
    expect(context.document.documentElement.dataset.theme).toBe("light");
    expect(storage.value).toBe(canonical(preference("light", 4)));
    expect(listener).toHaveBeenCalledTimes(1);
    store.destroy();
  });

  it("does not create an unsafe revision past the maximum safe integer", () => {
    const storage = new SharedStorage();
    storage.value = canonical(preference("light", Number.MAX_SAFE_INTEGER));
    const context = new BrowserContext();
    const store = createStore(
      storage,
      context,
      "2026-08-08T00:00:05.000Z",
    );
    store.hydrate();
    const before = storage.value;
    const writes = storage.writes.length;

    expect(store.setTheme("dark")).toBe(false);
    expect(store.getSnapshot().theme).toBe("light");
    expect(storage.value).toBe(before);
    expect(storage.writes).toHaveLength(writes);
    store.destroy();
  });

  it("synchronizes two stores in one window through the custom event", () => {
    const storage = new SharedStorage();
    const context = new BrowserContext();
    const first = createStore(
      storage,
      context,
      "2026-08-08T00:00:01.000Z",
    );
    const second = createStore(
      storage,
      context,
      "2026-08-08T00:00:02.000Z",
    );
    first.hydrate();
    second.hydrate();

    storage.source = context;
    expect(first.setTheme("dark")).toBe(true);

    expect(first.getSnapshot().theme).toBe("dark");
    expect(second.getSnapshot().theme).toBe("dark");
    first.destroy();
    second.destroy();
  });

  it("rejects stale values, accepts higher revisions, and ignores active deletion", () => {
    const storage = new SharedStorage();
    storage.value = canonical(preference("dark", 5));
    const context = new BrowserContext();
    const store = createStore(
      storage,
      context,
      "2026-08-08T00:00:06.000Z",
    );
    store.hydrate();
    const listener = vi.fn();
    store.subscribe(listener);

    context.dispatchEvent(new StorageEvent("storage", {
      key: KEY,
      newValue: canonical(preference("light", 3)),
    }));
    context.dispatchEvent(new StorageEvent("storage", {
      key: KEY,
      newValue: null,
    }));
    expect(store.getSnapshot().theme).toBe("dark");
    expect(listener).not.toHaveBeenCalled();

    context.dispatchEvent(new StorageEvent("storage", {
      key: KEY,
      newValue: canonical(preference(
        "light",
        6,
        "2026-08-08T00:00:06.000Z",
      )),
    }));
    expect(store.getSnapshot().theme).toBe("light");
    expect(listener).toHaveBeenCalledTimes(1);
    store.destroy();
  });

  it("uses canonical JSON total order at equal revision and rewrites only the loser", () => {
    const storage = new SharedStorage();
    const context = new BrowserContext();
    const store = createStore(
      storage,
      context,
      "2026-08-08T00:00:03.000Z",
    );
    const left = preference("dark", 7, "2026-08-08T00:00:01.000Z");
    const right = preference("light", 7, "2026-08-08T00:00:02.000Z");
    const winner = canonical(left) > canonical(right) ? left : right;
    const loser = winner === left ? right : left;
    storage.value = canonical(loser);
    store.hydrate();
    const listener = vi.fn();
    store.subscribe(listener);

    context.dispatchEvent(new StorageEvent("storage", {
      key: KEY,
      newValue: canonical(winner),
    }));
    const writesAfterWinner = storage.writes.length;
    const callsAfterWinner = storage.setCalls;
    context.dispatchEvent(new StorageEvent("storage", {
      key: KEY,
      newValue: canonical(winner),
    }));

    expect(store.getSnapshot().theme).toBe(winner.theme);
    expect(storage.value).toBe(canonical(winner));
    expect(storage.writes).toHaveLength(writesAfterWinner);
    expect(storage.setCalls).toBe(callsAfterWinner);
    expect(listener).toHaveBeenCalledTimes(1);
    store.destroy();
  });

  it.each([false, true])(
    "converges concurrent N+1 writes across two contexts, a third context, and refresh (reverse=%s)",
    (reverse) => {
      const storage = new SharedStorage();
      storage.value = canonical(preference("light", 8));
      const contextA = new BrowserContext();
      const contextB = new BrowserContext();
      const storeA = createStore(
        storage,
        contextA,
        "2026-08-08T00:00:09.000Z",
      );
      const storeB = createStore(
        storage,
        contextB,
        "2026-08-08T00:00:10.000Z",
      );
      storeA.hydrate();
      storeB.hydrate();

      storage.source = contextA;
      expect(storeA.setTheme("dark")).toBe(true);
      storage.source = contextB;
      expect(storeB.setTheme("light")).toBe(true);
      storage.source = null;
      storage.deliverAll(reverse);
      storage.deliverAll(reverse);

      const expected = [
        canonical(preference("dark", 9, "2026-08-08T00:00:09.000Z")),
        canonical(preference("light", 9, "2026-08-08T00:00:10.000Z")),
      ].sort().at(-1)!;
      expect(storage.value).toBe(expected);
      expect(storeA.getSnapshot().theme).toBe(JSON.parse(expected).theme);
      expect(storeB.getSnapshot().theme).toBe(JSON.parse(expected).theme);

      const contextC = new BrowserContext();
      const storeC = createStore(
        storage,
        contextC,
        "2026-08-08T00:00:11.000Z",
      );
      storeC.hydrate();
      const refreshed = createStore(
        storage,
        new BrowserContext(),
        "2026-08-08T00:00:12.000Z",
      );
      refreshed.hydrate();
      expect(storeC.getSnapshot().theme).toBe(JSON.parse(expected).theme);
      expect(refreshed.getSnapshot().theme).toBe(JSON.parse(expected).theme);

      storeA.destroy();
      storeB.destroy();
      storeC.destroy();
      refreshed.destroy();
    },
  );

  it("treats a missing key as light after refresh", () => {
    const storage = new SharedStorage();
    storage.value = null;
    const store = createStore(
      storage,
      new BrowserContext(),
      "2026-08-08T00:00:01.000Z",
    );
    store.hydrate();
    expect(store.getSnapshot()).toMatchObject({
      hydrated: true,
      theme: "light",
    });
    store.destroy();
  });
});
