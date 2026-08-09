import type { DatabaseSync } from "node:sqlite";

import { validateCurrentDataInvariants } from "@/src/adapters/outbound/sqlite/current-data-invariants";
import {
  assertCurrentSchemaManifest,
  CURRENT_SCHEMA,
  type CurrentSchemaManifest,
  normalizeCanonicalSql,
} from "@/src/adapters/outbound/sqlite/current-schema";
import { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";

type SchemaRow = {
  name: string;
  sql: string | null;
  type: string;
};

let snapshotHookForTests: (() => void) | undefined;

export function setCurrentSchemaSnapshotHookForTests(hook: (() => void) | undefined): void {
  snapshotHookForTests = hook;
}

export function validateCurrentSchema(
  database: DatabaseSync,
  manifest: CurrentSchemaManifest = CURRENT_SCHEMA,
): void {
  assertCurrentSchemaManifest(manifest);
  const identity = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (identity.user_version !== manifest.identity.userVersion) {
    throw new SchemaError("SCHEMA_UNSUPPORTED");
  }

  const rows = database.prepare(`
    SELECT type,name,sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
  `).all() as SchemaRow[];

  const hook = snapshotHookForTests;
  snapshotHookForTests = undefined;
  hook?.();

  const expected = new Map(
    manifest.objects.map((object) => [
      object.name,
      {
        sql: normalizeCanonicalSql(object.createSql),
        type: object.kind,
      },
    ]),
  );
  if (
    rows.length !== expected.size
    || rows.some((row) => {
      const object = expected.get(row.name);
      return (
        object === undefined
        || row.sql === null
        || row.type !== object.type
        || normalizeCanonicalSql(row.sql) !== object.sql
      );
    })
  ) {
    throw new SchemaError("SCHEMA_DRIFT");
  }

  if ((database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) {
    throw new SchemaError("SCHEMA_DATA_INVALID");
  }

  const dataValidation = validateCurrentDataInvariants(database);
  if (dataValidation === "SCHEMA_DATA_INVALID") {
    throw new SchemaError("SCHEMA_DATA_INVALID");
  }
}
