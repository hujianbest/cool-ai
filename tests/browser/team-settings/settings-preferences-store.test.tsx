// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type SettingsSectionId = "skills" | "providers" | "agents";
type Register = {
  pinned: boolean;
  clock: number;
  writerId: string;
  changedAt: string;
};
type AuditEvent = {
  clock: number;
  writerId: string;
  eventId: string;
  changedAt: string;
  action: "pin" | "unpin";
  section: SettingsSectionId;
};
type SettingsPreference = {
  version: 1;
  clock: number;
  pinned: SettingsSectionId[];
  registers: Record<SettingsSectionId, Register>;
  events: AuditEvent[];
};
type SettingsPreferencesSnapshot = {
  hydrated: boolean;
  preference: SettingsPreference;
  error: "read" | "write" | "invalid" | "conflict" | null;
};
type TestOptions = {
  writerId?: string;
  uuid?: () => string;
  now?: () => Date;
};
type StoreModule = {
  MAX_SETTINGS_AUDIT_EVENTS?: number;
  PINNED_SETTINGS_KEY?: string;
  SETTINGS_PREFERENCES_EVENT?: string;
  mergePreferences?: (
    left: SettingsPreference,
    right: SettingsPreference,
  ) => SettingsPreference;
  getSettingsPreferenceUpdatedAt?: (
    preference: SettingsPreference,
  ) => string | null;
  useSettingsPreferences?: () => SettingsPreferencesSnapshot;
  pinSettingsSection?: (section: SettingsSectionId) => boolean;
  unpinSettingsSection?: (section: SettingsSectionId) => boolean;
  __settingsPreferencesStoreTest?: {
    reset: (options?: TestOptions | (() => Date)) => void;
    hydrate: () => void;
    getSnapshot: () => SettingsPreferencesSnapshot;
    getServerSnapshot: () => SettingsPreferencesSnapshot;
  };
};

const modulePath = pathToFileURL(
  join(process.cwd(), "components", "settings-preferences-store.ts"),
).href;
const store = await import(/* @vite-ignore */ modulePath)
  .then((loaded) => loaded as StoreModule)
  .catch(() => ({} as StoreModule));

const ZERO_REGISTER: Register = {
  pinned: false,
  clock: 0,
  writerId: "",
  changedAt: "",
};

function preference(
  overrides: Partial<SettingsPreference> = {},
): SettingsPreference {
  return {
    version: 1,
    clock: 0,
    pinned: [],
    registers: {
      skills: { ...ZERO_REGISTER },
      providers: { ...ZERO_REGISTER },
      agents: { ...ZERO_REGISTER },
    },
    events: [],
    ...overrides,
  };
}

function event(
  clock: number,
  writerId: string,
  section: SettingsSectionId = "skills",
  action: "pin" | "unpin" = "pin",
): AuditEvent {
  return {
    clock,
    writerId,
    eventId: `${writerId}:${clock}:event`,
    changedAt: `2026-08-08T00:00:${String(clock).padStart(2, "0")}.000Z`,
    action,
    section,
  };
}

function withOperation(
  section: SettingsSectionId,
  register: Register,
  auditEvent: AuditEvent,
): SettingsPreference {
  return preference({
    clock: auditEvent.clock,
    pinned: register.pinned ? [section] : [],
    registers: {
      skills: { ...ZERO_REGISTER },
      providers: { ...ZERO_REGISTER },
      agents: { ...ZERO_REGISTER },
      [section]: register,
    },
    events: [auditEvent],
  });
}

afterEach(() => {
  store.__settingsPreferencesStoreTest?.reset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("settings preferences bounded LWW store", () => {
  it("provides a pure merge for concurrent preference envelopes", () => {
    expect(store.mergePreferences).toBeTypeOf("function");
  });

  it("keeps stable SSR/client snapshots while hydration is busy", async () => {
    const testing = store.__settingsPreferencesStoreTest;
    expect(testing).toBeDefined();
    if (!testing || !store.useSettingsPreferences) return;

    expect(testing.getServerSnapshot()).toBe(testing.getServerSnapshot());
    expect(testing.getSnapshot()).toBe(testing.getSnapshot());
    const seen: boolean[] = [];
    function Probe() {
      const snapshot = store.useSettingsPreferences!();
      seen.push(snapshot.hydrated);
      return <output>{snapshot.hydrated ? "ready" : "busy"}</output>;
    }
    render(<Probe />);
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(seen[0]).toBe(false);
  });

  it("merges as a commutative, associative, idempotent operation", () => {
    const merge = store.mergePreferences;
    expect(merge).toBeTypeOf("function");
    if (!merge) return;

    const a = withOperation(
      "skills",
      {
        pinned: true,
        clock: 1,
        writerId: "a",
        changedAt: "2026-08-08T00:00:01.000Z",
      },
      event(1, "a"),
    );
    const b = withOperation(
      "providers",
      {
        pinned: true,
        clock: 1,
        writerId: "b",
        changedAt: "2026-08-08T00:00:02.000Z",
      },
      event(1, "b", "providers"),
    );
    const c = withOperation(
      "agents",
      {
        pinned: true,
        clock: 2,
        writerId: "c",
        changedAt: "2026-08-08T00:00:03.000Z",
      },
      event(2, "c", "agents"),
    );

    expect(merge(a, b)).toEqual(merge(b, a));
    expect(merge(merge(a, b), c)).toEqual(merge(a, merge(b, c)));
    expect(merge(a, a)).toEqual(a);
    expect(merge(a, b).pinned).toEqual(["skills", "providers"]);
  });

  it("resolves same-section concurrency by clock then writerId", () => {
    const merge = store.mergePreferences;
    expect(merge).toBeTypeOf("function");
    if (!merge) return;

    const pin = withOperation(
      "skills",
      {
        pinned: true,
        clock: 4,
        writerId: "writer-a",
        changedAt: "pin-time",
      },
      event(4, "writer-a"),
    );
    const unpin = withOperation(
      "skills",
      {
        pinned: false,
        clock: 4,
        writerId: "writer-z",
        changedAt: "unpin-time",
      },
      event(4, "writer-z", "skills", "unpin"),
    );

    const merged = merge(pin, unpin);
    expect(merged.pinned).toEqual([]);
    expect(merged.registers.skills).toEqual(unpin.registers.skills);
    expect(merged.events).toHaveLength(2);
  });

  it("uses canonical content for tuple/event collisions and announces damage", () => {
    const testing = store.__settingsPreferencesStoreTest;
    expect(testing).toBeDefined();
    if (!testing || !store.PINNED_SETTINGS_KEY) return;

    const initial = withOperation(
      "skills",
      {
        pinned: false,
        clock: 2,
        writerId: "same",
        changedAt: "a",
      },
      event(2, "same", "skills", "unpin"),
    );
    localStorage.setItem(store.PINNED_SETTINGS_KEY, JSON.stringify(initial));
    testing.hydrate();
    const conflicting = {
      ...initial,
      pinned: ["skills"],
      registers: {
        ...initial.registers,
        skills: { ...initial.registers.skills, pinned: true, changedAt: "z" },
      },
      events: [
        { ...initial.events[0], action: "pin" as const, changedAt: "z" },
      ],
    };
    localStorage.setItem(store.PINNED_SETTINGS_KEY, JSON.stringify(conflicting));
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: store.PINNED_SETTINGS_KEY,
        newValue: JSON.stringify(conflicting),
      }),
    );

    expect(testing.getSnapshot()).toMatchObject({
      error: "conflict",
      preference: {
        pinned: ["skills"],
        registers: { skills: { pinned: true, changedAt: "z" } },
        events: [{ action: "pin", changedAt: "z" }],
      },
    });
  });

  it("deduplicates, canonically sorts, and retains only the latest 100 events", () => {
    const merge = store.mergePreferences;
    expect(merge).toBeTypeOf("function");
    expect(store.MAX_SETTINGS_AUDIT_EVENTS).toBe(100);
    if (!merge) return;

    const events = Array.from({ length: 120 }, (_, index) =>
      event(index + 1, `writer-${String(index).padStart(3, "0")}`),
    );
    const many = preference({ clock: 120, events });
    const merged = merge(many, preference({ events: [events[119]] }));

    expect(merged.events).toHaveLength(100);
    expect(merged.events[0].clock).toBe(21);
    expect(merged.events[99].clock).toBe(120);
    expect(new Set(merged.events.map(({ eventId }) => eventId)).size).toBe(100);
  });

  it("does not regress when stale storage snapshots arrive out of order", () => {
    const testing = store.__settingsPreferencesStoreTest;
    expect(testing).toBeDefined();
    if (!testing || !store.PINNED_SETTINGS_KEY) return;

    const current = withOperation(
      "agents",
      {
        pinned: true,
        clock: 5,
        writerId: "new",
        changedAt: "new-time",
      },
      event(5, "new", "agents"),
    );
    localStorage.setItem(store.PINNED_SETTINGS_KEY, JSON.stringify(current));
    testing.hydrate();
    const stale = withOperation(
      "agents",
      {
        pinned: false,
        clock: 3,
        writerId: "old",
        changedAt: "old-time",
      },
      event(3, "old", "agents", "unpin"),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: store.PINNED_SETTINGS_KEY,
        newValue: JSON.stringify(stale),
      }),
    );

    expect(testing.getSnapshot().preference.pinned).toEqual(["agents"]);
    expect(testing.getSnapshot().preference.clock).toBe(5);
    expect(testing.getSnapshot().preference.events).toHaveLength(2);
  });

  it("does not rewrite or notify for an identical canonical storage envelope", () => {
    const testing = store.__settingsPreferencesStoreTest;
    expect(testing).toBeDefined();
    if (!testing || !store.PINNED_SETTINGS_KEY) return;

    const value = withOperation(
      "providers",
      {
        pinned: true,
        clock: 1,
        writerId: "writer",
        changedAt: "time",
      },
      event(1, "writer", "providers"),
    );
    localStorage.setItem(store.PINNED_SETTINGS_KEY, JSON.stringify(value));
    testing.hydrate();
    const before = testing.getSnapshot();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: store.PINNED_SETTINGS_KEY,
        newValue: localStorage.getItem(store.PINNED_SETTINGS_KEY),
      }),
    );

    expect(writes).not.toHaveBeenCalled();
    expect(testing.getSnapshot()).toBe(before);
  });

  it("rolls back an operation when canonical persistence throws", () => {
    const testing = store.__settingsPreferencesStoreTest;
    expect(testing).toBeDefined();
    if (!testing || !store.pinSettingsSection) return;

    testing.reset({
      writerId: "writer-a",
      uuid: () => "uuid-a",
      now: () => new Date("2026-08-08T00:00:01.000Z"),
    });
    testing.hydrate();
    const before = testing.getSnapshot().preference;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    expect(store.pinSettingsSection("skills")).toBe(false);
    expect(testing.getSnapshot().preference).toBe(before);
    expect(testing.getSnapshot().error).toBe("write");
  });

  it("injects writer, uuid, and time for deterministic local operations", () => {
    const testing = store.__settingsPreferencesStoreTest;
    expect(testing).toBeDefined();
    if (!testing || !store.pinSettingsSection || !store.getSettingsPreferenceUpdatedAt) {
      return;
    }
    testing.reset({
      writerId: "writer-a",
      uuid: () => "uuid-a",
      now: () => new Date("2026-08-08T00:00:01.000Z"),
    });
    testing.hydrate();

    expect(store.pinSettingsSection("agents")).toBe(true);
    const value = testing.getSnapshot().preference;
    expect(value).toMatchObject({
      clock: 1,
      pinned: ["agents"],
      registers: {
        agents: {
          pinned: true,
          clock: 1,
          writerId: "writer-a",
          changedAt: "2026-08-08T00:00:01.000Z",
        },
      },
      events: [
        {
          clock: 1,
          writerId: "writer-a",
          eventId: "writer-a:1:uuid-a",
          changedAt: "2026-08-08T00:00:01.000Z",
          action: "pin",
          section: "agents",
        },
      ],
    });
    expect(store.getSettingsPreferenceUpdatedAt(value)).toBe(
      "2026-08-08T00:00:01.000Z",
    );
  });

  it("migrates legacy revision envelopes and safely rejects damaged data", () => {
    const testing = store.__settingsPreferencesStoreTest;
    expect(testing).toBeDefined();
    if (!testing || !store.PINNED_SETTINGS_KEY) return;

    localStorage.setItem(
      store.PINNED_SETTINGS_KEY,
      JSON.stringify({
        version: 1,
        revision: 2,
        updatedAt: "2026-08-08T00:00:02.000Z",
        pinned: ["providers", "unknown"],
        events: [
          {
            revision: 1,
            changedAt: "2026-08-08T00:00:01.000Z",
            action: "pin",
            section: "agents",
          },
          {
            revision: 2,
            changedAt: "2026-08-08T00:00:02.000Z",
            action: "pin",
            section: "providers",
          },
        ],
      }),
    );
    testing.hydrate();

    expect(testing.getSnapshot().preference).toMatchObject({
      clock: 2,
      pinned: ["providers"],
      registers: {
        agents: { pinned: false, clock: 2, writerId: "legacy" },
        providers: { pinned: true, clock: 2, writerId: "legacy" },
      },
      events: [
        { clock: 1, writerId: "legacy", section: "agents" },
        { clock: 2, writerId: "legacy", section: "providers" },
      ],
    });
    expect(JSON.parse(localStorage.getItem(store.PINNED_SETTINGS_KEY!)!)).not
      .toHaveProperty("revision");

    testing.reset();
    localStorage.setItem(store.PINNED_SETTINGS_KEY, "{damaged");
    testing.hydrate();
    expect(testing.getSnapshot()).toMatchObject({
      hydrated: true,
      error: "invalid",
      preference: { clock: 0, pinned: [], events: [] },
    });
  });
});
