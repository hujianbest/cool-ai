import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { agentApiError } from "@/src/server/agent-api";
import { collaborationErrorResponse } from "@/src/server/collaboration/collaboration-api";
import { contextApiError } from "@/src/server/context-api";
import { executionErrorResponse } from "@/src/server/execution/execution-api";
import { membershipApiError } from "@/src/server/membership-api";
import { memoryApiError } from "@/src/server/memory-api";
import { missionApiError } from "@/src/server/mission-api";
import { providerApiError } from "@/src/server/provider-api";
import { skillApiError } from "@/src/server/skill-api";
import { validationPolicySchemaErrorResponse } from "@/src/server/execution/validation-policy-http";
import {
  SchemaError,
  type SchemaErrorCode,
} from "@/src/server/storage/schema-error";

type SchemaAdapter = (error: unknown, route: string) => Response;

const adapters: Array<{ adapter: SchemaAdapter; label: string }> = [
  { adapter: agentApiError, label: "agent" },
  { adapter: collaborationErrorResponse, label: "collaboration" },
  { adapter: contextApiError, label: "context" },
  { adapter: executionErrorResponse, label: "execution" },
  { adapter: membershipApiError, label: "membership" },
  { adapter: memoryApiError, label: "memory" },
  { adapter: missionApiError, label: "mission" },
  { adapter: providerApiError, label: "provider" },
  { adapter: skillApiError, label: "skill" },
  {
    adapter(error) {
      return validationPolicySchemaErrorResponse(error);
    },
    label: "validation-policy",
  },
];

const stableCases: Array<{ code: SchemaErrorCode; message: string }> = [
  { code: "SCHEMA_DATA_INVALID", message: "Database data is invalid." },
  { code: "SCHEMA_DRIFT", message: "Database schema does not match the current schema." },
  { code: "SCHEMA_UNSUPPORTED", message: "Database schema is unsupported." },
  { code: "STORAGE_UNAVAILABLE", message: "Database storage is unavailable." },
];

const adapterSources = [
  "../src/server/agent-api.ts",
  "../src/server/collaboration/collaboration-api.ts",
  "../src/server/context-api.ts",
  "../src/server/execution/execution-api.ts",
  "../src/server/execution/execution-read-service.ts",
  "../src/server/membership-api.ts",
  "../src/server/memory-api.ts",
  "../src/server/mission-api.ts",
  "../src/server/provider-api.ts",
  "../src/server/skill-api.ts",
] as const;

describe("schema error inbound adapters", () => {
  it("returns only the stable sanitized schema message", async () => {
    const sensitive = [
      "C:\\private\\cockpit.sqlite",
      "CREATE TABLE leaked_secret",
      "credential-super-secret",
    ].join(" ");
    const response = agentApiError(
      new SchemaError("SCHEMA_DRIFT", sensitive),
      "/api/agents",
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "SCHEMA_DRIFT",
        message: "Database schema does not match the current schema.",
      },
    });
  });

  for (const { adapter, label } of adapters) {
    it.each(stableCases)(`${label} maps $code without weakening it`, async ({ code, message }) => {
      const response = adapter(new SchemaError(code), `/api/${label}`);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code, message },
      });
    });
  }

  it("imports SchemaError only from the current storage boundary", () => {
    for (const sourcePath of adapterSources) {
      const source = readFileSync(new URL(sourcePath, import.meta.url), "utf8");
      expect(source).toContain('from "@/src/server/storage/schema-error"');
      expect(source).not.toContain('from "@/src/server/migrations"');
      expect(source).not.toContain("SchemaMigrationError");
    }
  });
});
