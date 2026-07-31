import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { migrateDatabase, SchemaMigrationError } from "@/src/server/migrations";

export function openDatabase(databasePath: string): DatabaseSync {
  let database: DatabaseSync | undefined;

  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON");
    migrateDatabase(database);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The sanitized migration error below remains the public failure.
    }
    if (error instanceof SchemaMigrationError) throw error;
    throw new SchemaMigrationError("STORAGE_UNAVAILABLE", "Database migration failed.");
  }
}
