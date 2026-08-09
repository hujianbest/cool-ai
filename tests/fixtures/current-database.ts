import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "@/src/server/db";

export function openEmptyCurrentDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "cool-ai-current-database-"));
  const databasePath = join(directory, "cockpit.sqlite");
  return {
    database: openDatabase(databasePath),
    databasePath,
    directory,
  };
}
