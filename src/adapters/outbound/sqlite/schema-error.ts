export type SchemaErrorCode =
  | "SCHEMA_DATA_INVALID"
  | "SCHEMA_DRIFT"
  | "SCHEMA_TOO_NEW"
  | "SCHEMA_UNSUPPORTED"
  | "STORAGE_UNAVAILABLE";

const DEFAULT_MESSAGES: Record<SchemaErrorCode, string> = {
  SCHEMA_DATA_INVALID: "Database data is invalid.",
  SCHEMA_DRIFT: "Database schema does not match the current schema.",
  SCHEMA_TOO_NEW: "Database schema is unsupported.",
  SCHEMA_UNSUPPORTED: "Database schema is unsupported.",
  STORAGE_UNAVAILABLE: "Database storage is unavailable.",
};

export class SchemaError extends Error {
  constructor(
    public readonly code: SchemaErrorCode,
    _legacyMessage?: string,
  ) {
    super(DEFAULT_MESSAGES[code]);
    this.name = "SchemaError";
  }
}
