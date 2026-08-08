import { DatabaseSync } from "node:sqlite";

import { openDatabase as openProductionDatabase } from "@/src/server/db";
import { initializeMissionDeliveryTx } from "@/src/server/migrations-v6";
import {
  V6_INDEXES,
  V6_TABLES,
  V6_TRIGGERS,
  validateV6,
} from "@/src/server/migrations-v6";
import {
  migrateDatabase,
  SchemaMigrationError,
} from "@/src/server/migrations";

export type V6FixtureOptions = {
  missingDeliveryHeadMissionIds: readonly string[];
  missingReviewHeadResultIds: readonly string[];
};

export type V6FixtureHandle = object;

type FixtureDefinition = {
  options: V6FixtureOptions;
  path: string;
};

type MissingMission = {
  id: string;
  projectId: string;
  updatedAt: string;
};

type MissingReviewResult = {
  createdAt: string;
  id: string;
  missionId: string;
  projectId: string;
  workItemId: string;
};

const fixtureHandles = new WeakSet<object>();
const fixtureDefinitions = new WeakMap<object, FixtureDefinition>();
const completedFixtures = new Map<string, string>();

function fixtureSignature(options: V6FixtureOptions): string {
  return JSON.stringify({
    missions: [...options.missingDeliveryHeadMissionIds].sort(),
    results: [...options.missingReviewHeadResultIds].sort(),
  });
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function sortedUnique(ids: readonly string[]): string[] | null {
  const sorted = [...ids].sort();
  return new Set(sorted).size === sorted.length ? sorted : null;
}

function assertCompleteV6Objects(database: DatabaseSync): void {
  const wanted = [...V6_TABLES, ...V6_INDEXES, ...V6_TRIGGERS].sort();
  const actual = (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
      AND name IN (${wanted.map(() => "?").join(",")})
    ORDER BY name
  `).all(...wanted) as Array<{ name: string }>).map(({ name }) => name);
  if (!sameIds(actual, wanted)) throw new Error("V6_FIXTURE_SCHEMA_INCOMPLETE");
}

function missingMissions(database: DatabaseSync): MissingMission[] {
  return database.prepare(`
    SELECT m.id,m.project_id AS projectId,m.updated_at AS updatedAt
    FROM missions m
    WHERE NOT EXISTS(
      SELECT 1 FROM mission_delivery_heads h
      WHERE h.mission_id=m.id AND h.project_id=m.project_id
    )
    ORDER BY m.id
  `).all() as MissingMission[];
}

function missingCurrentReviewResults(database: DatabaseSync): MissingReviewResult[] {
  return database.prepare(`
    SELECT r.id,r.project_id AS projectId,r.mission_id AS missionId,
           r.work_item_id AS workItemId,r.created_at AS createdAt
    FROM work_item_result_versions r
    WHERE r.version=(
      SELECT MAX(latest.version)
      FROM work_item_result_versions latest
      WHERE latest.work_item_id=r.work_item_id
    )
      AND NOT EXISTS(
        SELECT 1 FROM work_item_review_heads h
        WHERE h.work_item_id=r.work_item_id
      )
    ORDER BY r.id
  `).all() as MissingReviewResult[];
}

function initializeReviewHead(database: DatabaseSync, result: MissingReviewResult): void {
  database.prepare(`
    INSERT INTO work_item_review_heads(
      work_item_id,project_id,mission_id,current_result_id,current_attempt_id,
      state,version,updated_at
    ) VALUES (?, ?, ?, ?, NULL, 'pending_review', 1, ?)
  `).run(
    result.workItemId,
    result.projectId,
    result.missionId,
    result.id,
    result.createdAt,
  );
}

function repairFixture(
  database: DatabaseSync,
  expectedMissions: readonly string[],
  expectedResults: readonly string[],
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const version = (database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }).user_version;
    if (version !== 6) throw new Error("V6_FIXTURE_VERSION_MISMATCH");
    assertCompleteV6Objects(database);

    const missions = missingMissions(database);
    const results = missingCurrentReviewResults(database);
    if (
      !sameIds(missions.map(({ id }) => id), expectedMissions)
      || !sameIds(results.map(({ id }) => id), expectedResults)
    ) {
      throw new Error("V6_FIXTURE_ALLOWLIST_MISMATCH");
    }
    for (const mission of missions) initializeMissionDeliveryTx(database, mission);
    for (const result of results) initializeReviewHead(database, result);
    const validation = validateV6(database);
    if (validation !== null) throw new Error(`V6_FIXTURE_${validation}`);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function fixtureAware(
  database: DatabaseSync,
  definition: FixtureDefinition,
  expectedMissions: readonly string[],
  expectedResults: readonly string[],
): DatabaseSync {
  const complete = () => {
    if (database.isTransaction) return;
    const signature = fixtureSignature(definition.options);
    if (completedFixtures.get(definition.path) === signature) return;
    const actualMissions = missingMissions(database).map(({ id }) => id);
    const actualResults = missingCurrentReviewResults(database).map(({ id }) => id);
    if (actualMissions.length === 0 && actualResults.length === 0) return;
    try {
      repairFixture(database, expectedMissions, expectedResults);
      completedFixtures.set(definition.path, signature);
    } catch (error) {
      if (
        error instanceof Error
        && error.message === "V6_FIXTURE_SCHEMA_DATA_INVALID"
      ) return;
      throw error;
    }
  };
  return new Proxy(database, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string) => {
          target.exec(sql);
          complete();
        };
      }
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "run") {
                return (...values: Parameters<typeof statementTarget.run>) => {
                  const result = statementTarget.run(...values);
                  complete();
                  return result;
                };
              }
              const statementValue = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget,
              ) as unknown;
              return typeof statementValue === "function"
                ? statementValue.bind(statementTarget)
                : statementValue;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function createV6FixtureHandle(
  path: string,
  options: V6FixtureOptions,
): V6FixtureHandle {
  const handle = Object.freeze({});
  fixtureHandles.add(handle);
  fixtureDefinitions.set(handle, {
    options: {
      missingDeliveryHeadMissionIds: [...options.missingDeliveryHeadMissionIds],
      missingReviewHeadResultIds: [...options.missingReviewHeadResultIds],
    },
    path,
  });
  return handle;
}

export function openV6FixtureDatabase(handle: V6FixtureHandle): DatabaseSync {
  if (
    typeof handle !== "object"
    || handle === null
    || !fixtureHandles.has(handle)
  ) {
    throw new TypeError("A branded v6 fixture handle is required.");
  }
  const definition = fixtureDefinitions.get(handle);
  if (!definition) throw new TypeError("A branded v6 fixture handle is required.");
  const expectedMissions = sortedUnique(definition.options.missingDeliveryHeadMissionIds);
  const expectedResults = sortedUnique(definition.options.missingReviewHeadResultIds);
  if (!expectedMissions || !expectedResults) {
    throw new Error("V6_FIXTURE_ALLOWLIST_DUPLICATE");
  }

  if (definition.path !== ":memory:") {
    const probe = new DatabaseSync(definition.path);
    const version = (probe.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }).user_version;
    probe.close();
    if (version === 7) return openProductionDatabase(definition.path);
  }

  try {
    const valid = openDatabaseAtV6(definition.path);
    const signature = fixtureSignature(definition.options);
    if (
      expectedMissions.length === 0 && expectedResults.length === 0
      || completedFixtures.get(definition.path) === signature
    ) {
      return valid;
    }
    return fixtureAware(valid, definition, expectedMissions, expectedResults);
  } catch (error) {
    if (
      !(error instanceof SchemaMigrationError)
      || error.code !== "SCHEMA_DATA_INVALID"
      || definition.path === ":memory:"
    ) throw error;
    if (
      completedFixtures.get(definition.path)
      === fixtureSignature(definition.options)
    ) {
      throw error;
    }

    const database = new DatabaseSync(definition.path);
    try {
      database.exec("PRAGMA foreign_keys=ON");
      repairFixture(database, expectedMissions, expectedResults);
      completedFixtures.set(definition.path, fixtureSignature(definition.options));
      return database;
    } catch (repairError) {
      database.close();
      throw repairError;
    }
  }
}

export function openDatabase(input: string | V6FixtureHandle): DatabaseSync {
  return typeof input === "string"
    ? openProductionDatabase(input)
    : openV6FixtureDatabase(input);
}

export function createV6FixtureDatabaseOpener(
  options: V6FixtureOptions,
): (path: string) => DatabaseSync {
  const handles = new Map<string, V6FixtureHandle>();
  return (path: string) => {
    let handle = handles.get(path);
    if (!handle) {
      handle = createV6FixtureHandle(path, options);
      handles.set(path, handle);
    }
    return openV6FixtureDatabase(handle);
  };
}

export function openDatabaseAtV6(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON");
  const initialVersion = (database.prepare("PRAGMA user_version").get() as {
    user_version: number;
  }).user_version;
  if (initialVersion > 6) {
    database.close();
    throw new SchemaMigrationError(
      "SCHEMA_TOO_NEW",
      "Database schema is newer than this application.",
    );
  }
  try {
    migrateDatabase(database, (step) => {
      if (step === "precheck") throw new Error("STOP_AT_V6");
    });
  } catch (error) {
    if (error instanceof SchemaMigrationError && error.code !== "STORAGE_UNAVAILABLE") {
      database.close();
      throw error;
    }
    if (!(error instanceof SchemaMigrationError)) {
      database.close();
      throw new SchemaMigrationError(
        "STORAGE_UNAVAILABLE",
        "Database migration failed.",
      );
    }
  }
  const version = (database.prepare("PRAGMA user_version").get() as {
    user_version: number;
  }).user_version;
  if (version !== 6) {
    database.close();
    throw new Error("V6_FIXTURE_VERSION_MISMATCH");
  }
  const validation = validateV6(database);
  if (validation !== null) {
    database.close();
    throw new SchemaMigrationError(
      validation,
      `Database version 6 ${validation === "SCHEMA_DRIFT" ? "schema" : "data"} is invalid.`,
    );
  }
  return database;
}
