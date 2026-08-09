import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { agentApiError } from "@/app/api/_shared/agent-api";
import { collaborationErrorResponse } from "@/app/api/_shared/collaboration/collaboration-api";
import { contextApiError } from "@/app/api/_shared/context-api";
import { executionErrorResponse } from "@/app/api/_shared/execution/execution-api";
import { membershipApiError } from "@/app/api/_shared/membership-api";
import { memoryApiError } from "@/app/api/_shared/memory-api";
import { missionApiError } from "@/app/api/_shared/mission-api";
import { providerApiError } from "@/app/api/_shared/provider-api";
import { skillApiError } from "@/app/api/_shared/skill-api";
import { validationPolicySchemaErrorResponse } from "@/app/api/_shared/execution/validation-policy-http";
import {
  SchemaError,
  type SchemaErrorCode,
} from "@/src/adapters/outbound/sqlite/schema-error";

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
  "../../../app/api/_shared/agent-api.ts",
  "../../../app/api/_shared/collaboration/collaboration-api.ts",
  "../../../app/api/_shared/context-api.ts",
  "../../../app/api/_shared/execution/execution-api.ts",
  "../../../src/adapters/outbound/sqlite/safe-execution/execution-read-service.ts",
  "../../../app/api/_shared/membership-api.ts",
  "../../../app/api/_shared/memory-api.ts",
  "../../../app/api/_shared/mission-api.ts",
  "../../../app/api/_shared/provider-api.ts",
  "../../../app/api/_shared/skill-api.ts",
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
      // T-14: 入站 _shared 助手经装配根拿 SchemaError（canonical 定义仍在
      // sqlite 存储边界并由 composition 具名 re-export）；Adapter 直接引用边界。
      expect(source).toMatch(
        /import \{[^}]*\bSchemaError\b[^}]*\} from "(?:@\/src\/composition|@\/src\/adapters\/outbound\/sqlite\/schema-error)"/u,
      );
      expect(source).not.toContain("src/server/migrations");
      expect(source).not.toContain("SchemaMigrationError");
    }
  });
});
