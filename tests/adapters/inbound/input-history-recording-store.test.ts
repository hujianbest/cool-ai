// @vitest-environment jsdom
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

type RecordingSnapshot = {
  hydrated: boolean;
  record: boolean;
  error?: "read" | "write" | "invalid" | null;
};
type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};
type WindowLike = {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  dispatchEvent(event: Event): boolean;
};
type Store = {
  hydrate(): void;
  setRecording(record: boolean): boolean;
  getSnapshot(): RecordingSnapshot;
  getServerSnapshot(): RecordingSnapshot;
  subscribe(listener: () => void): () => void;
  destroy(): void;
};
type StoreModule = {
  INPUT_HISTORY_RECORDING_KEY?: string;
  INPUT_HISTORY_RECORDING_EVENT?: string;
  setInputHistoryRecording?: (record: boolean) => boolean;
  __inputHistoryRecordingStoreTest?: {
    createStore(options: {
      storage: StorageLike;
      window: WindowLike;
      now: () => Date;
    }): Store;
    parse(value: string): { record: boolean } | null;
  };
};

const modulePath = pathToFileURL(
  join(process.cwd(), "components", "input-history-recording-store.ts"),
).href;
const loaded = await import(/* @vite-ignore */ modulePath)
  .then((module) => module as StoreModule)
  .catch(() => ({} as StoreModule));

const KEY = "cool-ai:input-history-recording:v1";
const EVENT = "cool-ai:input-history-recording-event:v1";

class BrowserContext extends EventTarget implements WindowLike {}

class SharedStorage implements StorageLike {
  value: string | null = null;
  failRead = false;
  failWrite = false;
  getItem(): string | null {
    if (this.failRead) throw new Error("read denied");
    return this.value;
  }
  setItem(_key: string, value: string): void {
    if (this.failWrite) throw new Error("write denied");
    this.value = value;
  }
}

function canonical(record: boolean, revision: number): string {
  return JSON.stringify({
    version: 1,
    record,
    revision,
    updatedAt: "2026-08-10T00:00:00.000Z",
  });
}

function createStore(storage = new SharedStorage()) {
  const test = loaded.__inputHistoryRecordingStoreTest;
  expect(test, "input history recording store test surface").toBeDefined();
  const context = new BrowserContext();
  const store = test!.createStore({
    storage,
    window: context,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  return { context, storage, store };
}

describe("input history recording preference store", () => {
  it("defaults to recording on first hydrate without a stored value", () => {
    const { storage, store } = createStore();
    store.hydrate();
    expect(store.getSnapshot()).toEqual({
      hydrated: true,
      record: true,
      error: null,
    });
    expect(storage.value).toBeNull();
    expect(loaded.INPUT_HISTORY_RECORDING_KEY).toBe(KEY);
    expect(loaded.INPUT_HISTORY_RECORDING_EVENT).toBe(EVENT);
  });

  it("hydrates a stored opt-out", () => {
    const storage = new SharedStorage();
    storage.value = canonical(false, 3);
    const { store } = createStore(storage);
    store.hydrate();
    expect(store.getSnapshot()).toEqual({
      hydrated: true,
      record: false,
      error: null,
    });
  });

  it("persists setRecording and notifies subscribers", () => {
    const { storage, store } = createStore();
    store.hydrate();
    const notifications: boolean[] = [];
    store.subscribe(() => notifications.push(store.getSnapshot().record));

    expect(store.setRecording(false)).toBe(true);
    expect(store.getSnapshot().record).toBe(false);
    expect(storage.value).toBe(canonical(false, 1));
    expect(notifications).toEqual([false]);

    expect(store.setRecording(true)).toBe(true);
    expect(storage.value).toBe(canonical(true, 2));
    expect(notifications).toEqual([false, true]);
  });

  it("surfaces an invalid error and keeps the default when stored data is malformed", () => {
    const storage = new SharedStorage();
    storage.value = JSON.stringify({ version: 1, record: "no", revision: 1 });
    const { store } = createStore(storage);
    store.hydrate();
    expect(store.getSnapshot()).toEqual({
      hydrated: true,
      record: true,
      error: "invalid",
    });
  });

  it("rejects envelopes with extra keys", () => {
    const test = loaded.__inputHistoryRecordingStoreTest;
    expect(test).toBeDefined();
    const parsed = test!.parse(JSON.stringify({
      version: 1,
      record: false,
      revision: 1,
      updatedAt: "2026-08-10T00:00:00.000Z",
      extra: true,
    }));
    expect(parsed).toBeNull();
  });

  it("surfaces a read error when storage is unavailable", () => {
    const storage = new SharedStorage();
    storage.failRead = true;
    const { store } = createStore(storage);
    store.hydrate();
    expect(store.getSnapshot()).toEqual({
      hydrated: true,
      record: true,
      error: "read",
    });
  });

  it("surfaces a write error and keeps the current value when persistence fails", () => {
    const storage = new SharedStorage();
    const { store } = createStore(storage);
    store.hydrate();
    storage.failWrite = true;
    expect(store.setRecording(false)).toBe(false);
    expect(store.getSnapshot()).toEqual({
      hydrated: true,
      record: true,
      error: "write",
    });
    expect(storage.value).toBeNull();
  });

  it("syncs an opt-out across contexts via storage events with revision ordering", () => {
    const storage = new SharedStorage();
    const first = createStore(storage);
    const second = createStore(storage);
    first.store.hydrate();
    second.store.hydrate();

    first.store.setRecording(false);
    const stored = storage.value;
    second.context.dispatchEvent(new StorageEvent("storage", {
      key: KEY,
      newValue: stored,
    }));
    expect(second.store.getSnapshot().record).toBe(false);

    second.context.dispatchEvent(new StorageEvent("storage", {
      key: KEY,
      newValue: canonical(true, 0),
    }));
    expect(second.store.getSnapshot().record, "older revision must not win")
      .toBe(false);
    expect(stored).toBe(canonical(false, 1));
  });
});
