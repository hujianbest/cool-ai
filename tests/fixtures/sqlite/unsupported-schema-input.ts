import { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { CURRENT_SCHEMA } from "@/src/adapters/outbound/sqlite/current-schema";

export type UnsupportedSchemaInput =
  | { readonly kind: "legacy-identity"; readonly userVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 }
  | { readonly kind: "non-empty-v0" }
  | { readonly kind: "partial-current" }
  | { readonly kind: "unsupported-identity"; readonly userVersion: number }
  | { readonly kind: "extra-object" }
  | { readonly kind: "missing-object" }
  | { readonly kind: "changed-object" }
  | { readonly kind: "foreign-key-invalid" }
  | { readonly kind: "current-data-invalid" };

const MARKER_VALUE = "unsupported-schema-marker-content";

function createMinimalMarker(path: string, userVersion: number): void {
  if (
    !Number.isSafeInteger(userVersion)
    || userVersion < 0
    || userVersion > 2_147_483_647
  ) {
    throw new Error("UNSUPPORTED_SCHEMA_FIXTURE_IDENTITY_INVALID");
  }
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE unsupported_schema_marker(value TEXT NOT NULL);
      INSERT INTO unsupported_schema_marker(value) VALUES ('${MARKER_VALUE}');
      PRAGMA user_version=${userVersion};
    `);
  } finally {
    database.close();
  }
}

function mutateCurrent(path: string, input: UnsupportedSchemaInput): void {
  openDatabase(path).close();
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys=OFF");
    switch (input.kind) {
      case "extra-object":
        database.exec("CREATE TABLE unsupported_extra_object(id TEXT)");
        break;
      case "missing-object":
        database.exec("DROP INDEX agents_provider_id_idx");
        break;
      case "changed-object":
        database.exec(`
          DROP INDEX agents_provider_id_idx;
          CREATE INDEX agents_provider_id_idx ON agents(model);
        `);
        break;
      case "foreign-key-invalid":
        database.exec(`
          INSERT INTO task_runs(
            id,project_id,goal,status,result,error,created_at,updated_at
          ) VALUES (
            'unsupported-task','missing-project','Goal','queued',NULL,NULL,
            '2026-08-09T00:00:00.000Z','2026-08-09T00:00:00.000Z'
          );
        `);
        break;
      case "current-data-invalid":
        database.exec(`
          INSERT INTO projects(id,name,created_at,version)
          VALUES (
            'unsupported-project','Invalid','2026-08-09T00:00:00.000Z',1
          );
          INSERT INTO missions(id,project_id,title,goal,version,created_at,updated_at)
          VALUES (
            'unsupported-mission','unsupported-project','Mission','Goal',1,
            '2026-08-09T00:00:00.000Z','2026-08-09T00:00:00.000Z'
          );
        `);
        break;
      default:
        throw new Error("UNSUPPORTED_SCHEMA_FIXTURE_CASE_INVALID");
    }
  } finally {
    database.close();
  }
}

export function createUnsupportedSchemaInput(
  path: string,
  input: UnsupportedSchemaInput,
): void {
  switch (input.kind) {
    case "legacy-identity":
    case "unsupported-identity":
      createMinimalMarker(path, input.userVersion);
      return;
    case "non-empty-v0":
      createMinimalMarker(path, 0);
      return;
    case "partial-current":
      createMinimalMarker(path, CURRENT_SCHEMA.identity.userVersion);
      return;
    default:
      mutateCurrent(path, input);
  }
}
