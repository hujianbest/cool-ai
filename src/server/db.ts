import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { bootstrapCurrentSchema } from "@/src/server/storage/bootstrap-current-schema";
import { SchemaError } from "@/src/server/storage/schema-error";
import { validateCurrentSchema } from "@/src/server/storage/validate-current-schema";

function hasUserSchemaObjects(database: DatabaseSync): boolean {
  return database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get() !== undefined;
}

function validateCurrentReopen(database: DatabaseSync): void {
  database.exec("PRAGMA query_only=ON");
  try {
    database.exec("BEGIN");
    validateCurrentSchema(database);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the sanitized schema failure.
      }
    }
    throw error;
  } finally {
    database.exec("PRAGMA query_only=OFF");
  }
}

export function openDatabase(databasePath: string): DatabaseSync {
  let database: DatabaseSync | undefined;

  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec("PRAGMA busy_timeout = 5000");
    if (hasUserSchemaObjects(database)) {
      validateCurrentReopen(database);
    } else {
      bootstrapCurrentSchema(database);
    }
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The sanitized schema error below remains the public failure.
    }
    if (error instanceof SchemaError) throw error;
    throw new SchemaError("STORAGE_UNAVAILABLE");
  }
}
