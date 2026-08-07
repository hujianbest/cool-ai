"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/components/settings-navigation";

export type SettingsPreferenceRegister = {
  pinned: boolean;
  clock: number;
  writerId: string;
  changedAt: string;
};

export type SettingsPreferenceEvent = {
  clock: number;
  writerId: string;
  eventId: string;
  changedAt: string;
  action: "pin" | "unpin";
  section: SettingsSectionId;
};

export type SettingsPreference = {
  version: 1;
  clock: number;
  pinned: SettingsSectionId[];
  registers: Record<SettingsSectionId, SettingsPreferenceRegister>;
  events: SettingsPreferenceEvent[];
};

export type SettingsPreferencesSnapshot = {
  hydrated: boolean;
  preference: SettingsPreference;
  error: "read" | "write" | "invalid" | "conflict" | null;
};

type MergeResult = {
  preference: SettingsPreference;
  conflict: boolean;
};

type ParsedPreference = {
  preference: SettingsPreference;
  migrated: boolean;
};

type TestOptions = {
  writerId?: string;
  uuid?: () => string;
  now?: () => Date;
};

export const PINNED_SETTINGS_KEY = "cool-ai:pinned-settings:v1";
export const SETTINGS_PREFERENCES_EVENT = "cool-ai:settings-preferences:v1";
export const MAX_SETTINGS_AUDIT_EVENTS = 100;

const WRITER_ID_KEY = "cool-ai:settings-preferences-writer:v1";
const SECTION_IDS = SETTINGS_SECTIONS.map(({ id }) => id);
const SECTION_ID_SET = new Set<SettingsSectionId>(SECTION_IDS);

function zeroRegister(): SettingsPreferenceRegister {
  return { pinned: false, clock: 0, writerId: "", changedAt: "" };
}

function emptyPreference(): SettingsPreference {
  return {
    version: 1,
    clock: 0,
    pinned: [],
    registers: {
      skills: zeroRegister(),
      providers: zeroRegister(),
      agents: zeroRegister(),
    },
    events: [],
  };
}

const SERVER_SNAPSHOT: SettingsPreferencesSnapshot = {
  hydrated: false,
  preference: emptyPreference(),
  error: null,
};

let snapshot = SERVER_SNAPSHOT;
let serializedPreference: string | null = null;
let contextWriterId: string | null = null;
let now = () => new Date();
let createUuid = () => crypto.randomUUID();
const listeners = new Set<() => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSectionId(value: unknown): value is SettingsSectionId {
  return typeof value === "string" &&
    SECTION_ID_SET.has(value as SettingsSectionId);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareVersion(
  left: Pick<SettingsPreferenceRegister, "clock" | "writerId">,
  right: Pick<SettingsPreferenceRegister, "clock" | "writerId">,
): number {
  return left.clock - right.clock || compareText(left.writerId, right.writerId);
}

function compareEvents(
  left: SettingsPreferenceEvent,
  right: SettingsPreferenceEvent,
): number {
  return compareVersion(left, right) ||
    compareText(left.eventId, right.eventId);
}

function canonicalRegister(value: SettingsPreferenceRegister): string {
  return JSON.stringify({
    pinned: value.pinned,
    clock: value.clock,
    writerId: value.writerId,
    changedAt: value.changedAt,
  });
}

function canonicalEvent(value: SettingsPreferenceEvent): string {
  return JSON.stringify({
    clock: value.clock,
    writerId: value.writerId,
    eventId: value.eventId,
    changedAt: value.changedAt,
    action: value.action,
    section: value.section,
  });
}

function chooseRegister(
  left: SettingsPreferenceRegister,
  right: SettingsPreferenceRegister,
): { register: SettingsPreferenceRegister; conflict: boolean } {
  const order = compareVersion(left, right);
  if (order !== 0) {
    return { register: order > 0 ? left : right, conflict: false };
  }
  const leftCanonical = canonicalRegister(left);
  const rightCanonical = canonicalRegister(right);
  return {
    register: leftCanonical >= rightCanonical ? left : right,
    conflict: leftCanonical !== rightCanonical,
  };
}

function derivePinned(
  registers: Record<SettingsSectionId, SettingsPreferenceRegister>,
): SettingsSectionId[] {
  return SECTION_IDS.filter((section) => registers[section].pinned);
}

function maxObservedClock(preference: SettingsPreference): number {
  return Math.max(
    preference.clock,
    ...SECTION_IDS.map((section) => preference.registers[section].clock),
    ...preference.events.map(({ clock }) => clock),
  );
}

function mergeDetailed(
  left: SettingsPreference,
  right: SettingsPreference,
): MergeResult {
  let conflict = false;
  const registers = {} as Record<
    SettingsSectionId,
    SettingsPreferenceRegister
  >;
  for (const section of SECTION_IDS) {
    const chosen = chooseRegister(
      left.registers[section],
      right.registers[section],
    );
    registers[section] = { ...chosen.register };
    conflict ||= chosen.conflict;
  }

  const eventsById = new Map<string, SettingsPreferenceEvent>();
  for (const candidate of [...left.events, ...right.events]) {
    const existing = eventsById.get(candidate.eventId);
    if (!existing) {
      eventsById.set(candidate.eventId, { ...candidate });
      continue;
    }
    const existingCanonical = canonicalEvent(existing);
    const candidateCanonical = canonicalEvent(candidate);
    if (existingCanonical !== candidateCanonical) conflict = true;
    if (candidateCanonical > existingCanonical) {
      eventsById.set(candidate.eventId, { ...candidate });
    }
  }
  const events = [...eventsById.values()]
    .sort(compareEvents)
    .slice(-MAX_SETTINGS_AUDIT_EVENTS);
  const clock = Math.max(
    left.clock,
    right.clock,
    ...SECTION_IDS.map((section) => registers[section].clock),
    ...events.map((candidate) => candidate.clock),
  );
  return {
    preference: {
      version: 1,
      clock,
      pinned: derivePinned(registers),
      registers,
      events,
    },
    conflict,
  };
}

export function mergePreferences(
  left: SettingsPreference,
  right: SettingsPreference,
): SettingsPreference {
  return mergeDetailed(left, right).preference;
}

export function getSettingsPreferenceUpdatedAt(
  preference: SettingsPreference,
): string | null {
  let latest: SettingsPreferenceRegister | null = null;
  for (const section of SECTION_IDS) {
    const candidate = preference.registers[section];
    if (
      candidate.clock > 0 &&
      (!latest || compareVersion(candidate, latest) > 0)
    ) {
      latest = candidate;
    }
  }
  return latest?.changedAt || null;
}

function canonicalPreference(preference: SettingsPreference): string {
  return JSON.stringify({
    version: 1,
    clock: preference.clock,
    pinned: derivePinned(preference.registers),
    registers: {
      skills: preference.registers.skills,
      providers: preference.registers.providers,
      agents: preference.registers.agents,
    },
    events: preference.events,
  });
}

function parseRegister(value: unknown): SettingsPreferenceRegister | null {
  if (
    !isRecord(value) ||
    typeof value.pinned !== "boolean" ||
    !isNonNegativeInteger(value.clock) ||
    typeof value.writerId !== "string" ||
    typeof value.changedAt !== "string" ||
    (value.clock === 0 &&
      (value.writerId !== "" || value.changedAt !== "" || value.pinned))
  ) {
    return null;
  }
  return {
    pinned: value.pinned,
    clock: value.clock,
    writerId: value.writerId,
    changedAt: value.changedAt,
  };
}

function parseEvent(value: unknown): SettingsPreferenceEvent | "unknown" | null {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.clock) ||
    value.clock === 0 ||
    typeof value.writerId !== "string" ||
    value.writerId.length === 0 ||
    typeof value.eventId !== "string" ||
    value.eventId.length === 0 ||
    typeof value.changedAt !== "string" ||
    value.changedAt.length === 0 ||
    (value.action !== "pin" && value.action !== "unpin") ||
    typeof value.section !== "string"
  ) {
    return null;
  }
  if (!isSectionId(value.section)) return "unknown";
  return {
    clock: value.clock,
    writerId: value.writerId,
    eventId: value.eventId,
    changedAt: value.changedAt,
    action: value.action,
    section: value.section,
  };
}

function parseCurrentEnvelope(parsed: Record<string, unknown>): SettingsPreference | null {
  if (
    !isNonNegativeInteger(parsed.clock) ||
    !Array.isArray(parsed.pinned) ||
    !isRecord(parsed.registers) ||
    !Array.isArray(parsed.events)
  ) {
    return null;
  }
  const registers = {} as Record<
    SettingsSectionId,
    SettingsPreferenceRegister
  >;
  for (const section of SECTION_IDS) {
    const register = parseRegister(parsed.registers[section]);
    if (!register) return null;
    registers[section] = register;
  }
  const events: SettingsPreferenceEvent[] = [];
  for (const value of parsed.events) {
    const candidate = parseEvent(value);
    if (candidate === null) return null;
    if (candidate !== "unknown") events.push(candidate);
  }
  return mergePreferences(emptyPreference(), {
    version: 1,
    clock: parsed.clock,
    pinned: [],
    registers,
    events,
  });
}

function parseLegacyEnvelope(parsed: Record<string, unknown>): SettingsPreference | null {
  if (
    !isNonNegativeInteger(parsed.revision) ||
    !Array.isArray(parsed.pinned) ||
    !Array.isArray(parsed.events) ||
    (parsed.updatedAt !== null && typeof parsed.updatedAt !== "string")
  ) {
    return null;
  }
  const pinned = new Set(parsed.pinned.filter(isSectionId));
  const changedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
  if (parsed.revision > 0 && changedAt.length === 0) return null;
  const registers = {
    skills: {
      pinned: pinned.has("skills"),
      clock: parsed.revision,
      writerId: parsed.revision > 0 ? "legacy" : "",
      changedAt,
    },
    providers: {
      pinned: pinned.has("providers"),
      clock: parsed.revision,
      writerId: parsed.revision > 0 ? "legacy" : "",
      changedAt,
    },
    agents: {
      pinned: pinned.has("agents"),
      clock: parsed.revision,
      writerId: parsed.revision > 0 ? "legacy" : "",
      changedAt,
    },
  } satisfies Record<SettingsSectionId, SettingsPreferenceRegister>;
  const events: SettingsPreferenceEvent[] = [];
  for (const value of parsed.events) {
    if (
      !isRecord(value) ||
      !isNonNegativeInteger(value.revision) ||
      value.revision === 0 ||
      typeof value.changedAt !== "string" ||
      value.changedAt.length === 0 ||
      (value.action !== "pin" && value.action !== "unpin") ||
      typeof value.section !== "string"
    ) {
      return null;
    }
    if (!isSectionId(value.section)) continue;
    events.push({
      clock: value.revision,
      writerId: "legacy",
      eventId: `legacy:${value.revision}:${value.section}:${value.action}`,
      changedAt: value.changedAt,
      action: value.action,
      section: value.section,
    });
  }
  return mergePreferences(emptyPreference(), {
    version: 1,
    clock: parsed.revision,
    pinned: [],
    registers,
    events,
  });
}

function parseStoredPreference(value: string): ParsedPreference | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return null;
  if ("registers" in parsed) {
    const preference = parseCurrentEnvelope(parsed);
    return preference ? { preference, migrated: false } : null;
  }
  if ("revision" in parsed) {
    const preference = parseLegacyEnvelope(parsed);
    return preference ? { preference, migrated: true } : null;
  }
  return null;
}

function publish(next: SettingsPreferencesSnapshot) {
  if (Object.is(snapshot, next)) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function publishError(
  error: Exclude<SettingsPreferencesSnapshot["error"], null>,
) {
  if (snapshot.hydrated && snapshot.error === error) return;
  publish({
    hydrated: true,
    preference: snapshot.preference,
    error,
  });
}

function persistCanonical(value: string): boolean {
  try {
    window.localStorage.setItem(PINNED_SETTINGS_KEY, value);
    return true;
  } catch {
    publishError("write");
    return false;
  }
}

function hydrate() {
  if (snapshot.hydrated || typeof window === "undefined") return;
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(PINNED_SETTINGS_KEY);
  } catch {
    publishError("read");
    return;
  }
  if (stored === null) {
    const preference = emptyPreference();
    serializedPreference = canonicalPreference(preference);
    publish({ hydrated: true, preference, error: null });
    return;
  }
  const parsed = parseStoredPreference(stored);
  if (!parsed) {
    publishError("invalid");
    return;
  }
  const canonical = canonicalPreference(parsed.preference);
  if ((parsed.migrated || canonical !== stored) && !persistCanonical(canonical)) {
    return;
  }
  serializedPreference = canonical;
  publish({ hydrated: true, preference: parsed.preference, error: null });
}

function acceptSerialized(value: string | null) {
  if (!snapshot.hydrated) hydrate();
  const incoming = value === null
    ? { preference: emptyPreference(), migrated: false }
    : parseStoredPreference(value);
  if (!incoming) {
    publishError("invalid");
    return;
  }
  const merged = mergeDetailed(snapshot.preference, incoming.preference);
  const mergedCanonical = canonicalPreference(merged.preference);
  const incomingCanonical = canonicalPreference(incoming.preference);
  const requiresWrite = value === null ||
    incoming.migrated ||
    value !== incomingCanonical ||
    mergedCanonical !== incomingCanonical;
  if (requiresWrite && !persistCanonical(mergedCanonical)) return;

  const preferenceChanged = mergedCanonical !== serializedPreference;
  serializedPreference = mergedCanonical;
  if (!preferenceChanged && !merged.conflict) return;
  publish({
    hydrated: true,
    preference: preferenceChanged ? merged.preference : snapshot.preference,
    error: merged.conflict ? "conflict" : null,
  });
}

function resolveWriterId(): string {
  if (contextWriterId) return contextWriterId;
  try {
    const stored = window.sessionStorage.getItem(WRITER_ID_KEY);
    if (stored) {
      contextWriterId = stored;
      return stored;
    }
  } catch {
    // An in-memory writer below still remains stable for this context.
  }
  contextWriterId = createUuid();
  try {
    window.sessionStorage.setItem(WRITER_ID_KEY, contextWriterId);
  } catch {
    // sessionStorage is optional; the module-level value is the fallback.
  }
  return contextWriterId;
}

function updatePreference(
  section: SettingsSectionId,
  action: "pin" | "unpin",
): boolean {
  if (!snapshot.hydrated || !isSectionId(section) || typeof window === "undefined") {
    return false;
  }
  const writerId = resolveWriterId();
  const clock = maxObservedClock(snapshot.preference) + 1;
  const changedAt = now().toISOString();
  const auditEvent: SettingsPreferenceEvent = {
    clock,
    writerId,
    eventId: `${writerId}:${clock}:${createUuid()}`,
    changedAt,
    action,
    section,
  };
  const candidate = mergePreferences(snapshot.preference, {
    ...emptyPreference(),
    clock,
    registers: {
      ...emptyPreference().registers,
      [section]: {
        pinned: action === "pin",
        clock,
        writerId,
        changedAt,
      },
    },
    events: [auditEvent],
  });
  const canonical = canonicalPreference(candidate);
  if (!persistCanonical(canonical)) return false;

  serializedPreference = canonical;
  publish({ hydrated: true, preference: candidate, error: null });
  window.dispatchEvent(
    new CustomEvent(SETTINGS_PREFERENCES_EVENT, { detail: canonical }),
  );
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

function getServerSnapshot() {
  return SERVER_SNAPSHOT;
}

export function useSettingsPreferences(): SettingsPreferencesSnapshot {
  const current = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  useEffect(() => {
    hydrate();
  }, []);
  return current;
}

export function pinSettingsSection(section: SettingsSectionId): boolean {
  return updatePreference(section, "pin");
}

export function unpinSettingsSection(section: SettingsSectionId): boolean {
  return updatePreference(section, "unpin");
}

if (typeof window !== "undefined") {
  window.addEventListener(SETTINGS_PREFERENCES_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail === "string") acceptSerialized(detail);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === PINNED_SETTINGS_KEY) acceptSerialized(event.newValue);
  });
}

function resetForTests(options: TestOptions | (() => Date) = {}) {
  const normalized = typeof options === "function" ? { now: options } : options;
  snapshot = SERVER_SNAPSHOT;
  serializedPreference = null;
  contextWriterId = normalized.writerId ?? null;
  now = normalized.now ?? (() => new Date());
  createUuid = normalized.uuid ?? (() => crypto.randomUUID());
  listeners.forEach((listener) => listener());
}

/**
 * Test-only control surface. Production components only receive the hook and
 * mutation API; this value is replaced with undefined outside tests.
 */
export const __settingsPreferencesStoreTest =
  process.env.NODE_ENV === "test"
    ? {
        reset: resetForTests,
        hydrate,
        getSnapshot,
        getServerSnapshot,
      }
    : undefined;
