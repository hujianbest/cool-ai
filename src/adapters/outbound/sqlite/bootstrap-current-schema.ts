import type { DatabaseSync } from "node:sqlite";

import {
  CURRENT_SCHEMA,
  type CurrentSchemaManifest,
  orderedCurrentSchemaObjects,
} from "@/src/adapters/outbound/sqlite/current-schema";
import { SchemaError } from "@/src/adapters/outbound/sqlite/schema-error";
import { validateCurrentSchema } from "@/src/adapters/outbound/sqlite/validate-current-schema";

let bootstrapObjectHookForTests: ((createdObjectCount: number) => void) | undefined;

export function setCurrentSchemaBootstrapHookForTests(
  hook: ((createdObjectCount: number) => void) | undefined,
): void {
  bootstrapObjectHookForTests = hook;
}

export function bootstrapCurrentSchema(
  database: DatabaseSync,
  manifest: CurrentSchemaManifest = CURRENT_SCHEMA,
): void {
  const objects = orderedCurrentSchemaObjects(manifest);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [index, object] of objects.entries()) {
      database.exec(object.createSql);
      bootstrapObjectHookForTests?.(index + 1);
    }
    bootstrapObjectHookForTests = undefined;
    database.exec(`PRAGMA user_version=${manifest.identity.userVersion}`);
    validateCurrentSchema(database, manifest);
    database.exec("COMMIT");
  } catch (error) {
    bootstrapObjectHookForTests = undefined;
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the sanitized schema failure below.
      }
    }
    if (error instanceof SchemaError) throw error;
    throw new SchemaError("STORAGE_UNAVAILABLE");
  }
}
