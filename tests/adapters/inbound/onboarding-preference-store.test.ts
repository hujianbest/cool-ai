import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { GUIDE_STEPS, type GuideStep } from "@/src/shared/onboarding-guide-machine";

type Status = "active" | "dismissed" | "completed";
type Action = "skip" | "reset" | "dismiss" | "resume" | "complete" | "drift";
type Register<T> = {
  value: T;
  clock: number;
  writerId: string;
  changedAt: string;
};
type GuideEvent = {
  action: Action;
  changedAt: string;
  clock: number;
  eventId: string;
  step: GuideStep | null;
  writerId: string;
};
type Preference = {
  version: 1;
  clock: number;
  status: Register<Status>;
  skips: Record<GuideStep, Register<boolean>>;
  events: GuideEvent[];
};
type Snapshot = {
  hydrated: boolean;
  preference: Preference;
  repair: boolean;
  error: "read" | "write" | "invalid" | "conflict" | null;
};
type Store = {
  hydrate(): void;
  getSnapshot(): Snapshot;
  getServerSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  skip(step: GuideStep): boolean;
  reset(step?: GuideStep): boolean;
  dismiss(): boolean;
  resume(options?: { resetSkipped?: boolean }): boolean;
  complete(factsSatisfied: boolean): boolean;
  drift(factsSatisfied: boolean): boolean;
  destroy(): void;
};
type StoreModule = {
  ONBOARDING_PREFERENCE_KEY?: string;
  ONBOARDING_PREFERENCE_EVENT?: string;
  MAX_ONBOARDING_EVENTS?: number;
  mergeOnboardingPreferences?: (left: Preference, right: Preference) => Preference;
  __onboardingPreferenceStoreTest?: {
    createStore(options: {
      storage: StorageLike;
      window: BrowserContext;
      writerId: string;
      uuid: () => string;
      now: () => Date;
    }): Store;
    parse(value: string): Preference | null;
    canonical(value: Preference): string;
    empty(): Preference;
  };
};
type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const modulePath = pathToFileURL(
  join(process.cwd(), "components", "onboarding-preference-store.ts"),
).href;
const loaded = await import(/* @vite-ignore */ modulePath)
  .then((module) => module as StoreModule)
  .catch(() => ({} as StoreModule));

const KEY = "cool-ai:onboarding-preference:v1";
const EVENT = "cool-ai:onboarding-preference:v1";

class BrowserContext extends EventTarget {}

class SharedStorage implements StorageLike {
  value: string | null = null;
  failRead = false;
  failWrite = false;
  writes: string[] = [];
  contexts: BrowserContext[] = [];
  source: BrowserContext | null = null;
  pending: Array<{ target: BrowserContext; value: string | null }> = [];

  getItem(key: string) {
    expect(key).toBe(KEY);
    if (this.failRead) throw new DOMException("denied", "SecurityError");
    return this.value;
  }

  setItem(key: string, value: string) {
    expect(key).toBe(KEY);
    if (this.failWrite) throw new DOMException("quota", "QuotaExceededError");
    if (this.value === value) return;
    this.value = value;
    this.writes.push(value);
    for (const target of this.contexts) {
      if (target !== this.source) this.pending.push({ target, value });
    }
  }

  removeExternally() {
    this.value = null;
    for (const target of this.contexts) {
      this.pending.push({ target, value: null });
    }
  }

  deliverAll(reverse = false) {
    while (this.pending.length > 0) {
      const index = reverse ? this.pending.length - 1 : 0;
      const [{ target, value }] = this.pending.splice(index, 1);
      target.dispatchEvent(
        new StorageEvent("storage", { key: KEY, newValue: value }),
      );
    }
  }
}

function createStore(
  storage: SharedStorage,
  context: BrowserContext,
  writerId: string,
  start = 1,
): Store {
  const factory = loaded.__onboardingPreferenceStoreTest?.createStore;
  expect(factory).toBeTypeOf("function");
  storage.contexts.push(context);
  let sequence = start;
  return factory!({
    storage,
    window: context,
    writerId,
    uuid: () => `uuid-${writerId}-${sequence}`,
    now: () =>
      new Date(`2026-08-08T00:00:${String(sequence++).padStart(2, "0")}.000Z`),
  });
}

function hydrate(store: Store) {
  store.hydrate();
  expect(store.getSnapshot().hydrated).toBe(true);
}

describe("onboarding status/skips LWW store", () => {
  it("exposes the exact bounded preference contract", () => {
    expect(loaded.ONBOARDING_PREFERENCE_KEY).toBe(KEY);
    expect(loaded.ONBOARDING_PREFERENCE_EVENT).toBe(EVENT);
    expect(loaded.MAX_ONBOARDING_EVENTS).toBe(100);
    expect(loaded.mergeOnboardingPreferences).toBeTypeOf("function");
    expect(loaded.__onboardingPreferenceStoreTest?.createStore).toBeTypeOf(
      "function",
    );
  });

  it("starts SSR-safe with stable active and unskipped snapshots", () => {
    const store = createStore(new SharedStorage(), new BrowserContext(), "a");
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
    expect(store.getServerSnapshot()).toMatchObject({
      hydrated: false,
      preference: { clock: 0, status: { value: "active" }, events: [] },
      repair: false,
      error: null,
    });
    expect(
      GUIDE_STEPS.every(
        (step) => !store.getServerSnapshot().preference.skips[step].value,
      ),
    ).toBe(true);
    store.destroy();
  });

  it("applies skip/reset/dismiss/resume while keeping registers independent", () => {
    const store = createStore(new SharedStorage(), new BrowserContext(), "a");
    hydrate(store);

    expect(store.skip("workspace")).toBe(true);
    expect(store.getSnapshot().preference.skips.workspace.value).toBe(true);
    expect(store.getSnapshot().preference.status.value).toBe("active");
    expect(store.dismiss()).toBe(true);
    expect(store.getSnapshot().preference.status.value).toBe("dismissed");
    expect(store.resume()).toBe(true);
    expect(store.getSnapshot().preference).toMatchObject({
      status: { value: "active" },
      skips: { workspace: { value: true } },
    });
    expect(store.dismiss()).toBe(true);
    expect(store.resume({ resetSkipped: true })).toBe(true);
    expect(
      GUIDE_STEPS.every(
        (step) => !store.getSnapshot().preference.skips[step].value,
      ),
    ).toBe(true);
    expect(store.skip("goal")).toBe(true);
    expect(store.reset("goal")).toBe(true);
    expect(store.getSnapshot().preference).toMatchObject({
      status: { value: "active" },
      skips: { goal: { value: false } },
    });
    store.destroy();
  });

  it("completes only from active with satisfied facts and preserves history on drift", () => {
    const store = createStore(new SharedStorage(), new BrowserContext(), "a");
    hydrate(store);

    expect(store.complete(false)).toBe(false);
    expect(store.dismiss()).toBe(true);
    expect(store.complete(true)).toBe(false);
    expect(store.resume()).toBe(true);
    expect(store.complete(true)).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      preference: { status: { value: "completed" } },
      repair: false,
    });
    expect(store.resume()).toBe(false);
    expect(store.drift(false)).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      preference: {
        status: { value: "completed" },
        events: expect.arrayContaining([
          expect.objectContaining({ action: "drift", step: null }),
        ]),
      },
      repair: true,
    });
    expect(store.drift(true)).toBe(true);
    expect(store.getSnapshot().repair).toBe(false);
    expect(store.getSnapshot().preference.status.value).toBe("completed");
    expect(store.reset()).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      preference: { status: { value: "active" } },
      repair: false,
    });
    store.destroy();
  });

  it("parses only the exact canonical shape and rejects sensitive/business fields", () => {
    const testing = loaded.__onboardingPreferenceStoreTest!;
    const empty = testing.empty();
    const canonical = testing.canonical(empty);
    expect(testing.parse(canonical)).toEqual(empty);

    const unsafeFields = [
      "secret",
      "apiKey",
      "projectId",
      "resourceId",
      "path",
      "goal",
      "message",
      "targetBody",
    ];
    for (const field of unsafeFields) {
      expect(
        testing.parse(JSON.stringify({ ...empty, [field]: "must-not-persist" })),
        field,
      ).toBeNull();
    }
    expect(
      testing.parse(
        JSON.stringify({
          ...empty,
          status: { ...empty.status, secret: "must-not-persist" },
        }),
      ),
    ).toBeNull();
    expect(
      testing.parse(
        JSON.stringify({
          ...empty,
          skips: { ...empty.skips, projectId: empty.skips.goal },
        }),
      ),
    ).toBeNull();
    expect(
      testing.parse(
        JSON.stringify({
          ...empty,
          events: [
            {
              action: "skip",
              changedAt: "2026-08-08T00:00:01.000Z",
              clock: 1,
              eventId: "event",
              step: "goal",
              writerId: "writer",
              path: "D:\\secret",
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("merges status and every skip independently with deterministic tuple ties", () => {
    const testing = loaded.__onboardingPreferenceStoreTest!;
    const merge = loaded.mergeOnboardingPreferences!;
    const base = testing.empty();
    const left: Preference = {
      ...base,
      clock: 4,
      status: {
        value: "dismissed",
        clock: 4,
        writerId: "a",
        changedAt: "left",
      },
      skips: {
        ...base.skips,
        provider: {
          value: true,
          clock: 3,
          writerId: "z",
          changedAt: "left",
        },
      },
    };
    const right: Preference = {
      ...base,
      clock: 4,
      status: {
        value: "active",
        clock: 4,
        writerId: "z",
        changedAt: "right",
      },
      skips: {
        ...base.skips,
        agent: {
          value: true,
          clock: 3,
          writerId: "a",
          changedAt: "right",
        },
      },
    };
    const winner = merge(left, right);
    expect(winner.status).toEqual(right.status);
    expect(winner.skips.provider).toEqual(left.skips.provider);
    expect(winner.skips.agent).toEqual(right.skips.agent);
    expect(merge(left, right)).toEqual(merge(right, left));
    expect(merge(winner, winner)).toEqual(winner);

    const tieLeft = {
      ...left,
      status: { ...left.status, writerId: "same", changedAt: "a" },
    };
    const tieRight = {
      ...left,
      status: {
        ...left.status,
        writerId: "same",
        value: "completed" as const,
        changedAt: "z",
      },
    };
    const expected =
      JSON.stringify(tieLeft.status) > JSON.stringify(tieRight.status)
        ? tieLeft.status
        : tieRight.status;
    expect(merge(tieLeft, tieRight).status).toEqual(expected);
  });

  it("deduplicates eventId collisions canonically and keeps the latest 100", () => {
    const testing = loaded.__onboardingPreferenceStoreTest!;
    const merge = loaded.mergeOnboardingPreferences!;
    const events: GuideEvent[] = Array.from({ length: 120 }, (_, index) => ({
      action: "skip",
      changedAt: `time-${index + 1}`,
      clock: index + 1,
      eventId: `event-${String(index + 1).padStart(3, "0")}`,
      step: "provider",
      writerId: "writer",
    }));
    const left = { ...testing.empty(), clock: 120, events };
    const collision = {
      ...events[119],
      action: "reset" as const,
      changedAt: "z",
    };
    const right = { ...testing.empty(), clock: 120, events: [collision] };
    const merged = merge(left, right);
    const expectedCollision =
      JSON.stringify(events[119]) > JSON.stringify(collision)
        ? events[119]
        : collision;

    expect(merged.events).toHaveLength(100);
    expect(merged.events[0].clock).toBe(21);
    expect(new Set(merged.events.map(({ eventId }) => eventId)).size).toBe(100);
    expect(merged.events.at(-1)).toEqual(expectedCollision);
  });

  it.each([false, true])(
    "converges same-version concurrent writes across tabs and refresh (reverse=%s)",
    (reverse) => {
      const storage = new SharedStorage();
      const contextA = new BrowserContext();
      const contextB = new BrowserContext();
      const a = createStore(storage, contextA, "writer-a");
      const b = createStore(storage, contextB, "writer-b");
      hydrate(a);
      hydrate(b);

      storage.source = contextA;
      expect(a.skip("provider")).toBe(true);
      storage.source = contextB;
      expect(b.skip("agent")).toBe(true);
      storage.source = null;
      storage.deliverAll(reverse);
      storage.deliverAll(reverse);

      expect(a.getSnapshot().preference).toEqual(b.getSnapshot().preference);
      expect(a.getSnapshot().preference.skips.provider.value).toBe(true);
      expect(a.getSnapshot().preference.skips.agent.value).toBe(true);
      const refreshed = createStore(
        storage,
        new BrowserContext(),
        "writer-c",
      );
      hydrate(refreshed);
      expect(refreshed.getSnapshot().preference).toEqual(
        a.getSnapshot().preference,
      );
      a.destroy();
      b.destroy();
      refreshed.destroy();
    },
  );

  it("synchronizes stores in one window using the custom event", () => {
    const storage = new SharedStorage();
    const context = new BrowserContext();
    const a = createStore(storage, context, "writer-a");
    const b = createStore(storage, context, "writer-b");
    hydrate(a);
    hydrate(b);

    expect(a.skip("members")).toBe(true);
    expect(b.getSnapshot().preference.skips.members.value).toBe(true);
    a.destroy();
    b.destroy();
  });

  it("ignores stale and out-of-order values while converging storage to the winner", () => {
    const storage = new SharedStorage();
    const context = new BrowserContext();
    const store = createStore(storage, context, "writer-a");
    hydrate(store);
    expect(store.skip("goal")).toBe(true);
    const current = storage.value!;
    const stale = loaded.__onboardingPreferenceStoreTest!.canonical(
      loaded.__onboardingPreferenceStoreTest!.empty(),
    );

    context.dispatchEvent(
      new StorageEvent("storage", { key: KEY, newValue: stale }),
    );
    context.dispatchEvent(
      new StorageEvent("storage", { key: KEY, newValue: current }),
    );

    expect(store.getSnapshot().preference.skips.goal.value).toBe(true);
    expect(storage.value).toBe(current);
    store.destroy();
  });

  it("handles deletion, corruption, and throwing reads without restoring business data", () => {
    const missing = new SharedStorage();
    const fresh = createStore(missing, new BrowserContext(), "fresh");
    hydrate(fresh);
    expect(fresh.getSnapshot()).toMatchObject({
      preference: { status: { value: "active" }, events: [] },
      error: null,
    });
    fresh.destroy();

    const damaged = new SharedStorage();
    damaged.value = "{damaged";
    const invalid = createStore(damaged, new BrowserContext(), "invalid");
    hydrate(invalid);
    expect(invalid.getSnapshot()).toMatchObject({
      preference: { status: { value: "active" }, events: [] },
      error: "invalid",
    });
    invalid.destroy();

    const denied = new SharedStorage();
    denied.failRead = true;
    const unreadable = createStore(denied, new BrowserContext(), "denied");
    hydrate(unreadable);
    expect(unreadable.getSnapshot()).toMatchObject({
      preference: { status: { value: "active" }, events: [] },
      error: "read",
    });
    unreadable.destroy();

    const storage = new SharedStorage();
    const context = new BrowserContext();
    const active = createStore(storage, context, "active");
    hydrate(active);
    expect(active.skip("provider")).toBe(true);
    storage.removeExternally();
    storage.deliverAll();
    expect(active.getSnapshot().preference.skips.provider.value).toBe(true);
    expect(storage.value).not.toBeNull();
    active.destroy();
  });

  it("rolls back local and merge writes when persistence throws", () => {
    const storage = new SharedStorage();
    const context = new BrowserContext();
    const store = createStore(storage, context, "writer-a");
    hydrate(store);
    const before = store.getSnapshot().preference;
    storage.failWrite = true;
    expect(store.skip("provider")).toBe(false);
    expect(store.getSnapshot().preference).toBe(before);
    expect(store.getSnapshot().error).toBe("write");

    storage.failWrite = false;
    expect(store.skip("provider")).toBe(true);
    const committed = store.getSnapshot().preference;
    storage.failWrite = true;
    const incoming = loaded.__onboardingPreferenceStoreTest!.empty();
    incoming.skips.agent = {
      value: true,
      clock: committed.clock + 1,
      writerId: "remote",
      changedAt: "2026-08-08T00:00:09.000Z",
    };
    incoming.clock = committed.clock + 1;
    context.dispatchEvent(
      new StorageEvent("storage", {
        key: KEY,
        newValue: loaded.__onboardingPreferenceStoreTest!.canonical(incoming),
      }),
    );
    expect(store.getSnapshot().preference).toBe(committed);
    expect(store.getSnapshot().error).toBe("write");
    store.destroy();
  });

  it("never writes caller-provided project facts, IDs, paths, or target bodies", () => {
    const storage = new SharedStorage();
    const store = createStore(storage, new BrowserContext(), "safe-writer");
    hydrate(store);
    expect(store.skip("goal")).toBe(true);
    expect(store.complete(true)).toBe(true);
    const persisted = storage.value!;

    for (const forbidden of [
      "projectId",
      "resourceId",
      "path",
      "apiKey",
      "secret",
      "mission",
      "goalText",
      "message",
      "targetBody",
    ]) {
      expect(persisted).not.toContain(forbidden);
    }
    expect(JSON.parse(persisted)).toEqual(
      loaded.__onboardingPreferenceStoreTest!.parse(persisted),
    );
    expect(
      JSON.parse(persisted).events.every(
        (event: Record<string, unknown>) =>
          Object.keys(event).sort().join(",") ===
          "action,changedAt,clock,eventId,step,writerId",
      ),
    ).toBe(true);
    store.destroy();
  });
});
