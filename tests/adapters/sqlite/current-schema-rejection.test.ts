import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";
import { SchemaError, type SchemaErrorCode } from "@/src/adapters/outbound/sqlite/schema-error";
import {
  createUnsupportedSchemaInput,
  type UnsupportedSchemaInput,
} from "@/tests/fixtures/sqlite/unsupported-schema-input";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "cool-ai-schema-rejection-"));
  temporaryDirectories.push(directory);
  return join(directory, "cockpit.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, maxRetries: 3, recursive: true, retryDelay: 20 });
  }
});

const stableMessages: Record<SchemaErrorCode, string> = {
  SCHEMA_DATA_INVALID: "Database data is invalid.",
  SCHEMA_DRIFT: "Database schema does not match the current schema.",
  SCHEMA_TOO_NEW: "Database schema is unsupported.",
  SCHEMA_UNSUPPORTED: "Database schema is unsupported.",
  STORAGE_UNAVAILABLE: "Database storage is unavailable.",
};

function rejectedOpen(path: string): SchemaError {
  try {
    const database = openDatabase(path);
    database.close();
    throw new Error("EXPECTED_SCHEMA_REJECTION");
  } catch (error) {
    if (error instanceof SchemaError) return error;
    throw error;
  }
}

const cases: Array<{
  expectedCode: SchemaErrorCode;
  input: UnsupportedSchemaInput;
  label: string;
}> = [
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] as const).map((userVersion) => ({
    expectedCode: "SCHEMA_UNSUPPORTED" as const,
    input: { kind: "legacy-identity" as const, userVersion },
    label: `legacy identity ${userVersion}`,
  })),
  {
    expectedCode: "SCHEMA_UNSUPPORTED",
    input: { kind: "non-empty-v0" },
    label: "non-empty identity 0",
  },
  {
    expectedCode: "SCHEMA_DRIFT",
    input: { kind: "partial-current" },
    label: "partial current schema",
  },
  {
    expectedCode: "SCHEMA_UNSUPPORTED",
    input: { kind: "unsupported-identity", userVersion: 24 },
    label: "unsupported future identity",
  },
  {
    expectedCode: "SCHEMA_DRIFT",
    input: { kind: "extra-object" },
    label: "extra object",
  },
  {
    expectedCode: "SCHEMA_DRIFT",
    input: { kind: "missing-object" },
    label: "missing object",
  },
  {
    expectedCode: "SCHEMA_DRIFT",
    input: { kind: "changed-object" },
    label: "changed object DDL",
  },
  {
    expectedCode: "SCHEMA_DATA_INVALID",
    input: { kind: "foreign-key-invalid" },
    label: "foreign-key-invalid current data",
  },
  {
    expectedCode: "SCHEMA_DATA_INVALID",
    input: { kind: "current-data-invalid" },
    label: "current data invariant violation",
  },
];

describe("unsupported current schema inputs", () => {
  it.each(cases)(
    "rejects $label without changing or retaining the database",
    ({ expectedCode, input }) => {
      const path = databasePath();
      createUnsupportedSchemaInput(path, input);
      const before = readFileSync(path);

      const error = rejectedOpen(path);

      expect(error).toMatchObject({
        code: expectedCode,
        message: stableMessages[expectedCode],
        name: "SchemaError",
      });
      expect(error).not.toHaveProperty("cause");
      expect(error.message).not.toContain(path);
      expect(error.message).not.toContain("unsupported-schema-marker-content");
      expect(error.message).not.toMatch(/CREATE|credential|sqlite/i);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path)).toEqual(before);

      const movedPath = `${path}.closed`;
      renameSync(path, movedPath);
      renameSync(movedPath, path);
    },
    20000,
  );
});
