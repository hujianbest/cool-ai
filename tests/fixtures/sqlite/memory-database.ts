import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

const keeperConnections: DatabaseSync[] = [];
let memoryDatabaseCounter = 0;

// Shared-cache in-memory databases vanish once their last connection closes,
// so each path is pinned by a keeper connection that outlives the test's own
// open/close cycles until the suite-scoped cleanup below runs.
export function closeMemoryDatabaseKeepers(): void {
  while (keeperConnections.length > 0) {
    try {
      keeperConnections.pop()?.close();
    } catch {
      // A keeper already closed by its consumer is not an error.
    }
  }
}

afterEach(() => {
  closeMemoryDatabaseKeepers();
});

export function memoryDatabasePath(): string {
  memoryDatabaseCounter += 1;
  const databasePath = `file:cool-ai-test-${process.pid}-${memoryDatabaseCounter}?mode=memory&cache=shared`;
  keeperConnections.push(openDatabase(databasePath));
  return databasePath;
}

// Raw consumers build their own minimal schema with new DatabaseSync() and must
// bypass the canonical bootstrap that openDatabase performs, so their keeper is
// a plain connection that only pins the shared cache.
export function rawMemoryDatabasePath(): string {
  memoryDatabaseCounter += 1;
  const databasePath = `file:cool-ai-raw-${process.pid}-${memoryDatabaseCounter}?mode=memory&cache=shared`;
  keeperConnections.push(new DatabaseSync(databasePath));
  return databasePath;
}
